import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Grantmaker's lookout tools (llm/tools/lookout-management-tools.ts):
 * one definition list shared by the chat and the review pass; the executor
 * delegates to the service with the mandate id and the acting path, and
 * returns null for every other tool name so the agents' own handlers run.
 */

const { state } = vi.hoisted(() => ({
  state: {
    created: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    lookout: null as null | Record<string, unknown>,
  },
}));

vi.mock("../../../src/services/lookout-service.js", () => ({
  LOOKOUT_BOUNDS: { heartbeatHours: { max: 720 }, noteChars: 2_000 },
  LOOKOUT_TRIGGER_KINDS: ["retraction", "manual"],
  createLookout: vi.fn(async (input: Record<string, unknown>) => {
    state.created.push(input);
    return { ok: true, lookoutId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  }),
  updateLookout: vi.fn(async (input: Record<string, unknown>) => {
    state.updated.push(input);
    return { ok: true, lookoutId: input.lookoutId };
  }),
  summarizeLookouts: vi.fn(async () => [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Watch" }]),
  listLookoutFlags: vi.fn(async () => [{ id: "f-1" }]),
  queueLookoutEvent: vi.fn(async (input: Record<string, unknown>) => {
    state.events.push(input);
    return { queued: true };
  }),
  getLookout: vi.fn(async () => state.lookout),
}));

const L1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

import {
  executeLookoutManagementTool,
  getLookoutManagementToolDefinitions,
} from "../../../src/llm/tools/lookout-management-tools.js";

beforeEach(() => {
  state.created = [];
  state.updated = [];
  state.events = [];
  state.lookout = { id: L1, grant_id: "g-1", title: "Watch", status: "active", workspace: null };
});

describe("lookout management tools", () => {
  it("declares the five tools", () => {
    expect(getLookoutManagementToolDefinitions().map((t) => t.name)).toEqual([
      "spawn_lookout",
      "list_lookouts",
      "lookout_report",
      "update_lookout",
      "poke_lookout",
    ]);
  });

  it("spawn_lookout passes the brief and bounds to the service with the acting path", async () => {
    const out = JSON.parse(
      (await executeLookoutManagementTool(
        "g-1",
        "spawn_lookout",
        { title: "Retraction watch", brief: "b".repeat(60), heartbeat_hours: 12, triggers: ["retraction"], max_value: 4 },
        { createdBy: "grantmaker:review" }
      ))!
    );
    expect(out).toMatchObject({ success: true, lookout_id: L1 });
    expect(state.created[0]).toMatchObject({
      grantId: "g-1",
      title: "Retraction watch",
      heartbeatHours: 12,
      triggers: ["retraction"],
      maxValue: 4,
      maxIngestsPerRun: undefined,
      createdBy: "grantmaker:review",
    });
  });

  it("update_lookout forwards only the given fields; poke_lookout queues a manual event on the mandate's own lookout", async () => {
    await executeLookoutManagementTool("g-1", "update_lookout", { lookout_id: L1, status: "paused" }, { createdBy: "grantmaker:chat" });
    expect(state.updated[0]).toEqual({ grantId: "g-1", lookoutId: L1, status: "paused" });

    const poke = JSON.parse((await executeLookoutManagementTool("g-1", "poke_lookout", { lookout_id: L1, note: "check arXiv 2409.1" }, { createdBy: "grantmaker:chat" }))!);
    expect(poke.success).toBe(true);
    expect(state.events[0]).toMatchObject({ lookoutId: L1, kind: "manual", payload: { note: "check arXiv 2409.1", from: "grantmaker:chat" } });

    state.lookout = { id: L1, grant_id: "other", status: "active" };
    const denied = JSON.parse((await executeLookoutManagementTool("g-1", "poke_lookout", { lookout_id: L1, note: "x" }, { createdBy: "grantmaker:chat" }))!);
    expect(denied.success).toBe(false);
  });

  it("returns null for any other tool", async () => {
    expect(await executeLookoutManagementTool("g-1", "post_bounty", {}, { createdBy: "x" })).toBeNull();
  });
});
