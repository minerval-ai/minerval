import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * How a feed's items reach the ledger (#695): the lookout's triage raises
 * each ingest at its own urgency within the lookout's ceiling, with no
 * count per run; an auto_ingest feed raises every new item at the
 * lookout's ceiling, with no count per day, and the mandate's allocator
 * decides what that buys. flagIngest and the DB are mocked.
 */

const LOOKOUT = "22222222-2222-4222-8222-222222222222";
const GRANT = "11111111-1111-4111-8111-111111111111";
const ITEM = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const { state } = vi.hoisted(() => ({
  state: {
    flagged: [] as Array<Record<string, unknown>>,
    waiting: [] as Array<{ id: string; url: string | null; title: string | null }>,
    marked: [] as Array<{ id: unknown; status: unknown }>,
    waitingLimit: null as unknown,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("FROM lookout_feed_items i JOIN lookout_feeds f")) {
      return [{
        id: params[0], lookout_id: LOOKOUT, url: `https://x.org/${String(params[0]).slice(-2)}`,
        title: "A post", status: "new", feed: "Feed", ingest_focus: null,
      }];
    }
    if (q.includes("SELECT grant_id, status, max_value FROM lookouts")) {
      return [{ grant_id: GRANT, status: "active", max_value: 4 }];
    }
    if (q.includes("FROM lookout_feed_items") && q.includes("status = 'new'") && q.includes("ORDER BY first_seen_at")) {
      state.waitingLimit = params[1];
      return state.waiting;
    }
    if (q.includes("UPDATE lookout_feed_items") && q.includes("SET status = $2")) {
      state.marked.push({ id: params[0], status: params[1] });
      return [];
    }
    return [];
  }),
}));
vi.mock("../../../src/services/lookout-service.js", () => ({
  queueLookoutEvent: vi.fn(async () => ({ queued: true })),
  flagIngest: vi.fn(async (input: Record<string, unknown>) => {
    state.flagged.push(input);
    return { ok: true, duplicate: false, flag_id: "f", action_id: "a", value_written: 4, note: "Recorded." };
  }),
}));

import { pollFeed, triageItems, FEED_BOUNDS, type FeedRow } from "../../../src/services/feed-service.js";

beforeEach(() => {
  state.flagged = [];
  state.waiting = [];
  state.marked = [];
  state.waitingLimit = null;
});

describe("triageItems", () => {
  it("raises every ingest decision at its urgency within the ceiling, with no allowance", async () => {
    const decisions = Array.from({ length: 12 }, (_, i) => ({
      item_id: ITEM(i), decision: "ingest", ...(i === 0 ? { urgency: 9 } : {}),
    }));
    const res = await triageItems({ lookoutId: LOOKOUT, grantId: GRANT, decisions, maxValue: 4 });
    expect(res.ingested).toBe(12);
    expect(state.flagged).toHaveLength(12);
    expect(state.flagged[0]).toMatchObject({ lookoutId: LOOKOUT, grantId: GRANT, maxValue: 4, urgency: 9 });
    // No urgency given reads as 5; flagIngest clamps it to the ceiling.
    expect(state.flagged[1]).toMatchObject({ maxValue: 4, urgency: 5 });
  });
});

describe("auto_ingest", () => {
  const feed = (): FeedRow => ({
    id: "33333333-3333-4333-8333-333333333333", lookout_id: LOOKOUT, url: "https://x.org/feed", site_url: null,
    title: "Trusted feed", status: "active", wake: "auto_ingest", batch_size: 10, max_wait_hours: 24,
    min_wake_hours: 4, poll_hours: 6, retain_days: 14, ingest_focus: "housing", seeded_at: new Date(),
    last_polled_at: null, next_poll_at: new Date(), last_woke_at: null, consecutive_failures: 0,
    last_error: null, created_by: null, created_at: new Date(),
  });

  it("raises every new item at the lookout's ceiling, a poll's worth at a time, with no daily count", async () => {
    state.waiting = Array.from({ length: 30 }, (_, i) => ({ id: ITEM(i), url: `https://x.org/p/${i}`, title: `Post ${i}` }));
    state.waiting.push({ id: ITEM(99), url: null, title: "No link" });
    const res = await pollFeed(feed(), { parsed: { format: "rss", title: "T", siteUrl: null, items: [] } as never });
    expect(res.ok).toBe(true);
    expect(res.autoIngested).toBe(30);
    expect(state.waitingLimit).toBe(FEED_BOUNDS.itemsPerPoll);
    expect(state.flagged).toHaveLength(30);
    expect(state.flagged[0]).toMatchObject({ grantId: GRANT, maxValue: 4, urgency: 4, focus: "housing" });
    expect(state.marked).toContainEqual({ id: ITEM(99), status: "skipped" });
  });
});
