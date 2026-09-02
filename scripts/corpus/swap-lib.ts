/**
 * Model-swap runner, the pure half (#334 L1 driver; substrate for S7's
 * fidelity-vs-reference and #295's model-convergence).
 *
 * A swap is two arms of the same cluster: A on the current configuration
 * (the reference — with --profile=production, what production runs), B
 * identical except that ONE agent runs a different model. Each arm is a
 * child corpus:run in its own process, because config caches on first
 * read and the override has to be in the environment before that; each
 * arm is snapshotted; the two snapshots are compared with corpus:agreement.
 * What comes back is fidelity: how close the cheaper (or newer) model's
 * graph is to the reference on claim set, credence and structure — the
 * per-agent tiering data allocation is waiting on (§6).
 */
import type { AgreementReport } from "./graph-agreement.js";
import type { ScorecardConfig } from "./fingerprint.js";

export const SWAPPABLE_AGENTS = {
  extractor: "EXTRACTOR_MODEL",
  matcher: "MATCHER_MODEL",
  steward: "STEWARD_MODEL",
  curator: "CURATOR_MODEL",
} as const;
export type SwappableAgent = keyof typeof SWAPPABLE_AGENTS;

export function envVarFor(agent: string): string {
  const v = (SWAPPABLE_AGENTS as Record<string, string>)[agent];
  if (!v) {
    throw new Error(
      `Unknown agent "${agent}"; swappable: ${Object.keys(SWAPPABLE_AGENTS).join(", ")}`
    );
  }
  return v;
}

/**
 * Snapshot names for the two arms, from a timestamp: its first twelve
 * digits (YYYYMMDDHHMM), within snapshot-core's [a-z0-9_]{1,40}.
 */
export function armSnapshotNames(stamp: string): { a: string; b: string } {
  const s = stamp.replace(/[^0-9]/g, "").slice(0, 12);
  return { a: `swap_${s}_a`, b: `swap_${s}_b` };
}

export interface ArmCommand {
  arm: "a" | "b";
  /** Arguments to scripts/corpus/run.ts. */
  args: string[];
  /** Environment overrides on top of the parent's. */
  env: Record<string, string>;
}

export function buildArmCommands(opts: {
  cluster: string;
  agent: SwappableAgent;
  model: string;
  profile?: string | null;
  limit?: number;
  posts?: string[];
  /** Skip arm A: an existing snapshot is the reference. */
  baselineSnapshot?: string | null;
}): ArmCommand[] {
  const common = [opts.cluster];
  if (opts.profile) common.push(`--profile=${opts.profile}`);
  if (opts.limit !== undefined) common.push(`--limit=${opts.limit}`);
  if (opts.posts && opts.posts.length > 0) common.push(`--posts=${opts.posts.join(",")}`);
  const arms: ArmCommand[] = [];
  if (!opts.baselineSnapshot) arms.push({ arm: "a", args: [...common], env: {} });
  // lib.ts applies --profile at import and would override a plain env
  // override, so the swap is an explicit flag the run honours AFTER the
  // profile; the env var is set too, for anything outside config that
  // reads it.
  arms.push({
    arm: "b",
    args: [...common, `--swap=${opts.agent}:${opts.model}`],
    env: { [envVarFor(opts.agent)]: opts.model },
  });
  return arms;
}

export interface ArmRecord {
  cluster: string;
  registryId: string | null;
  startedAt: string;
  finishedAt: string;
  postsIngested: number;
  capped: boolean;
  costMicroUsd?: number;
  models: ScorecardConfig["models"] | Omit<ScorecardConfig["models"], "judge">;
  observed?: Record<string, string[]>;
  profile?: string | null;
  gitCommit?: string | null;
  pipelineEpoch?: string;
}

export interface SwapSummary {
  cluster: string;
  agent: SwappableAgent;
  referenceModel: string;
  swapModel: string;
  /** What each arm actually ran the swapped agent on, per llm_usage. */
  observed: { a: string[]; b: string[] };
  claimSetF1: number | null;
  credenceMeanAbsDiff: number | null;
  statusAgreement: number | null;
  edgeEditDistance: number;
  cost: { a: number | null; b: number | null };
  capped: { a: boolean; b: boolean };
}

export function summarizeSwap(input: {
  cluster: string;
  agent: SwappableAgent;
  swapModel: string;
  armA: ArmRecord | null;
  armB: ArmRecord;
  agreement: AgreementReport;
}): SwapSummary {
  const { agent, armA, armB, agreement } = input;
  const observedA = armA?.observed?.[agent] ?? [];
  const observedB = armB.observed?.[agent] ?? [];
  const referenceModel =
    observedA[0] ?? (armA?.models as Record<string, string> | undefined)?.[agent] ?? "unknown";
  return {
    cluster: input.cluster,
    agent,
    referenceModel,
    swapModel: input.swapModel,
    observed: { a: observedA, b: observedB },
    claimSetF1: agreement.claimSet.f1,
    credenceMeanAbsDiff: agreement.credence.meanAbsDiff,
    statusAgreement: agreement.credence.statusAgreement,
    edgeEditDistance: agreement.structure.editDistance,
    cost: { a: armA?.costMicroUsd ?? null, b: armB.costMicroUsd ?? null },
    capped: { a: armA?.capped ?? false, b: armB.capped },
  };
}
