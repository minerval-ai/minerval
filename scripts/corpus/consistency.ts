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
 *     plant known incoherences (`--plants=N`, default 4, alternating kinds):
 *       - flipped_premise: a child the parent rests on (requires/supports)
 *         gets a new assessment reversing its verdict, and the parent is
 *         not told: the parent's reasoning now stands on a premise the
 *         graph no longer holds.
 *       - overconfident_parent: a parent with a contested or weak
 *         `requires` child gets a new assessment at verified / 0.97 over
 *         its old reasoning, which still says the question is open.
 *     Planted claims are the recall set; everything else a sweep flags is
 *     read for precision (flags.md).
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
  kind: "flipped_premise" | "overconfident_parent";
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

function detects(flag: { primary_claim_id: string; claim_ids: string[] }, plant: Plant): boolean {
  if (flag.primary_claim_id === plant.expectedPrimary) return true;
  return plant.alsoPrimary.includes(flag.primary_claim_id) && flag.claim_ids.includes(plant.expectedPrimary);
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

const FLIPPED_TRACE =
  "Re-examined. The evidence previously cited for this claim does not establish it: " +
  "the sources that assert it do so without independent support, and the strongest " +
  "available evidence points the other way. On the record as it now stands the claim " +
  "is not supported, and its negation is the better-supported reading.";

async function plant(n: number, outDir: string): Promise<void> {
  const plants: Plant[] = [];
  const used = new Set<string>();
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
  const overconfident = await rawQuery<{
    parent: string; child: string; p_text: string; c_text: string;
  }>(
    `SELECT r.parent_claim_id AS parent, r.child_claim_id AS child, p.text AS p_text, c.text AS c_text
       FROM claim_relationships r
       JOIN claims p ON p.id = r.parent_claim_id AND p.state = 'active'
       JOIN claims c ON c.id = r.child_claim_id AND c.state = 'active'
       JOIN assessments pa ON pa.claim_id = p.id AND pa.is_current
       JOIN assessments ca ON ca.claim_id = c.id AND ca.is_current
      WHERE r.relation_type = 'requires'
        AND pa.status IN ('contested', 'supported', 'unsupported')
        AND (ca.status IN ('contested', 'unsupported') OR COALESCE(ca.claim_credence, 1) <= 0.6)
      ORDER BY p.importance DESC`
  );
  let fi = 0;
  let oi = 0;
  for (let k = 0; plants.length < n; k++) {
    const wantFlip = k % 2 === 0;
    const pool = wantFlip ? flips : overconfident;
    let pick: (typeof flips)[number] | undefined;
    while (wantFlip ? fi < pool.length : oi < pool.length) {
      const cand = pool[wantFlip ? fi++ : oi++]!;
      if (!used.has(cand.parent) && !used.has(cand.child)) {
        pick = cand;
        break;
      }
    }
    if (!pick) {
      if (fi >= flips.length && oi >= overconfident.length) break;
      continue;
    }
    used.add(pick.parent);
    used.add(pick.child);
    const parentBefore = (await currentAssessment(pick.parent))!;
    const childBefore = (await currentAssessment(pick.child))!;
    const target = wantFlip ? pick.child : pick.parent;
    const [old] = await rawQuery<{ reasoning_trace: string; summary: string | null; confidence: number }>(
      `SELECT reasoning_trace, summary, confidence FROM assessments WHERE claim_id = $1 AND is_current`,
      [target]
    );
    await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [target]);
    const [ins] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments
         (claim_id, status, confidence, claim_credence, summary, reasoning_trace,
          is_current, assessed_at, model, trigger, marginal_yield)
       VALUES ($1, $2, $3, $4, $5, $6, true, now(), 'plant', 'plant', 0.1)
       RETURNING id`,
      wantFlip
        ? [target, "contradicted", 0.7, 0.1, "Re-examined: not supported; the evidence points the other way.", FLIPPED_TRACE]
        : [target, "verified", 0.9, 0.97, old?.summary ?? null, old?.reasoning_trace ?? ""]
    );
    plants.push({
      kind: wantFlip ? "flipped_premise" : "overconfident_parent",
      // A flipped premise leaves the PARENT standing on a premise the graph
      // no longer holds; a flag on the thinly reassessed child naming the
      // parent is as good a catch. An overconfident parent is its own defect.
      expectedPrimary: pick.parent,
      alsoPrimary: wantFlip ? [pick.child] : [],
      claims: [pick.parent, pick.child],
      parentText: pick.p_text,
      childText: pick.c_text,
      plantedAssessmentId: ins!.id,
      before: { parent: parentBefore, child: childBefore },
    });
    console.log(`  planted ${plants[plants.length - 1]!.kind}: ${pick.p_text.slice(0, 70)}`);
  }
  writeFileSync(join(outDir, "plants.json"), JSON.stringify(plants, null, 2));
  const baseline = await dryRunRead("planted, before any arm");
  writeFileSync(join(outDir, "baseline-read.json"), JSON.stringify(baseline, null, 2));
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
    const stats = await drainLocalQueues({
      onEvent: (e) => events.push({ round, queue: e.queue, message: e.message, ok: e.ok, error: e.error }),
    });
    const ran = events.length - before;
    console.log(`  round ${round}: ${ran} unit(s) ${JSON.stringify(stats.processed)}${Object.keys(stats.errors).length ? ` errors ${JSON.stringify(stats.errors)}` : ""}`);
    if (ran === 0) break;
  }

  // What ran, and what it changed.
  const stewardRuns = await rawQuery<{
    claim_id: string; text: string; trigger: string | null; status: string; claim_credence: number | null;
    prev_status: string | null; prev_credence: number | null; summary: string | null; trigger_context: string | null;
  }>(
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
  const flags = await rawQuery<{
    id: string; kind: string; primary_claim_id: string; claim_ids: string[]; rationale: string;
    expected_gain: number; status_at_flag: string | null; credence_at_flag: number | null;
    action_status: string | null; status_now: string | null; credence_now: number | null; ran: boolean; moved: boolean;
    claim_text: string;
  }>(
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
  const sweeps = await rawQuery(
    `SELECT partition, tag_id, status, claims_in_scope, flags_raised, note, started_at, finished_at
       FROM consistency_sweeps WHERE started_at >= $1 ORDER BY started_at`,
    [startedAt]
  );
  const cost = await rawQuery<{ agent: string; calls: number; usd: number }>(
    `SELECT COALESCE(agent, '?') AS agent, COUNT(*)::int AS calls,
            ROUND(SUM(cost_micro_usd)::numeric / 1e6, 4)::float AS usd
       FROM llm_usage WHERE created_at >= $1 GROUP BY 1 ORDER BY 3 DESC`,
    [startedAt]
  );
  const enqueues = await rawQuery<{ trigger: string; n: number; coalesced: number }>(
    `SELECT COALESCE(trigger, '?') AS trigger, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE coalesced)::int AS coalesced
       FROM enqueue_events WHERE queue = 'steward' AND created_at >= $1 GROUP BY 1 ORDER BY 2 DESC`,
    [startedAt]
  );
  const allocations = await rawQuery<{ kind: string; n: number; usd: number }>(
    `SELECT x.kind, COUNT(*)::int AS n, ROUND(SUM(al.amount_micro_usd)::numeric / 1e6, 4)::float AS usd
       FROM action_allocations al JOIN actions x ON x.id = al.action_id
      WHERE al.created_at >= $1 GROUP BY 1`,
    [startedAt]
  );
  const unfunded = await rawQuery<{ n: number; flagged: number }>(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM consistency_flags f
                                            WHERE f.action_id = x.id))::int AS flagged
       FROM actions x WHERE x.status = 'open' AND x.kind IN ('assess', 'reassess')`
  );

  const plantOutcomes = [];
  for (const p of plants) {
    const parentNow = await currentAssessment(p.claims[0]!);
    const childNow = await currentAssessment(p.claims[1]!);
    plantOutcomes.push({
      kind: p.kind,
      parent: p.parentText.slice(0, 160),
      flagged: flags.some((f) => detects(f, p)),
      parentReassessed: parentNow?.id !== (p.kind === "overconfident_parent" ? p.plantedAssessmentId : p.before.parent.id),
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
  const passthrough = process.argv.slice(2).filter((a) => /^--(passes|cadence|plants|reads)=/.test(a));
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
