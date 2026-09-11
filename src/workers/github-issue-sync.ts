/**
 * GitHub issue sync (#366): the backlog filer for agent reports.
 *
 * raiseIssue() files a report's issue on first sighting, off the caller's
 * path. This worker is what makes that eventually complete: on each tick it
 * takes the open reports that have no issue yet — everything raised before
 * the sync existed, and any filing that failed at raise time (GitHub down,
 * a rate limit, a bad token) — and files them, oldest first, at most
 * GITHUB_ISSUES_BACKFILL_PER_TICK per tick so the first run after a deploy
 * is a bounded burst rather than a storm at GitHub's content-creation
 * limits.
 *
 * Idempotent through the row: fileIssueForReport records the issue number
 * only where none is recorded yet, so two API tasks ticking at once can at
 * worst file one duplicate for a report, never a run of them. Off unless
 * the sync is configured; a tick with nothing pending costs one indexed
 * read.
 */
import { loadConfig } from "../config.js";
import {
  fileIssueForReport,
  githubIssuesConfigured,
} from "../services/github-issue-service.js";
import { listReportsAwaitingIssue } from "../services/report-service.js";

export interface GithubIssueSyncTickResult {
  pending: number;
  filed: number;
  failed: number;
}

/** One sync pass; exported separately so tests can drive it. */
export async function githubIssueSyncTick(): Promise<GithubIssueSyncTickResult> {
  const config = loadConfig();
  const result: GithubIssueSyncTickResult = { pending: 0, filed: 0, failed: 0 };
  if (!githubIssuesConfigured() || config.githubIssuesBackfillPerTick <= 0) {
    return result;
  }
  const rows = await listReportsAwaitingIssue(config.githubIssuesBackfillPerTick, {
    includeExternal: config.githubIssuesIncludeExternal,
  });
  result.pending = rows.length;
  for (const row of rows) {
    const ref = await fileIssueForReport(row);
    if (ref) result.filed++;
    else result.failed++;
  }
  return result;
}

/**
 * Run the sync on an interval. A tick that finds nothing is silent; one
 * that files something says so, and one that failed everything it tried
 * says that too, since it will keep retrying the same rows.
 */
export function startGithubIssueSync(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  if (!githubIssuesConfigured() || config.githubIssuesBackfillPerTick <= 0) {
    options.logger.info(
      "GitHub issue sync not configured (GITHUB_TOKEN + GITHUB_ISSUES_REPO); agent reports stay in agent_reports"
    );
    return { stop: () => {} };
  }
  const interval =
    options.intervalMs ?? Math.max(30, config.githubIssuesSyncIntervalSeconds) * 1000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await githubIssueSyncTick();
      if (result.pending > 0) {
        options.logger.info(
          `GitHub issue sync: ${result.filed} filed, ${result.failed} failed ` +
            `of ${result.pending} pending report(s)`
        );
      }
    } catch (err) {
      options.logger.error(
        "GitHub issue sync error",
        err instanceof Error ? err.message : err
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info(
    `GitHub issue sync started (${config.githubIssuesRepo}, ` +
      `${config.githubIssuesBackfillPerTick}/tick)`
  );

  return { stop: () => clearInterval(timer) };
}
