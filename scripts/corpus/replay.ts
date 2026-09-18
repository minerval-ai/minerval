/**
 * The replay exporter, the database half and the CLI (#334, the evals
 * page's "show me" half): read one run window's rows out of a corpus
 * database (the live one or a snapshot), hand them to the pure builder
 * (replay-lib.ts), and write the recording as two layouts:
 *
 *   <dir>/replay.json                      the index: arms, sources, every
 *                                          event with its deltas and step
 *                                          gists (verbatim content replaced
 *                                          by sizes), matching, final graph
 *   <dir>/replay-events/<arm>/<seq>.json   the full event: untrimmed steps,
 *                                          the prompt step included
 *
 * A committed recording is the same pair copied to corpus/replays/<name>/
 * (`--commit-as=<name>`), which the content sync vendors for the player.
 *
 * Usage:
 *   npm run corpus:replay -- db --since=<iso> [--until=<iso>] --name=<name>
 *       [--kind=ingest] [--cluster=<c>] [--out=DIR] [--commit-as=<name>]
 *   npm run corpus:replay -- snap:<a> snap:<b> --since=<iso> --name=<name>
 *       [--since-a=<iso> --since-b=<iso>] [--agreement=<path>] [--kind=property|swap]
 *       [--cluster=<c>] [--out=DIR] [--commit-as=<name>]
 *
 * The two-arm form reads each arm from its snapshot and links the claims
 * the agreement metric paired: from an --agreement JSON (what
 * corpus:agreement --out writes) when given, otherwise computed in-process
 * from the two graphs' stored embeddings (no judge, no spend).
 *
 * The exports (collectArm, assembleReplay, matchingFromAgreement,
 * writeReplay, replayName) are the contract the drivers call after their
 * drain; importing this module has no side effects (the corpus DB pin in
 * lib.ts is loaded only when a caller leaves `databaseUrl` unset, or by the
 * CLI).
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { dbNameOf, snapshotDbName } from "./snapshot-core.js";
import {
  buildMatching,
  graphAgreement,
  type AgreementGraph,
  type AgreementReport,
  type MatchedPair,
} from "./graph-agreement.js";
import { buildReplayArm, splitReplay } from "./replay-lib.js";
import type {
  AgentRunRow,
  AgentStepRow,
  AppealRow,
  ArbitrationRow,
  AssessmentRow,
  ClaimRow,
  ContributionRow,
  EdgeRow,
  EnqueueEventRow,
  InstanceRow,
  ReviewRow,
  SourceRow,
  UsageRow,
} from "./replay-lib.js";
import {
  REPLAY_VERSION,
  type Replay,
  type ReplayArm,
  type ReplayFingerprint,
  type ReplayKind,
  type ReplayMatching,
  type ReplayScenario,
} from "./replay-types.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPLAYS_ROOT = join(REPO_ROOT, "corpus", "replays");

/** The corpus DB pin, loaded on demand (importing lib.js repoints DATABASE_URL). */
async function corpusDatabaseUrl(): Promise<string> {
  const lib = await import("./lib.js");
  return lib.CORPUS_DATABASE_URL;
}

/** The connection URL of a snapshot of the corpus DB (a database named by snapshot-core). */
export function snapshotUrl(baseUrl: string, snapshot: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${snapshotDbName(dbNameOf(baseUrl), snapshot)}`;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (dbNameOf(url) === "episteme") throw new Error("Refusing to read the main 'episteme' database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Read the rows of one run window from `databaseUrl` (default: the pinned
 * corpus DB) and build the arm. Graph rows are read whole (the final graph
 * is everything that stands); the window bounds which rows become deltas
 * and which agent runs, enqueues and usage belong to the arm.
 */
export async function collectArm(opts: {
  databaseUrl?: string;
  since: Date;
  until?: Date;
  key: string;
  label: string;
  variation: string | null;
  fingerprint: ReplayFingerprint;
  database?: string | null;
  capped?: boolean;
  /** Corpus post ids by source url, when the driver knows the manifest. */
  sourceKeys?: Record<string, string>;
}): Promise<ReplayArm> {
  const url = opts.databaseUrl ?? (await corpusDatabaseUrl());
  const since = opts.since;
  const until = opts.until ?? new Date();
  const w = [since, until];
  return withClient(url, async (c) => {
    const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await c.query(sql, params)).rows as T[];
    const runs = await q<AgentRunRow>(
      `SELECT id, agent, claim_id, job_id, started_at, finished_at, outcome, error
         FROM agent_runs WHERE started_at >= $1 AND started_at <= $2 ORDER BY started_at`,
      w
    );
    const steps = runs.length
      ? await q<AgentStepRow>(
          `SELECT run_id, seq, kind, content, created_at FROM agent_steps
            WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, seq`,
          [runs.map((r) => r.id)]
        )
      : [];
    const enqueueEvents = await q<EnqueueEventRow>(
      `SELECT id, queue, trigger, claim_id, contribution_id, source_agent, source_run_id, coalesced, created_at
         FROM enqueue_events WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at`,
      w
    );
    const usage = await q<UsageRow>(
      `SELECT run_id, SUM(cost_micro_usd)::bigint AS cost_micro_usd
         FROM llm_usage WHERE created_at >= $1 AND created_at <= $2 GROUP BY run_id`,
      w
    );
    const claims = await q<ClaimRow>(
      `SELECT id, text, claim_type, created_by, created_at, importance, steward_state, state, merged_into FROM claims`
    );
    const edges = await q<EdgeRow>(
      `SELECT r.id, r.parent_claim_id, r.child_claim_id, r.relation_type, r.created_by, r.created_at,
              (SELECT MIN(s.argument_id::text) FROM argument_subclaims s WHERE s.relationship_id = r.id) AS argument_id
         FROM claim_relationships r`
    );
    const instances = await q<InstanceRow>(
      `SELECT id, claim_id, source_id, stance, verbatim_text, proposed_canonical_form, created_by, created_at
         FROM claim_instances`
    );
    const assessments = await q<AssessmentRow>(
      `SELECT id, claim_id, status, confidence, claim_credence, summary, trigger, is_current, assessed_at FROM assessments`
    );
    const sources = await q<SourceRow>(
      `SELECT id, url, title, retrieved_at,
              CASE WHEN raw_content IS NULL THEN NULL
                   ELSE array_length(regexp_split_to_array(btrim(raw_content), E'\\\\s+'), 1) END AS words
         FROM sources`
    );
    const contributions = await q<ContributionRow>(
      `SELECT c.id, c.claim_id, c.contribution_type, c.contributor_id, u.display_name AS contributor_name,
              c.submitted_at, c.review_status
         FROM contributions c LEFT JOIN contributors u ON u.id = c.contributor_id
        WHERE c.submitted_at >= $1 AND c.submitted_at <= $2`,
      w
    );
    const reviews = await q<ReviewRow>(
      `SELECT id, contribution_id, decision, confidence, suspected_bad_faith, reasoning, reviewed_at
         FROM contribution_reviews WHERE reviewed_at >= $1 AND reviewed_at <= $2`,
      w
    );
    const appeals = await q<AppealRow>(
      `SELECT a.id, a.contribution_id, u.display_name AS appellant_name, a.submitted_at
         FROM appeals a LEFT JOIN contributors u ON u.id = a.appellant_id
        WHERE a.submitted_at >= $1 AND a.submitted_at <= $2`,
      w
    );
    const arbitrations = await q<ArbitrationRow>(
      `SELECT id, contribution_id, appeal_id, outcome, reasoning, arbitrated_at
         FROM arbitration_results WHERE arbitrated_at >= $1 AND arbitrated_at <= $2`,
      w
    );
    return buildReplayArm({
      meta: {
        key: opts.key,
        label: opts.label,
        variation: opts.variation,
        fingerprint: opts.fingerprint,
        database: opts.database ?? dbNameOf(url),
        capped: opts.capped ?? false,
      },
      since,
      until,
      runs,
      steps,
      enqueueEvents,
      usage,
      claims,
      edges,
      instances,
      assessments,
      sources,
      contributions,
      reviews,
      appeals,
      arbitrations,
      ...(opts.sourceKeys ? { sourceKeys: opts.sourceKeys } : {}),
    });
  });
}

export function assembleReplay(opts: {
  kind: ReplayKind;
  name: string;
  title: string;
  cluster: string | null;
  about: string;
  arms: ReplayArm[];
  matching?: ReplayMatching[] | null;
  scenario?: ReplayScenario | null;
  summary?: Record<string, unknown> | null;
  evalRunId?: string | null;
}): Replay {
  const costs = opts.arms.map((a) => a.costMicroUsd).filter((c): c is number => c !== null);
  return {
    version: REPLAY_VERSION,
    kind: opts.kind,
    name: opts.name,
    title: opts.title,
    cluster: opts.cluster,
    generatedAt: new Date().toISOString(),
    about: opts.about,
    arms: opts.arms,
    matching: opts.matching ?? null,
    scenario: opts.scenario ?? null,
    summary: opts.summary ?? null,
    evalRunId: opts.evalRunId ?? null,
    costMicroUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

/** The matching between two arms, from an agreement report and the pairs it was computed over. */
export function matchingFromAgreement(
  armA: string,
  armB: string,
  report: AgreementReport,
  pairs: MatchedPair[] | undefined
): ReplayMatching {
  return {
    armA,
    armB,
    pairs: (pairs ?? []).map((p) => ({ a: p.a, b: p.b, method: p.method, similarity: p.similarity })),
    unmatchedA: report.claimSet.unmatchedA,
    unmatchedB: report.claimSet.unmatchedB,
    summary: {
      claimSetF1: report.claimSet.f1,
      credenceMeanAbsDiff: report.credence.meanAbsDiff,
      statusAgreement: report.credence.statusAgreement,
      edgeEditDistance: report.structure.editDistance,
    },
  };
}

/** A fingerprint from what a run record / RunFingerprint carries (the drivers' shape). */
export function fingerprintFromRecord(rec: {
  pipelineEpoch?: string | null;
  gitCommit?: string | null;
  profile?: string | null;
  swap?: { agent: string; model: string } | null;
  order?: string | null;
  /** AgentModels or any per-agent map (interfaces have no index signature; copied into a plain record). */
  models?: object;
  caps?: Record<string, number>;
}): ReplayFingerprint {
  return {
    pipelineEpoch: rec.pipelineEpoch ?? null,
    gitCommit: rec.gitCommit ?? null,
    profile: rec.profile ?? null,
    swap: rec.swap ?? null,
    order: rec.order ?? null,
    models: { ...(rec.models ?? {}) } as Record<string, string | undefined>,
    caps: rec.caps ?? {},
  };
}

/**
 * Write both layouts under `runDir`: replay.json (the index) and
 * replay-events/<arm>/<seq>.json (the full events). Returns the index path.
 * A stale replay-events directory is removed first, so the files match the
 * index exactly.
 */
export function writeReplay(runDir: string, replay: Replay): string {
  const { index, details } = splitReplay(replay);
  mkdirSync(runDir, { recursive: true });
  const eventsDir = join(runDir, "replay-events");
  rmSync(eventsDir, { recursive: true, force: true });
  for (const d of details) {
    const path = join(eventsDir, d.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(d.event));
  }
  const indexPath = join(runDir, "replay.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return indexPath;
}

/** Copy a written recording into corpus/replays/<name>/ (replacing what is there). Returns the directory. */
export function commitReplay(runDir: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name)) {
    throw new Error(`Replay name "${name}" must be lowercase letters, digits and hyphens.`);
  }
  const indexPath = join(runDir, "replay.json");
  if (!existsSync(indexPath)) throw new Error(`No replay.json under ${runDir}.`);
  const dest = join(REPLAYS_ROOT, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(indexPath, join(dest, "replay.json"));
  const eventsDir = join(runDir, "replay-events");
  if (existsSync(eventsDir)) cpSync(eventsDir, join(dest, "replay-events"), { recursive: true });
  return dest;
}

/** A stable replay name: "<prefix>-YYYYMMDD-HHMM" (lowercase, hyphenated). */
export function replayName(prefix: string, stamp?: string): string {
  const digits = (stamp ?? new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 12);
  const p = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "replay";
  return `${p}-${digits.slice(0, 8)}-${digits.slice(8, 12)}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function loadGraph(label: string, url: string): Promise<AgreementGraph> {
  return withClient(url, async (c) => {
    const claims = await c.query<{ id: string; text: string; created_by: string; importance: number; status: string | null; credence: number | null; embedding: string | null }>(
      `SELECT c.id, c.text, c.created_by, c.importance, a.status, a.claim_credence AS credence, c.embedding::text AS embedding
         FROM claims c LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
        WHERE c.state = 'active'`
    );
    const edges = await c.query<{ parent: string; child: string; rel: string }>(
      `SELECT parent_claim_id AS parent, child_claim_id AS child, relation_type AS rel FROM claim_relationships`
    );
    const vec = (t: string | null): number[] | null => {
      if (!t) return null;
      try {
        const v = JSON.parse(t) as unknown;
        return Array.isArray(v) ? (v as number[]) : null;
      } catch {
        return null;
      }
    };
    return {
      label,
      claims: claims.rows.map((r) => ({ id: r.id, text: r.text, createdBy: r.created_by, importance: r.importance, status: r.status, credence: r.credence, embedding: vec(r.embedding) })),
      edges: edges.rows,
    };
  });
}

function parseDate(flag: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error(`--${flag}=${value} is not a date`);
  return d;
}

async function main(): Promise<void> {
  const lib = await import("./lib.js");
  const { argFlag, positional, RUNS_ROOT, CORPUS_DATABASE_URL } = lib;
  lib.assertCorpusDb();
  const refA = positional(0);
  const refB = positional(1);
  const name = argFlag("name");
  const since = parseDate("since", argFlag("since"));
  if (!refA || !name || !since) {
    console.error(
      "Usage: corpus:replay -- db --since=<iso> [--until=<iso>] --name=<name> [--kind=ingest] [--cluster=..] [--out=DIR] [--commit-as=<name>]\n" +
        "       corpus:replay -- snap:<a> snap:<b> --since=<iso> --name=<name> [--since-a=.. --since-b=.. --until-a=.. --until-b=..] [--agreement=<path>] [--kind=property|swap] [--cluster=..] [--out=DIR] [--commit-as=<name>]"
    );
    process.exit(1);
  }
  const cluster = argFlag("cluster") ?? null;
  const cfg = (await import("../../src/config.js")).loadConfig();
  const fingerprint = fingerprintFromRecord({
    pipelineEpoch: cfg.pipelineEpoch,
    gitCommit: lib.gitCommit(),
    profile: lib.CORPUS_PROFILE,
    swap: lib.CORPUS_SWAP ? { agent: lib.CORPUS_SWAP.agent, model: lib.CORPUS_SWAP.model } : null,
    models: { extractor: cfg.extractorModel, matcher: cfg.matcherModel, steward: cfg.stewardModel, curator: cfg.curatorModel },
  });
  const outDir = argFlag("out") ?? join(RUNS_ROOT, `replay-${name}`);

  const urlOf = (ref: string): { url: string; database: string } => {
    if (ref === "db") return { url: CORPUS_DATABASE_URL, database: dbNameOf(CORPUS_DATABASE_URL) };
    if (ref.startsWith("snap:")) {
      const url = snapshotUrl(CORPUS_DATABASE_URL, ref.slice(5));
      return { url, database: dbNameOf(url) };
    }
    if (/^postgres(ql)?:\/\//.test(ref)) return { url: ref, database: dbNameOf(ref) };
    throw new Error(`unknown ref "${ref}" (use db | snap:<name> | postgresql://…)`);
  };

  let replay: Replay;
  if (!refB) {
    const { url, database } = urlOf(refA);
    const arm = await collectArm({
      databaseUrl: url,
      since,
      until: parseDate("until", argFlag("until")),
      key: "run",
      label: cluster ?? refA,
      variation: null,
      fingerprint,
      database,
    });
    const kind = (argFlag("kind") ?? "ingest") as ReplayKind;
    replay = assembleReplay({
      kind,
      name,
      title: `${cluster ?? refA}: ${arm.sources.length} source(s) on ${[...new Set(Object.values(fingerprint.models).filter(Boolean))].join(", ") || "?"}`,
      cluster,
      about: `One ${kind} window read back from ${database} since ${since.toISOString()}: each source landing, the Extractor's list, the Matcher's identity decisions, and each Steward's structuring and verdict, with the graph rebuilt from the deltas as they land.`,
      arms: [arm],
    });
  } else {
    const A = urlOf(refA);
    const B = urlOf(refB);
    const [armA, armB] = await Promise.all([
      collectArm({ databaseUrl: A.url, since: parseDate("since-a", argFlag("since-a")) ?? since, until: parseDate("until-a", argFlag("until-a")), key: "a", label: refA, variation: null, fingerprint, database: A.database }),
      collectArm({ databaseUrl: B.url, since: parseDate("since-b", argFlag("since-b")) ?? since, until: parseDate("until-b", argFlag("until-b")), key: "b", label: refB, variation: null, fingerprint, database: B.database }),
    ]);
    let report: AgreementReport;
    let pairs: MatchedPair[];
    const agreementPath = argFlag("agreement");
    if (agreementPath) {
      const { readFileSync } = await import("node:fs");
      const parsed = JSON.parse(readFileSync(agreementPath, "utf8")) as { report: AgreementReport; pairs?: MatchedPair[] };
      report = parsed.report;
      pairs = parsed.pairs ?? [];
    } else {
      const [ga, gb] = await Promise.all([loadGraph(refA, A.url), loadGraph(refB, B.url)]);
      pairs = buildMatching(ga, gb).pairs;
      report = graphAgreement(ga, gb, pairs);
    }
    const kind = (argFlag("kind") ?? "property") as ReplayKind;
    replay = assembleReplay({
      kind,
      name,
      title: `${cluster ?? "two arms"}: ${refA} vs ${refB}`,
      cluster,
      about: `Two arms read back from ${A.database} and ${B.database}, shown side by side, with the claims the agreement metric paired linked across them.`,
      arms: [armA, armB],
      matching: [matchingFromAgreement("a", "b", report, pairs)],
      summary: { claimSetF1: report.claimSet.f1, credenceMeanAbsDiff: report.credence.meanAbsDiff, statusAgreement: report.credence.statusAgreement, edgeEditDistance: report.structure.editDistance },
    });
  }

  const path = writeReplay(outDir, replay);
  const events = replay.arms.reduce((n, a) => n + a.events.length, 0);
  console.log(`  replay: ${path} (${replay.arms.length} arm(s), ${events} event(s), details under ${join(outDir, "replay-events")})`);
  const commitAs = argFlag("commit-as");
  if (commitAs) console.log(`  committed: ${commitReplay(outDir, commitAs)} (run \`npx tsx scripts/sync-frontend-content.ts\` to publish)`);
}

// Run directly (not when imported for its exports by the drivers or tests).
if ((process.argv[1] ?? "").endsWith("replay.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
