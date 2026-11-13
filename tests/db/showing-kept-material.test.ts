/**
 * What a run read through a connection, or computed over a set of files, and
 * kept is a source its node's page drew on (docs/showing-a-page.md, "The gate"), whether or not an instance
 * was recorded from it: an agent keeps a reading when a judgment rests on
 * it. So when the page is shown to readers who do not read its label, the
 * party whose system the reading came from is among those asked, and the
 * source is among those the page says exist.
 *
 * Labels as the review tests use them: `r3-c` reads `r3-a`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import type { GateActor } from "../../src/services/release-gate-service.js";
import { askShowing } from "../../src/services/showing-service.js";
import { summarizeCoverage } from "../../src/services/coverage-service.js";
import { A, C, asPerson, seedNode, seedUser, system, unwall, version, wall } from "./review-3-common.js";

const id: Record<string, string> = {};
let director: GateActor;

/** A call through the connection by a run working on `node`, at `label`, kept as a source or not. */
async function call(node: string, label: string, kept: boolean): Promise<{ call: string; source: string | null }> {
  return system(async () => {
    const callId = randomUUID();
    let source: string | null = null;
    if (kept) {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO sources (url, title, raw_content, content_hash, page_url_hash, facts_checked_at, sensitivity_label, party_id)
         VALUES ($1, 'Corvid warehouse: read_rows', 'A reading.', $2, '', now(), $3, $4) RETURNING id`,
        [`reading:corvid/${callId}`, `hash-${callId}`, label, id.corvid]
      );
      source = row!.id;
      await rawQuery(
        `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, sensitivity_label)
         VALUES ($1, NULL, 'Corvid', 'Corvid is paid on the figures its warehouse shows.', 'connection', $2)`,
        [source, label]
      );
    }
    await rawQuery(
      `INSERT INTO connection_calls
         (id, connection_id, tool, arguments, outcome, result, result_hash, result_chars, claim_id, party_id, source_id, kept_at, sensitivity_label)
       VALUES ($1, $2, 'read_rows', '{}'::jsonb, 'answered', 'A reading.', 'h', 10, $3, $4, $5, $6, $7)`,
      [callId, id.connection, node, id.corvid, source, kept ? new Date() : null, label]
    );
    return { call: callId, source };
  });
}

/** A command a run working on `node` ran over the sets of two parties, kept as a source. An analysis over two parties' sets carries no one party. */
async function analysis(node: string, label: string): Promise<string> {
  return system(async () => {
    const callId = randomUUID();
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, raw_content, content_hash, page_url_hash, facts_checked_at, sensitivity_label, party_id)
       VALUES ($1, 'Analysis of 2 file sets', 'An analysis.', $2, '', now(), $3, NULL) RETURNING id`,
      [`analysis:${callId}`, `hash-${callId}`, label]
    );
    await rawQuery(
      `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, sensitivity_label)
       VALUES ($1, NULL, 'Corvid; Dunlin', 'Corvid: paid on its figures. Dunlin: audited on them.', 'file_set', $2)`,
      [row!.id, label]
    );
    await rawQuery(
      `INSERT INTO sandbox_calls (id, command, file_sets, outcome, output, output_hash, output_chars, claim_id, source_id, kept_at, sensitivity_label)
       VALUES ($1, 'python3 compare.py', $2::jsonb, 'exited', 'ok', 'h', 2, $3, $4, now(), $5)`,
      [
        callId,
        JSON.stringify([
          { id: randomUUID(), name: "Corvid ledger", party_id: id.corvid, party: "Corvid" },
          { id: randomUUID(), name: "Dunlin audit", party_id: id.dunlin, party: "Dunlin" },
        ]),
        node,
        row!.id,
        label,
      ]
    );
    return row!.id;
  });
}

async function pageOf(showingId: string): Promise<{ rests_on: string[]; header: { sources: Array<Record<string, unknown>> } }> {
  const [page] = await system(() =>
    rawQuery<{ rests_on: string[]; header: string }>(`SELECT rests_on, header FROM showing_pages WHERE showing_id = $1`, [showingId])
  );
  return { rests_on: page!.rests_on, header: JSON.parse(page!.header) };
}

beforeAll(async () => {
  await wall();
  await system(async () => {
    const [own] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    if (own) id.org = own.id;
    else {
      const [made] = await rawQuery<{ id: string }>(
        `INSERT INTO parties (name, is_own_organization) VALUES ($1, true) RETURNING id`,
        [`The organization ${Date.now()}`]
      );
      id.org = made!.id;
      id.orgMadeHere = "yes";
    }
    const [corvid] = await rawQuery<{ id: string }>(`INSERT INTO parties (name) VALUES ($1) RETURNING id`, [`Corvid ${Date.now()}`]);
    id.corvid = corvid!.id;
    const [dunlin] = await rawQuery<{ id: string }>(`INSERT INTO parties (name) VALUES ($1) RETURNING id`, [`Dunlin ${Date.now()}`]);
    id.dunlin = dunlin!.id;
    const [connection] = await rawQuery<{ id: string }>(
      `INSERT INTO connections (name, tool_prefix, url, party_id, stake, sensitivity_label)
       VALUES ($1, $2, 'https://warehouse.corvid.example/mcp', $3, 'Corvid is paid on the figures its warehouse shows.', $4) RETURNING id`,
      [`Corvid warehouse ${Date.now()}`, `corvid${Date.now() % 100000}`, id.corvid, A]
    );
    id.connection = connection!.id;
  });
  id.director = await seedUser();
  director = { id: id.director!, holding: ["direct"], clearance: [C, A, "public"], releaseParties: [], direct: true };

  // Two nodes at c, each with a judgment at c and no instance recorded. The
  // run on the first kept its reading; the run on the second looked and kept nothing.
  id.rested = await seedNode(C, "The warehouse shipped more than it received in March");
  id.looked = await seedNode(C, "The warehouse was audited in March");
  await version(id.rested!, C, "supported", "The warehouse's own rows show it.");
  await version(id.looked!, C, "inconclusive", "Nothing found either way.");
  id.keptSource = (await call(id.rested!, C, true)).source!;
  await call(id.looked!, C, false);
  id.compared = await seedNode(C, "The warehouse's ledger agrees with the audit");
  await version(id.compared!, C, "supported", "The two agree line by line.");
  id.analysisSource = await analysis(id.compared!, C);
}, 180_000);

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM connections WHERE id = $1`, [id.connection]);
    await rawQuery(`DELETE FROM sandbox_calls WHERE source_id = $1`, [id.analysisSource]);
    await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[])`, [[id.keptSource, id.analysisSource]]);
  }).catch((err: unknown) => console.warn("[showing-kept-material] cleanup:", err instanceof Error ? err.message : err));
  await unwall();
  await system(() => rawQuery(`DELETE FROM parties WHERE id = ANY($1::uuid[])`, [[id.corvid, id.dunlin, ...(id.orgMadeHere ? [id.org] : [])]])).catch(
    (err: unknown) => console.warn("[showing-kept-material] cleanup:", err instanceof Error ? err.message : err)
  );
}, 180_000);

describe("a page whose run kept a reading", () => {
  it("rests on the party whose system the reading came from, and says the source exists", async () => {
    const asked = await askShowing({ nodeId: id.rested!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: director });
    const page = await pageOf(asked.showing_id);
    // The version read nothing else, so the party of the reading is the one asked.
    expect(page.rests_on).toEqual([id.corvid]);
    expect(page.header.sources).toEqual([
      { source: 1, kind: "unknown", fingerprint: expect.stringMatching(/^hash-/), supplied_by: "an_outside_party", interest_recorded: true },
    ]);
    // The supplier's name and the words of its interest are a part of their own, resting on that party.
    const parts = await system(() =>
      rawQuery<{ kind: string; rests_on: string[]; original: string }>(
        `SELECT p.kind, p.rests_on, p.original FROM showing_parts p JOIN showing_pages g ON g.id = p.page_id WHERE g.showing_id = $1 ORDER BY p.position`,
        [asked.showing_id]
      )
    );
    const supplier = parts.find((p) => p.kind === "supplier")!;
    expect(supplier.original).toContain("Recorded interest: Corvid. Corvid is paid on the figures its warehouse shows.");
    expect(supplier.rests_on).toEqual([id.corvid]);
    // Every paragraph of the version rests on what the version rests on.
    for (const p of parts.filter((x) => x.kind === "summary" || x.kind === "reasoning" || x.kind === "wording")) {
      expect(p.rests_on, p.kind).toEqual([id.corvid]);
    }
  });

  it("an analysis kept in work on the node rests on the party of every set its command had mounted", async () => {
    const asked = await askShowing({ nodeId: id.compared!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: director });
    const page = await pageOf(asked.showing_id);
    // The source itself carries no one party, and is not taken for the organization's own.
    expect([...page.rests_on].sort()).toEqual([id.corvid, id.dunlin].sort());
    expect(page.header.sources).toEqual([
      { source: 1, kind: "unknown", fingerprint: expect.stringMatching(/^hash-/), supplied_by: "an_outside_party", interest_recorded: true },
    ]);
  });

  it("a call that was made and not kept is not a source: the page rests on the organization alone", async () => {
    const asked = await askShowing({ nodeId: id.looked!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: director });
    const page = await pageOf(asked.showing_id);
    expect(page.rests_on).toEqual([id.org]);
    expect(page.header.sources).toEqual([]);
  });
});

describe("what a judgment at a private label was made on, where it rests on a kept reading and no instance", () => {
  it("is said to a reader of that label as evidence they can read, and to one who does not read it as evidence they cannot", async () => {
    // A public node judged at a, on a reading the run kept before it wrote the judgment. Nothing at a is attached to the node.
    const node = await seedNode("public", "The warehouse shipped on every working day in March");
    const kept = await call(node, A, true);
    await version(node, A, "supported", "The warehouse's own rows show it.");
    const said = async (reads: string[]) =>
      (await asPerson([A, "public"], () => summarizeCoverage([node], { saidTo: { reads, outside: false } }))).get(node);
    expect(await said([A, "public"])).toEqual({ examined: true, on: ["evidence_this_reader_can_read"] });
    expect(await said(["public"])).toEqual({ examined: true, on: ["evidence_this_reader_cannot_read"] });
    await system(() => rawQuery(`DELETE FROM sources WHERE id = $1`, [kept.source]));
  });
});
