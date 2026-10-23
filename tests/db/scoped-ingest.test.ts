/**
 * Scoped ingest over real SQL (services/ingest-focus-service.ts): a plan's
 * ingest of one URL for a focus is its own ledger group with the focus on
 * record, beside the whole-document group; the extraction record decides
 * what an ingest would only repeat; the extraction worker hands the focus
 * to the extractor, records what it read the document for, closes the
 * scoped group, and adds no second instance for a claim the source already
 * carries. The extractor and matcher are faked; everything else is real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

const fake = vi.hoisted(() => ({
  extractInputs: [] as Array<Record<string, unknown>>,
  claims: [] as Array<Record<string, unknown>>,
  matchTo: null as string | null,
}));

vi.mock("../../src/llm/agents/extractor.js", () => ({
  extractClaims: vi.fn(async (input: Record<string, unknown>) => {
    fake.extractInputs.push(input);
    return fake.claims;
  }),
}));
vi.mock("../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(async () =>
    fake.matchTo
      ? { outcome: "match", is_match: true, matched_claim_id: fake.matchTo, instance_stance: "affirms" }
      : { outcome: "new", is_match: false, matched_claim_id: null, new_canonical_form: null, instance_stance: "affirms" }
  ),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embeddings in tests");
  }),
}));
vi.mock("../../src/services/source-facts-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/source-facts-service.js")>()),
  refreshSourceFactsOnce: vi.fn(async () => {}),
}));
vi.mock("../../src/services/url-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/url-guard.js")>()),
  assertPublicHttpUrl: async (raw: string) => new URL(raw),
}));

import { materializePlanItems } from "../../src/services/action-service.js";
import {
  ingestCoverage,
  ingestGroup,
  recordExtraction,
  sourceExtractions,
} from "../../src/services/ingest-focus-service.js";
import { flagIngest } from "../../src/services/lookout-service.js";
import { handleUrlExtraction } from "../../src/workers/url-extraction.js";
import { createJob } from "../../src/services/job-service.js";
import { getSourceDocument } from "../../src/services/source-segment-service.js";

const FOCUS = "the author's claims about grid reliability";

async function seedSource(url: string, content: string | null = null): Promise<string> {
  const [s] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content) VALUES ($1, 'An essay', $2) RETURNING id`,
    [url, content]
  );
  return s!.id;
}

async function seedLookout(grantId: string): Promise<string> {
  const [l] = await rawQuery<{ id: string }>(
    `INSERT INTO lookouts (grant_id, title, brief) VALUES ($1, 'Watch', $2) RETURNING id`,
    [grantId, "Watch the essays and ingest what bears on the mandate."]
  );
  return l!.id;
}

beforeEach(() => {
  fake.extractInputs = [];
  fake.claims = [];
  fake.matchTo = null;
});

describe("plan materialization", () => {
  it("opens one group per focus beside the whole-document group, with the focus on record", async () => {
    const funder = await seedUser("scoped");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000 });
    const url = `https://example.org/${randomUUID()}`;
    const items = [
      { action: "ingest", url, rationale: "whole" },
      { action: "ingest", url, rationale: "scoped", focus: FOCUS },
      { action: "ingest", url, rationale: "same focus, spaced", focus: `  ${FOCUS.replace(/ /g, "  ")} ` },
    ];
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [grantId, JSON.stringify({ items })]);
    const out = await materializePlanItems(grantId);
    const groups = out.map((o) => o.ledger.exclusion_group);
    expect(groups[0]).toBe(`ingest:${url}`);
    expect(groups[1]).toBe(ingestGroup(url, FOCUS));
    expect(groups[2]).toBe(groups[1]);
    const rows = await rawQuery<{ exclusion_group: string; label: string }>(
      `SELECT exclusion_group, label FROM actions WHERE target_ref = $1 ORDER BY exclusion_group`,
      [url]
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.exclusion_group === groups[1])!.label).toContain(`focus: ${FOCUS}`);
    const [focus] = await rawQuery<{ focus: string }>(
      `SELECT focus FROM ingest_focuses WHERE exclusion_group = $1`,
      [groups[1]]
    );
    expect(focus!.focus).toBe(FOCUS);
  });
});

describe("what an ingest would only repeat", () => {
  it("covers by a whole reading, by the same focus, or (with no records) by the old rule", async () => {
    const fresh = `https://example.org/${randomUUID()}`;
    expect(await ingestCoverage(fresh, null)).toEqual({ covered: false });

    // Legacy: a source extracted before records existed is covered whole and scoped.
    const legacyUrl = `https://example.org/${randomUUID()}`;
    const legacy = await seedSource(legacyUrl);
    const claim = await seedClaim("legacy claim");
    await rawQuery(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'x')`,
      [claim, legacy]
    );
    expect(await ingestCoverage(legacyUrl, null)).toMatchObject({ covered: true, by: "legacy" });
    expect(await ingestCoverage(legacyUrl, FOCUS)).toMatchObject({ covered: true, by: "legacy" });

    // A source row nothing was ever extracted from (a cited URL) can be read for a focus.
    const citedUrl = `https://example.org/${randomUUID()}`;
    await seedSource(citedUrl);
    expect(await ingestCoverage(citedUrl, FOCUS)).toEqual({ covered: false });

    // Read for a focus: the same focus is covered; another focus, or whole, is not.
    const scopedUrl = `https://example.org/${randomUUID()}`;
    const scoped = await seedSource(scopedUrl);
    await recordExtraction({ sourceId: scoped, focus: FOCUS, claimsExtracted: 2, claimsCreated: 2, claimsMatched: 0 });
    expect(await ingestCoverage(scopedUrl, ` ${FOCUS} `)).toMatchObject({ covered: true, by: "same_focus" });
    expect(await ingestCoverage(scopedUrl, "claims about housing")).toEqual({ covered: false });
    expect(await ingestCoverage(scopedUrl, null)).toEqual({ covered: false });

    // Read whole: everything is covered.
    await recordExtraction({ sourceId: scoped, focus: null, claimsExtracted: 5, claimsCreated: 3, claimsMatched: 2 });
    expect(await ingestCoverage(scopedUrl, "claims about housing")).toMatchObject({ covered: true, by: "whole" });
  });

  it("flagIngest plans a scoped ingest, refuses it twice, and still allows the whole document", async () => {
    const funder = await seedUser("scoped-flag");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000 });
    const lookoutId = await seedLookout(grantId);
    const url = `https://example.org/${randomUUID()}`;

    const first = await flagIngest({ lookoutId, grantId, url, rationale: "bears on the mandate", focus: FOCUS });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const again = await flagIngest({ lookoutId, grantId, url, rationale: "bears on the mandate", focus: FOCUS });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    const whole = await flagIngest({ lookoutId, grantId, url, rationale: "and the rest of it" });
    expect(whole).toMatchObject({ ok: true, duplicate: false });

    const [g] = await rawQuery<{ plan: { items: Array<{ url: string; focus?: string }> } }>(
      `SELECT plan FROM grants WHERE id = $1`,
      [grantId]
    );
    expect(g!.plan.items.map((i) => i.focus ?? null)).toEqual([FOCUS, null]);
  });
});

describe("the extraction worker", () => {
  it("reads for the focus, records it, closes the scoped group, and adds no second instance", async () => {
    const funder = await seedUser("scoped-extract");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000 });
    const url = `https://example.org/${randomUUID()}`;
    const sourceId = await seedSource(url, "<p>An essay about the grid, and about other things.</p>");
    const existing = await seedClaim("already linked from this source");
    await rawQuery(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'earlier reading')`,
      [existing, sourceId]
    );
    const group = ingestGroup(url, FOCUS);
    const [action] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status)
       VALUES ('ingest', $1, 'standard', $2, 'Ingest', 1000, 'running') RETURNING id`,
      [group, url]
    );
    const job = await createJob("url_extraction", { sourceId, url });

    fake.matchTo = existing;
    fake.claims = [
      {
        verbatim_text: "the grid", context: null, proposed_canonical_form: "The grid is fragile.",
        claim_type: "empirical_verifiable", confidence: 0.9, importance: 0.5, contestation: 0.5,
        source_location: null, domains: [],
      },
    ];
    await handleUrlExtraction({ sourceId, jobId: job.id, url, focus: FOCUS, ingestGroup: group, grantId });

    expect(fake.extractInputs[0]).toMatchObject({ focus: FOCUS });
    const instances = await rawQuery<{ id: string }>(
      `SELECT id FROM claim_instances WHERE claim_id = $1 AND source_id = $2`,
      [existing, sourceId]
    );
    expect(instances).toHaveLength(1);
    const records = await sourceExtractions(sourceId);
    expect(records).toEqual([
      expect.objectContaining({ focus: FOCUS, grant_id: grantId, claims_extracted: 1, claims_matched: 1, claims_created: 0 }),
    ]);
    const [a] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE id = $1`, [action!.id]);
    expect(a!.status).not.toBe("running");
    const [j] = await rawQuery<{ result: Record<string, unknown> }>(`SELECT result FROM jobs WHERE id = $1`, [job.id]);
    expect(j!.result).toMatchObject({ instances_already_recorded: 1, focus: FOCUS });

    // The source page's document view carries the record.
    const doc = await getSourceDocument(sourceId);
    expect(doc!.extractions).toHaveLength(1);
  });
});
