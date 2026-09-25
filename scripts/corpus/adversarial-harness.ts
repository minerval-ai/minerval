/**
 * The DB-touching helpers the adversarial drivers share (corpus:adversarial,
 * corpus:redteam): restore the baseline between arms, read a target's
 * before/after state, the reassessments that landed on it, the holistic
 * top-level view for the graph-level judge, whole-graph agreement against
 * the baseline snapshot, the run fingerprint, and the judge calls
 * themselves. Assumes lib.ts has pinned DATABASE_URL to the corpus DB.
 */
import { closeDb, rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { completeStructured } from "../../src/llm/client.js";
import { withAgent, withCostMeter } from "../../src/llm/usage-context.js";
import { OPENROUTER_MODELS } from "../../src/llm/models.js";
import { CORPUS_DATABASE_URL, CORPUS_PROFILE, gitCommit } from "./lib.js";
import { restoreSnapshot, saveSnapshot } from "./snapshot-core.js";
import { buildMatching, graphAgreement, type AgreementGraph, type AgreementReport, type MatchedPair } from "./graph-agreement.js";
import { loadAgreementGraph, snapshotUrl } from "./graph-load.js";
import {
  BLIND_JUDGE_SCHEMA,
  HOLISTIC_JUDGE_SCHEMA,
  blindJudgePrompt,
  holisticJudgePrompt,
  type BlindJudgeVerdict,
  type HolisticClaim,
  type HolisticJudgeVerdict,
  type JudgedAssessment,
} from "./adversarial-prompts.js";
import type { ClaimState, Reassessment } from "./adversarial-lib.js";
import type { ReplayFingerprint } from "./replay-emit.js";

/** The attacker's model: REDTEAM_MODEL, else the cheap OpenRouter flash pin. */
export function redteamModel(): string {
  return process.env.REDTEAM_MODEL?.trim() || OPENROUTER_MODELS.flash;
}

/**
 * Replace the corpus DB with the baseline snapshot. The pool is closed first
 * (restore force-terminates every connection to the database, and a pool
 * holding dead clients would fail its next query); getDb() reopens lazily.
 */
export async function restoreBaseline(name: string): Promise<void> {
  await closeDb();
  await restoreSnapshot(CORPUS_DATABASE_URL, name);
}

export async function snapshotArm(name: string): Promise<string> {
  await closeDb();
  return saveSnapshot(CORPUS_DATABASE_URL, name);
}

/** Snapshot names are [a-z0-9_]{1,40}: adv_<stamp12>_<target≤12>_<arm≤6>. */
export function armSnapshotName(prefix: string, stamp: string, target: string, arm: string): string {
  const s = stamp.replace(/[^0-9]/g, "").slice(0, 12);
  const t = target.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "t";
  const a = arm.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "arm";
  return `${prefix}_${s}_${t}_${a}`.slice(0, 40);
}

export async function readClaimState(id: string): Promise<ClaimState | null> {
  const [row] = await rawQuery<{
    id: string;
    text: string;
    importance: number;
    status: string | null;
    credence: number | null;
    confidence: number | null;
    summary: string | null;
    reasoning_trace: string | null;
    assessed_at: Date | null;
  }>(
    `SELECT c.id, c.text, c.importance, a.status, a.claim_credence AS credence, a.confidence,
            a.summary, a.reasoning_trace, a.assessed_at
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
      WHERE c.id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    credence: row.credence,
    confidence: row.confidence,
    summary: row.summary,
    reasoningTrace: row.reasoning_trace,
    importance: row.importance,
    assessedAt: row.assessed_at ? new Date(row.assessed_at).toISOString() : null,
  };
}

/** Every assessment written for the claim since `since`, oldest first, with its trigger. */
export async function reassessmentsSince(claimId: string, since: Date): Promise<Reassessment[]> {
  const rows = await rawQuery<{
    trigger: string | null;
    trigger_context: string | null;
    status: string;
    claim_credence: number | null;
    confidence: number;
    assessed_at: Date;
  }>(
    `SELECT trigger, trigger_context, status, claim_credence, confidence, assessed_at
       FROM assessments WHERE claim_id = $1 AND assessed_at >= $2 ORDER BY assessed_at ASC`,
    [claimId, since]
  );
  return rows.map((r) => ({
    trigger: r.trigger,
    triggerContext: r.trigger_context,
    status: r.status,
    credence: r.claim_credence,
    confidence: r.confidence,
    assessedAt: new Date(r.assessed_at).toISOString(),
  }));
}

/** Reassessments across the whole graph since `since` (campaign mode). */
export async function reassessmentCountSince(since: Date): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM assessments WHERE assessed_at >= $1`, [since]);
  return row?.n ?? 0;
}

/**
 * The cluster's top-level claims (≥1 source instance) with status, credence,
 * importance and direct decomposition: what the holistic judge compares.
 */
export async function loadHolisticView(): Promise<Array<HolisticClaim & { id: string }>> {
  const tops = await rawQuery<{ id: string; text: string; importance: number; status: string | null; credence: number | null }>(
    `SELECT c.id, c.text, c.importance, a.status, a.claim_credence AS credence
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
      WHERE c.state = 'active' AND EXISTS (SELECT 1 FROM claim_instances ci WHERE ci.claim_id = c.id)
      ORDER BY c.importance DESC, c.created_at ASC`
  );
  if (tops.length === 0) return [];
  const kids = await rawQuery<{ parent: string; relation: string; text: string; status: string | null }>(
    `SELECT r.parent_claim_id AS parent, r.relation_type AS relation, k.text, a.status
       FROM claim_relationships r
       JOIN claims k ON k.id = r.child_claim_id AND k.state = 'active'
       LEFT JOIN assessments a ON a.claim_id = k.id AND a.is_current
      WHERE r.parent_claim_id = ANY($1)`,
    [tops.map((t) => t.id)]
  );
  const byParent = new Map<string, HolisticClaim["children"]>();
  for (const k of kids) (byParent.get(k.parent) ?? byParent.set(k.parent, []).get(k.parent)!).push({ relation: k.relation, text: k.text, status: k.status });
  return tops.map((t) => ({ id: t.id, text: t.text, importance: t.importance, status: t.status, credence: t.credence, children: byParent.get(t.id) ?? [] }));
}

export interface ArmAgreement {
  report: AgreementReport;
  pairs: MatchedPair[];
  before: AgreementGraph;
  after: AgreementGraph;
}

/** Whole-graph agreement: baseline snapshot (A) vs the live corpus DB (B). */
export async function agreementAgainstBaseline(baseline: string, baselineGraph: AgreementGraph | null, armLabel: string): Promise<ArmAgreement> {
  const a = baselineGraph ?? (await loadAgreementGraph(`snap:${baseline}`, snapshotUrl(baseline)));
  const b = await loadAgreementGraph(armLabel, CORPUS_DATABASE_URL);
  const { pairs } = buildMatching(a, b);
  return { report: graphAgreement(a, b, pairs), pairs, before: a, after: b };
}

export function runFingerprint(extra: Record<string, string | undefined> = {}): ReplayFingerprint {
  const cfg = loadConfig();
  return {
    pipelineEpoch: cfg.pipelineEpoch,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    swap: null,
    order: null,
    models: {
      steward: cfg.stewardModel,
      matcher: cfg.matcherModel,
      curator: cfg.curatorModel,
      governance: cfg.governanceModel,
      arbitration: cfg.arbitrationModel,
      judge: cfg.judgeModel,
      ...extra,
    },
    caps: { stewardMaxRuns: cfg.stewardMaxRuns, stewardMaxIterations: cfg.stewardMaxIterations, curatorMaxRuns: cfg.curatorMaxRuns },
  };
}

// ---------------------------------------------------------------------------
// The judges: JUDGE_MODEL, through the real client, tagged "judge"
// ---------------------------------------------------------------------------

export async function judgeBlindPair(input: { claimText: string; first: JudgedAssessment; second: JudgedAssessment }): Promise<{ verdict: BlindJudgeVerdict; costMicroUsd: number }> {
  const model = loadConfig().judgeModel;
  const { value, billedMicroUsd } = await withCostMeter(() =>
    withAgent("judge", () =>
      completeStructured<BlindJudgeVerdict>({
        model,
        schema: BLIND_JUDGE_SCHEMA,
        schemaName: "BlindAssessmentComparison",
        maxTokens: 8192,
        messages: [{ role: "user", content: blindJudgePrompt(input) }],
      })
    )
  );
  return { verdict: value, costMicroUsd: billedMicroUsd };
}

export async function judgeHolisticPair(input: { cluster: string; description: string | null; first: HolisticClaim[]; second: HolisticClaim[] }): Promise<{ verdict: HolisticJudgeVerdict; costMicroUsd: number }> {
  const model = loadConfig().judgeModel;
  const { value, billedMicroUsd } = await withCostMeter(() =>
    withAgent("judge", () =>
      completeStructured<HolisticJudgeVerdict>({
        model,
        schema: HOLISTIC_JUDGE_SCHEMA,
        schemaName: "HolisticGraphComparison",
        maxTokens: 8192,
        messages: [{ role: "user", content: holisticJudgePrompt(input) }],
      })
    )
  );
  return { verdict: value, costMicroUsd: billedMicroUsd };
}
