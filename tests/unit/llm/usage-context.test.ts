import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  finish: vi.fn(),
  seal: vi.fn(),
  record: false,
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  startAgentRun: mocks.start,
  finishAgentRun: mocks.finish,
  sealAgentRun: mocks.seal,
  recordMode: () => mocks.record,
  RunLogError: class RunLogError extends Error {},
}));

import {
  currentLabel,
  getUsageContext,
  runWithUsageContext,
  untraced,
  withAgent,
} from "../../../src/llm/usage-context.js";
import { PUBLIC_LABEL } from "../../../src/labels.js";

const fakeTrace = () => ({ runId: "run-1", seq: { n: 0 }, ready: Promise.resolve() });

beforeEach(() => {
  mocks.start.mockReset().mockReturnValue(null);
  mocks.finish.mockReset();
  mocks.seal.mockReset().mockResolvedValue(true);
  mocks.record = false;
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

// The label a write carries comes from the context, never from the agent
// (src/labels.ts). The public graph sets none, so everything is public.
describe("currentLabel", () => {
  it("is public outside any run", () => {
    expect(PUBLIC_LABEL).toBe("public");
    expect(currentLabel()).toBe(PUBLIC_LABEL);
  });

  it("is public inside a run whose context sets no label", async () => {
    await runWithUsageContext({ jobId: "job-9" }, () =>
      withAgent("steward", async () => {
        expect(currentLabel()).toBe(PUBLIC_LABEL);
      })
    );
  });

  it("is the context's label, through nested agents and untraced work", async () => {
    await runWithUsageContext({ label: "internal" }, () =>
      withAgent("steward", async () => {
        expect(currentLabel()).toBe("internal");
        await withAgent("matcher", async () => {
          expect(currentLabel()).toBe("internal");
        });
        await untraced(async () => {
          expect(currentLabel()).toBe("internal");
        });
      })
    );
    expect(currentLabel()).toBe(PUBLIC_LABEL);
  });

  it("is handed to the run when it opens, so the run row carries it", async () => {
    await runWithUsageContext({ label: "internal" }, () => withAgent("steward", async () => undefined));
    expect(mocks.start).toHaveBeenCalledWith("steward", expect.objectContaining({ label: "internal" }));
  });
});

// RUN_LOG_MODE=record (#552): the run is not finished until its log is.
describe("withAgent in record mode", () => {
  it("holds the result until the log is sealed", async () => {
    mocks.record = true;
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    let sealed = false;
    mocks.seal.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      sealed = true;
      return true;
    });
    const result = await withAgent("steward", async () => 42);
    expect(sealed).toBe(true);
    expect(result).toBe(42);
    expect(mocks.seal).toHaveBeenCalledWith(trace, "ok");
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("fails the run when its log could not be written whole", async () => {
    mocks.record = true;
    mocks.start.mockReturnValue(fakeTrace());
    mocks.seal.mockResolvedValue(false);
    await expect(withAgent("steward", async () => 42)).rejects.toThrow();
  });

  it("closes the log and rethrows the work's own error", async () => {
    mocks.record = true;
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    mocks.seal.mockResolvedValue(false);
    await expect(
      withAgent("steward", async () => {
        throw new Error("kaput");
      })
    ).rejects.toThrow("kaput");
    expect(mocks.seal).toHaveBeenCalledWith(trace, "error", expect.any(Error));
  });

  it("does not wait in best-effort mode", async () => {
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    await withAgent("steward", async () => 1);
    expect(mocks.finish).toHaveBeenCalledWith(trace, "ok");
    expect(mocks.seal).not.toHaveBeenCalled();
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
