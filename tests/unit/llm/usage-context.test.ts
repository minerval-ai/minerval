import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  startAgentRun: mocks.start,
  finishAgentRun: mocks.finish,
}));

import {
  getUsageContext,
  runWithUsageContext,
  withAgent,
} from "../../../src/llm/usage-context.js";

const fakeTrace = () => ({ runId: "run-1", seq: { n: 0 } });

beforeEach(() => {
  mocks.start.mockReset().mockReturnValue(null);
  mocks.finish.mockReset();
});

describe("withAgent without tracing", () => {
  it("tags the agent and sets no run identity", async () => {
    await withAgent("matcher", async () => {
      expect(getUsageContext().agent).toBe("matcher");
      expect(getUsageContext().runId).toBeUndefined();
      expect(getUsageContext().trace).toBeUndefined();
    });
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});

describe("withAgent with tracing", () => {
  it("passes the enclosing attribution to startAgentRun", async () => {
    await runWithUsageContext({ jobId: "job-9", claimId: "claim-7" }, () =>
      withAgent("steward", async () => undefined)
    );
    expect(mocks.start).toHaveBeenCalledWith(
      "steward",
      expect.objectContaining({ jobId: "job-9", claimId: "claim-7" })
    );
  });

  it("threads runId + trace through the context and finishes ok", async () => {
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    const result = await withAgent("steward", async () => {
      expect(getUsageContext().runId).toBe("run-1");
      expect(getUsageContext().trace).toBe(trace);
      return 42;
    });
    expect(result).toBe(42);
    expect(mocks.finish).toHaveBeenCalledWith(trace, "ok");
  });

  it("finishes with error and rethrows on async failure", async () => {
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    await expect(
      withAgent("steward", async () => {
        throw new Error("kaput");
      })
    ).rejects.toThrow("kaput");
    expect(mocks.finish).toHaveBeenCalledWith(trace, "error", expect.any(Error));
  });

  it("finishes with error and rethrows on synchronous failure", () => {
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    expect(() =>
      withAgent("steward", () => {
        throw new Error("sync kaput");
      })
    ).toThrow("sync kaput");
    expect(mocks.finish).toHaveBeenCalledWith(trace, "error", expect.any(Error));
  });

  it("finishes ok for a synchronous return", () => {
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    expect(withAgent("steward", () => "done")).toBe("done");
    expect(mocks.finish).toHaveBeenCalledWith(trace, "ok");
  });
});
