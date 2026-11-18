/**
 * Directing the public graph is public (docs/allocation.md, "Directing the
 * public graph is public"). A granting conversation, the mandate it makes,
 * and every run that directs that mandate's money are public from the first
 * message: the Grantmaker, its planning pass and review passes, its program
 * officers, its Correspondents and Lookouts, and the Researchers it launches.
 * Their agents' inputs are classified public (run-visibility.ts).
 *
 * The conversations and mandates made before that rule were made under a
 * promise that a funder's words were private (grant_conversations.in_public,
 * grants.directed_in_public, both false on those rows, migration 0183). A
 * run that works for one of them keeps the promise: it marks itself private
 * with PRIVATE_GRANTMAKING_REASON when it opens. No other reason keeps such
 * a run from the public; information that cannot be published belongs with
 * a person's own Assistant or in a private graph, not with a Grantmaker.
 */
import { rawQuery } from "../db/client.js";
import { markCurrentRunPrivate } from "./usage-context.js";

export const PRIVATE_GRANTMAKING_REASON = "input:private-grantmaking";

/** Whether the grantmaking this run works for was promised privacy: a mandate or a conversation made before the rule. */
export async function grantmakingPromisedPrivate(ref: {
  grantId?: string | null;
  conversationId?: string | null;
}): Promise<boolean> {
  if (ref.conversationId) {
    const [row] = await rawQuery<{ in_public: boolean }>(
      `SELECT in_public FROM grant_conversations WHERE id = $1`,
      [ref.conversationId]
    );
    if (row && !row.in_public) return true;
  }
  if (ref.grantId) {
    const [row] = await rawQuery<{ directed_in_public: boolean }>(
      `SELECT directed_in_public FROM grants WHERE id = $1`,
      [ref.grantId]
    );
    if (row && !row.directed_in_public) return true;
  }
  return false;
}

/**
 * Mark the run open now private when the grantmaking it works for was
 * promised privacy. Call it as the run opens, before it reads anything.
 */
export async function keepGrantmakingPromise(ref: {
  grantId?: string | null;
  conversationId?: string | null;
}): Promise<void> {
  if (await grantmakingPromisedPrivate(ref)) markCurrentRunPrivate(PRIVATE_GRANTMAKING_REASON);
}
