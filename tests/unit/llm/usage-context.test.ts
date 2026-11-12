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
  runAtLabel,
  runWithUsageContext,
  untraced,
  withAgent,
} from "../../../src/llm/usage-context.js";
import { MissingLabelError, PUBLIC_LABEL } from "../../../src/labels.js";

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
// A run works at the label of the work that started it (src/labels.ts): the
// worker that picks a row up opens its run with the row's label.
describe("runAtLabel", () => {
  it("runs the work at the row's label, and hands back what it returns", async () => {
    const out = await runAtLabel("internal", "job j-1", async () => {
      expect(currentLabel()).toBe("internal");
      return 7;
    });
    expect(out).toBe(7);
    expect(currentLabel()).toBe(PUBLIC_LABEL);
  });

  it("keeps the label through the identity a worker sets inside it and the run that opens", async () => {
    await runAtLabel("internal", "ledger action a-1", () =>
      runWithUsageContext({ userId: "u-1", jobId: "job-9" }, () =>
        withAgent("steward", async () => {
          expect(getUsageContext()).toMatchObject({ label: "internal", userId: "u-1", jobId: "job-9", agent: "steward" });
        })
      )
    );
    expect(mocks.start).toHaveBeenCalledWith("steward", expect.objectContaining({ label: "internal" }));
  });

  it("takes the row's label over the label of whatever is delivering the work", async () => {
    await runWithUsageContext({ label: "internal" }, () =>
      runAtLabel(PUBLIC_LABEL, "paused session s-1", async () => {
        expect(currentLabel()).toBe(PUBLIC_LABEL);
      })
    );
  });

  it("refuses a row with no label instead of running it as public", () => {
    const work = vi.fn();
    for (const missing of [undefined, null, ""]) {
      expect(() => runAtLabel(missing, "job j-2", work)).toThrow(MissingLabelError);
    }
    expect(() => runAtLabel(undefined, "job j-2", work)).toThrow(/job j-2 carries no label/);
    expect(work).not.toHaveBeenCalled();
  });
});

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

// Record mode has no exemption (docs/run-log.md): a deployment that keeps
// its log as a record logs work over a reader's own content like any other.
describe("untraced in record mode", () => {
  it("opens a run for each agent inside it, handed the mark so the run starts private", async () => {
    mocks.record = true;
    const trace = fakeTrace();
    mocks.start.mockReturnValue(trace);
    await runWithUsageContext({ userId: "user-1", requestId: "r-1" }, () =>
      untraced(() =>
        withAgent("extractor", async () => {
          expect(getUsageContext()).toMatchObject({ agent: "extractor", untraced: true, runId: "run-1" });
          expect(getUsageContext().trace).toBe(trace);
        })
      )
    );
    expect(mocks.start).toHaveBeenCalledWith(
      "extractor",
      expect.objectContaining({ untraced: true, userId: "user-1", requestId: "r-1" })
    );
    // The run waited on its seal, as every run in record mode does.
    expect(mocks.seal).toHaveBeenCalledWith(trace, "ok");
  });

  it("fails the work when the log of a run inside it could not be written whole", async () => {
    mocks.record = true;
    mocks.start.mockReturnValue(fakeTrace());
    mocks.seal.mockResolvedValue(false);
    await expect(untraced(() => withAgent("matcher", async () => "a verdict"))).rejects.toThrow();
  });

  it("keeps an enclosing run's trace, so a call made inside it is recorded on that run", async () => {
    mocks.record = true;
    const outer = fakeTrace();
    mocks.start.mockReturnValue(outer);
    await withAgent("assistant", () =>
      untraced(async () => {
        expect(getUsageContext().trace).toBe(outer);
        expect(getUsageContext().runId).toBe("run-1");
      })
    );
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
