/**
 * Today's date, told to every model call that has a system prompt (#771).
 *
 * Constitution §9: "the admin knows today's date and reads every source
 * against the world as it now stands". Only the Claim Steward's task
 * message carried it, so the Researcher dating sources, the Lookout judging
 * what is a recent retraction, the Checker flagging a stale premise and the
 * Extractor reading "next year" all worked from the model's training-time
 * sense of now.
 *
 * It is added at the LLM seam (client.ts), the one path every agent's call
 * takes, rather than in each agent or in buildAdminPrompt: the admin prompt
 * is rendered into the site's role pages, which would change every day, and
 * some prompts are built once per process, which would carry yesterday's
 * date. It goes at the end of the last system block, so the cached prefix
 * before it (the constitution, the role) is untouched, and it is computed
 * once per call or per loop, so a run's prompt stays the same across its
 * turns.
 */
import type { SystemPrompt } from "./providers/types.js";

/** The line itself, in UTC, matching how the graph dates everything else. */
export function runDateLine(now: Date = new Date()): string {
  return (
    `Today's date is ${now.toISOString().slice(0, 10)} (UTC). Read every source ` +
    `and claim against the world as it stands on this date, not as of your training.`
  );
}

const DATED = /\n\nToday's date is \d{4}-\d{2}-\d{2} \(UTC\)\. [^\n]*$/;

/**
 * `system` with the date line after its last non-empty block. Idempotent, so
 * a loop that dates its prompt and then calls completeWithTools with it does
 * not date it twice. No system prompt, no date: a bare call has no admin.
 */
export function withRunDate(
  system: SystemPrompt | undefined,
  now: Date = new Date()
): SystemPrompt | undefined {
  if (system === undefined) return undefined;
  const blocks = typeof system === "string" ? [system] : [...system];
  let last = blocks.length - 1;
  while (last >= 0 && blocks[last]!.length === 0) last--;
  if (last < 0 || DATED.test(blocks[last]!)) return system;
  blocks[last] = `${blocks[last]}\n\n${runDateLine(now)}`;
  return typeof system === "string" ? blocks[0]! : blocks;
}
