/**
 * "Hit run and see results" — the corpus harness entry point.
 *
 * This runs the REAL system against the isolated corpus DB: it builds the actual
 * Fastify app and submits each post through the real `POST /sources` route
 * (via in-process injection), then drains the in-memory queues with the same
 * local runner the dev server uses. Inputs and processing are exactly what
 * production does; only the database differs. A trace of every agent message is
 * recorded so inter-agent behavior and propagation are observable.
 *
 * Usage:
 *   tsx scripts/corpus/run.ts [cluster] [flags]
 *
 * Flags:
 *   --no-reset             keep the existing graph (ingest on top of it)
 *   --limit=N              only the first N posts (cheap smoke test)
 *   --posts=id1,id2        only these post IDs
 *   --profile=production   run on the production model pins (lib.ts)
 *   --swap=<agent>:<model> one agent on another model, on top of the profile
 *   --order=reverse|shuffle:<seed>|role:<role>|adversarial
 *                          ingest the selected posts in another order (role:/adversarial
 *                          put a manifest role — or the most partisan one — first)
 *   --dup-suffix=<k>|<a>..<b>|<k1,k2>  (#295 dup-flood) submit every selected post
 *                          again under url?dup=<k>, once per suffix; pair with --no-reset
 *   --foreign=<cluster>:<postId>[,<postId>]  (#295 locality) ingest that other cluster's
 *                          post(s) instead of this cluster's (unless --posts names some)
 *   --reassess-all         (#295 fixpoint) with --no-reset: re-enqueue every stewarded
 *                          claim with trigger staleness_check and drain, ingesting nothing
 *                          unless --posts names posts
 *   --score[=N]            emit a scorecard afterwards (judge sample N)
 *
 * Examples:
 *   npm run corpus:run -- lethalities --limit=2     # quick, cheap
 *   npm run corpus:run -- lethalities               # full cluster
 *   npm run corpus:run -- blackholes --profile=production --score   # a baseline
 *
 * Every run registers itself in the eval-run registry (eval_runs, kind
 * 'ingest') with its configuration fingerprint — epoch, commit, profile, the
 * models each agent was configured with, the spend caps — and, once drained,
 * the models actually observed in llm_usage. corpus:score reads that row
 * back, so a scorecard describes the run that built the graph rather than
 * whatever config happens to be loaded at score time (#334 L1).
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  argFlag,
  assertCorpusDb,
  CORPUS_PROFILE,
  CORPUS_SWAP,
  gitCommit,
  hasFlag,
  loadManifest,
  positional,
  postMarkdownPath,
  postUrl,
  RUNS_ROOT,
} from "./lib.js";
import type { ManifestPost } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { getSessionUsage } from "../../src/llm/budget-tracker.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { resolveProvider } from "../../src/llm/providers/routing.js";
import { getJobById } from "../../src/services/job-service.js";
import { buildApp } from "../../src/server/app.js";
import { drainLocalQueues } from "../../src/workers/local-runner.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { analyzeCascade, readCascade } from "./cascade-lib.js";
import { loadCascadeInput } from "./cascade-load.js";
import type { DrainStats, RunnerEvent } from "../../src/workers/local-runner.js";
import { resetCorpusDb } from "./reset.js";
import { generateReport } from "./report.js";
import { scoreRun, type RunFingerprint } from "./score.js";
import { observedModels } from "./fingerprint.js";

function formatActivity(stats: DrainStats): string {
  const acts = Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`);
  const errs = Object.values(stats.errors).reduce((a, b) => a + b, 0);
  let s = acts.join(", ") || "no follow-up work";
  if (errs) s += `, ${errs} handler errors`;
  if (stats.capped) s += " (CAPPED — did not reach quiescence)";
  return s;
}

// Exact run cost, read back from llm_usage — the durable meter every provider
// adapter writes at raw, per-model rates (including refusal fallbacks and
// OpenRouter provider-reported cost). A context-carried cost meter can NOT
// see this run's drained work: the steward pipeline and engine executor wrap
// each operation in their own withCostMeter for cap-and-settle, and nested
// meters shadow outer ones by design. llm_usage has no such scoping — every
// call in the window lands there, so summing the window is the whole truth.
// The window opens at process start; llm_usage is deliberately NOT truncated
// by corpus:reset, so timestamps are the right filter.
const RUN_STARTED_AT = new Date();

/** The fingerprint as configured, recorded before the first LLM call. */
function configuredFingerprint(): RunFingerprint {
  const cfg = loadConfig();
  return {
    pipelineEpoch: cfg.pipelineEpoch,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    swap: CORPUS_SWAP ? { agent: CORPUS_SWAP.agent, model: CORPUS_SWAP.model } : null,
    order: argFlag("order") ?? null,
    models: {
      extractor: cfg.extractorModel,
      matcher: cfg.matcherModel,
      steward: cfg.stewardModel,
      curator: cfg.curatorModel,
    },
    caps: {
      stewardMaxRuns: cfg.stewardMaxRuns,
      stewardMaxIterations: cfg.stewardMaxIterations,
      curatorMaxRuns: cfg.curatorMaxRuns,
      curatorSweepRate: cfg.curatorSweepRate,
      llmDailyTokenLimit: cfg.llmDailyTokenLimit,
      llmHourlyTokenLimit: cfg.llmHourlyTokenLimit,
    },
  };
}

/** Exact metered cost of the run window, in micro-USD (raw rates, per llm_usage). */
async function meteredCostSinceStart(): Promise<number | null> {
  try {
    const [row] = await rawQuery<{ micro: string | null }>(
      `SELECT SUM(cost_micro_usd) AS micro FROM llm_usage WHERE created_at >= $1`,
      [RUN_STARTED_AT]
    );
    return Number(row?.micro ?? 0);
  } catch {
    return null;
  }
}

/** Per-agent models actually seen in llm_usage since the run window opened. */
async function observedSinceStart(): Promise<Record<string, string[]>> {
  const rows = await rawQuery<{ agent: string; model: string; calls: number }>(
    `SELECT agent, model, COUNT(*)::int AS calls
       FROM llm_usage WHERE created_at >= $1
      GROUP BY agent, model`,
    [RUN_STARTED_AT]
  );
  return observedModels(rows);
}

/**
 * The API keys this run's configured models need, by provider: every agent's
 * model routes somewhere (routing.ts), and embeddings always need OpenAI. A
 * production-profile run puts the Matcher on OpenRouter, so a fixed
 * "Anthropic + OpenAI" preflight would let it start and fail on the first
 * match.
 */
function missingKeys(): string[] {
  const cfg = loadConfig();
  const keyFor = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
  const needed = new Set<string>(["OPENAI_API_KEY"]);
  for (const model of [cfg.extractorModel, cfg.matcherModel, cfg.stewardModel, cfg.curatorModel]) {
    const provider = resolveProvider(model);
    if (provider) needed.add(keyFor[provider]);
  }
  return [...needed].filter((k) => !process.env[k]);
}

async function printUsage(label: string): Promise<void> {
  const u = getSessionUsage();
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const cacheTotalInput = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const hitRate =
    cacheTotalInput > 0 ? ((u.cacheReadTokens / cacheTotalInput) * 100).toFixed(0) : "0";
  console.log(
    `\n=== LLM usage (${label}) ===\n` +
      `  calls: ${u.calls}\n` +
      `  input:  ${k(u.inputTokens)} fresh + ${k(u.cacheReadTokens)} cache-read ` +
      `+ ${k(u.cacheCreationTokens)} cache-write  (cache hit rate ${hitRate}%)\n` +
      `  output: ${k(u.outputTokens)}`
  );
  try {
    const rows = await rawQuery<{ agent: string; model: string; calls: number; micro: string }>(
      `SELECT agent, model, COUNT(*)::int AS calls, SUM(cost_micro_usd) AS micro
         FROM llm_usage WHERE created_at >= $1
        GROUP BY agent, model ORDER BY SUM(cost_micro_usd) DESC`,
      [RUN_STARTED_AT]
    );
    let total = 0;
    for (const r of rows) {
      total += Number(r.micro);
      console.log(
        `    ${r.agent.padEnd(10)} ${r.model.padEnd(28)} ${String(r.calls).padStart(4)} calls  ${formatMicroUsd(Number(r.micro))}`
      );
    }
    console.log(`  metered cost (exact, raw rates): ${formatMicroUsd(total)}`);
  } catch (err) {
    console.log(
      `  metered cost unavailable (${err instanceof Error ? err.message : err})`
    );
  }
}

/** A selected post, with the cluster whose posts/ dir holds its markdown. */
type SelectedPost = ManifestPost & { cluster: string };

function selectPosts(cluster: string, all: ManifestPost[]): SelectedPost[] {
  const only = argFlag("posts")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limitRaw = argFlag("limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`Invalid --limit=${limitRaw} (expected a positive integer).`);
      process.exit(1);
    }
  }
  let posts: SelectedPost[] = all.map((p) => ({ ...p, cluster }));
  if (only?.length) posts = posts.filter((p) => only.includes(p.id));
  if (limit !== undefined) posts = posts.slice(0, limit);
  // --- #295 S3 flags (property arms) ------------------------------------
  // --foreign: posts from ANOTHER cluster (locality's arm B). They replace
  // this cluster's selection unless --posts named some of it explicitly.
  const foreign = parseForeign(argFlag("foreign"));
  if (foreign) {
    const other = loadManifest(foreign.cluster);
    const picked = foreign.ids.map((id) => {
      const p = other.posts.find((x) => x.id === id);
      if (!p) throw new Error(`--foreign: post "${id}" is not in corpus/${foreign.cluster}/manifest.json`);
      return { ...p, cluster: foreign.cluster };
    });
    posts = only?.length ? [...posts, ...picked] : picked;
  }
  // --reassess-all: an empty ingest unless --posts named some.
  if (hasFlag("reassess-all") && !only?.length && !foreign) posts = [];
  // -----------------------------------------------------------------------
  return orderPosts(posts, argFlag("order"), (p) => p.role);
}

/** `<cluster>:<id>[,<id>]` → the other cluster and its post ids. */
export function parseForeign(raw: string | undefined): { cluster: string; ids: string[] } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i <= 0 || i === raw.length - 1) throw new Error(`--foreign must be <cluster>:<postId>[,<postId>], got "${raw}"`);
  const ids = raw.slice(i + 1).split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error(`--foreign must name at least one post id, got "${raw}"`);
  return { cluster: raw.slice(0, i), ids };
}

/**
 * Duplicate suffixes (#295 dup-flood): `3` → ["3"], `1..3` → ["1","2","3"],
 * `a,b` → ["a","b"]. Each selected post is submitted once per suffix under
 * `<url>?dup=<k>` — a distinct URL, so the sources table's uniqueness lets
 * it in and extraction runs again over the same text.
 */
export function parseDupSuffixes(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  const range = /^(\d+)\.\.(\d+)$/.exec(raw);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (hi < lo) throw new Error(`--dup-suffix range must ascend, got "${raw}"`);
    return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
  }
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error(`--dup-suffix parts must be [A-Za-z0-9_-], got "${raw}"`);
  return parts;
}

/** `<url>?dup=<k>` (or `&dup=<k>` when the url already has a query). */
export function dupUrl(url: string, suffix: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}dup=${encodeURIComponent(suffix)}`;
}

/**
 * Which manifest role counts as the most partisan, for `--order=adversarial`
 * (#295's adversarial ordering: anchor the graph on the most one-sided
 * source and see whether it gets first-mover advantage). Roles are free
 * text in manifest.json; the first keyword here that some role contains
 * wins, and when none matches the LAST post goes first (clusters are
 * ordered foundational → dissent, so the last is the usual dissenter).
 */
export const PARTISAN_ROLE_KEYWORDS = [
  "dissent",
  "skeptic",
  "contrarian",
  "lab-leak-case",
  "counterargument",
  "conflicting",
  "primary-source",
  "case",
  "anchor",
  "response",
] as const;

export function pickAdversarialFirst<T>(posts: T[], roleOf: (p: T) => string | undefined): number {
  if (posts.length === 0) return -1;
  for (const kw of PARTISAN_ROLE_KEYWORDS) {
    const i = posts.findIndex((p) => (roleOf(p) ?? "").toLowerCase().includes(kw));
    if (i >= 0) return i;
  }
  return posts.length - 1;
}

/**
 * Ingest order (#334 S3 tier 1, path independence): matching is stateful —
 * the first phrasing ingested becomes the canonical node and later ones
 * attach to it — so the same posts in another order can produce another
 * graph. `reverse` and `shuffle:<seed>` (a seeded Fisher–Yates, so a
 * permutation is reproducible) let the property runner build the second arm.
 */
export function orderPosts<T>(posts: T[], order: string | undefined, roleOf?: (p: T) => string | undefined): T[] {
  if (!order) return posts;
  if (order === "reverse") return [...posts].reverse();
  // --- #295 adversarial ordering: a role first, or the most partisan one.
  if (order === "adversarial" || order.startsWith("role:")) {
    const role = (p: T) => (roleOf ? roleOf(p) : (p as { role?: string }).role);
    if (order === "adversarial") {
      const i = pickAdversarialFirst(posts, role);
      if (i < 0) return posts;
      return [posts[i]!, ...posts.filter((_, j) => j !== i)];
    }
    const wanted = order.slice(5);
    const first = posts.filter((p) => role(p) === wanted);
    if (first.length === 0) throw new Error(`--order=role:${wanted}: no selected post carries that role`);
    return [...first, ...posts.filter((p) => role(p) !== wanted)];
  }
  // -----------------------------------------------------------------------
  const m = /^shuffle:(\d+)$/.exec(order);
  if (m) {
    let seed = Number(m[1]) >>> 0;
    const next = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = [...posts];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  throw new Error(`--order must be "reverse", "shuffle:<seed>", "role:<role>" or "adversarial", got "${order}"`);
}

async function main(): Promise<void> {
  const cluster = positional(0) ?? "lethalities";
  const manifest = loadManifest(cluster);
  const posts = selectPosts(cluster, manifest.posts);
  // --- #295 S3 flags: duplicates, and a re-stewarding pass over the graph.
  const dupSuffixes = parseDupSuffixes(argFlag("dup-suffix"));
  const reassessAll = hasFlag("reassess-all");
  if ((reassessAll || dupSuffixes.length > 0) && !hasFlag("no-reset")) {
    console.error("--reassess-all and --dup-suffix act on an existing graph: pass --no-reset (restore a snapshot first).");
    process.exit(1);
  }
  // -----------------------------------------------------------------------

  // Preflight: an embeddings key plus a key for every provider the configured
  // agent models route to.
  const missing = missingKeys();
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}. Set them in .env.`);
    process.exit(1);
  }

  // Don't run a destructive reset just to ingest nothing.
  if (posts.length === 0 && !reassessAll) {
    console.error("No posts selected (check --posts / --limit / manifest). Not resetting.");
    process.exit(1);
  }

  // Backstop: confirm we resolved the isolated corpus DB, not the main graph,
  // before we reset or write anything.
  assertCorpusDb();

  const fingerprint = configuredFingerprint();
  console.log(`\n=== corpus run: ${cluster} — ${posts.length} post(s) ===`);
  console.log(
    `  epoch ${fingerprint.pipelineEpoch} · commit ${fingerprint.gitCommit ?? "?"}` +
      (fingerprint.profile ? ` · profile ${fingerprint.profile}` : "") +
      `\n  extractor ${fingerprint.models.extractor} · matcher ${fingerprint.models.matcher}` +
      ` · steward ${fingerprint.models.steward} · curator ${fingerprint.models.curator}`
  );

  if (!hasFlag("no-reset")) {
    console.log("Resetting corpus DB…");
    await resetCorpusDb();
  } else {
    console.log("--no-reset: ingesting on top of the existing graph");
  }

  const runDir = join(RUNS_ROOT, `${cluster}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDir, { recursive: true });
  const trace: RunnerEvent[] = [];

  // Register the run before the first LLM call, so even an aborted run leaves
  // its fingerprint behind. Best-effort: the registry must never block a run.
  let registryId: string | null = null;
  try {
    const [row] = await getDb()
      .insert(evalRuns)
      .values({
        cluster,
        kind: "ingest",
        config: {
          ...fingerprint,
          posts: posts.map((p) => p.id),
          noReset: hasFlag("no-reset"),
          dupSuffixes,
          foreign: argFlag("foreign") ?? null,
          reassessAll,
        },
        runDir,
      })
      .returning({ id: evalRuns.id });
    registryId = row?.id ?? null;
    if (registryId) console.log(`  registered ingest run ${registryId.slice(0, 8)}`);
  } catch (err) {
    console.warn(
      "[run] eval-run registry write failed (the run proceeds unregistered):",
      err instanceof Error ? err.message : err
    );
  }

  // The actual production app, pointed at the corpus DB.
  const app = await buildApp();
  let succeeded = 0;
  let anyCapped = false;

  // --- #295 dup-flood: each post once per suffix, under a distinct url.
  const items: Array<SelectedPost & { url: string; dup: string | null }> =
    dupSuffixes.length > 0
      ? dupSuffixes.flatMap((k) => posts.map((p) => ({ ...p, url: dupUrl(postUrl(p), k), dup: k })))
      : posts.map((p) => ({ ...p, url: postUrl(p), dup: null }));
  if (dupSuffixes.length > 0) console.log(`  --dup-suffix: ${posts.length} post(s) × ${dupSuffixes.length} suffix(es) = ${items.length} submission(s)`);
  // -----------------------------------------------------------------------
  try {
    for (const [i, p] of items.entries()) {
      const tag = `[${i + 1}/${items.length}]`;
      const mdPath = postMarkdownPath(p.cluster, p.id);
      if (!existsSync(mdPath)) {
        console.log(`  ${tag} ${p.id} — MISSING markdown; run \`npm run corpus:fetch\` first`);
        continue;
      }
      const content = readFileSync(mdPath, "utf8");
      const url = p.url;

      process.stdout.write(`  ${tag} ${(p.dup ? `[dup ${p.dup}] ` : "") + p.title.slice(0, 50).padEnd(50)} submit…`);
      const started = Date.now();
      try {
        // Submit through the real route, exactly as an API client would.
        const res = await app.inject({
          method: "POST",
          url: "/sources",
          payload: { url, title: p.title, content },
        });
        if (res.statusCode !== 202) {
          console.log(` ✗ POST /sources -> ${res.statusCode} ${res.body.slice(0, 120)}`);
          continue;
        }
        const { job_id } = res.json() as { job_id: string };

        // Drive the whole organization to a stable state, tracing every message.
        const before = trace.length;
        const stats = await drainLocalQueues({ onEvent: (e) => trace.push(e) });

        if (stats.capped) anyCapped = true;

        const finished = await getJobById(job_id);
        const r = (finished?.result ?? {}) as Record<string, number>;
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(
          ` ✓ ${r.claims_extracted ?? "?"} extracted, ` +
            `${r.claims_created ?? "?"} new / ${r.claims_matched ?? "?"} matched ` +
            `(${secs}s, ${trace.length - before} agent msgs)\n      agents: ${formatActivity(stats)}`
        );
        succeeded++;
      } catch (err) {
        const msg = (err as Error).message;
        console.log(` ✗ ${msg}`);
        // Drain whatever this post already enqueued so partial work is processed
        // and attributed here, not orphaned or leaked into the next post.
        await drainLocalQueues({ onEvent: (e) => trace.push(e) }).catch(() => {});
        if (/budget/i.test(msg)) {
          console.log("\nLLM budget exceeded — stopping early. Report covers what was ingested.");
          break;
        }
      }
    }
    // --- #295 fixpoint: re-enqueue every stewarded claim and drain again.
    // The trigger is the staleness sweep's, so the Steward is asked exactly
    // what a cadence check asks: re-examine, and re-affirm cheaply if
    // nothing moved. A stable graph should come back unchanged.
    if (reassessAll) {
      const done = await rawQuery<{ id: string }>(
        `SELECT id FROM claims WHERE state = 'active' AND steward_state = 'done' ORDER BY importance DESC`
      );
      console.log(`  --reassess-all: re-enqueueing ${done.length} stewarded claim(s) with trigger staleness_check…`);
      for (const c of done) {
        await enqueueSteward({
          claimId: c.id,
          trigger: "staleness_check",
          context:
            "Fixpoint check (corpus:property fixpoint): nothing is known to have changed. " +
            "Re-examine whether the evidence landscape has moved; if nothing material changed, " +
            "re-affirm cheaply and record a low marginal_yield.",
        });
      }
      const before = trace.length;
      const started = Date.now();
      try {
        const stats = await drainLocalQueues({ onEvent: (e) => trace.push(e) });
        if (stats.capped) anyCapped = true;
        console.log(`  reassessed in ${((Date.now() - started) / 1000).toFixed(0)}s, ${trace.length - before} agent msgs\n      agents: ${formatActivity(stats)}`);
      } catch (err) {
        console.log(`  reassess-all drain failed: ${(err as Error).message}`);
      }
    }
    // -----------------------------------------------------------------------
  } finally {
    await app.close();
  }

  // Observability artifact: the full ordered stream of agent activity.
  writeFileSync(join(runDir, "trace.jsonl"), trace.map((e) => JSON.stringify(e)).join("\n"));

  // Close the fingerprint with what actually ran: the models llm_usage saw
  // per agent (a second model under an agent means a fallback fired), and
  // whether any drain hit its cap. run.json is the file-side copy; the
  // registry row is what corpus:score reads.
  const observed = await observedSinceStart().catch(() => ({}) as Record<string, string[]>);
  const costMicroUsd = await meteredCostSinceStart();
  const finished: RunFingerprint = { ...fingerprint, observed };
  const runRecord = {
    ...finished,
    cluster,
    registryId,
    startedAt: RUN_STARTED_AT.toISOString(),
    finishedAt: new Date().toISOString(),
    posts: posts.map((p) => p.id),
    postClusters: posts.map((p) => p.cluster),
    dupSuffixes,
    reassessAll,
    postsIngested: succeeded,
    capped: anyCapped,
    costMicroUsd,
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(runRecord, null, 2));
  if (registryId) {
    try {
      await getDb()
        .update(evalRuns)
        .set({ config: runRecord })
        .where(eq(evalRuns.id, registryId));
    } catch (err) {
      console.warn(
        "[run] eval-run registry update failed (run.json is intact):",
        err instanceof Error ? err.message : err
      );
    }
  }
  for (const [agent, models] of Object.entries(observed)) {
    if (models.length > 1) {
      console.log(`  note: ${agent} ran on more than one model (${models.join(", ")}) — a fallback fired.`);
    }
  }

  console.log(`\n${succeeded}/${items.length} posts ingested. Generating report…`);
  const reportPath = await generateReport(cluster, runDir);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Trace:  ${join(runDir, "trace.jsonl")} (${trace.length} agent messages)`);
  console.log("Read the report alongside corpus/RUBRIC.md.");

  // --- #295 cascade stability: the propagation this run's drains produced,
  // reconstructed from the telemetry of the run window (corpus:cascade for
  // the full table). Best-effort: a telemetry hiccup must never fail a run.
  try {
    const cascade = analyzeCascade(
      await loadCascadeInput(process.env.DATABASE_URL!, { since: RUN_STARTED_AT.toISOString() })
    );
    const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
    console.log(
      `\nCascade: R ${f(cascade.R)} · ${cascade.cascades.roots} root(s), ${cascade.cascades.propagating} propagating, max size ${cascade.cascades.maxSize} / depth ${cascade.cascades.maxDepth}` +
        ` · oscillations ${cascade.oscillations.status + cascade.oscillations.credence} · coalesced ${f(cascade.coalescing.share)}`
    );
    console.log(`  ${readCascade(cascade)}`);
    writeFileSync(join(runDir, "cascade.json"), JSON.stringify({ generatedAt: new Date().toISOString(), since: RUN_STARTED_AT.toISOString(), report: cascade }, null, 2));
  } catch (err) {
    console.log(`  cascade summary unavailable (${err instanceof Error ? err.message : err})`);
  }
  // -----------------------------------------------------------------------

  // Optional scored scorecard (#99). --score emits structural metrics + a
  // bounded LLM-judge sample into the same run dir; --score=N sets the sample
  // size; --score=0 is structural-only (free). Off by default so a plain run
  // stays cheap. The scorecard carries THIS run's fingerprint.
  const scoreFlag = argFlag("score");
  if (scoreFlag !== undefined) {
    const sample = scoreFlag === "" ? undefined : Number(scoreFlag);
    console.log("\nScoring the run…");
    const { dir } = await scoreRun(cluster, {
      sample: Number.isFinite(sample) ? sample : undefined,
      judge: sample !== 0,
      outDir: runDir,
      fingerprint: finished,
      allowSameModelJudge: hasFlag("allow-same-model-judge"),
    });
    console.log(`Scorecard: ${join(dir, "scorecard.md")}`);
  }

  await printUsage("this run");

  await closeDb();
}

// Run directly (not when imported for its pure helpers, e.g. by tests).
if ((process.argv[1] ?? "").endsWith("run.ts")) {
  main().catch(async (err) => {
    console.error(err);
    // Still report what the run cost before it failed — a crash shouldn't hide spend.
    try {
      await printUsage("partial — run errored");
    } catch {
      /* usage reporting is best-effort */
    }
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
