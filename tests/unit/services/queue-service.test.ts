import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
}));
// The post-enqueue priority stamp and action-ledger materialization are
// their own services' concerns; mocking them keeps these tests about the
// enqueue statement's own semantics.
vi.mock("../../../src/services/priority-service.js", () => ({
  refreshQueuePriority: vi.fn(async () => 0.5),
}));
vi.mock("../../../src/services/action-service.js", () => ({
  ensureAssessActions: vi.fn(async () => {}),
}));
// Enqueue-event telemetry is its own service's concern (and self-disables
// under vitest); mocking it here lets the coalescing-split tests assert what
// the enqueue statement reported without a database.
vi.mock("../../../src/services/enqueue-events-service.js", () => ({
  recordEnqueueEvent: vi.fn(),
}));

import {
  enqueueSteward,
  STEWARD_CONTEXT_MAX_CHARS,
} from "../../../src/services/queue-service.js";
import { rawQuery } from "../../../src/db/client.js";
import { recordEnqueueEvent } from "../../../src/services/enqueue-events-service.js";

// The claim row is the Steward's queue, so these semantics live in one SQL
// statement (atomic under concurrent enqueues). The regression this pins
// (#182): a second message arriving while a claim was already pending used to
// silently overwrite the first (latest-wins), dropping e.g. one of two Curator
// edge suggestions to the same parent.
describe("enqueueSteward (#182 pending-slot append)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function call(): Promise<string> {
    await enqueueSteward({
      claimId: "22222222-2222-2222-2222-222222222222",
      trigger: "curator_change",
      context: "adopt edge X",
    });
    return vi.mocked(rawQuery).mock.calls[0]![0] as string;
  }

  it("labels the chunk with its trigger, so batched chunks stay attributable", async () => {
    await enqueueSteward({
      claimId: "22222222-2222-2222-2222-222222222222",
      trigger: "curator_change",
      context: "adopt edge X",
    });
    expect(rawQuery).toHaveBeenCalledTimes(1);
    const params = vi.mocked(rawQuery).mock.calls[0]![1];
    expect(params).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "curator_change",
      "[curator_change] adopt edge X",
    ]);
  });

  it("appends to an already-pending slot instead of clobbering it", async () => {
    const sql = await call();
    // Append only while the earlier message is still undelivered (pending with
    // non-empty context); a consumed slot (running/done/error) starts fresh.
    expect(sql).toMatch(
      /WHEN steward_state = 'pending' AND COALESCE\(steward_context, ''\) <> ''/
    );
    expect(sql).toContain("steward_context || E'\\n\\n' || $3");
    expect(sql).toMatch(/ELSE \$3/);
  });

  it("keeps the pending trigger except when the first-pass superset arrives", async () => {
    const sql = await call();
    // structure_and_assess subsumes any re-trigger; otherwise the pending
    // trigger stands and the labeled chunks carry the per-message attribution.
    expect(sql).toContain("OR $2 <> 'structure_and_assess'");
    expect(sql).toContain("COALESCE(steward_trigger, $2)");
  });

  it("caps a storm-grown slot, dropping the OLDEST context with a marker", async () => {
    const sql = await call();
    expect(sql).toContain(`> ${STEWARD_CONTEXT_MAX_CHARS}`);
    // right() keeps the tail, i.e. the newest chunks.
    expect(sql).toContain(`right(steward_context || E'\\n\\n' || $3, ${STEWARD_CONTEXT_MAX_CHARS})`);
    expect(sql).toContain("'[earlier context truncated]'");
  });

  it("still only enqueues active claims", async () => {
    const sql = await call();
    expect(sql).toContain("AND state = 'active'");
  });
});

// The enqueue statement carries the row's PRE-update state out through
// RETURNING, so the telemetry can distinguish "created the pending slot" from
// "appended to one" — the #182 coalescing absorption #217 wants measured.
describe("enqueueSteward → enqueue-event coalescing split (#217)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const message = {
    claimId: "22222222-2222-2222-2222-222222222222",
    trigger: "subclaim_change" as const,
    context: "upstream credence moved",
  };

  it("returns the pre-update state from the same statement", async () => {
    await enqueueSteward(message);
    const sql = vi.mocked(rawQuery).mock.calls[0]![0] as string;
    expect(sql).toContain("steward_state AS prev_state");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("RETURNING prev.prev_state");
  });

  it("reports coalesced=false when the enqueue created the pending slot", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([{ prev_state: "done" }]);
    await enqueueSteward(message);
    expect(recordEnqueueEvent).toHaveBeenCalledWith({
      queue: "steward",
      trigger: "subclaim_change",
      claimId: message.claimId,
      coalesced: false,
    });
  });

  it("reports coalesced=true when it appended to an existing slot", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([{ prev_state: "pending" }]);
    await enqueueSteward(message);
    expect(recordEnqueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({ coalesced: true })
    );
  });

  it("records no event when the claim is missing or inactive (nothing enqueued)", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([]);
    await enqueueSteward(message);
    expect(recordEnqueueEvent).not.toHaveBeenCalled();
  });
});
