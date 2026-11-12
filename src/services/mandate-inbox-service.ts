/**
 * Putting work in front of a mandate's program officers: the one way
 * anything that wants a mandate's money reaches it without a run waiting on
 * the answer. What a lookout found, a curation request, an audit, a
 * consistency flag, work on a request: each is an item in the mandate's
 * inbox (mandate_inbox), which its officers decide under its operating
 * policy (program-officer.ts). Nothing here spends; it only asks.
 *
 * A repeat of an item still waiting (same mandate, same ledger row) is
 * folded into the earlier one rather than queued twice.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { currentLabel } from "../llm/usage-context.js";

export type InboxItemKind = "raised" | "outcome" | "funder_note" | "notice";

export async function raiseToMandate(input: {
  grantId: string;
  kind?: InboxItemKind;
  targetNodeId?: string | null;
  targetRef?: string | null;
  /** Who is asking, in words the officers read: a lookout's title, an agent role, 'the system'. */
  source: string;
  summary: string;
  /** Structured detail: action_id (the ledger row), a suggested budget, an expected gain… */
  detail?: Record<string, unknown>;
}): Promise<{ id: string; folded: boolean } | null> {
  const actionId = typeof input.detail?.action_id === "string" ? input.detail.action_id : null;
  if (actionId) {
    const [existing] = await rawQuery<{ id: string }>(
      `UPDATE mandate_inbox SET summary = summary || E'\\n' || $3
        WHERE id = (SELECT id FROM mandate_inbox
                     WHERE grant_id = $1 AND handled_at IS NULL AND detail->>'action_id' = $2
                     ORDER BY created_at DESC LIMIT 1)
        RETURNING id`,
      [input.grantId, actionId, input.summary.slice(0, 2000)]
    );
    if (existing) return { id: existing.id, folded: true };
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO mandate_inbox (grant_id, kind, target_node_id, target_ref, source, summary, detail, sensitivity_label)
     SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::text
      WHERE EXISTS (SELECT 1 FROM grants WHERE id = $1)
     RETURNING id`,
    [
      input.grantId,
      input.kind ?? "raised",
      input.targetNodeId ?? null,
      input.targetRef ?? null,
      input.source,
      input.summary.slice(0, 4000),
      JSON.stringify(input.detail ?? {}),
      currentLabel(),
    ]
  );
  if (!row) return null;
  if (loadConfig().officerSittingsEnabled) void sitSoon(input.grantId);
  return { id: row.id, folded: false };
}

/** Hold a sitting on the mandate's inbox in the background, when no one else holds one. */
async function sitSoon(grantId: string): Promise<void> {
  try {
    const { takeInboxLease, releaseInboxLease } = await import("./petition-service.js");
    if (!(await takeInboxLease(grantId))) return;
    try {
      const { workMandateInbox } = await import("../llm/agents/program-officer.js");
      await workMandateInbox(grantId);
    } finally {
      await releaseInboxLease(grantId);
    }
  } catch (err) {
    console.error(`[inbox] sitting for ${grantId} failed:`, err instanceof Error ? err.message : err);
  }
}
