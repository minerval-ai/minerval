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

import {
  enqueueSteward,
  STEWARD_CONTEXT_MAX_CHARS,
} from "../../../src/services/queue-service.js";
import { rawQuery } from "../../../src/db/client.js";

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
