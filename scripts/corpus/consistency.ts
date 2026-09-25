/**
 * Consistency Checker eval (#330): does a sweep that reads assessments
 * against each other make the graph better, and does its demand for
 * reassessment fit the allocation system rather than bypass it?
 *
 *   npm run corpus:consistency -- run <cluster> --base=<snapshot> [flags]
 *
 * One experiment, every arm from the same planted snapshot:
 *
 *  1. PLANT. Starting from a drained graph (`--base`, a corpus:snapshot),
 *     plant known incoherences (`--plants=N`, default 4, alternating kinds),
 *     each written by the Steward's own model in the style of the trace it
 *     replaces and stamped like a Steward's pass, so the checker has to find
 *     the incoherence, not the plant's fingerprints:
 *       - flipped_premise: a claim a parent rests on (requires/supports),
 *         assessed as holding, gets a plausible but wrong reversal. The
 *         parent still stands on it; the neighbors recording its evidence
 *         still say otherwise. A flag on the child or the parent catches it.
 *       - ignored_counterevidence: a parent with a recorded 'contradicts'
 *         consideration gets reasoning that never engages it, at a higher
 *         credence. A flag on the parent catches it.
 *     Planted claims are the recall set; everything else a sweep flags is
 *     read for precision (the flags in summary.md).
 *  2. ARMS. Each arm restores the planted snapshot, seeds a General mandate
 *     with the same daily budget (`--passes=N` standard Steward passes'
 *     worth), enqueues the same cadence candidates (the formula's top
 *     assessed claims, staleness_check), and drains rounds of
 *     reconcile → refresh valuations → drain until nothing runs:
 *       - formula: the budget buys what the formula ranks highest.
 *       - checker: the same, plus consistency sweeps as ledger actions
 *         (CONSISTENCY_MAX_SWEEPS_PER_DAY=`--sweeps`), paid out of the same
 *         budget; flags compete for passes through the formula's
 *         expected-gain term like anything else.
 *  3. READ. After the drain each arm takes a dry-run sweep of the whole
 *     graph (a fresh checker, writes nothing): how much would it still
 *     flag, and are the plants among it? A dry run of the planted graph
 *     before any arm is the baseline for that read.
 *
 * Output under runs/consistency-<cluster>-<stamp>/: plants.json, one
 * <arm>.json per arm (passes funded and what they changed, flags and their
 * outcomes, sweeps, cascade, cost by agent, the dry-run read), and
 * summary.md. Snapshots cc_<stamp>_planted / _<arm> are kept as evidence.
 *
 * Needs the corpus DB and keys for whatever models the env pins; set every
 * *_MODEL you care about in the environment (the arms inherit it).
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_DATABASE_URL, gitCommit, positional, RUNS_ROOT } from "./lib.js";
import { runChild } from "./arms.js";
import { restoreSnapshot, saveSnapshot } from "./snapshot-core.js";
import { closeDb, rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";

type ArmName = "formula" | "checker";

interface Plant {
  kind: "flipped_premise" | "ignored_counterevidence";
  /** The claim a correct flag names as primary. */
  expectedPrimary: string;
  /** Also a correct primary, when the flag names expectedPrimary among its claims. */
  alsoPrimary: string[];
  /** Every claim involved, for the outcome read. */
  claims: string[];
  parentText: string;
  childText: string;
  /** The planted assessment's id (the defect itself). */
  plantedAssessmentId: string;
  before: { parent: AssessmentSnap; child: AssessmentSnap };
}

interface AssessmentSnap {
  id: string;
  status: string;
  credence: number | null;
  assessed_at: string;
}

interface ProposedFlagLite {
  kind: string;
  primary_claim_id: string;
  claim_ids: string[];
  rationale: string;
  expected_gain: number;
}

const SCRIPT = "scripts/corpus/consistency.ts";

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

async function currentAssessment(claimId: string): Promise<AssessmentSnap | null> {
  const [row] = await rawQuery<{ id: string; status: string; claim_credence: number | null; assessed_at: Date }>(
    `SELECT id, status, claim_credence, assessed_at FROM assessments WHERE claim_id = $1 AND is_current = true`,
    [claimId]
  );
  return row
    ? { id: row.id, status: row.status, credence: row.claim_credence, assessed_at: new Date(row.assessed_at).toISOString() }
    : null;
}

/** A flag catches a plant when its primary is the defective assessment (or, for a flip, the parent standing on it). */
function detects(flag: { primary_claim_id: string; claim_ids: string[] }, plant: Plant): boolean {
  return flag.primary_claim_id === plant.expectedPrimary || plant.alsoPrimary.includes(flag.primary_claim_id);
}

interface DryRead {
  /** One entry per independent read: what a fresh sweep would flag. */
  reads: Array<{ proposed: ProposedFlagLite[]; note: string }>;
  claimsInScope: number;
}

/**
 * The coherence read: `--reads` independent dry-run sweeps of the whole
 * graph (a fresh checker each time, writing nothing). One LLM read is one
 * sample; the summary reports the mean flag count and, per plant, in how
 * many reads it was found.
 */
async function dryRunRead(label: string): Promise<DryRead> {
  const { runConsistencySweep } = await import("../../src/workers/consistency-sweep.js");
  const n = Math.max(1, Number(argFlag("reads") ?? 2));
  const reads: DryRead["reads"] = [];
  let claimsInScope = 0;
  for (let i = 0; i < n; i++) {
    console.log(`  dry-run read ${i + 1}/${n} (${label})…`);
    const res = await runConsistencySweep({
      partition: { partition: "graph", tagId: null, label: "whole graph" },
      dryRun: true,
      // A read, not a budgeted sweep: let it say everything it would flag.
      maxFlags: 20,
    });
    reads.push({ proposed: res?.proposed ?? [], note: res?.note ?? "" });
    claimsInScope = res?.claimsInScope ?? 0;
  }
  return { reads, claimsInScope };
}

function readStats(read: DryRead, plants: Plant[]) {
  const mean = read.reads.reduce((s, r) => s + r.proposed.length, 0) / read.reads.length;
  return {
    meanFlags: Math.round(mean * 10) / 10,
    plantHits: plants.map((p) => read.reads.filter((r) => r.proposed.some((f) => detects(f, p))).length),
    reads: read.reads.length,
  };
}

// ---------------------------------------------------------------------------
// plant (child)
// ---------------------------------------------------------------------------

interface WrittenAssessment {
  summary: string;
  reasoning: string;
}

const WRITTEN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences, as the assessment's summary." },
    reasoning: { type: "string", description: "The full reasoning trace, in the style of the original." },
  },
  required: ["summary", "reasoning"],
};

/**
 * A planted assessment has to read like a Steward's, or the checker finds
 * the plant by its fingerprints (a template trace, a model named 'plant',
 * one shared timestamp) rather than by the incoherence. So the Steward's
 * own model writes it, in the style of the trace it replaces.
 */
async function writePlantedAssessment(instruction: string, claimText: string, oldTrace: string): Promise<WrittenAssessment> {
  const { completeStructured } = await import("../../src/llm/client.js");
  return completeStructured<WrittenAssessment>({
    model: loadConfig().stewardModel,
    schema: WRITTEN_SCHEMA,
    schemaName: "PlantedAssessment",
    maxTokens: 6000,
    messages: [{
      role: "user",
      content:
        `You are generating a test fixture for an evaluation of a consistency checker. ` +
        `Write a replacement assessment for the claim below, in the same voice, structure and ` +
        `length as the existing reasoning trace, so that it is indistinguishable in style from ` +
        `the original.\n\n${instruction}\n\nDo not mention that this is a test, a revision, ` +
        `or a re-examination.\n\nCLAIM: ${claimText}\n\nEXISTING REASONING:\n${oldTrace.slice(0, 6000)}`,
    }],
  });
}

async function plant(n: number, outDir: string): Promise<void> {
  const config = loadConfig();
  const plants: Plant[] = [];
  const used = new Set<string>();
  // flipped_premise: a claim a parent rests on (requires/supports), assessed
  // as holding, gets a plausible but wrong reversal. The parent still stands
  // on it, and the neighbors that record the evidence still say otherwise.
  const flips = await rawQuery<{
    parent: string; child: string; p_text: string; c_text: string;
  }>(
    `SELECT r.parent_claim_id AS parent, r.child_claim_id AS child, p.text AS p_text, c.text AS c_text
       FROM claim_relationships r
       JOIN claims p ON p.id = r.parent_claim_id AND p.state = 'active'
       JOIN claims c ON c.id = r.child_claim_id AND c.state = 'active'
       JOIN assessments pa ON pa.claim_id = p.id AND pa.is_current
       JOIN assessments ca ON ca.claim_id = c.id AND ca.is_current
      WHERE r.relation_type IN ('requires', 'supports')
        AND ca.status IN ('supported', 'verified')
        AND pa.status IN ('supported', 'verified', 'contested')
      ORDER BY p.importance DESC, r.relation_type = 'requires' DESC, c.importance DESC`
  );
  // ignored_counterevidence: a parent with a recorded, credible 'contradicts'
  // consideration gets reasoning that never engages it, at a higher credence.
  const ignored = await rawQuery<{
    parent: string; child: string; p_text: string; c_text: string;
  }>(
    `SELECT r.parent_claim_id AS parent, r.child_claim_id AS child, p.text AS p_text, c.text AS c_text
       FROM claim_relationships r
       JOIN claims p ON p.id = r.parent_claim_id AND p.state = 'active'
       JOIN claims c ON c.id = r.child_claim_id AND c.state = 'active'
       JOIN assessments pa ON pa.claim_id = p.id AND pa.is_current
       JOIN assessments ca ON ca.claim_id = c.id AND ca.is_current
      WHERE r.relation_type = 'contradicts'
        AND ca.status IN ('supported', 'verified', 'contested')
        AND pa.status IN ('supported', 'contested', 'unsupported')
      ORDER BY p.importance DESC, c.importance DESC`
  );
  const pools = { flipped_premise: flips, ignored_counterevidence: ignored };
  const cursor = { flipped_premise: 0, ignored_counterevidence: 0 };
  for (let k = 0; plants.length < n; k++) {
    const kind: Plant["kind"] = k % 2 === 0 ? "flipped_premise" : "ignored_counterevidence";
    const pool = pools[kind];
    let pick: (typeof flips)[number] | undefined;
    while (cursor[kind] < pool.length) {
      const cand = pool[cursor[kind]++]!;
      if (!used.has(cand.parent) && !used.has(cand.child)) {
        pick = cand;
        break;
      }
    }
    if (!pick) {
      if (cursor.flipped_premise >= flips.length && cursor.ignored_counterevidence >= ignored.length) break;
      continue;
    }
    used.add(pick.parent);
    used.add(pick.child);
    const parentBefore = (await currentAssessment(pick.parent))!;
    const childBefore = (await currentAssessment(pick.child))!;
    const target = kind === "flipped_premise" ? pick.child : pick.parent;
    const [old] = await rawQuery<{ reasoning_trace: string; summary: string | null; claim_credence: number | null; assessed_at: Date }>(
      `SELECT reasoning_trace, summary, claim_credence, assessed_at FROM assessments WHERE claim_id = $1 AND is_current`,
      [target]
    );
    const written =
      kind === "flipped_premise"
        ? await writePlantedAssessment(
            `The new assessment concludes the claim is CONTRADICTED (the evidence, properly read, ` +
              `points against it). Argue it the way a careful but mistaken assessor might: ` +
              `reinterpret the key evidence, lean on a real-sounding methodological objection, and ` +
              `reach a confident negative verdict.`,
            pick.c_text,
            old?.reasoning_trace ?? ""
          )
        : await writePlantedAssessment(
            `Write it as the assessment of a reviewer who argues from the evidence FOR the claim ` +
              `and reaches a more confident supported verdict than the existing one. This reviewer ` +
              `did not consider the following point, so it does not appear in their reasoning: ` +
              `"${pick.c_text}".`,
            pick.p_text,
            old?.reasoning_trace ?? ""
          );
    // A model that declines writes a refusal, not an assessment; a refusal
    // planted as a verdict is not the defect under test. Skip the candidate.
    if (/^\s*(I\s+(can.?t|cannot|won.?t|am unable)|I'm not able|Sorry)/i.test(`${written.summary} ${written.reasoning}`)) {
      console.log(`  (skipped a ${kind} candidate: the writer declined)`);
      used.delete(pick.parent);
      used.delete(pick.child);
      continue;
    }
    const values =
      kind === "flipped_premise"
        ? { status: "contradicted", credence: 0.15, trigger: "staleness_check" }
        : {
            status: "supported",
            credence: Math.min(0.95, Math.max(0.8, (old?.claim_credence ?? 0.6) + 0.25)),
            trigger: "subclaim_change",
          };
    await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [target]);
    // A plausible moment: after the assessment it replaces, before now,
    // staggered so the plants do not share a timestamp.
    const [ins] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments
         (claim_id, status, confidence, claim_credence, summary, reasoning_trace,
          is_current, assessed_at, model, trigger, marginal_yield)
       VALUES ($1, $2, 0.75, $3, $4, $5, true,
               GREATEST($6::timestamptz + interval '5 minutes', now() - make_interval(mins => $7)),
               $8, $9, 0.2)
       RETURNING id`,
      [
        target,
        values.status,
        values.credence,
        written.summary,
        written.reasoning,
        old!.assessed_at,
        10 + plants.length * 17,
        config.stewardModel,
        values.trigger,
      ]
    );
    plants.push({
      kind,
      // flipped_premise: the reversed child IS the bad assessment, and the
      // parent now stands on a premise the graph no longer holds; a flag on
      // either is a catch. ignored_counterevidence: the parent is the defect.
      expectedPrimary: kind === "flipped_premise" ? pick.child : pick.parent,
      alsoPrimary: kind === "flipped_premise" ? [pick.parent] : [],
      claims: [pick.parent, pick.child],
      parentText: pick.p_text,
      childText: pick.c_text,
      plantedAssessmentId: ins!.id,
      before: { parent: parentBefore, child: childBefore },
    });
    console.log(`  planted ${kind}: ${(kind === "flipped_premise" ? pick.c_text : pick.p_text).slice(0, 80)}`);
  }
  writeFileSync(join(outDir, "plants.json"), JSON.stringify(plants, null, 2));
  const baseline = await dryRunRead("planted, before any arm");
  writeFileSync(join(outDir, "baseline-read.json"), JSON.stringify(baseline, null, 2));
}

/**
 * A read for the arm's report: a failed query is logged and reads as empty
 * rather than discarding the arm, whose drain has already been paid for.
 */
async function safeRead<T>(label: string, q: string, params: unknown[]): Promise<T[]> {
  try {
    return await rawQuery<T & Record<string, unknown>>(q, params) as T[];
  } catch (err) {
    console.warn(`  [report] ${label} failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// arm (child)
// ---------------------------------------------------------------------------

async function seedGeneralMandate(dailyMicroUsd: number): Promise<string> {
  const { getPlatformAccountId } = await import("../../src/services/bounty-service.js");
  const platform = await getPlatformAccountId();
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true AND policy = 'general'`);
  const [job] = await rawQuery<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
     VALUES ($1, 'grant', $2, 'running') RETURNING id`,
    [platform, dailyMicroUsd * 10]
  );
  const [grant] = await rawQuery<{ id: string }>(
    `INSERT INTO grants (funder_user_id, budget_job_id, name, policy, status, is_platform, daily_budget_micro_usd)
     VALUES ($1, $2, 'General assessment (eval)', 'general', 'active', true, $3) RETURNING id`,
    [platform, job!.id, dailyMicroUsd]
  );
  return grant!.id;
}

async function arm(name: ArmName, outDir: string): Promise<void> {
  const config = loadConfig();
  const passes = Number(argFlag("passes") ?? 12);
  const cadenceK = Number(argFlag("cadence") ?? passes * 2);
  const concurrency = Math.max(1, Number(argFlag("concurrency") ?? 1));
  const plants = JSON.parse(readFileSync(join(outDir, "plants.json"), "utf8")) as Plant[];
  const { stewardTierCostEstimates } = await import("../../src/services/cost-estimate-service.js");
  const { resetAllocationPolicyCache } = await import("../../src/services/allocation-policy-service.js");
  const { reconcileActions } = await import("../../src/services/action-service.js");
  const { refreshGeneralValuations } = await import("../../src/services/mandate-valuer-service.js");
  const { enqueueSteward } = await import("../../src/services/queue-service.js");
  const { drainLocalQueues } = await import("../../src/workers/local-runner.js");
  const { consistencyPrecision } = await import("../../src/services/consistency-service.js");

  const startedAt = new Date();
  const tiers = await stewardTierCostEstimates();
  const daily = Math.round(tiers.standardMicroUsd * passes);
  const grantId = await seedGeneralMandate(daily);
  resetAllocationPolicyCache();
  console.log(`\n=== arm ${name}: General mandate ${grantId.slice(0, 8)}, daily ${(daily / 1e6).toFixed(3)} USD (${passes} × ${(tiers.standardMicroUsd / 1e6).toFixed(4)}) ===`);

  // The cadence's candidates, identical in both arms: the formula's top
  // assessed claims, as the staleness sweep would enqueue them. The planted
  // claims are left out, so a plant is revisited only if something found
  // it: what either arm fixes of them is attributable.
  const plantClaims = plants.flatMap((p) => p.claims);
  const cadence = await rawQuery<{ id: string }>(
    `SELECT c.id FROM claims c
       JOIN assessments a ON a.claim_id = c.id AND a.is_current
      WHERE c.state = 'active' AND c.steward_state NOT IN ('pending', 'running')
        AND NOT (c.id = ANY($2::uuid[]))
      ORDER BY c.importance * (0.3 + 0.7 * COALESCE(c.contestation, 0)) DESC, c.id
      LIMIT $1`,
    [cadenceK, plantClaims]
  );
  for (const c of cadence) {
    await enqueueSteward({ claimId: c.id, trigger: "staleness_check", context: "Periodic refresh (eval cadence)." });
  }

  const events: Array<{ round: number; queue: string; message: unknown; ok: boolean; error?: string }> = [];
  for (let round = 1; round <= 8; round++) {
    await reconcileActions();
    await refreshGeneralValuations();
    const before = events.length;
    // Parallel drains, as production runs several workers: the Steward and
    // engine lanes claim their rows with SKIP LOCKED, so N loops never run
    // the same unit twice.
    const all = await Promise.all(
      Array.from({ length: concurrency }, () =>
        drainLocalQueues({
          onEvent: (e) => events.push({ round, queue: e.queue, message: e.message, ok: e.ok, error: e.error }),
        })
      )
    );
    const processed: Record<string, number> = {};
    for (const st of all) for (const [k, v] of Object.entries(st.processed)) processed[k] = (processed[k] ?? 0) + v;
    const errors = all.flatMap((st) => Object.entries(st.errors));
    const ran = events.length - before;
    console.log(`  round ${round}: ${ran} unit(s) ${JSON.stringify(processed)}${errors.length ? ` errors ${JSON.stringify(errors)}` : ""}`);
    if (ran === 0) break;
  }

  // What ran, and what it changed.
  const stewardRuns = await safeRead<{
    claim_id: string; text: string; trigger: string | null; status: string; claim_credence: number | null;
    prev_status: string | null; prev_credence: number | null; summary: string | null; trigger_context: string | null;
  }>("stewardRuns",
    `SELECT a.claim_id, c.text, a.trigger, a.status, a.claim_credence, a.summary, a.trigger_context,
            prev.status AS prev_status, prev.claim_credence AS prev_credence
       FROM assessments a
       JOIN claims c ON c.id = a.claim_id
       LEFT JOIN LATERAL (
         SELECT status, claim_credence FROM assessments p
          WHERE p.claim_id = a.claim_id AND p.assessed_at < a.assessed_at
          ORDER BY p.assessed_at DESC LIMIT 1) prev ON true
      WHERE a.assessed_at >= $1
      ORDER BY a.assessed_at`,
    [startedAt]
  );
  const flags = await safeRead<{
    id: string; kind: string; primary_claim_id: string; claim_ids: string[]; rationale: string;
    expected_gain: number; status_at_flag: string | null; credence_at_flag: number | null;
    action_status: string | null; status_now: string | null; credence_now: number | null; ran: boolean; moved: boolean;
    claim_text: string;
  }>("flags",
    `SELECT f.id, f.kind, f.primary_claim_id, f.claim_ids, f.rationale, f.expected_gain,
            f.status_at_flag, f.credence_at_flag, x.status AS action_status, c.text AS claim_text,
            cur.status AS status_now, cur.claim_credence AS credence_now,
            (cur.id IS NOT NULL AND cur.id IS DISTINCT FROM f.assessment_id_at_flag) AS ran,
            (cur.id IS NOT NULL AND cur.id IS DISTINCT FROM f.assessment_id_at_flag
             AND (cur.status IS DISTINCT FROM f.status_at_flag
                  OR ABS(COALESCE(cur.claim_credence,0) - COALESCE(f.credence_at_flag,0)) > 0.1)) AS moved
       FROM consistency_flags f
       JOIN claims c ON c.id = f.primary_claim_id
       LEFT JOIN actions x ON x.id = f.action_id
       LEFT JOIN assessments cur ON cur.claim_id = f.primary_claim_id AND cur.is_current
      WHERE f.created_at >= $1 ORDER BY f.created_at`,
    [startedAt]
  );
  const sweeps = await safeRead<Record<string, unknown>>("sweeps",
    `SELECT partition, tag_id, status, claims_in_scope, flags_raised, note, started_at, finished_at
       FROM consistency_sweeps WHERE started_at >= $1 ORDER BY started_at`,
    [startedAt]
  );
  const cost = await safeRead<{ agent: string; calls: number; usd: number }>("cost",
    `SELECT COALESCE(agent, '?') AS agent, COUNT(*)::int AS calls,
            ROUND(SUM(cost_micro_usd)::numeric / 1e6, 4)::float AS usd
       FROM llm_usage WHERE created_at >= $1 GROUP BY 1 ORDER BY 3 DESC`,
    [startedAt]
  );
  const enqueues = await safeRead<{ trigger: string; n: number; coalesced: number }>("enqueues",
    `SELECT COALESCE(trigger, '?') AS trigger, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE coalesced)::int AS coalesced
       FROM enqueue_events WHERE queue = 'steward' AND created_at >= $1 GROUP BY 1 ORDER BY 2 DESC`,
    [startedAt]
  );
  const allocations = await safeRead<{ kind: string; n: number; usd: number }>("allocations",
    // Unpinned allocations carry no action_id; the group names the kind.
    `SELECT split_part(al.exclusion_group, ':', 1) AS kind, COUNT(*)::int AS n,
            ROUND(SUM(al.amount_micro_usd)::numeric / 1e6, 4)::float AS usd
       FROM action_allocations al
      WHERE al.created_at >= $1 GROUP BY 1`,
    [startedAt]
  );
  // The rest of the admin system's response: Curator work the passes
  // escalated, and issue reports agents raised during the arm.
  const curatorRuns = await safeRead<{ n: number }>("curatorRuns",
    `SELECT COUNT(*)::int AS n FROM agent_runs WHERE agent = 'curator' AND started_at >= $1`,
    [startedAt]
  );
  const reports = await safeRead<{ agent: string; kind: string; severity: string; title: string }>("reports",
    `SELECT agent, kind, severity, title FROM agent_reports WHERE last_seen_at >= $1 ORDER BY last_seen_at`,
    [startedAt]
  );
  const unfunded = await safeRead<{ n: number; flagged: number }>("unfunded",
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM consistency_flags f
                                            WHERE f.action_id = x.id))::int AS flagged
       FROM actions x WHERE x.status = 'open' AND x.kind IN ('assess', 'reassess')`,
    []
  );

  const plantOutcomes = [];
  for (const p of plants) {
    const parentNow = await currentAssessment(p.claims[0]!);
    const childNow = await currentAssessment(p.claims[1]!);
    plantOutcomes.push({
      kind: p.kind,
      parent: p.parentText.slice(0, 160),
      flagged: flags.some((f) => detects(f, p)),
      parentReassessed: parentNow?.id !== (p.kind === "ignored_counterevidence" ? p.plantedAssessmentId : p.before.parent.id),
      childReassessed: childNow?.id !== (p.kind === "flipped_premise" ? p.plantedAssessmentId : p.before.child.id),
      before: p.before,
      now: { parent: parentNow, child: childNow },
    });
  }

  const read = await dryRunRead(`after ${name}`);
  const report = {
    arm: name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    models: { steward: config.stewardModel, consistency: config.consistencyModel, matcher: config.matcherModel },
    budget: { passes, dailyMicroUsd: daily, standardPassEstMicroUsd: tiers.standardMicroUsd, cadenceCandidates: cadence.length },
    allocations,
    unfundedAssessActions: unfunded[0],
    stewardRuns,
    flags,
    precision: await consistencyPrecision({ since: startedAt }),
    sweeps,
    enqueues,
    curatorRuns: curatorRuns[0]?.n ?? 0,
    reports,
    cost,
    plants: plantOutcomes,
    read: { ...read, ...readStats(read, plants) },
    events,
  };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(report, null, 2));
  console.log(`  written ${join(outDir, `${name}.json`)}`);
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

function summarize(outDir: string, arms: ArmName[]): string {
  const plants = JSON.parse(readFileSync(join(outDir, "plants.json"), "utf8")) as Plant[];
  const baseline = readStats(JSON.parse(readFileSync(join(outDir, "baseline-read.json"), "utf8")) as DryRead, plants);
  const lines: string[] = [];
  const w = (s = "") => lines.push(s);
  w(`# Consistency Checker eval`);
  w();
  w(`Plants: ${plants.map((p) => p.kind).join(", ")}.`);
  w(`Baseline dry-run read of the planted graph (${baseline.reads} read(s)): ${baseline.meanFlags} flag(s) per read; ` +
    `plants found in ${baseline.plantHits.map((h) => `${h}/${baseline.reads}`).join(", ")} reads.`);
  w();
  for (const name of arms) {
    const r = JSON.parse(readFileSync(join(outDir, `${name}.json`), "utf8"));
    const usd = (r.cost as Array<{ usd: number }>).reduce((s, c) => s + c.usd, 0);
    const moved = (r.stewardRuns as Array<{ status: string; prev_status: string | null; claim_credence: number | null; prev_credence: number | null }>)
      .filter((s) => s.status !== s.prev_status || Math.abs((s.claim_credence ?? 0) - (s.prev_credence ?? 0)) > 0.1).length;
    w(`## ${name}`);
    w();
    w(`- Steward passes: ${r.stewardRuns.length} (${moved} moved status or credence > 0.1); cost $${usd.toFixed(3)} (` +
      (r.cost as Array<{ agent: string; usd: number }>).map((c) => `${c.agent} $${c.usd}`).join(", ") + ")");
    w(`- Allocations: ${(r.allocations as Array<{ kind: string; n: number; usd: number }>).map((a) => `${a.kind} ×${a.n} ($${a.usd})`).join(", ") || "none"}; ` +
      `left open: ${r.unfundedAssessActions?.n ?? 0} assess action(s), ${r.unfundedAssessActions?.flagged ?? 0} of them flagged`);
    w(`- Steward enqueues by trigger: ${(r.enqueues as Array<{ trigger: string; n: number }>).map((e) => `${e.trigger} ${e.n}`).join(", ")}`);
    w(`- Curator runs: ${r.curatorRuns}; issue reports: ${(r.reports as Array<{ agent: string; title: string }>).map((x) => `${x.agent}: ${x.title}`).join("; ") || "none"}`);
    if (name === "checker") {
      w(`- Sweeps: ${r.sweeps.length}; flags: ${r.flags.length}; precision ran ${r.precision.ran}/${r.precision.flagged}, moved ${r.precision.moved}`);
    }
    w(`- Plants: ` + (r.plants as Array<{ kind: string; flagged: boolean; parentReassessed: boolean; childReassessed: boolean }>)
      .map((p) => `${p.kind} [flagged ${p.flagged ? "yes" : "no"}, parent reassessed ${p.parentReassessed ? "yes" : "no"}, child ${p.childReassessed ? "yes" : "no"}]`).join("; "));
    w(`- Dry-run read after (${r.read.reads} read(s)): ${r.read.meanFlags} flag(s) per read; plants still found in ` +
      `${(r.read.plantHits as number[]).map((h) => `${h}/${r.read.reads}`).join(", ")} reads`);
    w();
    if (r.flags.length > 0) {
      w(`### Flags raised`);
      w();
      for (const f of r.flags) {
        w(`- **${f.kind}** (gain ${f.expected_gain}) on "${String(f.claim_text).slice(0, 120)}": ${f.status_at_flag} ${f.credence_at_flag ?? ""} → ${f.status_now} ${f.credence_now ?? ""} [${f.ran ? (f.moved ? "moved" : "ran, unchanged") : `not run, action ${f.action_status}`}]`);
        w(`  > ${String(f.rationale).replace(/\n/g, " ")}`);
      }
      w();
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// run (parent)
// ---------------------------------------------------------------------------

async function run(cluster: string): Promise<void> {
  const base = argFlag("base");
  if (!base) throw new Error("--base=<snapshot> is required: a drained corpus graph (npm run corpus:snapshot -- save <name>)");
  const arms = (argFlag("arms") ?? "formula,checker").split(",") as ArmName[];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "_").toLowerCase();
  const outDir = join(RUNS_ROOT, `consistency-${cluster}-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const passthrough = process.argv.slice(2).filter((a) => /^--(passes|cadence|plants|reads|concurrency)=/.test(a));
  const planted = `cc_${stamp}_planted`;

  console.log(`\n=== consistency eval: ${cluster} from snapshot ${base} → ${outDir} ===`);
  await restoreSnapshot(CORPUS_DATABASE_URL, base);
  runChild(SCRIPT, ["plant", `--out=${outDir}`, ...passthrough], {});
  await saveSnapshot(CORPUS_DATABASE_URL, planted);
  for (const name of arms) {
    await restoreSnapshot(CORPUS_DATABASE_URL, planted);
    runChild(SCRIPT, ["arm", `--arm=${name}`, `--out=${outDir}`, ...passthrough], {
      BACKGROUND_FALLBACK_LANE_ENABLED: "false",
      // The eval mandate's own review pass is not what either arm measures.
      MANDATE_REVIEW_MAX_PASSES_PER_DAY: "0",
      CONSISTENCY_MAX_SWEEPS_PER_DAY: name === "checker" ? (argFlag("sweeps") ?? "2") : "0",
    });
    await saveSnapshot(CORPUS_DATABASE_URL, `cc_${stamp}_${name}`);
  }
  const md = summarize(outDir, arms);
  writeFileSync(join(outDir, "summary.md"), md);
  console.log(`\n${md}\n\n  written ${join(outDir, "summary.md")}`);
}

async function main(): Promise<void> {
  assertCorpusDb();
  const cmd = positional(0);
  const outDir = argFlag("out");
  if (cmd === "run") {
    await run(positional(1) ?? "corpus");
  } else if (cmd === "plant" && outDir) {
    await plant(Number(argFlag("plants") ?? 4), outDir);
  } else if (cmd === "arm" && outDir) {
    await arm((argFlag("arm") ?? "checker") as ArmName, outDir);
  } else if (cmd === "summary" && outDir) {
    console.log(summarize(outDir, (argFlag("arms") ?? "formula,checker").split(",") as ArmName[]));
  } else {
    console.error("Usage: corpus:consistency -- run <cluster> --base=<snapshot> [--plants=4] [--passes=12] [--sweeps=2] [--arms=formula,checker]");
    process.exit(1);
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
