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
// The message itself is the inbox's (inbox-service.ts).
vi.mock("../../../src/services/inbox-service.js", () => ({
  postMessage: vi.fn(async () => "m"),
}));

import { enqueueSteward } from "../../../src/services/queue-service.js";
import { rawQuery } from "../../../src/db/client.js";
import { postMessage } from "../../../src/services/inbox-service.js";
import { recordEnqueueEvent } from "../../../src/services/enqueue-events-service.js";

// The claim row is the Steward's queue, so these semantics live in one SQL
// statement (atomic under concurrent enqueues). The regression this pins
// (#182): a second message arriving while a claim was already pending used to
// silently overwrite the first (latest-wins), dropping e.g. one of two Curator
// edge suggestions to the same parent.
describe("enqueueSteward (#182 pending slot, inbox rows)", () => {
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

  it("keeps the message whole in the node's inbox, with its sender", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([{ prev_state: "done", prev_requeued: false }]);
    await enqueueSteward({
      claimId: "22222222-2222-2222-2222-222222222222",
      trigger: "curator_change",
      context: "adopt edge X",
      sender: { kind: "curator" },
    });
    const params = vi.mocked(rawQuery).mock.calls[0]![1];
    // The third parameter: whether this message may un-park the node (#846).
    expect(params).toEqual(["22222222-2222-2222-2222-222222222222", "curator_change", false]);
    expect(postMessage).toHaveBeenCalledWith({
      nodeId: "22222222-2222-2222-2222-222222222222",
      trigger: "curator_change",
      body: "adopt edge X",
      sender: { kind: "curator" },
      paid: undefined,
    });
  });

  it("no longer writes steward_context, so nothing is ever cut", async () => {
    const sql = await call();
    expect(sql).not.toContain("steward_context");
  });

  it("keeps no message for a claim it did not enqueue", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([]);
    await call();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("keeps the pending trigger except when the first-pass superset arrives", async () => {
    const sql = await call();
    // structure_and_assess subsumes any re-trigger; otherwise the pending
    // trigger stands and the labeled chunks carry the per-message attribution.
    expect(sql).toContain("OR $2 <> 'structure_and_assess'");
    expect(sql).toContain("COALESCE(steward_trigger, $2)");
  });

  it("still only enqueues active claims", async () => {
    const sql = await call();
    expect(sql).toContain("AND state = 'active'");
  });
});

// A park is not retried on its own (#846): only a message that comes with a
// commission returns a parked node to the queue. Any other is kept in the
// inbox and leaves the node as it was.
describe("enqueueSteward and a parked node (#846)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const base = {
    claimId: "22222222-2222-2222-2222-222222222222",
    trigger: "subclaim_change" as const,
    context: "upstream credence moved",
  };

  it("leaves 'error' as 'error' unless the message may un-park", async () => {
    await enqueueSteward(base);
    const [sql, params] = vi.mocked(rawQuery).mock.calls[0]!;
    expect(sql).toContain("WHEN steward_state = 'error' AND NOT $3::boolean THEN 'error'");
    expect((params as unknown[])[2]).toBe(false);
  });

  it("lets a paid message, or a commission joining a paid pass, un-park", async () => {
    await enqueueSteward({ ...base, paid: true });
    await enqueueSteward({ ...base, unpark: true });
    expect((vi.mocked(rawQuery).mock.calls[0]![1] as unknown[])[2]).toBe(true);
    expect((vi.mocked(rawQuery).mock.calls[1]![1] as unknown[])[2]).toBe(true);
  });

  it("keeps the message but opens no ledger row and records no arrival while the node stays parked", async () => {
    const { ensureAssessActions } = await import("../../../src/services/action-service.js");
    vi.mocked(rawQuery).mockResolvedValueOnce([{ prev_state: "error", prev_requeued: false, new_state: "error" }]);
    await enqueueSteward(base);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(recordEnqueueEvent).not.toHaveBeenCalled();
    expect(ensureAssessActions).not.toHaveBeenCalled();

    vi.mocked(rawQuery).mockResolvedValueOnce([{ prev_state: "error", prev_requeued: false, new_state: "pending" }]);
    await enqueueSteward({ ...base, paid: true });
    expect(recordEnqueueEvent).toHaveBeenCalledTimes(1);
    expect(ensureAssessActions).toHaveBeenCalledTimes(1);
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
