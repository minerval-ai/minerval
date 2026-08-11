/**
 * Curator pipeline worker.
 * Thin wrapper that invokes the Curator agent, with a per-process run cap so
 * curation spend is bounded predictably for tests/deploys (like the Steward).
 */
import type { CuratorMessage } from "../services/queue-service.js";
import { runCurator } from "../llm/agents/curator.js";
import { loadConfig } from "../config.js";
import { runWithUsageContext } from "../llm/usage-context.js";

let curatorRunCount = 0;

/** Test-only: reset the per-process Curator run counter. */
export function resetCuratorRunCount(): void {
  curatorRunCount = 0;
}

export async function handleCuratorMessage(
  message: CuratorMessage
): Promise<void> {
  const { curatorMaxRuns } = loadConfig();
  if (curatorMaxRuns > 0 && curatorRunCount >= curatorMaxRuns) {
    return; // spend backstop reached
  }
  curatorRunCount++;

  // The queue hop is where attribution was being lost: the message arrives in
  // a fresh async context, so whatever identity the enqueuing run had is gone
  // unless the message carried it and we restore it here.
  await runWithUsageContext(
    { userId: message.userId ?? null, jobId: message.jobId ?? null },
    () =>
      runCurator({
        trigger: message.trigger,
        claimId: message.claimId,
        context: message.context,
      })
  );
}
