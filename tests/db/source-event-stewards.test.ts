/**
 * A notice on a source reaches the Stewards of the nodes resting on it, over
 * real SQL (#507, #566): a retraction, correction or other notice recorded
 * against a source, by either watcher (the Crossref poll, or the facts
 * fetch's DOI check), is one `source_event` message in the inbox of every
 * active node with the source attached or resting on it through recorded
 * provenance. The message names the notice and the source; the node becomes
 * a candidate and its reassess rows open with no money on them, as for any
 * other message, so the pass runs when someone commissions it. A source no
 * node rests on has its event recorded and tells nobody.
 *
 * Only Crossref is replaced: the poll's window of notices, and the facts
 * fetch's DOI check.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { crossref } = vi.hoisted(() => ({
  crossref: { notices: [] as Array<Record<string, unknown>> },
}));

vi.mock("../../src/services/source-watch-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/source-watch-service.js")>();
  return {
    ...actual,
    retractionNoticesSince: vi.fn(async () => ({ notices: crossref.notices, complete: true, readThrough: null })),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { retractionPollTick } from "../../src/workers/lookout-triggers.js";
import { refreshSourceFacts } from "../../src/services/source-facts-service.js";
import { getJudgmentInputs, recordJudgmentInputs } from "../../src/services/judgment-inputs-service.js";
import { openInbox } from "../../src/services/inbox-service.js";
import type { DoiCheck } from "../../src/services/source-watch-service.js";
import { seedClaim } from "./helpers.js";

const newDoi = () => `10.5555/${randomUUID().slice(0, 12)}`;

async function seedSource(title: string, doi?: string): Promise<{ id: string; url: string }> {
  const url = doi ? `https://doi.org/${doi}` : `https://dbtest.example/${randomUUID()}`;
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title) VALUES ($1, $2) RETURNING id`,
    [url, title]
  );
  return { id: row!.id, url };
}

async function seedInstance(claimId: string, sourceId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'a passage') RETURNING id`,
    [claimId, sourceId]
  );
  return row!.id;
}

/** A claim with a judgment in force, its inputs recorded, at rest: as a Steward's pass leaves it. */
async function seedJudgedClaim(label: string, sourceIds: string[]): Promise<string> {
  const claim = await seedClaim(label);
  for (const s of sourceIds) await seedInstance(claim, s);
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace)
     VALUES ($1, 'supported', 0.7, 'dbtest') RETURNING id`,
    [claim]
  );
  await recordJudgmentInputs(rawQuery, "assessment", row!.id, claim);
  await rawQuery(`UPDATE claims SET steward_state = 'done', steward_trigger = NULL WHERE id = $1`, [claim]);
  return claim;
}

const messages = (nodeId: string) =>
  rawQuery<{ trigger: string; sender_kind: string; paid: boolean; body: string }>(
    `SELECT trigger, sender_kind, paid, body FROM node_messages WHERE node_id = $1 ORDER BY created_at, id`,
    [nodeId]
  );

async function stewardState(claimId: string) {
  const [c] = await rawQuery<{ steward_state: string; steward_trigger: string | null }>(
    `SELECT steward_state, steward_trigger FROM claims WHERE id = $1`,
    [claimId]
  );
  return c!;
}

/** The node's pass rows on the ledger, and the money placed on them. */
async function ledger(claimId: string) {
  const rows = await rawQuery<{ kind: string; variant: string; status: string }>(
    `SELECT kind, variant, status FROM actions WHERE exclusion_group = $1 ORDER BY variant`,
    [`assess:${claimId}`]
  );
  const [money] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM action_allocations WHERE exclusion_group = $1`,
    [`assess:${claimId}`]
  );
  return { rows, allocations: money!.n };
}

const mentions = async (text: string) =>
  (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM node_messages WHERE body LIKE '%' || $1 || '%'`, [text]))[0]!.n;

const eventsOn = (sourceId: string) =>
  rawQuery<{ kind: string; detected_by: string; notice_url: string }>(
    `SELECT kind, detected_by, notice_url FROM source_events WHERE source_id = $1`,
    [sourceId]
  );

describe("a notice the Crossref poll finds", () => {
  it("tells the Steward of a judged claim with the source attached, by a message that opens unfunded work, and tells nobody about a source no claim rests on", async () => {
    const doi = newDoi();
    const loneDoi = newDoi();
    const noticeDoi = newDoi();
    const paper = await seedSource("Retracted paper", doi);
    const lone = await seedSource("Paper nobody cites", loneDoi);
    const other = await seedSource("Unrelated paper", newDoi());
    const claim = await seedJudgedClaim("rests on the retracted paper", [paper.id]);
    const bystander = await seedJudgedClaim("rests on something else", [other.id]);
    const before = await ledger(claim);
    expect(before.rows).toEqual([]);

    crossref.notices = [
      { notice_doi: noticeDoi, retracted_dois: [doi], type: "retraction", title: "Retraction: a paper", updated: "2026-10-01T00:00:00Z", source: "retraction-watch" },
      { notice_doi: newDoi(), retracted_dois: [loneDoi], type: "retraction", title: "Retraction: another", updated: "2026-10-02T00:00:00Z", source: "publisher" },
    ];
    const r = await retractionPollTick({ force: true });
    expect(r).toMatchObject({ skipped: false, notices: 2, matchedSources: 2, sourceEvents: 2, stewardsTold: 1 });

    // The event is on the source, and the judgment made against it now reads as out of date.
    expect(await eventsOn(paper.id)).toEqual([
      { kind: "retraction", detected_by: "crossref_poll", notice_url: `https://doi.org/${noticeDoi}` },
    ]);
    const since = (await getJudgmentInputs(claim))!;
    expect(since.sources.events_since).toEqual([expect.objectContaining({ source_id: paper.id, kind: "retraction" })]);

    // One message, from the system, unpaid, naming the notice and the source.
    const inbox = await messages(claim);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ trigger: "source_event", sender_kind: "system", paid: false });
    expect(inbox[0]!.body).toContain(
      'Crossref records a retraction notice ("Retraction: a paper") dated 2026-10-01 against a document this node rests on.'
    );
    expect(inbox[0]!.body).toContain(`The notice: https://doi.org/${noticeDoi}.`);
    expect(inbox[0]!.body).toContain(`- "Retracted paper" (${paper.url}) is one of this node's sources.`);
    expect((await openInbox(claim)).brief).toMatch(/\[m1\] source_event · .* · from the system\n/);

    // The normal path: the node is a candidate, its reassess rows are open, and nothing has paid for them.
    expect(await stewardState(claim)).toEqual({ steward_state: "pending", steward_trigger: "source_event" });
    const after = await ledger(claim);
    expect(after.rows.length).toBeGreaterThan(0);
    expect(after.rows.every((a) => a.kind === "reassess" && a.status === "open")).toBe(true);
    expect(after.rows.map((a) => a.variant)).toContain("standard");
    expect(after.allocations).toBe(0);

    // The source no claim rests on: recorded, and nobody told.
    expect(await eventsOn(lone.id)).toHaveLength(1);
    expect(await mentions(lone.url)).toBe(0);
    // A claim resting on another source is left as it was.
    expect(await messages(bystander)).toEqual([]);
    expect(await stewardState(bystander)).toEqual({ steward_state: "done", steward_trigger: null });
    expect((await ledger(bystander)).rows).toEqual([]);

    // The same notice seen again (the poll's overlap window, a re-run) repeats nothing.
    const again = await retractionPollTick({ force: true });
    expect(again).toMatchObject({ sourceEvents: 0, stewardsTold: 0 });
    expect(await messages(claim)).toHaveLength(1);
  });

  it("reaches every active node with the source attached, judged or not, and not one whose instance was detached", async () => {
    const doi = newDoi();
    const paper = await seedSource("Corrected paper", doi);
    const unjudged = await seedClaim("not yet assessed");
    await seedInstance(unjudged, paper.id);
    const detached = await seedJudgedClaim("its instance was detached after the judgment", [paper.id]);
    await rawQuery(`UPDATE claim_instances SET detached_at = now() WHERE claim_id = $1`, [detached]);

    crossref.notices = [
      { notice_doi: newDoi(), retracted_dois: [doi], type: "correction", title: null, updated: null, source: "publisher" },
    ];
    const r = await retractionPollTick({ force: true });
    expect(r).toMatchObject({ sourceEvents: 1, stewardsTold: 1 });

    // The unjudged node reads the notice on its first pass: its rows are assess rows.
    expect((await messages(unjudged)).map((m) => m.trigger)).toEqual(["source_event"]);
    expect((await ledger(unjudged)).rows.every((a) => a.kind === "assess")).toBe(true);
    // The detached node is not told, though its judgment in force was made against the source.
    expect(await messages(detached)).toEqual([]);
    expect((await getJudgmentInputs(detached))!.sources.events_since).toHaveLength(1);
  });
});

describe("a notice the facts fetch finds", () => {
  function work(doi: string, updates: DoiCheck["updates"]): DoiCheck {
    return {
      doi, found: true, title: "Registered title", type: "journal-article", published: "2021-06",
      cited_by: 3, authors: ["Jane Smith"], publisher: "Registry Press", container: null,
      updates, updates_to: [],
    };
  }

  it("tells the Stewards of the nodes resting on the source, the first time the notice is recorded", async () => {
    // A source cited by URL and judged against before its facts were looked up.
    const doi = newDoi();
    const noticeDoi = newDoi();
    const paper = await seedSource("Cited before it was checked", doi);
    const news = await seedSource("News story drawing on it");
    const claim = await seedJudgedClaim("cites the paper", [paper.id]);
    const viaNews = await seedJudgedClaim("cites the news story", [news.id]);
    const [newsInstance] = await rawQuery<{ id: string }>(
      `SELECT id FROM claim_instances WHERE claim_id = $1`,
      [viaNews]
    );
    await rawQuery(
      `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, evidence, reasoning)
       VALUES ($1, $2, 'repeats', 'passage', 'why')`,
      [newsInstance!.id, paper.id]
    );

    const checkDoi = async (d: string) =>
      work(d, [{ doi: noticeDoi, type: "retraction", label: "Retraction", updated: "2026-08-12T00:00:00Z", source: "publisher" }]);
    const first = await refreshSourceFacts(paper.id, { checkDoi, archive: false });
    expect(first.events_recorded).toBe(1);
    expect(await eventsOn(paper.id)).toEqual([
      { kind: "retraction", detected_by: "facts_fetch", notice_url: `https://doi.org/${noticeDoi}` },
    ]);
    expect((await getJudgmentInputs(claim))!.sources.events_since).toHaveLength(1);

    const inbox = await messages(claim);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ trigger: "source_event", sender_kind: "system", paid: false });
    expect(inbox[0]!.body).toContain(
      "Crossref records a retraction notice dated 2026-08-12 against a document this node rests on."
    );
    expect(inbox[0]!.body).toContain(`The notice: https://doi.org/${noticeDoi}.`);
    expect(inbox[0]!.body).toContain(`- "Cited before it was checked" (${paper.url}) is one of this node's sources.`);
    expect((await openInbox(claim)).brief).toMatch(/\[m1\] source_event · .* · from the system\n/);
    expect(await stewardState(claim)).toEqual({ steward_state: "pending", steward_trigger: "source_event" });
    const rows = await ledger(claim);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((a) => a.kind === "reassess" && a.status === "open")).toBe(true);
    expect(rows.allocations).toBe(0);

    // The node whose source draws on the paper is told the path.
    const resting = await messages(viaNews);
    expect(resting).toHaveLength(1);
    expect(resting[0]!.body).toContain(
      `- "News story drawing on it", one of this node's sources, draws on "Cited before it was checked" (${paper.url}) (recorded as repeats).`
    );

    // Looking again records nothing new and tells nobody twice.
    const again = await refreshSourceFacts(paper.id, { checkDoi, archive: false });
    expect(again.events_recorded).toBe(0);
    expect(await messages(claim)).toHaveLength(1);
    expect(await messages(viaNews)).toHaveLength(1);
  });

  it("tells of every kind of notice it records, in Crossref's own word for it", async () => {
    // The poll asks Crossref for retractions, corrections and expressions of
    // concern; the DOI check returns every notice against the work, and each
    // is recorded (an erratum as a correction, a new version as an update)
    // and counted by since_assessed, so each is told.
    const paper = await seedSource("Paper with two notices", newDoi());
    const claim = await seedJudgedClaim("cites the paper with two notices", [paper.id]);
    const result = await refreshSourceFacts(paper.id, {
      checkDoi: async (d) =>
        work(d, [
          { doi: newDoi(), type: "erratum", label: "Erratum", updated: "2026-07-01T00:00:00Z", source: "publisher" },
          { doi: newDoi(), type: "new_version", label: "New version", updated: null, source: "publisher" },
        ]),
      archive: false,
    });
    expect(result.events_recorded).toBe(2);
    expect((await eventsOn(paper.id)).map((e) => e.kind).sort()).toEqual(["correction", "update"]);
    expect((await getJudgmentInputs(claim))!.sources.events_since).toHaveLength(2);
    const bodies = (await messages(claim)).map((m) => m.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("Crossref records an erratum notice dated 2026-07-01 against a document this node rests on.");
    expect(bodies[1]).toContain("Crossref records a new version notice against a document this node rests on.");
  });

  it("tells nobody when no node rests on the source", async () => {
    const paper = await seedSource("Fetched, cited by nothing", newDoi());
    const result = await refreshSourceFacts(paper.id, {
      checkDoi: async (d) =>
        work(d, [{ doi: newDoi(), type: "correction", label: "Correction", updated: null, source: "publisher" }]),
      archive: false,
    });
    expect(result.events_recorded).toBe(1);
    expect(await mentions(paper.url)).toBe(0);
  });
});
