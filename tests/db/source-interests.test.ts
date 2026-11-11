/**
 * A source's recorded interest (§9) over real SQL: the append-only rows, the
 * newest record standing for its scope while the older ones are kept, the
 * facts read, and the instance reads taking a claim's own record before the
 * source-wide one.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import {
  INTEREST_PARTY_MAX_CHARS,
  INTEREST_STAKE_MAX_CHARS,
  SourceInterestError,
  interestsForClaim,
  listCurrentSourceInterests,
  recordSourceInterest,
} from "../../src/services/source-interest-service.js";
import { getSourceFacts } from "../../src/services/source-facts-service.js";
import { listInstancesForMapping } from "../../src/services/source-map-service.js";
import { getClaimInstancePage, listOrderedClaimInstances } from "../../src/services/claim-instance-service.js";
import { getClaimInstances } from "../../src/services/claim-service.js";
import { getProvenanceStory } from "../../src/services/provenance-story-service.js";
import { seedClaim } from "./helpers.js";

async function seedSource(title: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, $2, 'unknown') RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, title]
  );
  return rows[0]!.id;
}

async function seedInstance(claimId: string, sourceId: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'x') RETURNING id`,
    [claimId, sourceId]
  );
  return rows[0]!.id;
}

interface Row {
  id: string;
  source_id: string;
  claim_id: string | null;
  party: string;
  stake: string;
  recorded_by: string;
  run_id: string | null;
}

async function rowsFor(sourceId: string): Promise<Row[]> {
  return rawQuery<Row>(
    `SELECT id, source_id, claim_id, party, stake, recorded_by, run_id
       FROM source_interests WHERE source_id = $1 ORDER BY created_at, id`,
    [sourceId]
  );
}

const LAB = "Acme Labs";
const OWN_SYSTEM = "Acme develops the system this card describes and sells access to it.";

describe("recordSourceInterest", () => {
  it("records an interest for the source as a whole, with the writer and the run that recorded it", async () => {
    const source = await seedSource("Acme system card");
    const runId = randomUUID();
    const out = await runWithUsageContext({ runId }, () =>
      recordSourceInterest({ sourceId: source, party: ` ${LAB} `, stake: OWN_SYSTEM, recordedBy: "claim_steward" })
    );
    expect(out).toMatchObject({ source_id: source, claim_id: null, party: LAB, stake: OWN_SYSTEM, supersedes_earlier: false });
    expect(new Date(out.recorded_at).getTime()).not.toBeNaN();
    expect(await rowsFor(source)).toEqual([
      { id: out.id, source_id: source, claim_id: null, party: LAB, stake: OWN_SYSTEM, recorded_by: "claim_steward", run_id: runId },
    ]);
  });

  it("records an interest scoped to one claim, apart from the source-wide one", async () => {
    const claim = await seedClaim("interest scoped");
    const source = await seedSource("Funded trial");
    const wide = await recordSourceInterest({ sourceId: source, party: LAB, stake: OWN_SYSTEM, recordedBy: "claim_steward" });
    const scoped = await recordSourceInterest({
      sourceId: source, claimId: claim, party: "Acme Foundation", stake: "The foundation paid for the trial this claim reports.",
      recordedBy: "researcher",
    });
    // A different scope, so nothing is superseded, and outside a run no run is stamped.
    expect(scoped).toMatchObject({ claim_id: claim, supersedes_earlier: false });
    const rows = await rowsFor(source);
    expect(rows.map((r) => [r.id, r.claim_id, r.recorded_by, r.run_id])).toEqual([
      [wide.id, null, "claim_steward", null],
      [scoped.id, claim, "researcher", null],
    ]);
  });

  it("supersedes an earlier record for the same scope for readers, and keeps the history", async () => {
    const claim = await seedClaim("interest superseded");
    const other = await seedClaim("interest superseded, other claim");
    const source = await seedSource("Company blog");
    await recordSourceInterest({ sourceId: source, party: "Acme", stake: "First wording.", recordedBy: "claim_steward" });
    await recordSourceInterest({ sourceId: source, claimId: claim, party: "Acme", stake: "First wording, on the claim.", recordedBy: "claim_steward" });
    await recordSourceInterest({ sourceId: source, claimId: other, party: "Acme", stake: "On the other claim.", recordedBy: "claim_steward" });
    const laterWide = await recordSourceInterest({ sourceId: source, party: LAB, stake: OWN_SYSTEM, recordedBy: "researcher" });
    const laterScoped = await recordSourceInterest({
      sourceId: source, claimId: claim, party: LAB, stake: "Second wording, on the claim.", recordedBy: "claim_steward",
    });
    expect(laterWide.supersedes_earlier).toBe(true);
    expect(laterScoped.supersedes_earlier).toBe(true);

    // Readers get the newest record of each scope: the source-wide one first.
    const current = await listCurrentSourceInterests(source);
    expect(current.map((c) => [c.claim_id, c.party, c.stake])).toEqual([
      [null, LAB, OWN_SYSTEM],
      [other, "Acme", "On the other claim."],
      [claim, LAB, "Second wording, on the claim."],
    ]);
    expect(current[0]!.recorded_at).toBe(laterWide.recorded_at);

    // Every row is still there, unchanged.
    const rows = await rowsFor(source);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.stake)).toEqual([
      "First wording.",
      "First wording, on the claim.",
      "On the other claim.",
      OWN_SYSTEM,
      "Second wording, on the claim.",
    ]);
  });

  it("refuses a source or claim that does not exist, a malformed id, and a missing or overlong party or stake", async () => {
    const source = await seedSource("Refusals");
    const base = { sourceId: source, party: LAB, stake: OWN_SYSTEM, recordedBy: "claim_steward" };
    await expect(recordSourceInterest({ ...base, sourceId: randomUUID() })).rejects.toThrow(/No source .* exists/);
    await expect(recordSourceInterest({ ...base, sourceId: "s1" })).rejects.toThrow(/source_id must be a uuid/);
    await expect(recordSourceInterest({ ...base, claimId: randomUUID() })).rejects.toThrow(/No claim .* exists/);
    await expect(recordSourceInterest({ ...base, claimId: "c1" })).rejects.toThrow(/claim_id must be a uuid/);
    await expect(recordSourceInterest({ ...base, party: "  " })).rejects.toThrow(/party is required/);
    await expect(recordSourceInterest({ ...base, stake: "" })).rejects.toThrow(/stake is required/);
    await expect(recordSourceInterest({ ...base, party: "p".repeat(INTEREST_PARTY_MAX_CHARS + 1) })).rejects.toThrow(
      new RegExp(`party is too long .*at most ${INTEREST_PARTY_MAX_CHARS}`)
    );
    await expect(recordSourceInterest({ ...base, stake: "s".repeat(INTEREST_STAKE_MAX_CHARS + 1) })).rejects.toThrow(
      new RegExp(`stake is too long .*at most ${INTEREST_STAKE_MAX_CHARS}`)
    );
    await expect(recordSourceInterest({ ...base, party: "" })).rejects.toThrow(SourceInterestError);
    expect(await rowsFor(source)).toEqual([]);
    // At the stated lengths a record is taken.
    await recordSourceInterest({
      ...base, party: "p".repeat(INTEREST_PARTY_MAX_CHARS), stake: "s".repeat(INTEREST_STAKE_MAX_CHARS),
    });
    expect(await rowsFor(source)).toHaveLength(1);
  });
});

describe("a source's facts", () => {
  it("carry its current interests and an empty list when none is recorded", async () => {
    const claim = await seedClaim("interest facts");
    const source = await seedSource("Acme product page");
    expect((await getSourceFacts(source))!.interests).toEqual([]);

    await recordSourceInterest({ sourceId: source, party: "Acme", stake: "An earlier wording.", recordedBy: "claim_steward" });
    const wide = await recordSourceInterest({ sourceId: source, party: LAB, stake: OWN_SYSTEM, recordedBy: "claim_steward" });
    const scoped = await recordSourceInterest({
      sourceId: source, claimId: claim, party: LAB, stake: "Acme's revenue depends on this benchmark result.", recordedBy: "researcher",
    });
    expect((await getSourceFacts(source))!.interests).toEqual([
      { party: LAB, stake: OWN_SYSTEM, claim_id: null, recorded_at: wide.recorded_at },
      { party: LAB, stake: "Acme's revenue depends on this benchmark result.", claim_id: claim, recorded_at: scoped.recorded_at },
    ]);
  });
});

describe("a claim's instances", () => {
  it("carry the claim's own record before the source-wide one, the source-wide one elsewhere, and null where none is", async () => {
    const claim = await seedClaim("interest on instances");
    const elsewhere = await seedClaim("interest on instances, another claim");
    const card = await seedSource("Acme system card");
    const review = await seedSource("Independent review");
    const cardInstance = await seedInstance(claim, card);
    const reviewInstance = await seedInstance(claim, review);
    const cardElsewhere = await seedInstance(elsewhere, card);

    const wide = await recordSourceInterest({ sourceId: card, party: LAB, stake: OWN_SYSTEM, recordedBy: "claim_steward" });
    const wideView = { party: LAB, stake: OWN_SYSTEM, claim_id: null, recorded_at: wide.recorded_at };

    // Only the source-wide record: both claims see it.
    expect((await interestsForClaim(claim, [card, review])).get(card)).toEqual(wideView);
    expect((await interestsForClaim(elsewhere, [card])).get(card)).toEqual(wideView);

    // An earlier claim-scoped record, then a later source-wide one: the
    // claim's own record still applies on that claim, however old it is.
    const scoped = await recordSourceInterest({
      sourceId: card, claimId: claim, party: LAB, stake: "The card reports Acme's own evaluation of this capability.",
      recordedBy: "claim_steward",
    });
    const laterWide = await recordSourceInterest({ sourceId: card, party: LAB, stake: "A later source-wide wording.", recordedBy: "claim_steward" });
    const scopedView = {
      party: LAB, stake: "The card reports Acme's own evaluation of this capability.", claim_id: claim, recorded_at: scoped.recorded_at,
    };
    const laterWideView = { party: LAB, stake: "A later source-wide wording.", claim_id: null, recorded_at: laterWide.recorded_at };

    const forClaim = await interestsForClaim(claim, [card, review, card]);
    expect(forClaim.get(card)).toEqual(scopedView);
    expect(forClaim.has(review)).toBe(false);
    expect((await interestsForClaim(elsewhere, [card])).get(card)).toEqual(laterWideView);
    expect((await interestsForClaim(claim, [])).size).toBe(0);

    // The Steward's map.
    const mapped = await listInstancesForMapping(claim);
    const bySource = new Map(mapped.map((i) => [i.source.id, i] as const));
    expect(bySource.get(card)!.instance_id).toBe(cardInstance);
    expect(bySource.get(card)!.source.interest).toEqual(scopedView);
    expect(bySource.get(review)!.source.interest).toBeNull();
    expect((await listInstancesForMapping(elsewhere))[0]!.source.interest).toEqual(laterWideView);

    // The claim page and the API, the MCP read, and the governance roles' page.
    const ordered = await listOrderedClaimInstances(claim);
    expect(ordered.find((i) => i.id === cardInstance)!.source_interest).toEqual(scopedView);
    expect(ordered.find((i) => i.id === reviewInstance)!.source_interest).toBeNull();
    expect((await listOrderedClaimInstances(elsewhere)).find((i) => i.id === cardElsewhere)!.source_interest).toEqual(laterWideView);
    expect((await getClaimInstances(claim)).find((i) => i.id === cardInstance)!.source_interest).toEqual(scopedView);
    const page = await getClaimInstancePage(claim);
    if ("error" in page) throw new Error(page.error);
    expect(page.instances.find((i) => i.id === cardInstance)!.source_interest).toEqual(scopedView);
    expect(page.instances.find((i) => i.id === reviewInstance)!.source_interest).toBeNull();

    // The provenance story.
    const story = await getProvenanceStory(claim);
    const node = (id: string) => story.nodes.find((n) => n.source.id === id)!;
    expect(node(card).source.interest).toEqual(scopedView);
    expect(node(review).source.interest).toBeNull();
    expect((await getProvenanceStory(elsewhere)).nodes[0]!.source.interest).toEqual(laterWideView);
  });
});
