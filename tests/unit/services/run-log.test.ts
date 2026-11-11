import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asStored,
  canonicalContent,
  chainChecker,
  checkChain,
  genesisHash,
  stepHash,
  type ChainedStep,
} from "../../../src/services/run-log.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const RUN = "11111111-1111-1111-1111-111111111111";

/** A chain over the given (kind, content) pairs, as the writer would make it. */
function chain(steps: Array<[string, unknown]>, runId = RUN): ChainedStep[] {
  let prev = genesisHash(runId);
  return steps.map(([kind, content], seq) => {
    const stored = asStored(content);
    const hash = stepHash(prev, seq, kind, stored);
    const row = { seq, kind, content: stored, prev_hash: prev, hash };
    prev = hash;
    return row;
  });
}

const sealOf = (steps: ChainedStep[]) => ({
  logHash: steps.at(-1)?.hash ?? genesisHash(RUN),
  stepsCounted: steps.length,
});

describe("the run log's hashes", () => {
  it("are plain sha256 over lines anyone can write down", () => {
    expect(genesisHash(RUN)).toBe(sha(`minerval-run-log/1\n${RUN}`));
    const content = { b: [1, { d: null, c: "x" }], a: "é" };
    expect(canonicalContent(content)).toBe('{"a":"é","b":[1,{"c":"x","d":null}]}');
    expect(stepHash("p", 3, "assistant", content)).toBe(
      sha(`p\n3\nassistant\n{"a":"é","b":[1,{"c":"x","d":null}]}`)
    );
  });

  it("do not depend on key order or on the case of the run id", () => {
    expect(stepHash("p", 0, "k", { a: 1, b: 2 })).toBe(stepHash("p", 0, "k", { b: 2, a: 1 }));
    expect(genesisHash(RUN.toUpperCase())).toBe(genesisHash(RUN));
  });

  it("start from the run, so a step cannot be moved to another run", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    const steps = chain([["prompt", { model: "m" }]]);
    expect(checkChain(other, steps, null).problem).toEqual({ seq: 0, reason: "prev_hash_mismatch" });
  });
});

describe("checking a chain", () => {
  const steps = chain([
    ["prompt", { model: "m", system: "s" }],
    ["assistant", { stopReason: "tool_use", content: [{ type: "text", text: "hm" }] }],
    ["tool_results", [{ name: "search", input: { q: "x" }, output: "found" }]],
    ["assistant", { stopReason: "end_turn", content: [] }],
  ]);

  it("passes a whole, sealed log, in whatever order the rows arrive", () => {
    const check = checkChain(RUN, [...steps].reverse(), sealOf(steps));
    expect(check).toEqual({ steps_checked: 4, head: steps[3].hash, problem: null });
  });

  it("passes an open run's log so far", () => {
    expect(checkChain(RUN, steps.slice(0, 2), null).problem).toBeNull();
  });

  it("passes a sealed run with no steps", () => {
    expect(checkChain(RUN, [], { logHash: genesisHash(RUN), stepsCounted: 0 }).problem).toBeNull();
  });

  it("finds a step whose content was changed", () => {
    const altered = steps.map((s) => (s.seq === 2 ? { ...s, content: [{ name: "search", output: "other" }] } : s));
    expect(checkChain(RUN, altered, sealOf(steps)).problem).toEqual({ seq: 2, reason: "hash_mismatch" });
  });

  it("finds a changed step even when its own hash was recomputed to match", () => {
    const content = [{ name: "search", output: "other" }];
    const forged = steps.map((s) =>
      s.seq === 2 ? { ...s, content, hash: stepHash(s.prev_hash!, 2, s.kind, content) } : s
    );
    expect(checkChain(RUN, forged, sealOf(steps)).problem).toEqual({ seq: 3, reason: "prev_hash_mismatch" });
  });

  it("finds a step removed from the middle", () => {
    const cut = steps.filter((s) => s.seq !== 1);
    expect(checkChain(RUN, cut, sealOf(steps)).problem).toEqual({ seq: 1, reason: "missing" });
  });

  it("finds steps trimmed from the end of a sealed log", () => {
    expect(checkChain(RUN, steps.slice(0, 3), sealOf(steps)).problem).toEqual({
      seq: 3,
      reason: "fewer_steps_than_counted",
    });
  });

  it("finds a step added after the seal", () => {
    const extended = chain([
      ...steps.map((s) => [s.kind, s.content] as [string, unknown]),
      ["assistant", { stopReason: "end_turn", content: [{ type: "text", text: "added" }] }],
    ]);
    expect(checkChain(RUN, extended, sealOf(steps)).problem).toEqual({ seq: null, reason: "seal_mismatch" });
  });

  it("says so when steps were recorded before the chain", () => {
    const old = steps.map((s) => ({ ...s, prev_hash: null, hash: null }));
    expect(checkChain(RUN, old, null).problem).toEqual({ seq: 0, reason: "not_chained" });
  });

  it("can be fed a step at a time", () => {
    const checker = chainChecker(RUN);
    for (const s of steps) expect(checker.push(s)).toBe(true);
    expect(checker.finish(sealOf(steps)).problem).toBeNull();
  });
});
