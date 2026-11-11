/**
 * The source backfill (#507) over real SQL: one pass, in id order, over the
 * sources missing facts, (with text) segments or (cited) text; each source
 * filled once and anchored; a batch claimed by moving the cursor, so a
 * second claim takes the next sources, not the same ones; a source that
 * yields nothing passed over rather than retaken; and a finished pass marked
 * done. Then the sweep: a source cited after the pass is fetched and filled
 * once, a source nothing cites is never fetched, and a held lease keeps a
 * second task out.
 *
 * The facts lookup is stubbed (it calls Crossref and the Wayback Machine)
 * and the page fetch is passed in; storing, segmentation and anchoring run
 * for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../../src/services/source-facts-service.js", async () => {
  const { rawQuery } = await import("../../src/db/client.js");
  return {
    refreshSourceFactsOnce: vi.fn(async (id: string, _opts?: { newText?: boolean }) => {
      await rawQuery(`UPDATE sources SET facts_checked_at = now() WHERE id = $1 AND facts_checked_at IS NULL`, [id]);
    }),
  };
});
// No test here reaches the network: a tick given no fetch of its own (and any
// source another suite left in the shared database) fails its fetch instead.
vi.mock("../../src/services/url-guard.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/url-guard.js")>()),
  fetchPublicUrl: vi.fn(async (url: string) => {
    throw new Error(`no network in tests: ${url}`);
  }),
}));
vi.mock("../../src/config.js", async (orig) => {
  const actual = await orig<typeof import("../../src/config.js")>();
  return { ...actual, loadConfig: () => ({ ...actual.loadConfig(), sourceBackfillPerTick: 500 }) };
});

import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { refreshSourceFactsOnce } from "../../src/services/source-facts-service.js";
import {
  SOURCE_BACKFILL_FLAG,
  SOURCE_SWEEP_LEASE_FLAG,
  claimSourceBatch,
  sourceBackfillTick,
} from "../../src/workers/source-backfill.js";

const HTML = `<html><body><h1>Night work and diabetes</h1>
  <p>Shift workers have long been suspected of higher metabolic risk.</p>
  <h2>Results</h2><p>Rotating night work was associated with a 1.4-fold higher risk.</p></body></html>`;

async function seedSource(content: string | null, factsChecked = false): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content, facts_checked_at)
     VALUES ($1, 'Paper', $2, ${factsChecked ? "now()" : "NULL"}) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, content]
  );
  return rows[0]!.id;
}

async function urlOf(sourceId: string): Promise<string> {
  const [row] = await rawQuery<{ url: string }>(`SELECT url FROM sources WHERE id = $1`, [sourceId]);
  return row!.url;
}

async function mark(): Promise<{ after: string | null; done: boolean } | null> {
  const [row] = await rawQuery<{ value: { after: string | null; done: boolean } }>(
    `SELECT value FROM platform_flags WHERE key = $1`,
    [SOURCE_BACKFILL_FLAG]
  );
  return row?.value ?? null;
}

/** Record that a claim's instance cites the source, as record_claim_instance would. */
async function cite(sourceId: string): Promise<void> {
  const claim = await seedClaim(`a claim citing ${sourceId}`);
  await rawQuery(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text)
     VALUES ($1, $2, 'Rotating night work was associated with a 1.4-fold higher risk')`,
    [claim, sourceId]
  );
}

async function stored(sourceId: string): Promise<{ raw_content: string | null; facts_checked_at: Date | null; segments: number }> {
  const [row] = await rawQuery<{ raw_content: string | null; facts_checked_at: Date | null; segments: number }>(
    `SELECT s.raw_content, s.facts_checked_at,
            (SELECT COUNT(*)::int FROM source_segments g WHERE g.source_id = s.id) AS segments
       FROM sources s WHERE s.id = $1`,
    [sourceId]
  );
  return row!;
}

beforeEach(async () => {
  await rawQuery(`DELETE FROM platform_flags WHERE key = ANY($1::text[])`, [
    [SOURCE_BACKFILL_FLAG, SOURCE_SWEEP_LEASE_FLAG],
  ]);
  // Sources other tests in this file left unchecked would be swept too.
  await rawQuery(`UPDATE sources SET facts_checked_at = now() WHERE facts_checked_at IS NULL`);
  vi.mocked(refreshSourceFactsOnce).mockClear();
});

describe("source backfill", () => {
  it("fills facts and segments once, anchors instances, passes over what yields nothing, and finishes", async () => {
    const legacy = await seedSource(HTML);
    const claim = await seedClaim("night work raises diabetes risk");
    const [inst] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text)
       VALUES ($1, $2, 'Rotating night work was associated with a 1.4-fold higher risk') RETURNING id`,
      [claim, legacy]
    );
    const textless = await seedSource(null);
    const empty = await seedSource("<html><body>   </body></html>", true);
    const done = await seedSource(HTML, true);
    await sourceBackfillTick(); // segments `done` too: it has text but no segments
    const doneSegs = await rawQuery(`SELECT id FROM source_segments WHERE source_id = $1`, [done]);

    // Start a fresh pass over what is left.
    await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [SOURCE_BACKFILL_FLAG]);
    vi.mocked(refreshSourceFactsOnce).mockClear();
    const again = await sourceBackfillTick();

    const facts = await rawQuery<{ id: string; facts_checked_at: Date | null }>(
      `SELECT id, facts_checked_at FROM sources WHERE id = ANY($1::uuid[])`,
      [[legacy, textless]]
    );
    expect(facts.every((f) => f.facts_checked_at !== null)).toBe(true);
    const [seg] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM source_segments WHERE source_id = $1`,
      [legacy]
    );
    expect(seg!.n).toBeGreaterThan(0);
    const [anchored] = await rawQuery<{ segment_id: string | null }>(
      `SELECT segment_id FROM claim_instances WHERE id = $1`,
      [inst!.id]
    );
    expect(anchored!.segment_id).not.toBeNull();

    // The second pass retakes only the page with no passages, once, and
    // leaves the already-segmented source's segments as they were.
    const retaken = vi.mocked(refreshSourceFactsOnce).mock.calls.map((c) => c[0]);
    expect(retaken).toContain(empty);
    expect(retaken).not.toContain(legacy);
    expect(again.done).toBe(true);
    expect(await mark()).toMatchObject({ done: true });
    expect(
      (await rawQuery(`SELECT id FROM source_segments WHERE source_id = $1`, [done])).map((r: any) => r.id).sort()
    ).toEqual(doneSegs.map((r: any) => r.id).sort());

    // A finished pass takes nothing more: the cursor stays where it ended.
    // (The sweep may still take a source another suite cited meanwhile.)
    const ended = await mark();
    expect((await sourceBackfillTick()).done).toBe(true);
    expect(await mark()).toEqual(ended);
  });

  it("the pass fetches a cited source that has no text, even one whose facts were checked without it", async () => {
    // Checked by the earlier pass, which only looked up facts: no page, so nothing found.
    const cited = await seedSource(null, true);
    await cite(cited);
    const uncited = await seedSource(null);
    const failing = await seedSource(null);
    await cite(failing);
    const fetch = vi.fn(async (url: string) => {
      if (url === (await urlOf(failing))) throw new Error("403");
      return HTML;
    });

    // Counts are floors throughout: other suites' sources share the database.
    const result = await sourceBackfillTick({ fetch });

    expect(result.fetched).toBeGreaterThanOrEqual(1);
    expect(await stored(cited)).toMatchObject({ raw_content: HTML });
    expect((await stored(cited)).segments).toBeGreaterThan(0);
    // The lookup runs again now there is a page to read.
    expect(vi.mocked(refreshSourceFactsOnce).mock.calls).toContainEqual([cited, { newText: true }]);
    // Nothing cites it: looked up, never fetched.
    expect(fetch.mock.calls.map((c) => c[0])).not.toContain(await urlOf(uncited));
    expect(await stored(uncited)).toMatchObject({ raw_content: null });
    expect((await stored(uncited)).facts_checked_at).not.toBeNull();
    // A page that cannot be fetched is marked checked and passed over.
    expect(await stored(failing)).toMatchObject({ raw_content: null });
    expect((await stored(failing)).facts_checked_at).not.toBeNull();
  });

  it("after the pass, sweeps each newly cited source once", async () => {
    expect((await sourceBackfillTick()).done).toBe(true);

    const cited = await seedSource(null);
    await cite(cited);
    const uncited = await seedSource(null);
    const failing = await seedSource(null);
    await cite(failing);
    const fetch = vi.fn(async (url: string) => {
      if (url === (await urlOf(failing))) throw new Error("timeout");
      return HTML;
    });

    const first = await sourceBackfillTick({ fetch });
    expect(first.done).toBe(true);
    expect(first.taken).toBeGreaterThanOrEqual(2);
    expect(first.fetched).toBeGreaterThanOrEqual(1);
    expect(await stored(cited)).toMatchObject({ raw_content: HTML });
    expect((await stored(cited)).segments).toBeGreaterThan(0);
    expect((await stored(failing)).facts_checked_at).not.toBeNull();
    // Left for intake to decide: neither fetched nor marked.
    expect(await stored(uncited)).toMatchObject({ raw_content: null, facts_checked_at: null });

    // Nothing is taken twice, the failed fetch included.
    fetch.mockClear();
    await sourceBackfillTick({ fetch });
    const again = fetch.mock.calls.map((c) => c[0]);
    expect(again).not.toContain(await urlOf(cited));
    expect(again).not.toContain(await urlOf(failing));
  });

  it("one task sweeps at a time: a live lease keeps a second out, an expired one does not", async () => {
    expect((await sourceBackfillTick()).done).toBe(true);
    const cited = await seedSource(null);
    await cite(cited);
    const fetch = vi.fn(async () => HTML);

    await rawQuery(
      `INSERT INTO platform_flags (key, value)
       VALUES ($1, jsonb_build_object('until', now() + interval '10 minutes'))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SOURCE_SWEEP_LEASE_FLAG]
    );
    expect(await sourceBackfillTick({ fetch })).toMatchObject({ taken: 0 });
    expect(fetch).not.toHaveBeenCalled();

    // The holder died: its lease runs out and the next tick takes the source.
    await rawQuery(
      `UPDATE platform_flags SET value = jsonb_build_object('until', now() - interval '1 second') WHERE key = $1`,
      [SOURCE_SWEEP_LEASE_FLAG]
    );
    await sourceBackfillTick({ fetch });
    expect(await stored(cited)).toMatchObject({ raw_content: HTML });
    // And releases it when done.
    const [lease] = await rawQuery<{ live: boolean }>(
      `SELECT (value->>'until')::timestamptz > now() AS live FROM platform_flags WHERE key = $1`,
      [SOURCE_SWEEP_LEASE_FLAG]
    );
    expect(lease!.live).toBe(false);
  });

  it("claims each batch by moving the cursor, so a second claim takes the next sources", async () => {
    await seedSource(null);
    await seedSource(null);
    await seedSource(null);
    const first = await claimSourceBatch(1);
    const second = await claimSourceBatch(1);
    expect(first.ids).toHaveLength(1);
    expect(second.ids).toHaveLength(1);
    expect(second.ids[0]! > first.ids[0]!).toBe(true);
    expect((await mark())!.after).toBe(second.ids[0]);

    // Concurrent claims never overlap.
    await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [SOURCE_BACKFILL_FLAG]);
    const [a, b] = await Promise.all([claimSourceBatch(2), claimSourceBatch(2)]);
    expect(a.ids.filter((id) => b.ids.includes(id))).toEqual([]);
  });
});
