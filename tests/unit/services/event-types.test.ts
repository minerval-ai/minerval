/**
 * The event types an outside client can follow (src/services/event-types.ts):
 * what they are, what arguments each takes, and that equal arguments are
 * written one way, since a webhook subscription is named by them.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import { EVENT_NAMES, cursorNow, eventTypes, pollEvents, validateArguments } from "../../../src/services/event-types.js";
import { decodeChangeCursor, graphChangeDefinition } from "../../../src/services/graph-change-service.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("the event types", () => {
  it("are the change stream and a Correspondent's updates, each with a schema for its arguments and its payload", () => {
    const types = eventTypes();
    expect(types.map((t) => t.name)).toEqual([...EVENT_NAMES]);
    for (const t of types) {
      expect(t.delivery).toEqual(["poll", "webhook"]);
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(t.payloadSchema.properties).length).toBeGreaterThan(3);
    }
    expect(eventTypes(["poll"]).every((t) => t.delivery.join() === "poll")).toBe(true);
  });

  it("gives graph.change the change stream's own filters, and not its paging", () => {
    const stream = graphChangeDefinition("caller").input_schema.properties;
    const mine = eventTypes()[0]!.inputSchema.properties;
    expect(Object.keys(mine).sort()).toEqual(["kinds", "material_only", "min_credence_delta", "tags", "under"]);
    for (const key of Object.keys(mine)) expect(mine[key]).toEqual(stream[key]);
  });

  it("never carries a node's reasoning or an update's body in a payload", () => {
    const fields = eventTypes().flatMap((t) => Object.keys(t.payloadSchema.properties));
    for (const field of ["body", "reasoning", "reasoning_trace", "text", "not_covered"]) expect(fields).not.toContain(field);
  });
});

describe("arguments", () => {
  it("are written one way: lists sorted and without repeats, ids in lower case, defaults left out", () => {
    const a = validateArguments("graph.change", { under: [B, A.toUpperCase(), A], tags: ["z", "a"], material_only: true });
    expect(a).toEqual({ ok: true, name: "graph.change", arguments: { under: [A, B], tags: ["a", "z"] } });
    expect(validateArguments("graph.change", { tags: [], under: [] })).toEqual({ ok: true, name: "graph.change", arguments: {} });
    expect(validateArguments("graph.change", undefined)).toEqual({ ok: true, name: "graph.change", arguments: {} });
    expect(validateArguments("graph.change", { material_only: false, min_credence_delta: 0.2, kinds: ["state_changed"] })).toEqual({
      ok: true,
      name: "graph.change",
      arguments: { material_only: false, min_credence_delta: 0.2, kinds: ["state_changed"] },
    });
  });

  it("are refused when the type does not take them, with what it does take", () => {
    expect(validateArguments("graph.change", { limit: 5 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", { under: ["not-an-id"] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", { under: A })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", { kinds: ["weather"] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", { min_credence_delta: 2 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", { min_credence_delta: "0.2" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", { material_only: "no" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("graph.change", [])).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("correspondent.update", {})).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("correspondent.update", { correspondent_id: A, under: [B] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(validateArguments("correspondent.update", { correspondent_id: A.toUpperCase() })).toEqual({
      ok: true,
      name: "correspondent.update",
      arguments: { correspondent_id: A },
    });
  });

  it("name no event type that does not exist", () => {
    expect(validateArguments("graph.changes", {})).toMatchObject({ ok: false, code: "NOT_FOUND", kind: "event" });
    expect(validateArguments(undefined, {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("a poll with no cursor", () => {
  it("returns nothing and the position now, so following starts when it is asked for", async () => {
    const before = Date.now();
    const result = await pollEvents({ name: "graph.change", cursor: null });
    expect(result).toMatchObject({ ok: true, page: { events: [], truncated: false, hasMore: false } });
    const at = result.ok ? decodeChangeCursor(result.page.cursor) : null;
    expect(new Date(at!.at).getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(decodeChangeCursor(cursorNow())).not.toBeNull();
  });

  it("refuses a cursor that is not one, and counts that are not counts", async () => {
    expect(await pollEvents({ name: "graph.change", cursor: "abc" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await pollEvents({ name: "graph.change", cursor: null, maxEvents: 0 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await pollEvents({ name: "graph.change", cursor: null, maxAgeMs: -1 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});
