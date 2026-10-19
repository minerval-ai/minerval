/**
 * A claim is a canonical proposition with no home source, and its Steward
 * decides which instances it carries and in what order (migration 0067).
 *
 *  - get_claim returns the canonical record and an instance_count, never the
 *    instances and never a stance tally.
 *  - get_claim_instances pages the instances in reading order: the Steward's
 *    ranks, then the provenance story (origins first, by depth), then the
 *    date of the statement. Insertion order decides nothing.
 *  - detach_claim_instance removes an instance from every read that shows or
 *    weighs the claim's instances, keeps the row and its reading for the
 *    provenance record, and writes the reason to the audit trail;
 *    reattach_claim_instance restores it.
 *  - set_instance_order ranks the listed ids 1..n and clears the rest.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { executeGovernanceTool } from "../../src/llm/tools/governance-tools.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { getClaimInstances } from "../../src/services/claim-service.js";
import { getProvenanceStory } from "../../src/services/provenance-story-service.js";
import { getClaimSourceMap, recordInstanceReading } from "../../src/services/source-map-service.js";
import { countClaimInstances } from "../../src/services/claim-instance-service.js";

async function source(title: string, sourceType: string, publishedDate: string | null = null) {
  const url = `https://dbtest.example/${randomUUID()}`;
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type, published_date) VALUES ($1, $2, $3, $4) RETURNING id`,
    [url, title, sourceType, publishedDate]
  );
  return { id: row!.id, url };
}

async function instance(claimId: string, sourceId: string, sourceDate: string | null, stance = "affirms") {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, source_date)
     VALUES ($1, $2, 'passage', $3, $4) RETURNING id`,
    [claimId, sourceId, stance, sourceDate]
  );
  return row!.id;
}

const gov = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await executeGovernanceTool(name, input));
const steward = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await executeStewardTool(name, input));
const ids = (page: { instances: Array<{ id: string }> }) => page.instances.map((i) => i.id);

describe("migration 0067: detach and rank columns on claim_instances", () => {
  it("adds nullable detached_at, detached_reason, detached_by and display_rank", async () => {
    const cols = await rawQuery<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'claim_instances'
          AND column_name IN ('detached_at', 'detached_reason', 'detached_by', 'display_rank')
        ORDER BY column_name`
    );
    expect(cols).toEqual([
      { column_name: "detached_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "detached_by", data_type: "text", is_nullable: "YES" },
      { column_name: "detached_reason", data_type: "text", is_nullable: "YES" },
      { column_name: "display_rank", data_type: "integer", is_nullable: "YES" },
    ]);
  });

  it("leaves a row written without them attached and unranked", async () => {
    const claim = await seedClaim("migration default");
    const s = await source("Plain", "unknown");
    const id = await instance(claim, s.id, null);
    const [row] = await rawQuery<{ detached_at: Date | null; display_rank: number | null }>(
      `SELECT detached_at, display_rank FROM claim_instances WHERE id = $1`,
      [id]
    );
    expect(row).toEqual({ detached_at: null, display_rank: null });
  });
});

describe("a claim's instances and the Steward's control of them", () => {
  let claim: string;
  let news1: string; // recorded first, dated 2020, untraced
  let origin: string; // a dataset: an origin by its kind, dated 2022
  let news2: string; // untraced, dated 2019
  let derived: string; // draws on the dataset, dated 2018
  let news1Url: string;

  beforeAll(async () => {
    claim = await seedClaim("instances");
    const sNews1 = await source("News one", "unknown");
    news1Url = sNews1.url;
    const sOrigin = await source("The dataset", "dataset");
    const sNews2 = await source("News two", "unknown", "2019-03");
    const sDerived = await source("Derived piece", "unknown");
    news1 = await instance(claim, sNews1.id, "2020");
    origin = await instance(claim, sOrigin.id, "2022");
    news2 = await instance(claim, sNews2.id, null, "denies"); // dated by its document
    derived = await instance(claim, sDerived.id, "2018");
    await rawQuery(
      `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, fidelity, evidence, reasoning)
       VALUES ($1, $2, 'derives_from', 'faithful', 'passage', 'why')`,
      [derived, sOrigin.id]
    );
    await recordInstanceReading({
      claimId: claim,
      instanceId: news1,
      support: "supports",
      note: "read it",
      createdBy: "claim_steward",
    });
  });

  it("get_claim returns the canonical record with a count and no instances", async () => {
    const out = await gov("get_claim", { claim_id: claim });
    expect(out.claim.id).toBe(claim);
    expect(out.instance_count).toBe(4);
    expect(out).not.toHaveProperty("instances");
    expect(JSON.stringify(out)).not.toMatch(/affirm|denies|verbatim_text/);
    expect(out).toHaveProperty("subclaims");
    expect(out).toHaveProperty("arguments");
    expect(out).toHaveProperty("related_claims");
    expect(out).toHaveProperty("findings_noted");
  });

  it("get_claim_with_context is gone", async () => {
    expect(await executeGovernanceTool("get_claim_with_context", { claim_id: claim })).toMatch(
      /Unknown governance tool/
    );
  });

  it("orders by the story (origins first, then by depth) and then by date, never by insertion", async () => {
    const page = await gov("get_claim_instances", { claim_id: claim });
    expect(ids(page)).toEqual([origin, news2, news1, derived]);
    expect(page.total).toBe(4);
    expect(page.has_more).toBe(false);
    const first = page.instances[0];
    expect(first.story).toMatchObject({ standing: "origin", depth: 0 });
    const n1 = page.instances.find((i: { id: string }) => i.id === news1);
    expect(n1.reading).toMatchObject({ support: "supports", note: "read it" });
    const d = page.instances.find((i: { id: string }) => i.id === derived);
    expect(d.draws_on).toEqual([expect.objectContaining({ source_title: "The dataset", relation_type: "derives_from" })]);
    expect(d.story).toMatchObject({ standing: "derived", depth: 1 });
  });

  it("pages with limit and offset", async () => {
    const p1 = await gov("get_claim_instances", { claim_id: claim, limit: 2 });
    expect(ids(p1)).toEqual([origin, news2]);
    expect(p1).toMatchObject({ total: 4, limit: 2, offset: 0, has_more: true });
    const p2 = await gov("get_claim_instances", { claim_id: claim, limit: 2, offset: 2 });
    expect(ids(p2)).toEqual([news1, derived]);
    expect(p2.has_more).toBe(false);
    const p3 = await gov("get_claim_instances", { claim_id: claim, offset: 10 });
    expect(p3.instances).toEqual([]);
  });

  it("set_instance_order ranks the listed ids first and clears every other rank", async () => {
    let out = await steward("set_instance_order", { claim_id: claim, instance_ids: [derived, news1] });
    expect(out.success).toBe(true);
    expect(ids(await gov("get_claim_instances", { claim_id: claim }))).toEqual([derived, news1, origin, news2]);

    out = await steward("set_instance_order", { claim_id: claim, instance_ids: [news2], reasoning: "the denial first" });
    expect(out.success).toBe(true);
    const ranks = await rawQuery<{ id: string; display_rank: number | null }>(
      `SELECT id, display_rank FROM claim_instances WHERE claim_id = $1`,
      [claim]
    );
    expect(Object.fromEntries(ranks.map((r) => [r.id, r.display_rank]))).toEqual({
      [news2]: 1,
      [news1]: null,
      [origin]: null,
      [derived]: null,
    });
    expect(ids(await gov("get_claim_instances", { claim_id: claim }))).toEqual([news2, origin, news1, derived]);
    // The page and the public read follow the same order.
    expect((await getClaimInstances(claim)).map((i) => i.id)).toEqual([news2, origin, news1, derived]);
    const [audit] = await rawQuery<{ reasoning: string }>(
      `SELECT reasoning FROM audit_log WHERE claim_id = $1 AND action = 'set_instance_order'
        ORDER BY created_at DESC LIMIT 1`,
      [claim]
    );
    expect(audit!.reasoning).toMatch(/the denial first/);
  });

  it("set_instance_order refuses foreign and repeated ids, and an empty list clears the order", async () => {
    const other = await seedClaim("other");
    const s = await source("Elsewhere", "unknown");
    const foreign = await instance(other, s.id, null);
    expect((await steward("set_instance_order", { claim_id: claim, instance_ids: [foreign] })).message).toMatch(
      /Not recorded instances of claim/
    );
    expect((await steward("set_instance_order", { claim_id: claim, instance_ids: [news1, news1] })).message).toMatch(
      /appear once/
    );
    expect((await steward("set_instance_order", { claim_id: claim, instance_ids: [] })).success).toBe(true);
    expect(ids(await gov("get_claim_instances", { claim_id: claim }))).toEqual([origin, news2, news1, derived]);
  });

  it("detach needs a reason and an instance of this claim", async () => {
    expect((await steward("detach_claim_instance", { claim_id: claim, instance_id: news1, reason: " " })).success).toBe(false);
    const other = await seedClaim("other2");
    expect(
      (await steward("detach_claim_instance", { claim_id: other, instance_id: news1, reason: "x" })).message
    ).toMatch(/not a recorded instance/);
  });

  it("detaching removes the instance from counts, pages, the story and the map, and keeps the row", async () => {
    await steward("set_instance_order", { claim_id: claim, instance_ids: [news1] });
    const out = await steward("detach_claim_instance", {
      claim_id: claim,
      instance_id: news1,
      reason: "The piece reports the claim as others' view and takes no side.",
    });
    expect(out).toMatchObject({ success: true, already_detached: false, instance_count: 3 });

    expect((await gov("get_claim", { claim_id: claim })).instance_count).toBe(3);
    expect(await countClaimInstances(claim)).toBe(3);
    expect(ids(await gov("get_claim_instances", { claim_id: claim }))).toEqual([origin, news2, derived]);
    expect((await getClaimInstances(claim)).map((i) => i.id)).not.toContain(news1);
    const story = await getProvenanceStory(claim);
    expect(story.nodes.map((n) => n.source.title)).not.toContain("News one");
    const map = await getClaimSourceMap(claim);
    expect(map.readings[news1]).toBeUndefined();

    // Kept for the provenance record: the row, its reading, and the reason.
    const [row] = await rawQuery<{ detached_reason: string; detached_by: string; display_rank: number | null }>(
      `SELECT detached_reason, detached_by, display_rank FROM claim_instances WHERE id = $1`,
      [news1]
    );
    expect(row).toEqual({
      detached_reason: "The piece reports the claim as others' view and takes no side.",
      detached_by: "claim_steward",
      display_rank: null,
    });
    const readings = await rawQuery(`SELECT 1 FROM claim_instance_readings WHERE instance_id = $1`, [news1]);
    expect(readings).toHaveLength(1);
    const [audit] = await rawQuery<{ reasoning: string }>(
      `SELECT reasoning FROM audit_log WHERE claim_id = $1 AND action = 'detached_claim_instance'`,
      [claim]
    );
    expect(audit!.reasoning).toMatch(/takes no side/);

    // Listed last, with its reason, only when asked for.
    const all = await gov("get_claim_instances", { claim_id: claim, include_detached: true });
    expect(ids(all)).toEqual([origin, news2, derived, news1]);
    expect(all.instances[3].detached).toMatchObject({ by: "claim_steward" });
    expect(all.instances[3].story).toBeNull();
  });

  it("a detached instance cannot be ordered, read into the map, or recorded again", async () => {
    expect((await steward("set_instance_order", { claim_id: claim, instance_ids: [news1] })).message).toMatch(
      /Detached instances cannot be ordered/
    );
    await expect(
      recordInstanceReading({ claimId: claim, instanceId: news1, support: "supports", createdBy: "claim_steward" })
    ).rejects.toThrow(/detached/);
    const again = await steward("record_claim_instance", {
      claim_id: claim,
      url: news1Url,
      verbatim_text: "the passage",
      stance: "affirms",
    });
    expect(again).toMatchObject({ success: false, deduplicated: true, instance_id: news1 });
    expect(again.message).toMatch(/reattach_claim_instance/);
    expect(await countClaimInstances(claim)).toBe(3);
  });

  it("reattaching restores the instance at the default position", async () => {
    const out = await steward("reattach_claim_instance", {
      claim_id: claim,
      instance_id: news1,
      reason: "On a full reading the piece endorses the claim in its own voice.",
    });
    expect(out).toMatchObject({ success: true, was_detached: true, instance_count: 4 });
    expect(ids(await gov("get_claim_instances", { claim_id: claim }))).toEqual([origin, news2, news1, derived]);
    const [row] = await rawQuery<{ detached_at: Date | null; detached_reason: string | null }>(
      `SELECT detached_at, detached_reason FROM claim_instances WHERE id = $1`,
      [news1]
    );
    expect(row).toEqual({ detached_at: null, detached_reason: null });
    const audit = await rawQuery(
      `SELECT 1 FROM audit_log WHERE claim_id = $1 AND action = 'reattached_claim_instance'`,
      [claim]
    );
    expect(audit).toHaveLength(1);
    // Reattaching what is attached changes nothing.
    expect(
      await steward("reattach_claim_instance", { claim_id: claim, instance_id: news1, reason: "again" })
    ).toMatchObject({ success: true, was_detached: false });
  });
});
