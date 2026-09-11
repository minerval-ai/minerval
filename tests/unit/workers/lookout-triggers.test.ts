import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The retraction poll (workers/lookout-triggers.ts): skips the network
 * when no lookout watches for retractions; honours its cadence through a
 * persisted high-water mark; joins Crossref notices to the graph's sources
 * and queues one event per matched source on every subscribed lookout;
 * never re-queues a notice a lookout already holds; advances the mark only
 * after a successful poll.
 */

const { state, queries } = vi.hoisted(() => ({
  state: {
    subscribed: 1,
    mark: null as null | { since: string; polled_at: string },
    notices: [] as Array<Record<string, unknown>>,
    matches: [] as Array<Record<string, unknown>>,
    dupPending: 0,
    fanout: [] as Array<Record<string, unknown>>,
  },
  queries: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    queries.push({ q, params });
    if (q.includes("l.triggers ? 'retraction'")) return [{ n: state.subscribed }];
    if (q.includes("FROM platform_flags")) return state.mark ? [{ value: state.mark }] : [];
    if (q.includes("payload->>'notice_doi' = $1")) return [{ n: state.dupPending }];
    return [];
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ lookoutRetractionPollHours: 24 }),
}));
vi.mock("../../../src/services/source-watch-service.js", () => ({
  recentRetractions: vi.fn(async () => state.notices),
  sourcesForDois: vi.fn(async () => state.matches),
}));
vi.mock("../../../src/services/lookout-service.js", () => ({
  queueLookoutEventsByTrigger: vi.fn(async (input: Record<string, unknown>) => {
    state.fanout.push(input);
    return { queued: 2 };
  }),
}));

import { retractionPollTick } from "../../../src/workers/lookout-triggers.js";

const NOW = Date.parse("2026-09-11T12:00:00Z");

beforeEach(() => {
  queries.length = 0;
  state.subscribed = 1;
  state.mark = null;
  state.notices = [];
  state.matches = [];
  state.dupPending = 0;
  state.fanout = [];
});

describe("retractionPollTick", () => {
  it("skips entirely when no lookout watches for retractions", async () => {
    state.subscribed = 0;
    const r = await retractionPollTick({ now: NOW });
    expect(r).toMatchObject({ skipped: true, eventsQueued: 0 });
    expect(queries.some((x) => x.q.includes("FROM platform_flags"))).toBe(false);
  });

  it("honours the cadence through the persisted mark, and force overrides it", async () => {
    state.mark = { since: "2026-09-10T12:00:00Z", polled_at: "2026-09-11T06:00:00Z" };
    expect((await retractionPollTick({ now: NOW })).skipped).toBe(true);
    expect((await retractionPollTick({ now: NOW, force: true })).skipped).toBe(false);
  });

  it("queues one event per matched source with the notice and the resting claims, and advances the mark", async () => {
    state.notices = [
      { notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "retraction", title: "Retraction: X", updated: null, source: "retraction-watch" },
      { notice_doi: "10.1/other", retracted_dois: ["10.1/unrelated"], type: "correction", title: null, updated: null, source: "publisher" },
    ];
    state.matches = [
      { doi: "10.1/paper", source_id: "s-1", url: "https://doi.org/10.1/paper", title: "Paper", claim_ids: ["c-1", "c-2"] },
      { doi: "10.1/paper", source_id: "s-2", url: "https://x.org/10.1/paper", title: "Mirror", claim_ids: [] },
    ];
    const r = await retractionPollTick({ now: NOW });
    expect(r).toEqual({ skipped: false, notices: 2, matchedSources: 2, eventsQueued: 2 });
    // The orphan mirror (no claims resting on it) wakes nobody.
    expect(state.fanout).toHaveLength(1);
    expect(state.fanout[0]).toMatchObject({
      kind: "retraction",
      payload: {
        doi: "10.1/paper",
        notice_doi: "10.1/notice",
        notice_type: "retraction",
        notice_source: "retraction-watch",
        source_id: "s-1",
        claim_ids: ["c-1", "c-2"],
      },
    });
    const mark = queries.find((x) => x.q.includes("INSERT INTO platform_flags"))!;
    expect(JSON.parse(mark.params[1] as string).since).toBe(new Date(NOW).toISOString());
  });

  it("does not hand a lookout a notice it already holds", async () => {
    state.notices = [{ notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "retraction", title: null, updated: null, source: null }];
    state.matches = [{ doi: "10.1/paper", source_id: "s-1", url: "u", title: "t", claim_ids: ["c-1"] }];
    state.dupPending = 1;
    const r = await retractionPollTick({ now: NOW });
    expect(r.eventsQueued).toBe(0);
    expect(state.fanout).toHaveLength(0);
  });
});
