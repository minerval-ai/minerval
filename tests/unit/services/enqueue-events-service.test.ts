import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(async () => undefined),
  config: { enqueueEvents: "on" as "on" | "off" | undefined },
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({ insert: () => ({ values: mocks.insertValues }) }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  enqueueEventsEnabled,
  recordEnqueueEvent,
} from "../../../src/services/enqueue-events-service.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";

beforeEach(() => {
  mocks.insertValues.mockClear();
  mocks.config.enqueueEvents = "on";
});

describe("enqueueEventsEnabled", () => {
  it("defaults off under vitest (fire-and-forget writes must not leak into unit tests)", () => {
    mocks.config.enqueueEvents = undefined;
    expect(enqueueEventsEnabled()).toBe(false);
  });

  it("honours an explicit setting", () => {
    mocks.config.enqueueEvents = "off";
    expect(enqueueEventsEnabled()).toBe(false);
    mocks.config.enqueueEvents = "on";
    expect(enqueueEventsEnabled()).toBe(true);
  });
});

describe("recordEnqueueEvent", () => {
  it("writes nothing when disabled", () => {
    mocks.config.enqueueEvents = "off";
    recordEnqueueEvent({ queue: "curator", trigger: "neighborhood_sweep" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("snapshots the source attribution from the ambient usage context", () => {
    runWithUsageContext(
      {
        agent: "steward",
        runId: "33333333-3333-3333-3333-333333333333",
        claimId: "44444444-4444-4444-4444-444444444444",
      },
      () =>
        recordEnqueueEvent({
          queue: "steward",
          trigger: "subclaim_change",
          claimId: "55555555-5555-5555-5555-555555555555",
          coalesced: true,
        })
    );
    expect(mocks.insertValues).toHaveBeenCalledOnce();
    const row = mocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.queue).toBe("steward");
    expect(row.trigger).toBe("subclaim_change");
    expect(row.claimId).toBe("55555555-5555-5555-5555-555555555555");
    expect(row.coalesced).toBe(true);
    expect(row.sourceAgent).toBe("steward");
    expect(row.sourceRunId).toBe("33333333-3333-3333-3333-333333333333");
    expect(row.sourceClaimId).toBe("44444444-4444-4444-4444-444444444444");
  });

  it("nulls non-uuid sentinels instead of failing the row", () => {
    // Upstream convention: steward-created claims enqueue the pipeline with
    // jobId "steward" (no job row exists). The event must still record.
    recordEnqueueEvent({
      queue: "claim_pipeline",
      claimId: "55555555-5555-5555-5555-555555555555",
      jobId: "steward",
    });
    const row = mocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.claimId).toBe("55555555-5555-5555-5555-555555555555");
    expect(row.jobId).toBeNull();
  });

  it("records system enqueues (no agent context) with null source fields", () => {
    recordEnqueueEvent({ queue: "url_extraction", jobId: "66666666-6666-6666-6666-666666666666" });
    const row = mocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.sourceAgent).toBeNull();
    expect(row.sourceRunId).toBeNull();
    expect(row.coalesced).toBeNull();
    expect(row.jobId).toBe("66666666-6666-6666-6666-666666666666");
  });
});
