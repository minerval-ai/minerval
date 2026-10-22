/**
 * Platform mandates through the Grantmaker (#529), against real Postgres:
 * the operator route's funding transaction (buy at cost, escrow, grant with
 * the approval recorded), its refusals (a revised draft, a person's
 * conversation, a quote the budget doesn't cover), its idempotency, the
 * refusal of the platform on the person's /fund path, and the public read
 * that serves the platform's conversations and nobody else's.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import {
  fundPlatformConversation,
  getPublicPlatformConversation,
  createPlatformGrantmakingKey,
  listPlatformGrantmakingKeys,
  revokePlatformGrantmakingKey,
} from "../../src/services/platform-mandate-service.js";
import { fundConversationMandate } from "../../src/services/grant-conversation-service.js";
import { getPlatformAccountId } from "../../src/services/platform-account.js";
import { mandateDraftHash } from "../../src/services/mandate-draft-hash.js";
import { resolveApiKey } from "../../src/services/api-key-service.js";
import { seedUser, creditOwls, owlBalance, OWL } from "./helpers.js";

function draft(label: string, quote = 40) {
  return {
    title: `Platform mandate ${label}`,
    objective: `Assess the claims under ${label}.`,
    plan: { strategy: "Breadth first.", items: [{ action: "assess", rationale: "the root" }] },
    expected_cost_owls: quote,
    notes: "An estimate.",
  };
}

async function seedConversation(
  userId: string,
  mandate: ReturnType<typeof draft> | null,
  status = "proposed"
): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO grant_conversations (user_id, status, messages, mandate)
     VALUES ($1, $2, $3::jsonb, $4::jsonb) RETURNING id`,
    [
      userId,
      status,
      JSON.stringify([
        { role: "user", content: "Fund this.", at: new Date().toISOString() },
        { role: "assistant", content: "Here is a draft.", at: new Date().toISOString() },
      ]),
      mandate ? JSON.stringify(mandate) : null,
    ]
  );
  return rows[0]!.id;
}

const approval = {
  approvalUrl: "https://github.com/minerval-ai/minerval/pull/1",
  approvedBy: "jacksonqueenking",
};

describe("fundPlatformConversation", () => {
  it("buys the budget at cost, escrows it, and creates a platform grant carrying the approval", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("funded");
    const convoId = await seedConversation(platform, d);
    const before = await owlBalance(platform);

    const res = await fundPlatformConversation({
      conversationId: convoId,
      budgetOwls: 50,
      mandateSha256: mandateDraftHash(d),
      ...approval,
    });
    expect(res).toMatchObject({ ok: true, alreadyFunded: false });
    if (!res.ok) return;

    // Bought and escrowed in the same breath: the free balance is unchanged.
    expect(await owlBalance(platform)).toBe(before);
    const ledger = await rawQuery<{ reason: string; amount_micro_usd: string; idempotency_key: string }>(
      `SELECT reason, amount_micro_usd, idempotency_key FROM owl_ledger
        WHERE idempotency_key IN ($1, $2) ORDER BY reason`,
      [`platform_mandate_buy:${convoId}`, `platform_mandate_hold:${convoId}`]
    );
    expect(ledger.map((r) => [r.reason, Number(r.amount_micro_usd)])).toEqual([
      ["admin_adjust", 50 * OWL],
      ["escrow_hold", -50 * OWL],
    ]);

    const [grant] = await rawQuery<{
      funder_user_id: string;
      is_platform: boolean;
      policy: string;
      status: string;
      name: string;
      mandate: unknown;
      platform_approval: Record<string, unknown>;
      budget_micro_usd: string;
    }>(
      `SELECT g.funder_user_id, g.is_platform, g.policy, g.status, g.name, g.mandate,
              g.platform_approval, j.budget_micro_usd
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
        WHERE g.id = $1`,
      [res.grantId]
    );
    expect(grant).toMatchObject({
      funder_user_id: platform,
      is_platform: true,
      policy: "agent",
      status: "active",
      name: d.title,
    });
    expect(Number(grant!.budget_micro_usd)).toBe(50 * OWL);
    expect(grant!.mandate).toEqual(d);
    expect(grant!.platform_approval).toMatchObject({
      approval_url: approval.approvalUrl,
      approved_by: approval.approvedBy,
      mandate_sha256: mandateDraftHash(d),
      budget_owls: 50,
      conversation_id: convoId,
    });

    const [convo] = await rawQuery<{ status: string; grant_id: string }>(
      `SELECT status, grant_id FROM grant_conversations WHERE id = $1`,
      [convoId]
    );
    expect(convo).toEqual({ status: "funded", grant_id: res.grantId });
  });

  it("is idempotent: a second call returns the same grant and buys nothing", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("idempotent");
    const convoId = await seedConversation(platform, d);
    const input = { conversationId: convoId, budgetOwls: 40, mandateSha256: mandateDraftHash(d), ...approval };

    const first = await fundPlatformConversation(input);
    const second = await fundPlatformConversation(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second).toEqual({ ok: true, grantId: first.grantId, alreadyFunded: true });
    const buys = await rawQuery(
      `SELECT 1 FROM owl_ledger WHERE idempotency_key = $1`,
      [`platform_mandate_buy:${convoId}`]
    );
    expect(buys).toHaveLength(1);
    const grants = await rawQuery(`SELECT 1 FROM grants WHERE platform_approval->>'conversation_id' = $1`, [convoId]);
    expect(grants).toHaveLength(1);
  });

  it("serializes racing calls on the conversation row: one grant, one purchase", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("race");
    const convoId = await seedConversation(platform, d);
    const input = { conversationId: convoId, budgetOwls: 40, mandateSha256: mandateDraftHash(d), ...approval };
    const results = await Promise.all([fundPlatformConversation(input), fundPlatformConversation(input)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.alreadyFunded)).toHaveLength(1);
    const grants = await rawQuery(`SELECT 1 FROM grants WHERE platform_approval->>'conversation_id' = $1`, [convoId]);
    expect(grants).toHaveLength(1);
  });

  it("refuses a draft revised after the approval pinned it, and writes nothing", async () => {
    const platform = await getPlatformAccountId();
    const pinned = draft("revised");
    const convoId = await seedConversation(platform, { ...pinned, expected_cost_owls: 45 });
    const before = await owlBalance(platform);
    const res = await fundPlatformConversation({
      conversationId: convoId,
      budgetOwls: 50,
      mandateSha256: mandateDraftHash(pinned),
      ...approval,
    });
    expect(res).toMatchObject({ ok: false, code: "DRAFT_CHANGED" });
    expect(await owlBalance(platform)).toBe(before);
    const ledger = await rawQuery(`SELECT 1 FROM owl_ledger WHERE idempotency_key LIKE $1`, [`%:${convoId}`]);
    expect(ledger).toHaveLength(0);
  });

  it("refuses a budget below the Grantmaker's quote", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("below-quote", 60);
    const convoId = await seedConversation(platform, d);
    const res = await fundPlatformConversation({ conversationId: convoId, budgetOwls: 50, mandateSha256: mandateDraftHash(d), ...approval });
    expect(res).toMatchObject({ ok: false, code: "BUDGET_BELOW_QUOTE" });
  });

  it("refuses a declined conversation, whatever its stored draft", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("declined");
    const convoId = await seedConversation(platform, d, "declined");
    const res = await fundPlatformConversation({ conversationId: convoId, budgetOwls: 50, mandateSha256: mandateDraftHash(d), ...approval });
    expect(res).toMatchObject({ ok: false, code: "NOT_PROPOSED" });
  });

  it("refuses a person's conversation: the operator route funds only the platform's", async () => {
    const person = await seedUser("not-platform");
    const d = draft("person");
    const convoId = await seedConversation(person, d);
    const res = await fundPlatformConversation({ conversationId: convoId, budgetOwls: 50, mandateSha256: mandateDraftHash(d), ...approval });
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses funding without a public approval", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("no-approval");
    const convoId = await seedConversation(platform, d);
    const res = await fundPlatformConversation({
      conversationId: convoId,
      budgetOwls: 50,
      mandateSha256: mandateDraftHash(d),
      approvalUrl: "not a url",
      approvedBy: "",
    });
    expect(res).toMatchObject({ ok: false, code: "BAD_APPROVAL" });
  });
});

describe("the person's /fund path", () => {
  it("refuses the platform account, even with owls in its balance", async () => {
    const platform = await getPlatformAccountId();
    await creditOwls(platform, 100 * OWL);
    const convoId = await seedConversation(platform, draft("user-path"));
    const res = await fundConversationMandate({ conversationId: convoId, userId: platform, budgetOwls: 50 });
    expect(res).toMatchObject({ ok: false, code: "PLATFORM_FUNDS_BY_APPROVAL" });
    const [convo] = await rawQuery<{ status: string }>(`SELECT status FROM grant_conversations WHERE id = $1`, [convoId]);
    expect(convo!.status).toBe("proposed");
  });

  it("still funds a person's conversation", async () => {
    const person = await seedUser("person-funds");
    await creditOwls(person, 100 * OWL);
    const convoId = await seedConversation(person, draft("person-path"));
    const res = await fundConversationMandate({ conversationId: convoId, userId: person, budgetOwls: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [grant] = await rawQuery<{ is_platform: boolean; platform_approval: unknown }>(
      `SELECT is_platform, platform_approval FROM grants WHERE id = $1`,
      [res.grantId]
    );
    expect(grant).toEqual({ is_platform: false, platform_approval: null });
  });
});

describe("getPublicPlatformConversation", () => {
  it("serves the platform's conversation with its draft and hash", async () => {
    const platform = await getPlatformAccountId();
    const d = draft("public");
    const convoId = await seedConversation(platform, d);
    const convo = await getPublicPlatformConversation(convoId);
    expect(convo).toMatchObject({
      id: convoId,
      funder: "Minerval",
      status: "proposed",
      draft: d,
      draft_sha256: mandateDraftHash(d),
    });
    expect(convo!.messages).toHaveLength(2);
  });

  it("never serves a person's conversation", async () => {
    const person = await seedUser("private-convo");
    const convoId = await seedConversation(person, draft("private"));
    expect(await getPublicPlatformConversation(convoId)).toBeNull();
  });
});

describe("platform-grantmaking keys", () => {
  it("resolve to the platform account with the narrow scope, and revoke", async () => {
    const platform = await getPlatformAccountId();
    const created = await createPlatformGrantmakingKey("agent session");
    const resolved = await resolveApiKey(created.plaintext);
    expect(resolved?.user.id).toBe(platform);
    expect(resolved?.key.scope).toBe("platform_grantmaking");
    expect((await listPlatformGrantmakingKeys()).map((k) => k.id)).toContain(created.key.id);

    expect(await revokePlatformGrantmakingKey(created.key.id)).not.toBeNull();
    expect(await resolveApiKey(created.plaintext)).toBeNull();
    expect(await revokePlatformGrantmakingKey(created.key.id)).toBeNull();
  });
});
