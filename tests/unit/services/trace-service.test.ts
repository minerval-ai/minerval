import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(async () => undefined),
  updateSet: vi.fn(),
  updateWhere: vi.fn(async () => undefined),
  config: {
    env: "development",
    traceLevel: "full" as "off" | "full" | undefined,
    gitSha: "abc1234def" as string | undefined,
    runLogMode: "best_effort" as "best_effort" | "record",
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({ values: mocks.insertValues }),
    update: () => ({
      set: (payload: unknown) => {
        mocks.updateSet(payload);
        return { where: mocks.updateWhere };
      },
    }),
  }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  startAgentRun,
  finishAgentRun,
  recordAgentStep,
  sealAgentRun,
  traceLevel,
  traceable,
  READERS_OWN_REASON,
} from "../../../src/services/trace-service.js";
import { checkChain, genesisHash, type ChainedStep } from "../../../src/services/run-log.js";

beforeEach(() => {
  mocks.insertValues.mockClear();
  mocks.updateSet.mockClear();
  mocks.updateWhere.mockClear();
  mocks.config.traceLevel = "full";
  mocks.config.env = "development";
  mocks.config.runLogMode = "best_effort";
  mocks.insertValues.mockImplementation(async () => undefined);
});

describe("traceLevel resolution", () => {
  it("honours an explicit setting", () => {
    mocks.config.traceLevel = "off";
    expect(traceLevel()).toBe("off");
    mocks.config.traceLevel = "full";
    expect(traceLevel()).toBe("full");
  });

  it("defaults off under vitest (fire-and-forget writes must not leak into unit tests)", () => {
    // process.env.VITEST is set by the runner itself.
    mocks.config.traceLevel = undefined;
    expect(traceLevel()).toBe("off");
  });

  it("defaults full everywhere else, production included (retention bounds it)", () => {
    mocks.config.traceLevel = undefined;
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      mocks.config.env = "production";
      expect(traceLevel()).toBe("full");
      mocks.config.env = "development";
      expect(traceLevel()).toBe("full");
    } finally {
      process.env.VITEST = saved;
    }
  });
});

// Per-agent policy (#356): the extension agent only ever sees a reader's own
// page and conversation, so while the log is best-effort it is never traced,
// whoever calls it.
describe("per-agent trace policy", () => {
  it("never records the extension agent, even at TRACE_LEVEL=full", () => {
    expect(traceable("extension")).toBe(false);
    expect(
      startAgentRun("extension", { userId: "33333333-3333-3333-3333-333333333333" })
    ).toBeNull();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("records every other agent at full, and none when off", () => {
    expect(traceable("steward")).toBe(true);
    expect(traceable("extractor")).toBe(true);
    mocks.config.traceLevel = "off";
    expect(traceable("steward")).toBe(false);
  });
});

describe("startAgentRun", () => {
  it("returns null and writes nothing when tracing is off", () => {
    mocks.config.traceLevel = "off";
    expect(startAgentRun("steward", {})).toBeNull();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("opens a run with the attribution snapshot", () => {
    const trace = startAgentRun("steward", {
      jobId: "11111111-1111-1111-1111-111111111111",
      claimId: "22222222-2222-2222-2222-222222222222",
    });
    expect(trace).not.toBeNull();
    expect(trace!.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(trace!.seq.n).toBe(0);
    expect(mocks.insertValues).toHaveBeenCalledOnce();
    const row = mocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.id).toBe(trace!.runId);
    expect(row.agent).toBe("steward");
    // The deployed commit rides on every run (config.gitSha).
    expect(row.commitSha).toBe("abc1234def");
    expect(row.jobId).toBe("11111111-1111-1111-1111-111111111111");
    expect(row.claimId).toBe("22222222-2222-2222-2222-222222222222");
    expect(row.userId).toBeNull();
    // A run opened with no label writes at public (src/labels.ts).
    expect(row.sensitivityLabel).toBe("public");
  });

  it("stamps the run row with the label the run writes at", () => {
    startAgentRun("steward", { label: "internal" });
    const row = mocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.sensitivityLabel).toBe("internal");
  });
});

// Step and finish writes wait for the run row's insert to settle before
// they go out (so the first step can never race the run row), so a test
// reads the mock after that turn of the event loop.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("recordAgentStep", () => {
  it("claims monotonic sequence numbers synchronously", async () => {
    const trace = startAgentRun("curator", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "assistant", { stopReason: "tool_use" });
    recordAgentStep(trace, "tool_results", [{ name: "search" }]);
    expect(trace.seq.n).toBe(2);
    await flush();
    const rows = mocks.insertValues.mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "tool_results"]);
    expect(rows.every((r) => r.runId === trace.runId)).toBe(true);
  });

  it("waits for content given as a promise, keeping the sequence it claimed", async () => {
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    let settle!: (content: unknown) => void;
    recordAgentStep(trace, "prompt", new Promise((resolve) => (settle = resolve)));
    recordAgentStep(trace, "assistant", { stopReason: "end_turn" });
    expect(trace.seq.n).toBe(2);
    await flush();
    settle({ setup: { promptSet: "abc" } });
    await flush();
    const rows = mocks.insertValues.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const prompt = rows.find((r) => r.kind === "prompt")!;
    expect(prompt.seq).toBe(0);
    expect(prompt.content).toEqual({ setup: { promptSet: "abc" } });
    expect(rows.find((r) => r.kind === "assistant")!.seq).toBe(1);
  });

  it("caps oversized content instead of writing it whole", async () => {
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "tool_results", [{ output: "x".repeat(300_000) }]);
    await flush();
    const row = mocks.insertValues.mock.calls[0]![0] as {
      content: { truncated?: boolean; originalChars?: number; preview?: string };
    };
    expect(row.content.truncated).toBe(true);
    expect(row.content.originalChars).toBeGreaterThan(200_000);
    expect(row.content.preview!.length).toBe(200_000);
  });
});

describe("finishAgentRun", () => {
  it("stamps outcome, step count, and a truncated error message", async () => {
    const trace = startAgentRun("steward", {})!;
    recordAgentStep(trace, "assistant", {});
    finishAgentRun(trace, "error", new Error("boom ".repeat(1000)));
    await flush();
    expect(mocks.updateSet).toHaveBeenCalledOnce();
    const payload = mocks.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.outcome).toBe("error");
    expect(payload.steps).toBe(1);
    expect((payload.error as string).length).toBeLessThanOrEqual(2000);
    expect(payload.finishedAt).toBeInstanceOf(Date);
  });

  it("clears error on ok", async () => {
    const trace = startAgentRun("steward", {})!;
    finishAgentRun(trace, "ok");
    await flush();
    const payload = mocks.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.outcome).toBe("ok");
    expect(payload.error).toBeNull();
  });
});

// The log as a hash chain (#552): steps are written in order, each carrying
// the hash of the one before it, and a run whose every step was written is
// sealed with the last hash.
describe("the chain and the seal", () => {
  const stepRows = () =>
    mocks.insertValues.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((r) => "seq" in r)
      .map((r) => ({
        seq: r.seq as number,
        kind: r.kind as string,
        content: r.content,
        prev_hash: r.prevHash as string,
        hash: r.hash as string,
      })) satisfies ChainedStep[];

  it("chains each step to the one before it, starting from the run's genesis", async () => {
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "prompt", { model: "m" });
    recordAgentStep(trace, "assistant", { stopReason: "tool_use" });
    recordAgentStep(trace, "tool_results", [{ name: "search", output: "x" }]);
    expect(await sealAgentRun(trace, "ok")).toBe(true);

    const steps = stepRows();
    expect(steps.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(steps[0].prev_hash).toBe(genesisHash(trace.runId));
    expect(steps[1].prev_hash).toBe(steps[0].hash);
    expect(steps[2].prev_hash).toBe(steps[1].hash);

    const seal = mocks.updateSet.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(seal.logHash).toBe(steps[2].hash);
    expect(seal.sealedAt).toBeInstanceOf(Date);
    expect(checkChain(trace.runId, steps, { logHash: seal.logHash as string, stepsCounted: 3 }).problem).toBeNull();
  });

  it("writes steps in the order they were claimed, even when an early one is slow to assemble", async () => {
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    let settle!: (content: unknown) => void;
    recordAgentStep(trace, "prompt", new Promise((resolve) => (settle = resolve)));
    recordAgentStep(trace, "assistant", { stopReason: "end_turn" });
    await flush();
    expect(stepRows()).toHaveLength(0);
    settle({ model: "m" });
    await sealAgentRun(trace, "ok");
    expect(stepRows().map((s) => s.kind)).toEqual(["prompt", "assistant"]);
  });

  it("seals a run with no steps at its genesis", async () => {
    const trace = startAgentRun("steward", {})!;
    expect(await sealAgentRun(trace, "ok")).toBe(true);
    const seal = mocks.updateSet.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(seal.logHash).toBe(genesisHash(trace.runId));
  });

  it("leaves a run that lost a step unsealed, and the gap shows in the chain", async () => {
    const trace = startAgentRun("steward", {})!;
    await flush();
    mocks.insertValues.mockClear();
    mocks.insertValues
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("connection lost");
      });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordAgentStep(trace, "prompt", { model: "m" });
    recordAgentStep(trace, "assistant", { stopReason: "tool_use" });
    recordAgentStep(trace, "tool_results", [{ name: "search" }]);
    expect(await sealAgentRun(trace, "ok")).toBe(false);
    errors.mockRestore();

    const finish = mocks.updateSet.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(finish.outcome).toBe("ok");
    expect(finish.steps).toBe(3);
    expect("logHash" in finish).toBe(false);
    expect("sealedAt" in finish).toBe(false);

    // Steps 0 and 2 were written; 2 chains from the lost step 1, not from 0.
    const written = stepRows().filter((s) => s.seq !== 1);
    expect(checkChain(trace.runId, written, null).problem).toEqual({ seq: 1, reason: "missing" });
  });

  it("hashes the content as stored: what a jsonb column keeps of it", async () => {
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "assistant", { b: 1, a: undefined, when: new Date("2026-11-11T00:00:00Z") });
    await sealAgentRun(trace, "ok");
    const [step] = stepRows();
    expect(step.content).toEqual({ b: 1, when: "2026-11-11T00:00:00.000Z" });
    // A reader of the row, with its keys in any order, recomputes the same hash.
    const reread = { ...step, content: { when: "2026-11-11T00:00:00.000Z", b: 1 } };
    expect(checkChain(trace.runId, [reread], null).problem).toBeNull();
  });
});

describe("record mode", () => {
  it("traces every traceable run, whatever TRACE_LEVEL says", () => {
    mocks.config.runLogMode = "record";
    mocks.config.traceLevel = "off";
    expect(traceLevel()).toBe("full");
    expect(traceable("steward")).toBe(true);
    // The never-traced agents handle a reader's own page (#356). That
    // exemption belongs to the best-effort log; a record has none.
    expect(traceable("extension")).toBe(true);
  });

  it("starts a run over a reader's own content private, whatever its agent's default", async () => {
    mocks.config.runLogMode = "record";
    startAgentRun("matcher", { userId: "33333333-3333-3333-3333-333333333333", untraced: true });
    startAgentRun("extension", { untraced: true });
    startAgentRun("matcher", {});
    const rows = mocks.insertValues.mock.calls.map((c) => c[0] as { agent: string; privateReasons: string[] });
    expect(rows.map((r) => [r.agent, r.privateReasons])).toEqual([
      ["matcher", [READERS_OWN_REASON]],
      ["extension", ["agent:extension", READERS_OWN_REASON]],
      ["matcher", []],
    ]);
    expect(READERS_OWN_REASON).toBe("input:readers-own-content");
  });

  it("cuts nothing to a size cap", async () => {
    mocks.config.runLogMode = "record";
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "tool_results", [{ output: "x".repeat(300_000) }]);
    await sealAgentRun(trace, "ok");
    const row = mocks.insertValues.mock.calls[0]![0] as { content: Array<{ output: string }> };
    expect(row.content[0].output.length).toBe(300_000);
  });
});
