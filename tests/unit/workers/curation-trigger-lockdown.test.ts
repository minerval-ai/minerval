/**
 * Curation is judgment-triggered, not automatic.
 *
 * The extraction path used to fire a Curator sweep for every newly created
 * claim (`curatorSweepRate` defaulted to 1, `curatorMaxRuns` to 0 = uncapped).
 * The first live epoch measured what that bought: 122 sweeps on the frontier
 * model, ~570k tokens, ~13 owls, and zero writes to the graph — no merge, no
 * edge, no notification. Predictably so, because the sweep only fired on
 * claims the Matcher had *just* searched the graph for and declared novel.
 *
 * This suite pins the shape of the fix rather than the number: the Curator is
 * reachable only from a trigger that carries an agent's judgment. It reads the
 * sources, because the failure it prevents is a one-line reintroduction of an
 * automatic trigger somewhere in the pipeline — which no behavioural test over
 * the current wiring would catch (same approach as model-guard.test.ts).
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

const callSites = walk(src)
  .map((file) => ({ file, text: readFileSync(file, "utf8") }))
  .filter(({ text }) => /\benqueueCurator\s*\(/.test(text))
  .map(({ file }) => file.slice(repoRoot.length + 1))
  // The queue service defines and exports it; that is not a trigger.
  .filter((f) => f !== "src/services/queue-service.ts")
  .sort();

describe("what can invoke the Curator", () => {
  it("is triggered only by a Steward escalation", () => {
    expect(callSites).toEqual(["src/llm/tools/steward-tools.ts"]);
  });

  it("is not triggered by source extraction", () => {
    // The specific regression: one new claim minted = one frontier-model sweep.
    const extraction = readFileSync(join(src, "workers/url-extraction.ts"), "utf8");
    expect(extraction).not.toMatch(/enqueueCurator/);
  });

  it("has no scheduled or cadence-driven trigger", () => {
    for (const file of walk(src).filter((f) => /scheduler|cron/i.test(f))) {
      expect(readFileSync(file, "utf8")).not.toMatch(/enqueueCurator/);
    }
  });
});
