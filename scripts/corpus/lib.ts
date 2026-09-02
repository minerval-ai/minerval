/**
 * Shared setup for the corpus test harness.
 *
 * Importing this module has one critical side effect: it points DATABASE_URL at
 * an isolated corpus database so that resets and runs never touch the main
 * Minerval graph. This MUST run before any src/* code calls loadConfig() (which
 * caches on first read), so every corpus entry script imports this file first.
 */
import { config as loadDotenv } from "dotenv";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";
import { applyProductionProfile } from "./production-pins.js";

loadDotenv(); // pull ANTHROPIC_API_KEY / OPENAI_API_KEY etc. from .env if present

// Dedicated, disposable database. Override with CORPUS_DATABASE_URL if you want
// to point somewhere else, but it must NOT be the main `episteme` database.
const DEFAULT_CORPUS_DB =
  "postgresql://episteme:episteme_dev@localhost:5432/episteme_corpus";
export const CORPUS_DATABASE_URL =
  process.env.CORPUS_DATABASE_URL ?? DEFAULT_CORPUS_DB;

// Force all downstream src/* code onto the corpus DB.
process.env.DATABASE_URL = CORPUS_DATABASE_URL;
// Never treat a corpus run as production (avoids the RDS SSL bundle requirement).
if (process.env.ENVIRONMENT === "production") {
  process.env.ENVIRONMENT = "development";
}
// Keep the real app's request/worker logging quiet by default so the harness's
// own structured output stays readable; override with LOG_LEVEL for debugging.
process.env.LOG_LEVEL ??= "warn";
// Belt-and-suspenders: make sure we never accidentally drain to real SQS.
delete process.env.SQS_URL_EXTRACTION_QUEUE;
delete process.env.SQS_CLAIM_PIPELINE_QUEUE;

/**
 * Model profile (#334). `--profile=production` (or CORPUS_PROFILE=production)
 * runs the harness on the per-agent model pins from the CDK task definition,
 * so a baseline measures the configuration production actually runs rather
 * than the config.ts defaults — the first epoch baseline (#349) was cut on the
 * Sonnet default Steward while production ran Fable. The pins override any
 * *_MODEL already in the environment: a profile means "as production", and a
 * stray override in .env must not quietly make it something else. Applied
 * here, at import, for the same reason DATABASE_URL is: it has to land before
 * any src module caches config.
 */
export const CORPUS_PROFILE: string | null =
  argFlag("profile") ?? process.env.CORPUS_PROFILE ?? null;
if (CORPUS_PROFILE === "production") {
  const pins = applyProductionProfile();
  console.log(
    `profile: production — ${pins.map((p) => `${p.envVar}=${p.model}`).join(", ")}`
  );
} else if (CORPUS_PROFILE !== null) {
  throw new Error(
    `Unknown profile "${CORPUS_PROFILE}" (known: production). ` +
      `Omit --profile to run on the config defaults plus your .env overrides.`
  );
}

/**
 * Fail loudly if the DB the app actually resolved is not the isolated corpus DB.
 * This is the runtime backstop for the import-ordering contract above: if any
 * src module ever causes loadConfig() to cache before DATABASE_URL was pinned,
 * we abort here rather than silently writing to (or truncating) the main graph.
 * Call this before any destructive or write operation.
 */
export function assertCorpusDb(): void {
  const active = loadConfig().databaseUrl;
  if (active !== CORPUS_DATABASE_URL) {
    throw new Error(
      `Active database (${active}) is not the corpus DB (${CORPUS_DATABASE_URL}). ` +
        `Config was likely cached before lib.ts pinned DATABASE_URL — check import ordering.`
    );
  }
  if (new URL(active).pathname.replace(/^\//, "") === "episteme") {
    throw new Error("Refusing to operate on the main 'episteme' database.");
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const CORPUS_ROOT = join(REPO_ROOT, "corpus");
export const RUNS_ROOT = join(REPO_ROOT, "runs");
/**
 * Committed scorecard history (#334 phase 0). runs/ is gitignored, so without
 * this there is nowhere a past run's numbers survive — the regression history
 * docs/graph-epochs.md describes. corpus:score writes a copy of every
 * scorecard.json here; commit the ones from runs you want as baselines.
 */
export const SCORECARDS_ROOT = join(CORPUS_ROOT, "scorecards");
export const MIGRATIONS_DIR = join(REPO_ROOT, "src", "db", "migrations");

export function clusterDir(name: string): string {
  return join(CORPUS_ROOT, name);
}
export function postsDir(name: string): string {
  return join(clusterDir(name), "posts");
}
export function manifestPath(name: string): string {
  return join(clusterDir(name), "manifest.json");
}
export function postMarkdownPath(name: string, id: string): string {
  return join(postsDir(name), `${id}.md`);
}
export function postSidecarPath(name: string, id: string): string {
  return join(postsDir(name), `${id}.json`);
}

export interface ManifestPost {
  id: string;
  /** LessWrong slug — used to build the canonical post URL. Optional for `web`
   *  clusters, which carry an explicit `url` instead. */
  slug?: string;
  /** Explicit source URL. Required for `web` clusters; for `lesswrong` clusters
   *  it is derived from id + slug when absent. This is the provenance recorded
   *  on the ingested source. */
  url?: string;
  title: string;
  author: string;
  role?: string;
}
export interface Manifest {
  cluster: string;
  /**
   * How the post markdown is sourced:
   *   "lesswrong" (default) — fetched from the LessWrong GraphQL API by id.
   *   "web"                 — curated, committed markdown from arbitrary public
   *                           sources; each post carries its own `url`. There is
   *                           no programmatic refetch (the committed `.md` is the
   *                           pinned source of truth), so `corpus:fetch` is a
   *                           no-op for these clusters.
   */
  kind?: "lesswrong" | "web";
  description: string;
  source: string;
  posts: ManifestPost[];
}

/** Canonical source URL for a post: explicit `url` wins, else the LessWrong form. */
export function postUrl(p: ManifestPost): string {
  if (p.url) return p.url;
  return `https://www.lesswrong.com/posts/${p.id}/${p.slug ?? ""}`;
}

export function loadManifest(name: string): Manifest {
  return JSON.parse(readFileSync(manifestPath(name), "utf8")) as Manifest;
}

/** Short git commit of the working tree, for run fingerprints; null outside a checkout. */
export function gitCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// --- tiny CLI helpers -------------------------------------------------------

/** Value of a `--name=value` flag, or undefined. */
export function argFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

/** Whether a bare `--name` flag is present. */
export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

/** The i-th non-flag positional argument. */
export function positional(i: number): string | undefined {
  return process.argv.slice(2).filter((a) => !a.startsWith("--"))[i];
}
