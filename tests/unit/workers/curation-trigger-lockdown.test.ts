/**
 * Curation is chosen and funded, not automatic.
 *
 * The extraction path used to fire a Curator sweep for every newly created
 * claim (`curatorSweepRate` defaulted to 1, `curatorMaxRuns` to 0 = uncapped).
 * The first live epoch measured what that bought: 122 sweeps on the frontier
 * model, ~570k tokens, ~13 owls, and zero writes to the graph — no merge, no
 * edge, no notification. Predictably so, because the sweep only fired on
 * claims the Matcher had *just* searched the graph for and declared novel.
 *
 * Since #363 the Curator runs only as a funded `curate` ledger action: a
 * request records a concern, a mandate values and funds the row, and the
 * engine executor runs it. This suite pins that shape rather than a number:
 * the Curator is reachable only through the executor, and requests come only
 * from an agent's judgment (a Steward's escalation) or the bounded scan. It
 * reads the sources, because the failure it prevents is a one-line
 * reintroduction of an automatic trigger somewhere in the pipeline — which no
 * behavioural test over the current wiring would catch (same approach as
 * model-guard.test.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = join(repoRoot, "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

const sources = walk(src).map((file) => ({
  file: file.slice(repoRoot.length + 1),
  text: readFileSync(file, "utf8"),
}));

function callersOf(pattern: RegExp, definedIn: string): string[] {
  return sources
    .filter(({ text }) => pattern.test(text))
    .map(({ file }) => file)
    .filter((f) => f !== definedIn)
    .sort();
}

describe("what can invoke the Curator", () => {
  it("runs only as a funded ledger action, through the engine executor", () => {
    expect(callersOf(/\brunCurator\s*\(/, "src/llm/agents/curator.ts")).toEqual([
      "src/workers/engine-executor.ts",
    ]);
  });

  it("is requested only by a Steward's escalation (the scan lives beside requestCuration)", () => {
    expect(
      callersOf(/\brequestCuration\s*\(/, "src/services/curation-service.ts")
    ).toEqual(["src/llm/tools/steward-tools.ts"]);
  });

  it("has no curate row opened outside the ledger's own producer", () => {
    expect(
      callersOf(/\bensureCurateAction\s*\(/, "src/services/action-service.ts")
    ).toEqual(["src/services/curation-service.ts", "src/workers/engine-executor.ts"]);
    // No hand-rolled INSERT of a curate row anywhere else.
    for (const { file, text } of sources) {
      if (file === "src/services/action-service.ts") continue;
      expect(text, file).not.toMatch(/VALUES\s*\(\s*'curate'/);
    }
  });

  it("is not triggered by source extraction", () => {
    // The specific regression: one new claim minted = one frontier-model sweep.
    const extraction = readFileSync(join(src, "workers/url-extraction.ts"), "utf8");
    expect(extraction).not.toMatch(/requestCuration|runCurator|scanReconcileCandidates/);
  });

  it("has no scheduled trigger but the bounded scan, and the scan ships off", () => {
    for (const { file, text } of sources.filter((s) => /scheduler|cron/i.test(s.file))) {
      expect(text, file).not.toMatch(/\brequestCuration\s*\(|\brunCurator\s*\(/);
    }
    const policy = readFileSync(join(src, "services/allocation-policy-service.ts"), "utf8");
    expect(policy).toMatch(/reconcile_candidates_max_per_sweep: 0,/);
  });
});
