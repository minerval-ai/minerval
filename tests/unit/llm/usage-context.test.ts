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
  untraced,
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

// untraced() is the privacy seam (#356): content a user never published
// (a page open in their browser, a chat question) must leave no transcript,
// whatever TRACE_LEVEL says.
describe("untraced", () => {
  it("opens no run for agents inside it, even when tracing is on", async () => {
    mocks.start.mockReturnValue(fakeTrace());
    await untraced(() =>
      withAgent("extractor", async () => {
        expect(getUsageContext().agent).toBe("extractor");
        expect(getUsageContext().untraced).toBe(true);
        expect(getUsageContext().trace).toBeUndefined();
        expect(getUsageContext().runId).toBeNull();
      })
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("drops an enclosing run's trace so nested agents cannot append to it", async () => {
    const outer = fakeTrace();
    mocks.start.mockReturnValue(outer);
    await withAgent("steward", async () => {
      expect(getUsageContext().trace).toBe(outer);
      await untraced(async () => {
        expect(getUsageContext().trace).toBeUndefined();
        await withAgent("matcher", async () => {
          expect(getUsageContext().trace).toBeUndefined();
          expect(getUsageContext().runId).toBeNull();
        });
      });
      // The outer run is intact once the untraced stretch ends.
      expect(getUsageContext().trace).toBe(outer);
      expect(getUsageContext().runId).toBe("run-1");
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.finish).toHaveBeenCalledWith(outer, "ok");
  });

  it("leaves metering attribution untouched", async () => {
    await runWithUsageContext({ userId: "user-1", apiKeyId: "key-1" }, () =>
      untraced(() =>
        withAgent("extension", async () => {
          expect(getUsageContext()).toMatchObject({
            userId: "user-1",
            apiKeyId: "key-1",
            agent: "extension",
            untraced: true,
          });
        })
      )
    );
  });
});
