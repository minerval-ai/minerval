import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(async () => undefined),
  updateSet: vi.fn(),
  updateWhere: vi.fn(async () => undefined),
  config: {
    env: "development",
    traceLevel: "full" as "off" | "full" | undefined,
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
  traceLevel,
} from "../../../src/services/trace-service.js";

beforeEach(() => {
  mocks.insertValues.mockClear();
  mocks.updateSet.mockClear();
  mocks.updateWhere.mockClear();
  mocks.config.traceLevel = "full";
  mocks.config.env = "development";
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
    expect(row.jobId).toBe("11111111-1111-1111-1111-111111111111");
    expect(row.claimId).toBe("22222222-2222-2222-2222-222222222222");
    expect(row.userId).toBeNull();
  });
});

describe("recordAgentStep", () => {
  it("claims monotonic sequence numbers synchronously", () => {
    const trace = startAgentRun("curator", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "assistant", { stopReason: "tool_use" });
    recordAgentStep(trace, "tool_results", [{ name: "search" }]);
    expect(trace.seq.n).toBe(2);
    const rows = mocks.insertValues.mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "tool_results"]);
    expect(rows.every((r) => r.runId === trace.runId)).toBe(true);
  });

  it("caps oversized content instead of writing it whole", () => {
    const trace = startAgentRun("steward", {})!;
    mocks.insertValues.mockClear();
    recordAgentStep(trace, "tool_results", [{ output: "x".repeat(300_000) }]);
    const row = mocks.insertValues.mock.calls[0]![0] as {
      content: { truncated?: boolean; originalChars?: number; preview?: string };
    };
    expect(row.content.truncated).toBe(true);
    expect(row.content.originalChars).toBeGreaterThan(200_000);
    expect(row.content.preview!.length).toBe(200_000);
  });
});

describe("finishAgentRun", () => {
  it("stamps outcome, step count, and a truncated error message", () => {
    const trace = startAgentRun("steward", {})!;
    recordAgentStep(trace, "assistant", {});
    finishAgentRun(trace, "error", new Error("boom ".repeat(1000)));
    expect(mocks.updateSet).toHaveBeenCalledOnce();
    const payload = mocks.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.outcome).toBe("error");
    expect(payload.steps).toBe(1);
    expect((payload.error as string).length).toBeLessThanOrEqual(2000);
    expect(payload.finishedAt).toBeInstanceOf(Date);
  });

  it("clears error on ok", () => {
    const trace = startAgentRun("steward", {})!;
    finishAgentRun(trace, "ok");
    const payload = mocks.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.outcome).toBe("ok");
    expect(payload.error).toBeNull();
  });
});
