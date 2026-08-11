/**
 * Trace suppression for user-private content (#334 L0, #72).
 *
 * The browser extension runs the Extractor and Matcher over whatever page the
 * user is looking at, so its transcripts must never reach agent_steps. These
 * pin the policy itself — the pure predicate — so the suppression path cannot
 * regress silently, and so the test does not depend on tracing being enabled
 * (it is off under vitest by design, which would make a DB-level assertion
 * pass vacuously).
 */
import { describe, it, expect } from "vitest";
import { shouldRecordRun } from "../../../src/services/trace-service.js";
import {
  getUsageContext,
  runWithUsageContext,
} from "../../../src/llm/usage-context.js";

describe("shouldRecordRun", () => {
  it("records ordinary system work when tracing is on", () => {
    expect(shouldRecordRun("full", {})).toBe(true);
    expect(shouldRecordRun("full", { claimId: "c1", jobId: "j1" })).toBe(true);
  });

  it("records user-attributed work that is not marked sensitive", () => {
    // A logged-in user submitting a /sources URL is public content: traced.
    expect(shouldRecordRun("full", { userId: "u1", requestId: "r1" })).toBe(true);
  });

  it("never records work marked sensitive, even with tracing fully on", () => {
    expect(shouldRecordRun("full", { sensitive: true })).toBe(false);
    expect(shouldRecordRun("full", { userId: "u1", sensitive: true })).toBe(false);
  });

  it("records nothing at all when tracing is off", () => {
    expect(shouldRecordRun("off", {})).toBe(false);
    expect(shouldRecordRun("off", { sensitive: true })).toBe(false);
  });

  it("stays sensitive through the nested contexts an agent run creates", async () => {
    // The extension route marks the context once; the Extractor runs inside
    // it, then the Matcher fans out 8-wide inside that. Every one of those
    // must still see the flag, or the transcript leaks from the deepest call.
    const seen = await runWithUsageContext(
      { userId: "u1", sensitive: true },
      async () =>
        runWithUsageContext({ agent: "extractor" }, async () =>
          Promise.all(
            Array.from({ length: 8 }, () =>
              runWithUsageContext({ agent: "matcher" }, async () => {
                await Promise.resolve();
                const ctx = getUsageContext();
                return shouldRecordRun("full", ctx);
              })
            )
          )
        )
    );
    expect(seen).toEqual(Array(8).fill(false));
  });

  it("does not leak sensitivity outward to sibling work", () => {
    runWithUsageContext({ sensitive: true }, () => {
      expect(shouldRecordRun("full", getUsageContext())).toBe(false);
    });
    // Back outside, ordinary system work traces again.
    expect(shouldRecordRun("full", getUsageContext())).toBe(true);
  });

  it("treats only an explicit true as sensitive, so an absent flag traces", () => {
    // Guards against a stray undefined/null silently disabling tracing for
    // every run — the failure mode that would leave L0 with no data at all.
    expect(shouldRecordRun("full", { sensitive: undefined })).toBe(true);
    expect(shouldRecordRun("full", { sensitive: false })).toBe(true);
  });
});
