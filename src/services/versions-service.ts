/**
 * The versions this deployment has run (docs/releases.md, "The deployment
 * records what it has run").
 *
 * versions_run has one row for each version the API has started as, with
 * when it first and last did. It is written at start. It is how the
 * deployment says "upgraded from 0.4.1 on 3 March", and which releases'
 * notes lie between the version it ran before and the one it runs now.
 *
 * The table carries no label and holds nothing of the deployment's
 * material. It is written and read on the owner's connection, because the
 * start that writes it has no reader's clearance and Health reads it for
 * the whole deployment.
 */
import { rawQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { compareVersions, isDevVersion, releaseOf, runningVersion, type RunningVersion } from "../version.js";

const VERSIONS_REASON =
  "The record of which versions of the software this deployment has run is the deployment's own: it carries no label and names no row of the graph.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(VERSIONS_REASON, fn);

export interface VersionRun {
  version: string;
  commit: string | null;
  first_started_at: string;
  last_started_at: string;
}

interface Row {
  version: string;
  commit: string | null;
  first_started_at: Date;
  last_started_at: Date;
}

/** Record that the API started as this version: a new row the first time, the last start's time after that. */
export async function recordVersionStarted(running: RunningVersion = runningVersion()): Promise<void> {
  await asOwner(() =>
    rawQuery(
      `INSERT INTO versions_run (version, commit) VALUES ($1, $2)
       ON CONFLICT (version) DO UPDATE SET last_started_at = now(), commit = COALESCE(EXCLUDED.commit, versions_run.commit)`,
      [running.version, running.commit]
    )
  );
}

/** Every version the API has started as, the one first started most recently first. */
export async function versionsRun(): Promise<VersionRun[]> {
  const rows = await asOwner(() =>
    rawQuery<Row>(
      `SELECT version, commit, first_started_at, last_started_at FROM versions_run ORDER BY first_started_at DESC, version DESC`
    )
  );
  return rows.map((r) => ({
    version: r.version,
    commit: r.commit,
    first_started_at: r.first_started_at.toISOString(),
    last_started_at: r.last_started_at.toISOString(),
  }));
}

export interface UpgradeFacts {
  /** The version running now, and when the API first started as it; null where that was not recorded. */
  running: RunningVersion & { since: string | null };
  /**
   * The version this deployment ran before the one it runs now: the release
   * most recently started before it that is another release. Null for a
   * deployment that has only ever run this one.
   */
  before: { version: string; until: string } | null;
}

/**
 * What the deployment runs and what it ran before. Builds of `main` of one
 * release-to-be are one version for this purpose: a deployment that follows
 * `main` did not upgrade each time it rebuilt.
 */
export function upgradeFacts(running: RunningVersion, runs: readonly VersionRun[]): UpgradeFacts {
  const mine = releaseOf(running.version);
  const same = (v: string) => releaseOf(v) === mine && isDevVersion(v) === isDevVersion(running.version);
  const ofThis = runs.filter((r) => same(r.version));
  const since = ofThis.length > 0 ? ofThis.map((r) => r.first_started_at).sort()[0]! : null;
  const earlier = runs
    .filter((r) => !same(r.version) && (since === null || r.first_started_at < since))
    .sort((a, b) => (a.first_started_at < b.first_started_at ? 1 : -1))[0];
  return {
    running: { ...running, since },
    before: earlier ? { version: earlier.version, until: since ?? earlier.last_started_at } : null,
  };
}

/** Whether `version` lies after `from` and at or before `to`, as releases: the releases an upgrade passed through. */
export function passedThrough(version: string, from: string | null, to: string): boolean {
  if (compareVersions(version, releaseOf(to)) > 0) return false;
  return from === null ? true : compareVersions(version, releaseOf(from)) > (isDevVersion(from) ? -1 : 0);
}
