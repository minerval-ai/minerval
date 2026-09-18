/**
 * Replay emission for the adversarial drivers (S4), behind a shim.
 *
 * The replay module (scripts/corpus/replay.ts: collectArm / assembleReplay /
 * writeReplay over scripts/corpus/replay-types.ts) was built in parallel
 * with this suite; this file keeps the slice of its contract the drivers
 * need and turns any failure into a warning: a run never loses its report
 * because the replay could not be written.
 *
 * Contract relied on:
 *   collectArm({ databaseUrl?, since, until?, key, label, variation,
 *                fingerprint, database?, capped? }): Promise<ReplayArm>
 *   assembleReplay({ kind, name, title, cluster, about, arms, matching?,
 *                    scenario?, summary?, evalRunId? }): Replay
 *   writeReplay(runDir, replay): string
 */

import * as replayModule from "./replay.js";

export interface ReplayFingerprint {
  pipelineEpoch: string | null;
  gitCommit: string | null;
  profile: string | null;
  swap: { agent: string; model: string } | null;
  order: string | null;
  models: Record<string, string | undefined>;
  caps: Record<string, number>;
}

/** Opaque here: whatever collectArm returns is handed back to assembleReplay untouched. */
export interface ReplayArm {
  key: string;
  label: string;
  [k: string]: unknown;
}

export interface ReplayScenario {
  name: string;
  description: string | null;
  actors: Array<{ key: string; displayName: string; note?: string | null; tier?: string | null; role?: "attacker" | "benign" | "persona" | null }>;
  targets?: Array<{ key: string; claimId: string | null; text: string | null; direction?: "up" | "down" | null }>;
}

export interface ReplayMatching {
  armA: string;
  armB: string;
  pairs: Array<{ a: string; b: string; method: string; similarity: number | null }>;
  unmatchedA: string[];
  unmatchedB: string[];
  summary: {
    claimSetF1: number | null;
    credenceMeanAbsDiff: number | null;
    statusAgreement: number | null;
    edgeEditDistance: number | null;
  } | null;
}

export interface CollectArmArgs {
  databaseUrl?: string;
  since: Date;
  until?: Date;
  key: string;
  label: string;
  variation: string | null;
  fingerprint: ReplayFingerprint;
  database?: string | null;
  capped?: boolean;
}

export interface AssembleReplayArgs {
  kind: "ingest" | "property" | "swap" | "contributions" | "adversarial" | string;
  name: string;
  title: string;
  cluster: string | null;
  about: string;
  arms: ReplayArm[];
  matching?: ReplayMatching[] | null;
  scenario?: ReplayScenario | null;
  summary?: Record<string, unknown> | null;
  evalRunId?: string | null;
}

interface ReplayModule {
  collectArm: (args: CollectArmArgs) => Promise<ReplayArm>;
  assembleReplay: (args: AssembleReplayArgs) => unknown;
  writeReplay: (runDir: string, replay: unknown) => string;
}

// replay.ts landed beside this shim; the guarded dynamic import it was
// written against is now a plain import, and the try/catch wrappers below
// remain the failure policy (a run never loses its report over a replay).
async function loadReplayModule(): Promise<ReplayModule | null> {
  return replayModule as unknown as ReplayModule;
}

/** Collect one arm's events from the trace substrate; null (with a warning) when it cannot. */
export async function tryCollectArm(args: CollectArmArgs): Promise<ReplayArm | null> {
  const mod = await loadReplayModule();
  if (!mod) return null;
  try {
    return await mod.collectArm(args);
  } catch (err) {
    console.warn(`[replay] collectArm(${args.key}) failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Stamp `arm` and `gambit` onto the arm's contribution_submitted deltas
 * (replay-types: `{ op: "contribution_submitted", contributionId, …, arm?,
 * gambit? }`), which collectArm cannot know from the database alone. Walks
 * the opaque structure defensively; a shape it does not recognise is left
 * untouched.
 */
export function annotateContributionDeltas(arm: ReplayArm, armKey: string, gambitByContributionId: Map<string, string | null>): void {
  const events = (arm as { events?: unknown }).events;
  if (!Array.isArray(events)) return;
  for (const ev of events) {
    const deltas = (ev as { deltas?: unknown })?.deltas;
    if (!Array.isArray(deltas)) continue;
    for (const d of deltas) {
      if (d && typeof d === "object" && (d as { op?: unknown }).op === "contribution_submitted") {
        const delta = d as { contributionId?: string; arm?: string | null; gambit?: string | null };
        delta.arm = armKey;
        if (delta.contributionId && gambitByContributionId.has(delta.contributionId)) {
          delta.gambit = gambitByContributionId.get(delta.contributionId) ?? null;
        }
      }
    }
  }
}

/** Assemble and write the replay into runDir; the written path, or null. */
export async function tryWriteReplay(runDir: string, args: AssembleReplayArgs): Promise<string | null> {
  const mod = await loadReplayModule();
  if (!mod) return null;
  if (args.arms.length === 0) {
    console.warn("[replay] no arms were collected; no replay written.");
    return null;
  }
  try {
    const replay = mod.assembleReplay(args);
    return mod.writeReplay(runDir, replay);
  } catch (err) {
    console.warn(`[replay] writing the replay failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
