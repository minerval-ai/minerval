/**
 * What system work writes for a recipient.
 *
 * Work under system clearance sees every label, to find what there is to
 * do. A review found three places where it then wrote what it had seen into
 * rows for recipients at other labels: the retraction poll gave every
 * lookout that watches for retractions the title, the address and the node
 * ids of every matched source, and wrote a public letter naming a private
 * document; the correspondents' change scan named a node at any label; the
 * graph feed woke a lookout for changes it could not read.
 *
 * The rule these hold: what is written for a recipient names a row only
 * where the recipient's label reads it. Labels are `public`, `fan-a` and
 * `fan-b`, which read `public` and not each other. Crossref is a stand-in;
 * the joins against the graph and the fan-out are the application's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stage = vi.hoisted(() => ({ notices: [] as Array<Record<string, unknown>> }));
vi.mock("../../src/services/source-watch-service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/source-watch-service.js")>()),
  retractionNoticesSince: vi.fn(async () => ({ notices: stage.notices, complete: true, readThrough: null })),
}));

import { rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { runAtLabel } from "../../src/llm/usage-context.js";
import { graphChangeScanTick, pendingCorrespondentEvents } from "../../src/services/correspondent-service.js";
import { pendingLookoutEvents } from "../../src/services/lookout-service.js";
import { graphFeedTick, retractionPollTick } from "../../src/workers/lookout-triggers.js";

const A = "fan-a";
const B = "fan-b";
const system = <T>(fn: () => Promise<T>) => withSystemClearance("A fan-out test seeds and checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a fan-out test", fn);
/** The poll and the scans as their workers run them. */
const asTheWorker = <T>(fn: () => Promise<T>) => withSystemClearance("A fan-out test runs a sweep as its worker does.", fn);

const tag = randomUUID().slice(0, 8);
const doi = `10.5555/fanout.${tag}`;
const lookouts: Record<string, string> = {};
const grants: Record<string, string> = {};
const made = {
  claims: [] as string[],
  sources: [] as string[],
  funder: "",
  pausedLookouts: [] as string[],
  pausedCorrespondents: [] as string[],
};
let claimAtA = "";
let publicClaim = "";

async function seedClaim(text: string, label: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claims (text, steward_state, tagged_at, sensitivity_label) VALUES ($1, 'done', now(), $2) RETURNING id`,
    [text, label]
  );
  made.claims.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'One partner.'), ($2, 'Another partner.') ON CONFLICT DO NOTHING`, [A, B]);
    await rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public') ON CONFLICT DO NOTHING`, [A, B]);
  });
  await ensureEnforcement();
  await system(async () => {
    const [funder] = await rawQuery<{ id: string }>(
      `INSERT INTO contributors (display_name, external_id) VALUES ('Fan-out funder', $1) RETURNING id`,
      [`fan-out-${tag}`]
    );
    made.funder = funder!.id;
    // No other lookout or correspondent is in the way of these; they are put back afterwards.
    made.pausedLookouts = (await rawQuery<{ id: string }>(`UPDATE lookouts SET status = 'paused' WHERE status = 'active' RETURNING id`)).map((r) => r.id);
    made.pausedCorrespondents = (
      await rawQuery<{ id: string }>(`UPDATE correspondents SET status = 'paused' WHERE status = 'active' RETURNING id`)
    ).map((r) => r.id);
    // A mandate with a lookout that watches for retractions and the graph, at each label.
    for (const label of ["public", A, B]) {
      const [job] = await rawQuery<{ id: string }>(
        `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status, sensitivity_label) VALUES ($1, 'grant', 1000000, 'running', $2) RETURNING id`,
        [funder!.id, label]
      );
      const [grant] = await rawQuery<{ id: string }>(
        `INSERT INTO grants (funder_user_id, budget_job_id, name, policy, status, daily_budget_micro_usd, sensitivity_label)
         VALUES ($1, $2, $3, 'custom', 'active', 100000, $4) RETURNING id`,
        [funder!.id, job!.id, `Fan-out mandate at ${label} ${tag}`, label]
      );
      grants[label] = grant!.id;
      const [l] = await rawQuery<{ id: string }>(
        `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers, sensitivity_label)
         VALUES ($1, $2, 'Watch.', 24, '["retraction", "graph"]'::jsonb, $3) RETURNING id`,
        [grant!.id, `Watch at ${label}`, label]
      );
      lookouts[label] = l!.id;
    }
    // Partner a's private document, a private node that rests on it, and a
    // public node on which partner a's run recorded a passage from it.
    claimAtA = await seedClaim("A-ONLY CLAIM: partner A's compound works because of this paper", A);
    publicClaim = await seedClaim(`Fan-out public node ${tag}`, "public");
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (title, url, doi, sensitivity_label)
       VALUES ('A-ONLY SOURCE TITLE: the paper partner A is quietly relying on', $1, $2, $3) RETURNING id`,
      [`https://doi.org/${doi}`, doi, A]
    );
    made.sources.push(source!.id);
    for (const claim of [claimAtA, publicClaim]) {
      await rawQuery(
        `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, sensitivity_label) VALUES ($1, $2, 'A-ONLY PASSAGE', $3)`,
        [claim, source!.id, A]
      );
    }
  });
  stage.notices = [
    { notice_doi: `10.5555/notice.${tag}`, retracted_dois: [doi], type: "retraction", title: "Retraction notice", updated: new Date().toISOString(), source: "publisher" },
  ];
});

afterAll(async () => {
  await system(async () => {
    const lookoutIds = Object.values(lookouts);
    const grantIds = Object.values(grants);
    await rawQuery(`DELETE FROM lookout_events WHERE lookout_id = ANY($1::uuid[])`, [lookoutIds]);
    await rawQuery(`DELETE FROM correspondent_events WHERE correspondent_id IN (SELECT id FROM correspondents WHERE grant_id = ANY($1::uuid[]))`, [grantIds]);
    await rawQuery(`DELETE FROM correspondents WHERE grant_id = ANY($1::uuid[])`, [grantIds]);
    await rawQuery(`DELETE FROM lookouts WHERE id = ANY($1::uuid[])`, [lookoutIds]);
    await rawQuery(`DELETE FROM actions WHERE claim_id = ANY($1::uuid[]) OR target_ref = ANY($2::text[])`, [made.claims, [...lookoutIds, ...grantIds]]);
    await rawQuery(`DELETE FROM grants WHERE id = ANY($1::uuid[])`, [grantIds]);
    await rawQuery(`DELETE FROM budget_jobs WHERE user_id = $1`, [made.funder]);
    for (const table of ["node_messages", "assessments", "claim_instances"]) {
      await rawQuery(`DELETE FROM ${table} WHERE ${table === "node_messages" ? "node_id" : "claim_id"} = ANY($1::uuid[])`, [made.claims]);
    }
    await rawQuery(`DELETE FROM source_events WHERE source_id = ANY($1::uuid[])`, [made.sources]);
    await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[])`, [made.sources]);
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [made.claims]);
    await rawQuery(`DELETE FROM contributors WHERE id = $1`, [made.funder]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B]]);
    await rawQuery(`UPDATE lookouts SET status = 'active' WHERE id = ANY($1::uuid[])`, [made.pausedLookouts]);
    await rawQuery(`UPDATE correspondents SET status = 'active' WHERE id = ANY($1::uuid[])`, [made.pausedCorrespondents]);
  }).catch((err: unknown) => console.warn("[system-fan-out] cleanup:", err instanceof Error ? err.message : err));
});

describe("the retraction poll", () => {
  it("hands a lookout the matched sources its own label reads and nothing of the others, and tells a node only what its label reads", async () => {
    const result = await asTheWorker(() => retractionPollTick({ force: true }));
    expect(result.matchedSources).toBe(1);
    expect(result.sourceEvents).toBe(1);
    // One lookout reads the document: the one at fan-a.
    expect(result.eventsQueued).toBe(1);

    const events = (label: string) =>
      system(() =>
        rawQuery<{ sensitivity_label: string; payload: Record<string, unknown> }>(
          `SELECT sensitivity_label, payload FROM lookout_events WHERE lookout_id = $1 AND kind = 'retraction'`,
          [lookouts[label]]
        )
      );
    // The lookouts at public and at fan-b are not told: neither reads the document.
    expect(await events("public")).toEqual([]);
    expect(await events(B)).toEqual([]);
    expect(await at(B, () => pendingLookoutEvents(lookouts[B]!))).toEqual([]);
    // The lookout at fan-a is, at its label, with the nodes its label reads.
    const forA = await events(A);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.sensitivity_label).toBe(A);
    expect(String(forA[0]!.payload.source_title)).toContain("A-ONLY SOURCE TITLE");
    expect((forA[0]!.payload.claim_ids as string[]).sort()).toEqual([claimAtA, publicClaim].sort());

    // Nothing anywhere at public, or at fan-b, names the private document.
    const leaked = await system(() =>
      rawQuery<{ where_found: string }>(
        `SELECT 'lookout_events' AS where_found FROM lookout_events
          WHERE sensitivity_label <> $1 AND payload::text LIKE '%A-ONLY%'
         UNION ALL
         SELECT 'node_messages' FROM node_messages m
          WHERE m.sensitivity_label <> $1 AND to_jsonb(m)::text LIKE '%A-ONLY%'`,
        [A]
      )
    );
    expect(leaked).toEqual([]);

    // The private node's Steward is told, at fan-a. The public node is tied
    // to the document only by a passage at fan-a, which its own label does
    // not read, so no letter is written to it.
    expect(result.stewardsTold).toBe(1);
    const letters = await system(() =>
      rawQuery<{ node_id: string; sensitivity_label: string }>(
        `SELECT node_id, sensitivity_label FROM node_messages WHERE node_id = ANY($1::uuid[])`,
        [[claimAtA, publicClaim]]
      )
    );
    expect(letters).toEqual([{ node_id: claimAtA, sensitivity_label: A }]);
  });

  it("does not hand a lookout the same notice twice", async () => {
    const again = await asTheWorker(() => retractionPollTick({ force: true }));
    expect(again.eventsQueued).toBe(0);
    expect(again.stewardsTold).toBe(0);
  });
});

describe("the graph feed and the correspondents' change scan", () => {
  it("wake a recipient for a change its label reads, and not for one it does not", async () => {
    // A correspondent at public and one at fan-a, both following the private node.
    const correspondents: Record<string, string> = {};
    await system(async () => {
      for (const label of ["public", A]) {
        const [c] = await rawQuery<{ id: string }>(
          `INSERT INTO correspondents (grant_id, title, brief, audience, scope_claim_ids, heartbeat_hours, triggers, created_by, created_at, sensitivity_label)
           VALUES ($1, $2, 'Tell the audience when the standing of the claims in scope changes materially.', 'People who follow this.',
                   ARRAY[$3]::uuid[], 0, '["graph_change"]'::jsonb, 'grantmaker:review', now() - interval '1 minute', $4)
           RETURNING id`,
          [grants[label], `Reporter at ${label}`, claimAtA, label]
        );
        correspondents[label] = c!.id;
      }
      await rawQuery(
        `UPDATE lookouts SET territory_claim_ids = ARRAY[$2]::uuid[], last_run_at = now() - interval '1 hour', changes_cursor = NULL
          WHERE id = ANY($1::uuid[])`,
        [Object.values(lookouts), claimAtA]
      );
      await rawQuery(`DELETE FROM lookout_events WHERE lookout_id = ANY($1::uuid[])`, [Object.values(lookouts)]);
    });
    // Something material changes on the private node: a judgment, at fan-a.
    await at(A, () =>
      rawQuery(
        `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, model, is_current, trigger, sensitivity_label)
         VALUES ($1, 'supported', 0.8, 'A-ONLY JUDGMENT', 'fan-out test', 'm', true, 'review', $2)`,
        [claimAtA, A]
      )
    );

    const scan = await asTheWorker(() => graphChangeScanTick());
    expect(scan.queued).toBe(1);
    expect(await system(() => pendingCorrespondentEvents(correspondents.public!))).toEqual([]);
    const told = await system(() => pendingCorrespondentEvents(correspondents[A]!));
    expect(told).toHaveLength(1);
    expect(told[0]!.payload.claim_id).toBe(claimAtA);

    const feed = await asTheWorker(() => graphFeedTick());
    expect(feed.woke).toBe(1);
    const woken = await system(() =>
      rawQuery<{ lookout_id: string; sensitivity_label: string }>(
        `SELECT lookout_id, sensitivity_label FROM lookout_events WHERE lookout_id = ANY($1::uuid[]) AND kind = 'graph'`,
        [Object.values(lookouts)]
      )
    );
    // The lookout at fan-a alone, and its wake is at its own label.
    expect(woken).toEqual([{ lookout_id: lookouts[A], sensitivity_label: A }]);
    // A lookout that could not read the change is not woken at the next tick either.
    expect((await asTheWorker(() => graphFeedTick())).woke).toBe(0);
  });
});
