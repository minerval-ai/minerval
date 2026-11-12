import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * Where a deployment has more than one label, the database holds every read
 * and write to a clearance (src/db/clearance.ts), and work with nothing in
 * context reads `public` alone. Some work must see every label: migrations,
 * the workers that find work at any label before running each piece at its
 * own, retention, the step that turns enforcement on. It says so through
 * one seam, withSystemClearance(reason, fn), which puts it on the tables'
 * owner's connection, past the policies.
 *
 * Every call of that seam under src/ and scripts/ is listed here with the
 * reason written at the call. A failure means a call was added, moved or
 * reworded without that list changing: decide whether the work really has
 * to see every label (most work does not; a run sees what its label reads,
 * and a sweep can run each piece with runAtLabel), and if it does, add it
 * here with its reason.
 *
 * The same goes for the other ways past the policies: a file that opens a
 * database connection of its own is listed below, with whose connection it
 * is.
 */
const SYSTEM_CALLERS: Record<string, string[]> = {
  "src/index.ts": [
    "Migrations change tables, which only their owner may do, and a migration that updates rows must see every one.",
    "Creating and updating read-only SQL's login roles is the owner's to do.",
    "Deciding whether a failed enforcement check may be passed over reads the label table as the owner.",
    "The page-hash fill writes a hash into every source's own row, whatever its label.",
    "Shutdown hands back every claim this process holds a lease on, whatever its label.",
  ],
  "src/db/enforcement.ts": [
    "The step that turns enforcement on changes every labelled table, which only their owner may do.",
    "The step that turns enforcement on changes every labelled table, which only their owner may do.",
    "Checking enforcement reads the catalog and the label table as the owner, to compare with what a cleared connection sees.",
  ],
  "src/services/setup-service.ts": [
    "A setup part is stored once for every label and numbered across all of them, so storing one must see them all.",
  ],
  "src/services/sql-service.ts": [
    "The key that signs read-only SQL's clearance is readable by the tables' owner alone.",
  ],
  "src/services/trace-service.ts": [
    "A run's log is written at the run's label whatever the work in progress may read, so a step is never refused by the clearance of the moment.",
  ],
  "src/workers/allocation-scheduler.ts": [
    "The scheduler reconciles the ledger and looks for stale or pending work at every label; each piece it starts runs at its own row's label.",
  ],
  "src/workers/audit-scheduler.ts": [
    "The audit scheduler asks for sweeps over decisions made at every label; each audit then runs at the label of its own row.",
  ],
  "src/workers/correspondent-triggers.ts": [
    "The change scan checks every correspondent, whatever its label, and wakes each at its own.",
  ],
  "src/workers/github-issue-sync.ts": [
    "The issue sync looks for unfiled reports at every label; which of them may leave the deployment is decided by the report's own rules, not by what the sync can see.",
  ],
  "src/workers/local-runner.ts": [
    "The runner finds waiting work at every label (queued jobs, covered ledger rows, pending claims); each piece then runs at the label of its own row.",
  ],
  "src/workers/lookout-triggers.ts": [
    "The retraction poll matches notices against sources at every label and queues each lookout's input at that lookout's label.",
    "The graph feed wakes every lookout that watches the graph, whatever its label; each then runs at its own.",
    "The feed poll finds every due feed, whatever its lookout's label, and polls each at that label.",
  ],
  "src/workers/monitor-scheduler.ts": [
    "The monitor looks for candidates among claims at every label and asks for each audit at the claim's label.",
  ],
  "src/workers/poller.ts": [
    "A queue handler loads the row its message names, at whatever label, and then runs the work at that row's label.",
  ],
  "src/workers/queue-depth-sampler.ts": [
    "The sampler counts waiting work at every label. It stores counts and no content.",
  ],
  "src/workers/recovery-sweep.ts": [
    "The recovery sweep finds stalled reviews and orders at every label and re-enqueues each at its own.",
  ],
  "src/workers/report-embedding-backfill.ts": [
    "The backfill gives a vector to reports at every label that lack one. It writes into the report's own row.",
  ],
  "src/workers/source-backfill.ts": [
    "The backfill finds sources at every label that lack facts or segments and fills each at the source's label.",
  ],
  "src/workers/tagging-pipeline.ts": [
    "The tagging drain leases untagged claims at every label and tags each at the claim's label.",
  ],
  "src/workers/trace-retention.ts": ["Retention deletes expired runs at every label."],
  "scripts/enforcement-plans.ts": ["Measuring plans reads the seeded rows as the owner."],
};

/** Files that open a connection themselves, and whose it is. */
const OWN_CONNECTIONS: Record<string, string> = {
  "src/db/client.ts":
    "The pools themselves: the owner's, and one per session, each connection opened with its clearance.",
  "src/services/sql-service.ts":
    "Read-only SQL's own login roles, which hold nothing but the public_read views; their clearance is signed.",
  "scripts/enforcement-plans.ts":
    "Explains statements as the owner and as cleared connections, to compare their plans. Read-only.",
  "scripts/corpus/agreement.ts": "The corpus harness, on its own evaluation database (CORPUS_DATABASE_URL).",
  "scripts/corpus/cascade-load.ts": "The corpus harness, on its own evaluation database.",
  "scripts/corpus/graph-load.ts": "The corpus harness, on its own evaluation database.",
  "scripts/corpus/replay.ts": "The corpus harness, on its own evaluation database.",
  "scripts/corpus/reset.ts": "The corpus harness: drops and rebuilds its own evaluation database.",
  "scripts/corpus/snapshot-core.ts": "The corpus harness: creates and drops its own snapshot databases.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = [...sourceFiles(join(repo, "src")), ...sourceFiles(join(repo, "scripts"))];
const rel = (path: string) => relative(repo, path).split("\\").join("/");

/** The reason of each withSystemClearance call in a file, in order: the literal, or the constant's value. */
function systemReasons(text: string): string[] {
  const constants = new Map(
    [...text.matchAll(/const ([A-Z_]+) =\s*"((?:[^"\\]|\\.)*)";/g)].map((m) => [m[1]!, m[2]!])
  );
  return [...text.matchAll(/withSystemClearance\(\s*(?:"((?:[^"\\]|\\.)*)"|([A-Z_]+))\s*,/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (constants.get(m[2]!) ?? `the constant ${m[2]}`)
  );
}

describe("work that sees every label", () => {
  it("sees the source tree", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("says so through withSystemClearance, and every caller is listed here with its reason", () => {
    const found: Record<string, string[]> = {};
    for (const path of files) {
      const file = rel(path);
      // The seam's own file defines it; it calls it nowhere.
      if (file === "src/db/clearance.ts") continue;
      const text = readFileSync(path, "utf-8");
      const calls = (text.match(/withSystemClearance\(/g) ?? []).length;
      if (calls === 0) continue;
      const reasons = systemReasons(text);
      // A call whose reason is not a literal or a constant in the same file cannot be listed.
      expect(reasons.length, `${file}: each call gives its reason as a string or a constant of the file`).toBe(calls);
      found[file] = reasons;
    }
    expect(found).toEqual(SYSTEM_CALLERS);
  });

  it("gives a reason that is a sentence", () => {
    for (const reasons of Object.values(SYSTEM_CALLERS)) {
      for (const reason of reasons) {
        expect(reason.length, reason).toBeGreaterThan(30);
        expect(reason, reason).toMatch(/\.$/);
      }
    }
  });

  it("opens no connection of its own outside the files listed here", () => {
    const opening = files
      .filter((path) => /new (?:pg\.)?(?:Pool|Client)\(\{/.test(readFileSync(path, "utf-8")))
      .map(rel)
      // An MCP client is not a database connection.
      .filter((file) => !/assistant-tools|elicit-tools/.test(file))
      .sort();
    expect(opening).toEqual(Object.keys(OWN_CONNECTIONS).sort());
  });

  it("is never the session of a test helper outside a test run", async () => {
    const { setNoContextSessionForTests } = await import("../../../src/db/clearance.js");
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => setNoContextSessionForTests({ role: "owner" })).toThrow(/test runs only/);
    } finally {
      process.env.VITEST = vitest;
    }
    const callers = files
      .filter((path) => rel(path) !== "src/db/clearance.ts")
      .filter((path) => readFileSync(path, "utf-8").includes("setNoContextSessionForTests"))
      .map(rel);
    expect(callers).toEqual([]);
  });
});
