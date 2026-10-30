/**
 * Platform mandates through the Grantmaker (#529).
 *
 * Minerval funds a mandate the way anyone does: its account holds a granting
 * conversation in which the Grantmaker designs the mandate, quotes it, and
 * can decline it. What differs is only the money. A person escrows owls
 * from their balance with POST /grant-conversations/:id/fund; the platform
 * cannot (grant-conversation-service refuses it). Its owls are bought at
 * cost and escrowed here, by the operator route, once a reviewed public
 * approval (a pull request carrying a snapshot of the draft and its hash,
 * mandates/platform/ in the repository) has been merged.
 *
 * The funding transaction refuses a draft that no longer hashes to what the
 * approval pinned, so a draft revised after review cannot ride an old
 * approval, and it is idempotent per conversation, so the workflow that
 * calls it after every deploy never buys owls twice.
 *
 * The platform's conversations are public (getPublicPlatformConversation):
 * the reasoning behind every platform mandate is on the record, which is
 * the openness the constitution asks of the one budget no outside funder
 * checks.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import type { GrantMandate } from "../llm/agents/grantmaker.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "./api-key-service.js";
import { mandateDraftHash } from "./mandate-draft-hash.js";
import { owlsToMicroUsd } from "./owl.js";
import {
  PLATFORM_EXTERNAL_ID,
  PLATFORM_GRANTMAKING_SCOPE,
  getPlatformAccountId,
} from "./platform-account.js";
import {
  serializeTurn,
  type ConversationMessage,
} from "./grant-conversation-service.js";

/** What the operator route records on the grant: the public approval. */
export interface PlatformApproval {
  /** The merged pull request that approved the money. */
  approval_url: string;
  /** Who merged it (a GitHub login, or the operator's name). */
  approved_by: string;
  /** SHA-256 of the draft's canonical JSON, as the approval pinned it. */
  mandate_sha256: string;
  budget_owls: number;
  conversation_id: string;
  funded_at: string;
}

export type PlatformFundResult =
  | { ok: true; grantId: string; alreadyFunded: boolean }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "NOT_PROPOSED"
        | "DRAFT_CHANGED"
        | "BUDGET_BELOW_QUOTE"
        | "BAD_APPROVAL";
      message: string;
    };

/**
 * Fund a platform conversation's drafted mandate under a public approval:
 * buy the budget in owls at cost, escrow it, and create the grant
 * (is_platform, with the approval recorded), in one transaction.
 */
export async function fundPlatformConversation(input: {
  conversationId: string;
  budgetOwls: number;
  mandateSha256: string;
  approvalUrl: string;
  approvedBy: string;
}): Promise<PlatformFundResult> {
  const approvalUrl = input.approvalUrl.trim();
  const approvedBy = input.approvedBy.trim();
  if (!/^https:\/\/\S+$/.test(approvalUrl) || !approvedBy) {
    return {
      ok: false,
      code: "BAD_APPROVAL",
      message:
        "A platform mandate is funded under a public approval: give its https URL and who approved it",
    };
  }
  const platformId = await getPlatformAccountId();

  return withTransaction(async (tx) => {
    const [convo] = await tx.query<{
      id: string;
      user_id: string;
      status: string;
      mandate: GrantMandate | null;
      grant_id: string | null;
    }>(
      `SELECT id, user_id, status, mandate, grant_id
         FROM grant_conversations WHERE id = $1 FOR UPDATE`,
      [input.conversationId]
    );
    if (!convo || convo.user_id !== platformId) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: "No platform granting conversation has that id",
      };
    }
    // Idempotent: the workflow runs after every deploy and calls this for
    // every request file; one already funded is a no-op, never a second
    // purchase.
    if (convo.status === "funded" && convo.grant_id) {
      return { ok: true as const, grantId: convo.grant_id, alreadyFunded: true };
    }
    const mandate = convo.mandate;
    if (convo.status !== "proposed" || !mandate) {
      return {
        ok: false as const,
        code: "NOT_PROPOSED" as const,
        message:
          `The conversation is ${convo.status}, not proposed: there is no ` +
          `standing draft to fund (a declined or withdrawn draft cannot be)`,
      };
    }
    const hash = mandateDraftHash(mandate);
    if (hash !== input.mandateSha256) {
      return {
        ok: false as const,
        code: "DRAFT_CHANGED" as const,
        message:
          "The Grantmaker's draft no longer matches the one the approval " +
          `pinned (now ${hash}); the approval has to be redone for the new draft`,
      };
    }
    if (input.budgetOwls < mandate.expected_cost_owls) {
      return {
        ok: false as const,
        code: "BUDGET_BELOW_QUOTE" as const,
        message:
          `The draft is quoted at ${mandate.expected_cost_owls} owls; the ` +
          `approval must cover at least that (unspent budget refunds)`,
      };
    }

    const budgetMicro = owlsToMicroUsd(input.budgetOwls);
    // The platform buys its owls at cost, the same entry the seed writes
    // for the standing mandates, keyed to the conversation so a retry can
    // never buy twice.
    await tx.query(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
       VALUES ($1, $2, 'admin_adjust', $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [platformId, budgetMicro, `platform_mandate_buy:${convo.id}`]
    );
    const [job] = await tx.query<{ id: string }>(
      `INSERT INTO budget_jobs (user_id, kind, claim_id, budget_micro_usd, status)
       VALUES ($1, 'grant', $2, $3, 'running')
       RETURNING id`,
      [platformId, mandate.scope_claim_id ?? null, budgetMicro]
    );
    await tx.query(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
       VALUES ($1, $2, 'escrow_hold', $3, $4)`,
      [platformId, -budgetMicro, job!.id, `platform_mandate_hold:${convo.id}`]
    );

    const approval: PlatformApproval = {
      approval_url: approvalUrl,
      approved_by: approvedBy,
      mandate_sha256: hash,
      budget_owls: input.budgetOwls,
      conversation_id: convo.id,
      funded_at: new Date().toISOString(),
    };
    // The same row a person's funding writes (fundConversationMandate), plus
    // the two things that make it the platform's: is_platform and the
    // approval it was funded under.
    const [grant] = await tx.query<{ id: string }>(
      `INSERT INTO grants
         (funder_user_id, budget_job_id, name, scope_claim_id, scope_query,
          policy, status, plan, plan_cursor, mandate, skills, is_platform,
          platform_approval)
       VALUES ($1, $2, $3, $4, $5, 'agent', 'active', $6::jsonb, 0,
               $7::jsonb, $8, true, $9::jsonb)
       RETURNING id`,
      [
        platformId,
        job!.id,
        mandate.title,
        mandate.scope_claim_id ?? null,
        mandate.scope_query ?? null,
        JSON.stringify(mandate.plan),
        JSON.stringify(mandate),
        mandate.skills ?? [],
        JSON.stringify(approval),
      ]
    );
    await tx.query(
      `UPDATE grant_conversations
          SET status = 'funded', grant_id = $2, updated_at = now()
        WHERE id = $1`,
      [convo.id, grant!.id]
    );
    return { ok: true as const, grantId: grant!.id, alreadyFunded: false };
  });
}

/**
 * A platform granting conversation, readable by anyone: the transcript, the
 * standing draft exactly as stored, and the hash an approval pins. Null for
 * any conversation that is not the platform's; a person's conversations
 * stay private to them.
 */
export async function getPublicPlatformConversation(conversationId: string) {
  const [row] = await rawQuery<{
    id: string;
    status: string;
    messages: ConversationMessage[] | null;
    mandate: GrantMandate | null;
    grant_id: string | null;
    turn_started_at: Date | null;
    turn_heartbeat_at: Date | null;
    turn_error: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT gc.id, gc.status, gc.messages, gc.mandate, gc.grant_id,
            gc.turn_started_at, gc.turn_heartbeat_at, gc.turn_error,
            gc.created_at, gc.updated_at
       FROM grant_conversations gc
       JOIN contributors c ON c.id = gc.user_id
      WHERE gc.id = $1 AND c.external_id = $2`,
    [conversationId, PLATFORM_EXTERNAL_ID]
  );
  if (!row) return null;
  return {
    id: row.id,
    funder: "Minerval",
    status: row.status,
    messages: row.messages ?? [],
    draft: row.mandate,
    draft_sha256: row.mandate ? mandateDraftHash(row.mandate) : null,
    // While a turn is replying the draft may still change, and its hash with it.
    turn: serializeTurn({
      turnStartedAt: row.turn_started_at,
      turnHeartbeatAt: row.turn_heartbeat_at,
      turnError: row.turn_error,
    }),
    grant_id: row.grant_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The platform-grantmaking key: minted, listed, and revoked with the
// operator key, so holding the platform's conversation never needs a
// database session.
// ---------------------------------------------------------------------------

export async function createPlatformGrantmakingKey(name: string) {
  const platformId = await getPlatformAccountId();
  return createApiKey({
    userId: platformId,
    name,
    scope: PLATFORM_GRANTMAKING_SCOPE,
  });
}

export async function listPlatformGrantmakingKeys() {
  const platformId = await getPlatformAccountId();
  const keys = await listApiKeys(platformId);
  return keys.filter((k) => k.scope === PLATFORM_GRANTMAKING_SCOPE);
}

/** Revoke one platform-grantmaking key; null when no such live key exists. */
export async function revokePlatformGrantmakingKey(keyId: string) {
  const live = await listPlatformGrantmakingKeys();
  if (!live.some((k) => k.id === keyId)) return null;
  const platformId = await getPlatformAccountId();
  return revokeApiKey(platformId, keyId);
}
