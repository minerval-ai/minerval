import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Grantmaker's lookout tools (llm/tools/lookout-management-tools.ts):
 * one definition list shared by the chat and the review pass; the executor
 * delegates to the service with the mandate id and the acting path, and
 * returns null for every other tool name so the agents' own handlers run.
 * The feed tools follow feeds on a lookout the mandate owns, and nowhere
 * else.
 */

const { state } = vi.hoisted(() => ({
  state: {
    created: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    lookout: null as null | Record<string, unknown>,
    feedsAdded: [] as Array<Record<string, unknown>>,
    feedUpdates: [] as Array<Record<string, unknown>>,
    feed: null as null | Record<string, unknown>,
  },
}));

vi.mock("../../../src/services/feed-service.js", () => ({
  FEED_BOUNDS: {
    feedsPerLookout: 50,
    batchSize: { min: 1, max: 500, dflt: 10 },
    maxWaitHours: { min: 1, max: 720, dflt: 24 },
    minWakeHours: { min: 0, max: 720, dflt: 4 },
    pollHours: { min: 1, max: 168, dflt: 6 },
    retainDays: { min: 1, max: 90, dflt: 14 },
    dailyIngestCap: { min: 0, max: 50, dflt: 5 },
  },
  FEED_WAKE_RULES: ["batch", "each", "heartbeat", "paused", "auto_ingest"],
  LOOKOUT_SETTABLE_WAKE_RULES: ["batch", "each", "heartbeat", "paused"],
  READ_VIEWS: ["lead", "outline", "section", "full"],
  TRIAGE_DECISIONS: ["ingest", "skip", "defer"],
  addFeed: vi.fn(async (input: Record<string, unknown>) => {
    state.feedsAdded.push(input);
    return { ok: true, feed_id: "feed-1", feed_url: `${input.url}/feed`, title: "T", wake: "batch", items_now: 3, latest: [], note: "" };
  }),
  updateFeed: vi.fn(async (input: Record<string, unknown>) => {
    state.feedUpdates.push(input);
    return { ok: true, feed_id: input.feedId };
  }),
  getFeed: vi.fn(async () => state.feed),
  feedReport: vi.fn(async () => [{ feed_id: "feed-1" }]),
  readListing: vi.fn(async (url: string) => ({ ok: true, url, kind: "page", rows: [] })),
  feedInbox: vi.fn(),
  readItem: vi.fn(),
  triageItems: vi.fn(),
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
  flagNote: vi.fn(),
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
  state.feedsAdded = [];
  state.feedUpdates = [];
  state.feed = { id: "feed-1", lookout_id: L1 };
});

describe("lookout management tools", () => {
  it("declares the lookout and feed tools", () => {
    expect(getLookoutManagementToolDefinitions().map((t) => t.name)).toEqual([
      "spawn_lookout",
      "add_feed",
      "update_feed",
      "feed_report",
      "read_listing",
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
  it("spawn_lookout with feeds wakes on them and follows each one", async () => {
    const out = JSON.parse(
      (await executeLookoutManagementTool(
        "g-1",
        "spawn_lookout",
        { title: "Zvi", brief: "b".repeat(60), triggers: ["manual"], feeds: ["https://thezvi.substack.com"] },
        { createdBy: "grantmaker:chat" }
      ))!
    );
    expect(state.created[0]).toMatchObject({ triggers: ["manual", "feed"] });
    expect(state.feedsAdded[0]).toMatchObject({ grantId: "g-1", lookoutId: L1, url: "https://thezvi.substack.com", createdBy: "grantmaker:chat" });
    expect(out).toMatchObject({ success: true, feeds: [{ success: true, feed_id: "feed-1", items_now: 3 }] });
  });

  it("add_feed passes the rule through; update_feed and feed_report check the lookout and feed belong to the mandate", async () => {
    await executeLookoutManagementTool(
      "g-1",
      "add_feed",
      { lookout_id: L1, url: "https://www.lesswrong.com/tag/ai", wake: "auto_ingest", daily_ingest_cap: 3 },
      { createdBy: "grantmaker:review" }
    );
    expect(state.feedsAdded[0]).toMatchObject({ rule: { wake: "auto_ingest", dailyIngestCap: 3 } });

    const upd = JSON.parse((await executeLookoutManagementTool("g-1", "update_feed", { lookout_id: L1, feed_id: "feed-1", status: "removed" }, { createdBy: "x" }))!);
    expect(upd).toEqual({ success: true, feed_id: "feed-1" });
    expect(state.feedUpdates[0]).toMatchObject({ lookoutId: L1, feedId: "feed-1", by: "grantmaker", status: "removed" });

    state.feed = { id: "feed-2", lookout_id: "someone-else" };
    const foreign = JSON.parse((await executeLookoutManagementTool("g-1", "update_feed", { lookout_id: L1, feed_id: "feed-2" }, { createdBy: "x" }))!);
    expect(foreign).toMatchObject({ success: false });

    state.lookout = { id: L1, grant_id: "g-other" };
    const report = JSON.parse((await executeLookoutManagementTool("g-1", "feed_report", { lookout_id: L1 }, { createdBy: "x" }))!);
    expect(report).toMatchObject({ success: false });
    expect(state.feedUpdates).toHaveLength(1);
  });

  it("read_listing is the Grantmaker's too", async () => {
    const out = JSON.parse((await executeLookoutManagementTool("g-1", "read_listing", { url: "https://x.example/archive" }, { createdBy: "x" }))!);
    expect(out).toMatchObject({ ok: true, url: "https://x.example/archive" });
  });
});
