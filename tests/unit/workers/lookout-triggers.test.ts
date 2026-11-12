import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The retraction poll (workers/lookout-triggers.ts): records a source
 * event for every notice matching a source, tells the Steward of every
 * node asserting or resting on it the first time a notice is recorded, and
 * wakes lookouts only when one watches for retractions; honours its cadence through a
 * persisted high-water mark; joins Crossref notices to the graph's sources
 * and queues one event per matched source on every subscribed lookout;
 * never re-queues a notice a lookout already holds; advances the mark to
 * now only when the whole window was read, and otherwise only as far as it
 * read (#686).
 */

const { state, queries } = vi.hoisted(() => ({
  state: {
    subscribed: 1,
    mark: null as null | { since: string; polled_at: string },
    notices: [] as Array<Record<string, unknown>>,
    complete: true,
    readThrough: null as null | Date,
    windowInput: null as null | Record<string, unknown>,
    doiBatches: [] as string[][],
    matches: [] as Array<Record<string, unknown>>,
    resting: [] as Array<Record<string, unknown>>,
    dupPending: 0,
    fanout: [] as Array<Record<string, unknown>>,
    sourceEvents: [] as Array<Record<string, unknown>>,
    recorded: true,
    stewards: [] as Array<Record<string, unknown>>,
    stewardFails: [] as string[],
    // The label each node carries; one with no entry reads as no row.
    claimLabels: {} as Record<string, string>,
    // The label each Steward was told at (currentLabel inside the enqueue).
    toldAt: [] as Array<{ claimId: string; label: string }>,
  },
  queries: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    queries.push({ q, params });
    if (q.includes("l.triggers ? 'retraction'")) return [{ n: state.subscribed }];
    if (q.includes("FROM platform_flags")) return state.mark ? [{ value: state.mark }] : [];
    if (q.includes("payload->>'notice_doi' = $1")) return [{ n: state.dupPending }];
    if (q.includes("SELECT sensitivity_label FROM claims")) {
      const label = state.claimLabels[params[0] as string];
      return label ? [{ sensitivity_label: label }] : [];
    }
    return [];
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ lookoutRetractionPollHours: 24 }),
}));
vi.mock("../../../src/services/source-watch-service.js", () => ({
  retractionNoticesSince: vi.fn(async (input: Record<string, unknown>) => {
    state.windowInput = input;
    return { notices: state.notices, complete: state.complete, readThrough: state.readThrough };
  }),
  sourcesForDois: vi.fn(async (dois: string[]) => {
    state.doiBatches.push(dois);
    return state.doiBatches.length === 1 ? state.matches : [];
  }),
  claimsRestingOnSources: vi.fn(async () => state.resting),
}));
vi.mock("../../../src/services/source-facts-service.js", () => ({
  eventKindForCrossref: (t: string) => (t === "expression_of_concern" ? "expression_of_concern" : t),
  recordSourceEvent: vi.fn(async (input: Record<string, unknown>) => {
    state.sourceEvents.push(input);
    return { recorded: state.recorded };
  }),
}));
vi.mock("../../../src/services/lookout-service.js", () => ({
  queueLookoutEventsByTrigger: vi.fn(async (input: Record<string, unknown>) => {
    state.fanout.push(input);
    return { queued: 2 };
  }),
}));

vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async (input: Record<string, unknown>) => {
    if (state.stewardFails.includes(input.claimId as string)) throw new Error("db down");
    const { currentLabel } = await import("../../../src/llm/usage-context.js");
    state.toldAt.push({ claimId: input.claimId as string, label: currentLabel() });
    state.stewards.push(input);
  }),
}));

import { retractionPollTick } from "../../../src/workers/lookout-triggers.js";

const NOW = Date.parse("2026-09-11T12:00:00Z");

beforeEach(() => {
  queries.length = 0;
  state.subscribed = 1;
  state.mark = null;
  state.notices = [];
  state.complete = true;
  state.readThrough = null;
  state.windowInput = null;
  state.doiBatches = [];
  state.matches = [];
  state.resting = [];
  state.dupPending = 0;
  state.fanout = [];
  state.sourceEvents = [];
  state.recorded = true;
  state.stewards = [];
  state.stewardFails = [];
  state.claimLabels = {};
  state.toldAt = [];
});

describe("retractionPollTick", () => {
  // The poll runs outside any run and writes to one node at a time, so the
  // pass each letter asks for is opened at that node's label (src/labels.ts).
  it("tells each node's Steward at that node's own label", async () => {
    state.subscribed = 0;
    state.notices = [
      { notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "retraction", title: "Retraction of X", updated: "2026-09-10T00:00:00Z", source: "publisher" },
    ];
    state.matches = [{ doi: "10.1/paper", source_id: "s-1", url: "u", title: "Paper", claim_ids: ["c-restricted", "c-open"] }];
    state.claimLabels = { "c-restricted": "internal", "c-open": "public" };
    const r = await retractionPollTick({ now: NOW });
    expect(r.stewardsTold).toBe(2);
    expect(state.toldAt).toEqual([
      { claimId: "c-restricted", label: "internal" },
      { claimId: "c-open", label: "public" },
    ]);
  });

  it("records what happened to a matched source even when no lookout watches, and tells its Stewards but wakes no lookout", async () => {
    state.subscribed = 0;
    state.notices = [
      { notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "correction", title: "Correction to X", updated: "2026-09-10T00:00:00Z", source: "publisher" },
    ];
    state.matches = [{ doi: "10.1/paper", source_id: "s-1", url: "u", title: "Paper", claim_ids: ["c-1"] }];
    const r = await retractionPollTick({ now: NOW });
    expect(r).toMatchObject({ skipped: false, sourceEvents: 1, stewardsTold: 1, eventsQueued: 0 });
    expect(state.sourceEvents).toEqual([
      {
        sourceId: "s-1", kind: "correction", occurredAt: "2026-09-10T00:00:00Z",
        noticeUrl: "https://doi.org/10.1/notice", note: "Correction to X", detectedBy: "crossref_poll",
      },
    ]);
    expect(state.fanout).toHaveLength(0);
    expect(queries.some((x) => x.q.includes("INSERT INTO platform_flags"))).toBe(true);
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
    expect(r).toEqual({ skipped: false, notices: 2, complete: true, matchedSources: 2, sourceEvents: 2, stewardsTold: 2, eventsQueued: 2 });
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
    expect(JSON.parse(mark.params[1] as string)).toEqual({
      since: new Date(NOW).toISOString(),
      polled_at: new Date(NOW).toISOString(),
    });
  });

  it("reads the whole window and joins its DOIs in chunks (#686)", async () => {
    state.notices = Array.from({ length: 1200 }, (_, i) => ({
      notice_doi: `10.1/n${i}`, retracted_dois: [`10.1/p${i}`], type: "correction", title: null, updated: null, source: null,
    }));
    const r = await retractionPollTick({ now: NOW });
    expect(state.windowInput).toMatchObject({ types: ["retraction", "correction", "expression_of_concern"] });
    expect(r.notices).toBe(1200);
    expect(state.doiBatches.map((b) => b.length)).toEqual([500, 500, 200]);
  });

  it("advances the mark only as far as it read when the window was not finished, and keeps the cadence open", async () => {
    state.mark = { since: "2026-09-09T00:00:00Z", polled_at: "2026-09-09T00:00:00Z" };
    state.complete = false;
    state.readThrough = new Date("2026-09-10T03:00:00Z");
    const r = await retractionPollTick({ now: NOW });
    expect(r.complete).toBe(false);
    const mark = queries.find((x) => x.q.includes("INSERT INTO platform_flags"))!;
    expect(JSON.parse(mark.params[1] as string)).toEqual({
      since: "2026-09-10T03:00:00.000Z",
      polled_at: "2026-09-09T00:00:00.000Z",
    });
  });

  it("leaves the mark alone when nothing could be read", async () => {
    state.complete = false;
    state.readThrough = null;
    await retractionPollTick({ now: NOW });
    expect(queries.some((x) => x.q.includes("INSERT INTO platform_flags"))).toBe(false);
  });

  it("reaches the claims resting on a source through provenance, even when none asserts it (#507)", async () => {
    state.notices = [{ notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "correction", title: null, updated: null, source: "publisher" }];
    state.matches = [
      { doi: "10.1/paper", source_id: "s-1", url: "u", title: "Paper", claim_ids: [] },
      { doi: "10.1/paper", source_id: "s-2", url: "u2", title: "Orphan", claim_ids: [] },
    ];
    state.resting = [
      { source_id: "s-1", claim_id: "c-9", via: "draws_on", through_source_id: "s-7", through_source_title: "News", relation_type: "repeats" },
      { source_id: "s-1", claim_id: "c-8", via: "copy_or_version", through_source_id: "s-3", through_source_title: "Preprint", relation_type: null },
    ];
    const r = await retractionPollTick({ now: NOW });
    // s-1 has resting claims and wakes its lookouts; s-2 has none and wakes nobody.
    expect(state.fanout).toHaveLength(1);
    expect(r.eventsQueued).toBe(2);
    expect(state.fanout[0]).toMatchObject({
      kind: "retraction",
      payload: {
        source_id: "s-1",
        notice_type: "correction",
        claim_ids: [],
        resting_claims: [
          { claim_id: "c-9", via: "draws_on", through_source_id: "s-7", through_source_title: "News", relation_type: "repeats" },
          { claim_id: "c-8", via: "copy_or_version", through_source_id: "s-3", through_source_title: "Preprint", relation_type: null },
        ],
      },
    });
  });

  it("does not hand a lookout a notice it already holds", async () => {
    state.notices = [{ notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "retraction", title: null, updated: null, source: null }];
    state.matches = [{ doi: "10.1/paper", source_id: "s-1", url: "u", title: "t", claim_ids: ["c-1"] }];
    state.dupPending = 1;
    const r = await retractionPollTick({ now: NOW });
    expect(r.eventsQueued).toBe(0);
    expect(state.fanout).toHaveLength(0);
  });
  it("tells each node's Steward once per notice, naming every path by which the notice reaches it (#507)", async () => {
    state.subscribed = 0;
    state.notices = [
      { notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "expression_of_concern", title: "EoC: X", updated: "2026-09-10T00:00:00Z", source: "publisher" },
    ];
    state.matches = [
      { doi: "10.1/paper", source_id: "s-1", url: "https://doi.org/10.1/paper", title: "Paper", claim_ids: ["c-1"] },
      { doi: "10.1/paper", source_id: "s-2", url: "https://mirror.org/10.1/paper", title: "Mirror", claim_ids: ["c-1"] },
    ];
    state.resting = [
      { source_id: "s-1", claim_id: "c-9", via: "draws_on", through_source_id: "s-7", through_source_title: "News", relation_type: "repeats" },
      { source_id: "s-1", claim_id: "c-8", via: "copy_or_version", through_source_id: "s-3", through_source_title: "Preprint", relation_type: null },
    ];
    const r = await retractionPollTick({ now: NOW });
    // Resting claims are looked up for the Stewards even with no lookout watching.
    expect(r.stewardsTold).toBe(3);
    expect(state.stewards.map((m) => m.claimId)).toEqual(["c-1", "c-9", "c-8"]);
    expect(state.stewards.every((m) => m.trigger === "source_event")).toBe(true);
    const c1 = state.stewards[0]!.context as string;
    expect(c1).toContain("Crossref records an expression of concern notice");
    expect(c1).toContain("dated 2026-09-10");
    expect(c1).toContain("https://doi.org/10.1/notice");
    // Both of c-1's sources are named in its one message.
    expect(c1).toContain('"Paper" (https://doi.org/10.1/paper) is one of this node\'s sources.');
    expect(c1).toContain('"Mirror" (https://mirror.org/10.1/paper) is one of this node\'s sources.');
    expect(state.stewards[1]!.context).toContain('"News", one of this node\'s sources, draws on "Paper" (https://doi.org/10.1/paper) (recorded as repeats).');
    expect(state.stewards[2]!.context).toContain('"Preprint", one of this node\'s sources, is a copy or another version of "Paper"');
    expect(state.fanout).toHaveLength(0);
  });

  it("tells nobody about a notice already recorded, so the overlap window and a re-run never repeat a message", async () => {
    state.notices = [{ notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "retraction", title: null, updated: null, source: null }];
    state.matches = [{ doi: "10.1/paper", source_id: "s-1", url: "u", title: "t", claim_ids: ["c-1"] }];
    state.recorded = false;
    const r = await retractionPollTick({ now: NOW });
    expect(r.stewardsTold).toBe(0);
    expect(state.stewards).toHaveLength(0);
  });

  it("keeps telling the rest when one message cannot be sent", async () => {
    state.notices = [{ notice_doi: "10.1/notice", retracted_dois: ["10.1/paper"], type: "retraction", title: null, updated: null, source: null }];
    state.matches = [{ doi: "10.1/paper", source_id: "s-1", url: "u", title: "t", claim_ids: ["c-1", "c-2"] }];
    state.stewardFails = ["c-1"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await retractionPollTick({ now: NOW });
    warn.mockRestore();
    expect(r.stewardsTold).toBe(1);
    expect(state.stewards.map((m) => m.claimId)).toEqual(["c-2"]);
  });
});
