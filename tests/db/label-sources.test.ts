/**
 * Sources and what is read from them carry a label (src/labels.ts).
 *
 * Against real Postgres and the real write seams, five things:
 *
 *  - A row a run writes about a source (a passage recorded from it, a
 *    reading and its log, what it was extracted for, an edge to the document
 *    it draws on, a relation between two documents, a claim's origin and its
 *    source map, an examination with its coverage, findings, citations and
 *    audit notes, a recorded stake, a mandate's ingested source, a feed
 *    item, a shared page analysis) carries the label of the run that writes
 *    it, and is public when written outside any run. Nothing is inherited
 *    from the source or the claim, and a write that lands on a row already
 *    there leaves that row's label alone.
 *  - What is derived mechanically from a document, with no judgment of a run
 *    in it (its segments, the notices against it), carries the document's
 *    label, whichever run or worker produced it.
 *  - A fetch that writes into a source's own row (its text, its facts, its
 *    page hash) leaves the source's label as it was.
 *  - Work that starts from a source itself, with no row of its own to wait
 *    in, runs at the source's label: the source backfill, and the
 *    scheduler's note of a source someone else ingested.
 *  - None of it reaches a reader: no view query_sql reads, no API response
 *    and no agent's read of a source carries the column.
 *
 * No model is called and nothing reaches the network. Every outside request
 * (a page, a feed, the Wayback Machine) is answered from a map in this
 * file, Crossref's two calls return what the test hands them, the Extractor
 * returns what it is given and the Matcher finds every wording new.
 * Everything around them is the code that runs in production.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

const stage = vi.hoisted(() => {
  // Tracing is off under vitest by default; a run in this file is a real run.
  process.env.TRACE_LEVEL = "full";
  return {
    /** The network: what each URL answers with. A URL not here fails. */
    pages: new Map<string, string>(),
    fetched: [] as string[],
    /** The label in the air when each URL was fetched. */
    fetchedAt: new Map<string, string>(),
    /** Crossref's record of a work, by DOI: the notices against it. */
    works: new Map<string, Array<{ doi: string; type: string; label: string; updated: string }>>(),
    /** What the retraction poll's window holds. */
    notices: [] as Array<Record<string, unknown>>,
    /** What the Extractor stand-in returns. */
    extracted: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("../../src/services/url-guard.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/url-guard.js")>()),
  assertPublicHttpUrl: async (raw: string) => new URL(raw),
  fetchPublicUrl: vi.fn(async (url: string) => {
    const { currentLabel } = await import("../../src/llm/usage-context.js");
    stage.fetched.push(url);
    stage.fetchedAt.set(url, currentLabel());
    const body = stage.pages.get(url);
    if (body === undefined) throw new Error(`no network in tests: ${url}`);
    return body;
  }),
}));
// Crossref, in its two calls. The joins against the graph stay real.
vi.mock("../../src/services/source-watch-service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/source-watch-service.js")>()),
  checkDoi: vi.fn(async (doi: string) => {
    const updates = stage.works.get(doi) ?? [];
    return {
      doi, found: updates.length > 0, title: null, type: null, published: null, cited_by: null, authors: [],
      publisher: updates.length > 0 ? "A registry" : null, container: null,
      updates: updates.map((u) => ({ ...u, source: "publisher" })), updates_to: [],
    };
  }),
  retractionNoticesSince: vi.fn(async () => ({ notices: stage.notices, complete: true, readThrough: null })),
}));
vi.mock("../../src/llm/agents/extractor.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/extractor.js")>()),
  extractClaims: vi.fn(async () => stage.extracted),
}));
vi.mock("../../src/llm/agents/matcher.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/matcher.js")>()),
  matchClaim: vi.fn(async () => ({
    outcome: "new", is_match: false, matched_claim_id: null, new_canonical_form: null, instance_stance: "affirms",
  })),
}));
vi.mock("../../src/llm/agents/domain-prior.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/domain-prior.js")>()),
  inferDomainPrior: vi.fn(async () => []),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { currentLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { executeGovernanceTool } from "../../src/llm/tools/governance-tools.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { createLookoutFeedTools } from "../../src/llm/tools/feed-tools.js";
import { executeKindTool } from "../../src/llm/tools/kind-tools.js";
import {
  executeCiteFindings,
  executeExaminationOutline,
  executeGetMap,
  executeNoteFinding,
  executeReadSource,
  executeRecordCoverage,
  executeRecordEdge,
  executeRecordFinding,
  executeRecordReading,
  executeRecordRoot,
  executeRecordSourceInterest,
  executeRecordSourceRelationship,
  executeWriteMap,
} from "../../src/llm/tools/provenance-tools.js";
import { createResearcherReadTools } from "../../src/llm/tools/researcher-read-tools.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { materializePlanItems, recordGrantSource } from "../../src/services/action-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { CLAIM_VIEW_INCLUDES, getClaimView } from "../../src/services/claim-view-service.js";
import { openExamination } from "../../src/services/examination-service.js";
import type { PageAnalysis } from "../../src/services/extension-service.js";
import { addFeed, getFeed, pollFeed, readItem } from "../../src/services/feed-service.js";
import { recordExtraction } from "../../src/services/ingest-focus-service.js";
import { runAtSourceLabel, runAtSourceLabelOutsideAnyRun } from "../../src/services/label-service.js";
import { getMandatePipeline } from "../../src/services/mandate-service.js";
import { normalizePageUrl, pageUrlHash } from "../../src/services/page-url.js";
import { defineQuantity } from "../../src/services/quantity-service.js";
import { getLocalQueue } from "../../src/services/queue-service.js";
import { reassignInstance } from "../../src/services/reconciliation-service.js";
import { getRecordedPage, resetRecordedPages } from "../../src/services/recorded-page-service.js";
import { getSharedAnalysis, shareIfPublic } from "../../src/services/shared-analysis-service.js";
import { listDocumentsForReview } from "../../src/services/source-context-service.js";
import { recordSourceEvent, refreshSourceFacts } from "../../src/services/source-facts-service.js";
import { readSourceContent } from "../../src/services/source-map-service.js";
import { segmentSource } from "../../src/services/source-segment-service.js";
import { fillSourcePageHashes, getOrCreateSource, submitSource } from "../../src/services/source-service.js";
import { retractionPollTick } from "../../src/workers/lookout-triggers.js";
import {
  SOURCE_BACKFILL_FLAG,
  SOURCE_SWEEP_LEASE_FLAG,
  fillSource,
  sourceBackfillTick,
} from "../../src/workers/source-backfill.js";
import { handleUrlExtraction } from "../../src/workers/url-extraction.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

const INTERNAL = "internal";
const FOREIGN_KEY_VIOLATION = "23503";

/** The tables this file is about: what is read from a source or written about one. */
const SOURCE_TABLES = [
  "audit_notes", "claim_instance_reading_log", "claim_instance_readings", "claim_instances",
  "claim_provenance_edges", "claim_provenance_roots", "claim_source_maps", "examination_coverage",
  "examination_findings", "examinations", "grant_sources", "lookout_feed_items", "reading_citations",
  "shared_page_analyses", "source_events", "source_extractions", "source_interests", "source_relationships",
  "source_segments",
];

const QUOTE = "Rotating night work was associated with a 1.4-fold higher risk.";
const PAGE = `<html><body><h1>Night work and diabetes</h1>
  <p>Shift workers have long been suspected of higher metabolic risk.</p>
  <h2>Results</h2><p>${QUOTE}</p>
  <h2>Discussion</h2><p>These findings suggest a causal role for circadian disruption.</p></body></html>`;
const PHRASE_A = "Coffee consumption reduces the risk of type 2 diabetes.";
const PHRASE_B = "Bananas are naturally radioactive because they contain potassium-40.";
const ANALYZED_PAGE = `<html><body><p>${PHRASE_A}</p><p>${PHRASE_B}</p></body></html>`;
const DEFINITION = { measures: "Rows written", population: "This test", unit: { kind: "count" as const, noun: "rows", min: 0 } };

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Work done from inside a run at `label`, as an agent's tool call does it. */
function inRunAt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runWithUsageContext({ label }, () => withAgent("steward", fn));
}

/** The labels on the rows of `table` that match, without repeats. */
async function labelsWhere(table: string, where: string, params: unknown[]): Promise<string[]> {
  const rows = await rawQuery<{ sensitivity_label: string }>(
    `SELECT DISTINCT sensitivity_label FROM ${table} WHERE ${where}`,
    params
  );
  // Sorted here: the database orders text by its locale, which differs between machines.
  return rows.map((r) => r.sensitivity_label).sort();
}
const labelOf = async (table: string, id: string) => (await labelsWhere(table, "id = $1", [id]))[0];
const labelsOn = (table: string, sourceId: string) => labelsWhere(table, "source_id = $1", [sourceId]);

/** A claim as it stands after its pass, so no sweep in another file picks it up. */
async function settledClaim(label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
  return id;
}

const pageUrl = (kind = "paper") => `https://dbtest.example/sources/${kind}/${randomUUID()}`;

/** A source as a fixture, at `label`: a row and nothing else. */
async function seedSource(label: string, opts: { url?: string; content?: string | null } = {}): Promise<{ id: string; url: string }> {
  const url = opts.url ?? pageUrl();
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content, sensitivity_label) VALUES ($1, 'A paper', $2, $3) RETURNING id`,
    [url, opts.content ?? null, label]
  );
  return { id: row!.id, url };
}

/** Something in the graph cites the source, so the backfill will fetch it. */
async function cite(sourceId: string): Promise<string> {
  const claim = await settledClaim("sources citing");
  await rawQuery(`INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, $3)`, [claim, sourceId, QUOTE]);
  return claim;
}

async function sourceRow(id: string) {
  const [row] = await rawQuery<{
    sensitivity_label: string; has_text: boolean; publisher: string | null; checked: boolean; page_url_hash: string | null;
  }>(
    `SELECT sensitivity_label, (raw_content IS NOT NULL AND raw_content <> '') AS has_text, publisher,
            facts_checked_at IS NOT NULL AS checked, page_url_hash
       FROM sources WHERE id = $1`,
    [id]
  );
  return row!;
}

/** Drop what a write queued for the claim pipeline. */
function dropPipeline(claimId: string): void {
  const queue = getLocalQueue("claimPipeline");
  const at = queue.findIndex((m) => m.claimId === claimId);
  if (at >= 0) queue.splice(at, 1);
}

function rss(site: string, ids: string[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed at ${site}</title><link>${site}</link>
    ${ids.map((id) => `<item><title>Post ${id}</title><link>${site}/p/${id}</link><guid>${site}/p/${id}</guid>
      <description>About ${id}</description></item>`).join("")}
  </channel></rss>`;
}

async function seedLookout(): Promise<{ grantId: string; lookoutId: string; site: string }> {
  const funder = await seedUser("sources-feeds");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10 * OWL });
  const [l] = await rawQuery<{ id: string }>(
    `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers)
     VALUES ($1, 'Feed watch', 'Watch this author.', 24, '["manual"]'::jsonb) RETURNING id`,
    [grantId]
  );
  return { grantId, lookoutId: l!.id, site: `https://blog-${randomUUID().slice(0, 8)}.example` };
}

function analysis(why: string): PageAnalysis {
  return {
    url: "unused",
    content_hash: randomUUID(),
    annotations: [PHRASE_A, PHRASE_B].map((phrase) => ({
      verbatim_text: phrase, context: null, source_location: null, verdict: "unknown" as const, why,
      confidence: 0.7, stance: "affirms" as const, proposed_canonical_form: "A proposed wording", claim: null,
    })),
    stats: { extracted: 2, matched: 0 },
    analyzed_at: new Date().toISOString(),
  };
}

const ok = (out: string | null): Record<string, any> => {
  const parsed = JSON.parse(out!);
  expect(parsed, out!).toMatchObject({ success: true });
  return parsed;
};

/**
 * One row in every source-side table, each through the seam the agents, the
 * workers and the routes write it with. Returns, for each table, where its
 * rows are, and the ids the later checks read by.
 */
async function writeOneOfEach() {
  const tag = randomUUID().slice(0, 8);
  const claim = await settledClaim("sources claim");
  const steward = { role: "claim-steward" as const, claimId: claim, run: { model: "dbtest-model" } };
  const url = pageUrl();
  const source = await getOrCreateSource({ url, title: "Night work and diabetes", content: PAGE });

  // A passage, recorded as the Steward records one it met while assessing.
  const recorded = ok(
    await executeStewardTool("record_claim_instance", { claim_id: claim, url, verbatim_text: QUOTE, stance: "affirms" })
  );
  // A figure on a quantity, which has its own tool and its own insert.
  const quantity = await settledClaim("sources quantity");
  await defineQuantity({ claimId: quantity, definition: DEFINITION, createdBy: "claim_steward" });
  const figure = ok(
    await executeKindTool(
      "record_estimate",
      { quantity_id: quantity, url: pageUrl("figure"), stated: { form: "point", central: 5 } },
      { role: "claim_steward", claimId: quantity, model: "dbtest-model" }
    )
  );
  // The Curator's copy of a passage onto another node.
  const other = await settledClaim("sources neighbor");
  const copied = await reassignInstance({ instanceId: recorded.instance_id, toClaimId: other, copy: true, reasoning: "It states both." });
  expect(copied, JSON.stringify(copied)).toMatchObject({ reassigned: true });

  // The document's structure, and what an extraction of it recorded.
  expect((await segmentSource(source.id)).segments).toBeGreaterThan(2);
  await recordExtraction({ sourceId: source.id, focus: null, claimsExtracted: 1, claimsCreated: 1, claimsMatched: 0 });
  const segments = await rawQuery<{ id: string }>(
    `SELECT id FROM source_segments WHERE source_id = $1 AND kind <> 'section' ORDER BY ordinal`,
    [source.id]
  );

  // The provenance map: a reading, an edge to a document not yet in the
  // graph, a relation between the two documents, an origin, the summary.
  ok(await executeRecordReading({ instance_id: recorded.instance_id, support: "supports", note: "It shows the figure.", source_read: true }, steward));
  const edge = ok(
    await executeRecordEdge(
      {
        from_instance_id: recorded.instance_id, to_source_url: pageUrl("upstream"), relation_type: "derives_from",
        evidence: "As the registry reports.", reasoning: "It restates the registry's figure.",
      },
      steward
    )
  );
  const relation = ok(
    await executeRecordSourceRelationship(
      { parent_source_id: source.id, child_source_id: edge.to_source_id, relation_type: "version_of", reasoning: "The published form." },
      steward
    )
  );
  const root = ok(await executeRecordRoot({ source_id: edge.to_source_id, status: "origin", basis: "The registry's own release." }, steward));
  const map = ok(await executeWriteMap({ summary: `The support rests on one registry release (${tag}).`, material: true }, steward));

  // An examination of the document: what it covered and found, the
  // Steward's citation of a finding, and the Audit agent's note on it.
  const exam = await openExamination({
    scope: "claim", trigger: "claim", claimId: claim, grantId: null, sourceId: source.id,
    brief: "Check the 1.4-fold figure.", facets: ["data"], requestedBy: "claim_steward",
  });
  const researcher = { role: "researcher" as const, examinationId: exam.id };
  ok(await executeRecordCoverage({ segment_ids: [segments[0]!.id], facet: "data" }, researcher));
  const finding = ok(
    await executeRecordFinding(
      { segment_id: segments[1]!.id, facet: "data", statement: `The figure is in the results (${tag}).`, evidence: QUOTE },
      researcher
    )
  );
  ok(await executeCiteFindings({ instance_id: recorded.instance_id, finding_ids: [finding.finding_id] }, steward));
  const note = ok(await executeNoteFinding({ finding_id: finding.finding_id, note: "Checked against the table." }, { role: "audit-agent" }));

  // A stake, a notice against the document, and a mandate that ingested it.
  const interest = ok(
    await executeRecordSourceInterest({ scope: "source", source_id: source.id, party: `The registry ${tag}`, stake: "It funds the study." }, steward)
  );
  const noticeUrl = `https://doi.org/10.5555/notice-${tag}`;
  expect(await recordSourceEvent({ sourceId: source.id, kind: "correction", noticeUrl, note: `Correction ${tag}`, detectedBy: "facts_fetch" }))
    .toEqual({ recorded: true });
  const funder = await seedUser("sources-funder");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10 * OWL });
  await recordGrantSource(grantId, source.id, url, null);

  // A feed a lookout follows: adding it records what the feed holds now.
  const watch = await seedLookout();
  stage.pages.set(`${watch.site}/feed`, rss(watch.site, ["a", "b"]));
  const feed = await addFeed({ grantId: watch.grantId, lookoutId: watch.lookoutId, url: `${watch.site}/feed`, createdBy: "grantmaker:chat" });
  if (!feed.ok) throw new Error(JSON.stringify(feed));

  // A reader's analysis of a public page, kept for the next reader.
  const analyzed = `https://dbtest.example/sources/analyzed/${randomUUID()}`;
  expect(await shareIfPublic(analyzed, analysis("why"), { fetchText: async () => ANALYZED_PAGE })).toMatchObject({ shared: true });
  const urlHash = pageUrlHash(normalizePageUrl(analyzed)!);

  const instances = [recorded.instance_id, figure.instance_id, copied.instanceId!];
  return {
    ids: {
      claim, source: source.id, upstream: edge.to_source_id as string, url, instance: recorded.instance_id as string,
      examination: exam.id, finding: finding.finding_id as string, grantId, urlHash, analyzed,
      lookout: watch, feedId: feed.feed_id, interest: `The registry ${tag}`, eventNote: `Correction ${tag}`,
    },
    tables: {
      claim_instances: { where: "id = ANY($1::uuid[])", params: [instances] },
      claim_instance_readings: { where: "instance_id = $1", params: [recorded.instance_id] },
      claim_instance_reading_log: { where: "instance_id = $1", params: [recorded.instance_id] },
      source_segments: { where: "source_id = $1", params: [source.id] },
      source_events: { where: "source_id = $1", params: [source.id] },
      source_extractions: { where: "source_id = $1", params: [source.id] },
      source_relationships: { where: "id = $1", params: [relation.id] },
      claim_provenance_edges: { where: "id = $1", params: [edge.id] },
      claim_provenance_roots: { where: "id = $1", params: [root.id] },
      claim_source_maps: { where: "id = $1", params: [map.id] },
      examinations: { where: "id = $1", params: [exam.id] },
      examination_coverage: { where: "examination_id = $1", params: [exam.id] },
      examination_findings: { where: "id = $1", params: [finding.finding_id] },
      reading_citations: { where: "finding_id = $1", params: [finding.finding_id] },
      audit_notes: { where: "id = $1", params: [note.note_id] },
      source_interests: { where: "id = $1", params: [interest.id] },
      grant_sources: { where: "grant_id = $1", params: [grantId] },
      lookout_feed_items: { where: "lookout_id = $1", params: [watch.lookoutId] },
      shared_page_analyses: { where: "url_hash = $1", params: [urlHash] },
    } as Record<string, { where: string; params: unknown[] }>,
  };
}

async function labelsOf(tables: Record<string, { where: string; params: unknown[] }>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, { where, params }] of Object.entries(tables)) out[table] = await labelsWhere(table, where, params);
  return out;
}
const everyTableAt = (label: string) => Object.fromEntries(SOURCE_TABLES.map((t) => [t, [label]]));

beforeAll(async () => {
  // A second label, as a deployment would define one: a row, nothing else.
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable inside the organization.')
     ON CONFLICT (name) DO NOTHING`,
    [INTERNAL]
  );
  // The platform's own mandates, left active by other files, would fund and
  // open rows of theirs when a plan is materialized here.
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

beforeEach(() => {
  stage.pages.clear();
  stage.fetched.length = 0;
  stage.fetchedAt.clear();
  stage.works.clear();
  stage.notices = [];
  stage.extracted = [];
});

describe("the columns", () => {
  it("are on every source-side table, public by default, and point at labels", async () => {
    const rows = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string; fk: boolean }>(
      `SELECT c.table_name, c.column_default, c.is_nullable,
              EXISTS (
                SELECT 1 FROM pg_constraint k
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                 WHERE k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                   AND k.contype = 'f' AND k.confrelid = 'public.labels'::regclass
                   AND k.convalidated AND a.attname = c.column_name
              ) AS fk
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = 'sensitivity_label'
          AND c.table_name = ANY($1)
        ORDER BY c.table_name`,
      [SOURCE_TABLES]
    );
    expect(rows).toEqual(
      SOURCE_TABLES.map((table_name) => ({ table_name, column_default: "minerval_default_label()", is_nullable: "NO", fk: true }))
    );
  });

  it("sit beside a segment's heading, which keeps its name and its value", async () => {
    const source = await seedSource(INTERNAL, { content: PAGE });
    await segmentSource(source.id);
    const rows = await rawQuery<{ label: string | null; sensitivity_label: string }>(
      `SELECT label, sensitivity_label FROM source_segments WHERE source_id = $1 AND kind = 'section' ORDER BY ordinal`,
      [source.id]
    );
    expect(rows.map((r) => r.label)).toEqual(["Night work and diabetes", "Results", "Discussion"]);
    expect(new Set(rows.map((r) => r.sensitivity_label))).toEqual(new Set([INTERNAL]));
  });

  it("cannot carry a label no row defines", async () => {
    const source = await seedSource(PUBLIC_LABEL, { content: PAGE });
    const claim = await cite(source.id);
    await expect(
      rawQuery(`UPDATE claim_instances SET sensitivity_label = 'undefined-label' WHERE claim_id = $1`, [claim])
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    // A run whose context names one records nothing.
    await expect(
      runWithUsageContext({ label: "undefined-label" }, () =>
        recordExtraction({ sourceId: source.id, focus: null, claimsExtracted: 0, claimsCreated: 0, claimsMatched: 0 })
      )
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    expect(await labelsOn("source_extractions", source.id)).toEqual([]);
  });
});

describe("a row read from a source or written about one", () => {
  it("written inside a run carries the run's label, in every table", async () => {
    // The run records the source too, so the two tables that follow the
    // source's label (its segments and its notices) agree with the rest.
    // Where the run and the source differ is the next describe's.
    const { tables } = await inRunAt(INTERNAL, writeOneOfEach);
    expect(Object.keys(tables).sort()).toEqual(SOURCE_TABLES);
    expect(await labelsOf(tables)).toEqual(everyTableAt(INTERNAL));
  });

  it("written outside any run is public, in every table", async () => {
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const { tables } = await writeOneOfEach();
    expect(await labelsOf(tables)).toEqual(everyTableAt(PUBLIC_LABEL));
  });

  it("is the writer's whatever source it hangs from: restricted on a public source, public on a restricted one", async () => {
    const write = async (label: string) => {
      const source = await seedSource(label, { content: PAGE });
      // Segmented, so there are passages to anchor a finding to. They carry the source's label.
      await segmentSource(source.id);
      const claim = await settledClaim("sources whatever");
      const steward = { role: "claim-steward" as const, claimId: claim };
      return { source, claim, steward };
    };
    const record = async ({ source, claim, steward }: Awaited<ReturnType<typeof write>>) => {
      const instance = ok(
        await executeStewardTool("record_claim_instance", { claim_id: claim, url: source.url, verbatim_text: QUOTE, stance: "affirms" })
      ).instance_id as string;
      ok(await executeRecordReading({ instance_id: instance, support: "supports" }, steward));
      const exam = await openExamination({
        scope: "claim", trigger: "claim", claimId: claim, grantId: null, sourceId: source.id,
        brief: "Check it.", facets: ["data"], requestedBy: "claim_steward",
      });
      const [passage] = await rawQuery<{ id: string }>(
        `SELECT id FROM source_segments WHERE source_id = $1 AND kind <> 'section' ORDER BY ordinal LIMIT 1`,
        [source.id]
      );
      const finding = ok(
        await executeRecordFinding(
          { segment_id: passage!.id, facet: "data", statement: "It is there.", evidence: QUOTE },
          { role: "researcher", examinationId: exam.id }
        )
      ).finding_id as string;
      const interest = ok(
        await executeRecordSourceInterest({ scope: "source", source_id: source.id, party: "A party", stake: "A stake." }, steward)
      ).id as string;
      return {
        instance: await labelOf("claim_instances", instance),
        reading: await labelsWhere("claim_instance_readings", "instance_id = $1", [instance]),
        examination: await labelOf("examinations", exam.id),
        finding: await labelOf("examination_findings", finding),
        coverage: await labelsWhere("examination_coverage", "examination_id = $1", [exam.id]),
        interest: await labelOf("source_interests", interest),
      };
    };
    const all = (label: string) => ({
      instance: label, reading: [label], examination: label, finding: label, coverage: [label], interest: label,
    });

    const open = await write(PUBLIC_LABEL);
    expect(await inRunAt(INTERNAL, () => record(open))).toEqual(all(INTERNAL));
    const restricted = await write(INTERNAL);
    expect(await record(restricted)).toEqual(all(PUBLIC_LABEL));

    // The sources and their passages keep the labels they had.
    expect((await sourceRow(open.source.id)).sensitivity_label).toBe(PUBLIC_LABEL);
    expect((await sourceRow(restricted.source.id)).sensitivity_label).toBe(INTERNAL);
    expect(await labelsOn("source_segments", open.source.id)).toEqual([PUBLIC_LABEL]);
    expect(await labelsOn("source_segments", restricted.source.id)).toEqual([INTERNAL]);
  });

  it("already there keeps its label when a run at another label writes it again", async () => {
    const first = await writeOneOfEach();
    const { ids } = first;
    const steward = { role: "claim-steward" as const, claimId: ids.claim };
    const researcher = { role: "researcher" as const, examinationId: ids.examination };
    const kept = [
      "claim_instance_readings", "claim_provenance_edges", "source_relationships", "claim_provenance_roots",
      "claim_source_maps", "source_events", "examination_coverage", "reading_citations", "grant_sources",
      "lookout_feed_items", "shared_page_analyses",
    ];
    const read = async () => {
      const labels = await labelsOf(first.tables);
      return Object.fromEntries(kept.map((t) => [t, labels[t]]));
    };
    expect(await read()).toEqual(Object.fromEntries(kept.map((t) => [t, [PUBLIC_LABEL]])));

    // The same writes again, from a run at another label: each lands on the row already there.
    const [covered] = await rawQuery<{ segment_id: string }>(
      `SELECT segment_id FROM examination_coverage WHERE examination_id = $1 LIMIT 1`,
      [ids.examination]
    );
    const [event] = await rawQuery<{ notice_url: string }>(`SELECT notice_url FROM source_events WHERE source_id = $1`, [ids.source]);
    const [upstream] = await rawQuery<{ url: string }>(`SELECT url FROM sources WHERE id = $1`, [ids.upstream]);
    await inRunAt(INTERNAL, async () => {
      expect(ok(await executeRecordReading({ instance_id: ids.instance, support: "overstates", note: "Read again." }, steward)).replaced).toBe(true);
      const edge = ok(
        await executeRecordEdge(
          {
            from_instance_id: ids.instance, to_source_url: upstream!.url, relation_type: "derives_from",
            evidence: "As the registry reports.", reasoning: "Read again.",
          },
          steward
        )
      );
      expect(edge).toMatchObject({ replaced: true, to_source_id: ids.upstream });
      expect(
        ok(
          await executeRecordSourceRelationship(
            { parent_source_id: ids.source, child_source_id: ids.upstream, relation_type: "version_of", reasoning: "Read again." },
            steward
          )
        ).replaced
      ).toBe(true);
      expect(ok(await executeRecordRoot({ source_id: ids.upstream, status: "untraced", basis: "Read again." }, steward)).replaced).toBe(true);
      expect(ok(await executeWriteMap({ summary: "Read again, and it still rests on one release.", material: false }, steward)).replaced).toBe(true);
      expect(await recordSourceEvent({ sourceId: ids.source, kind: "correction", noticeUrl: event!.notice_url, detectedBy: "crossref_poll" }))
        .toEqual({ recorded: false });
      expect(ok(await executeRecordCoverage({ segment_ids: [covered!.segment_id], facet: "data" }, researcher)).recorded).toBe(0);
      expect(ok(await executeCiteFindings({ instance_id: ids.instance, finding_ids: [ids.finding] }, steward)).cited).toBe(0);
      await recordGrantSource(ids.grantId, ids.source, ids.url, null);
      // The feed is polled again and holds what it held.
      stage.pages.set(`${ids.lookout.site}/feed`, rss(ids.lookout.site, ["a", "b"]));
      expect(await pollFeed((await getFeed(ids.feedId))!)).toMatchObject({ ok: true, newItems: 0 });
      expect(await shareIfPublic(ids.analyzed, analysis("a later reading"), { fetchText: async () => ANALYZED_PAGE }))
        .toMatchObject({ shared: true });
    });
    expect(await read()).toEqual(Object.fromEntries(kept.map((t) => [t, [PUBLIC_LABEL]])));
    // The rows were written: the reading and the shared entry say what the second run said.
    const [reading] = await rawQuery<{ support: string }>(`SELECT support FROM claim_instance_readings WHERE instance_id = $1`, [ids.instance]);
    expect(reading!.support).toBe("overstates");
    const [shared] = await rawQuery<{ annotations: Array<{ why: string }> }>(
      `SELECT annotations FROM shared_page_analyses WHERE url_hash = $1`,
      [ids.urlHash]
    );
    expect(shared!.annotations[0]!.why).toBe("a later reading");
    expect((await rawQuery(`SELECT 1 FROM grant_sources WHERE grant_id = $1`, [ids.grantId])).length).toBe(1);

    // The log is not an upsert: each reading is a row of its own, at its own run's label.
    const log = await rawQuery<{ support: string; sensitivity_label: string }>(
      `SELECT support, sensitivity_label FROM claim_instance_reading_log WHERE instance_id = $1 ORDER BY created_at`,
      [ids.instance]
    );
    expect(log).toEqual([
      { support: "supports", sensitivity_label: PUBLIC_LABEL },
      { support: "overstates", sensitivity_label: INTERNAL },
    ]);
  });

  it("is a feed item's at the label of the poll that first saw it, and the page fetched for it later leaves that alone", async () => {
    const { grantId, lookoutId, site } = await seedLookout();
    stage.pages.set(`${site}/feed`, rss(site, ["a"]));
    const feed = await inRunAt(INTERNAL, () => addFeed({ grantId, lookoutId, url: `${site}/feed`, createdBy: "grantmaker:chat" }));
    if (!feed.ok) throw new Error(JSON.stringify(feed));
    // The poller runs outside any run. A lookout carries no label yet, so what it records is public.
    stage.pages.set(`${site}/feed`, rss(site, ["a", "b"]));
    expect(await pollFeed((await getFeed(feed.feed_id))!)).toMatchObject({ ok: true, newItems: 1 });
    const items = (
      await rawQuery<{ id: string; url: string; sensitivity_label: string }>(
        `SELECT id, url, sensitivity_label FROM lookout_feed_items WHERE lookout_id = $1`,
        [lookoutId]
      )
    ).sort((a, b) => (a.url < b.url ? -1 : 1));
    expect(items.map((i) => [i.url, i.sensitivity_label])).toEqual([
      [`${site}/p/a`, INTERNAL],
      [`${site}/p/b`, PUBLIC_LABEL],
    ]);
    // A lookout's run reads the new item: the page lands on the item already there.
    stage.pages.set(`${site}/p/b`, `<html><body><article><p>The whole post.</p></article></body></html>`);
    const read = await inRunAt(INTERNAL, () => readItem({ lookoutId, itemId: items[1]!.id, view: "full", from: "page" }));
    expect(read).toMatchObject({ ok: true, from: "page" });
    const [item] = await rawQuery<{ body: string | null; sensitivity_label: string }>(
      `SELECT body, sensitivity_label FROM lookout_feed_items WHERE id = $1`,
      [items[1]!.id]
    );
    expect(item!.body).toContain("The whole post.");
    expect(item!.sensitivity_label).toBe(PUBLIC_LABEL);
  });
});

// What is computed from a document or looked up about it is the same whoever
// asks, so it carries the document's label and not the label of the run that
// happened to ask (src/labels.ts). What that run concludes stays the run's.
describe("what is derived mechanically from a document", () => {
  /** A source with a DOI and no text, its page on the network, and a notice Crossref holds against it. */
  async function unopened(label: string) {
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const source = await seedSource(label, { url: `https://doi.org/${doi}` });
    stage.pages.set(source.url, PAGE);
    stage.works.set(doi, [{ doi: `${doi}.c1`, type: "correction", label: "Correction", updated: "2026-09-10T00:00:00Z" }]);
    return { ...source, doi };
  }
  /** A run opens the document for the first time, then records a passage from it and reads it. */
  async function openedBy(runLabel: string, source: { id: string; url: string }) {
    const claim = await settledClaim("sources derived");
    return inRunAt(runLabel, async () => {
      const read = await readSourceContent({ sourceId: source.id });
      expect(read.origin).toBe("fetched");
      const instance = ok(
        await executeStewardTool("record_claim_instance", { claim_id: claim, url: source.url, verbatim_text: QUOTE, stance: "affirms" })
      ).instance_id as string;
      ok(await executeRecordReading({ instance_id: instance, support: "supports", source_read: true }, { role: "claim-steward", claimId: claim }));
      return {
        source: (await sourceRow(source.id)).sensitivity_label,
        segments: await labelsOn("source_segments", source.id),
        notices: await labelsOn("source_events", source.id),
        instance: await labelOf("claim_instances", instance),
        reading: await labelsWhere("claim_instance_readings", "instance_id = $1", [instance]),
      };
    });
  }

  it("is public when a run at a second label opens a public source: its segments and the notice against it", async () => {
    const open = await unopened(PUBLIC_LABEL);
    expect(await openedBy(INTERNAL, open)).toEqual({
      source: PUBLIC_LABEL, segments: [PUBLIC_LABEL], notices: [PUBLIC_LABEL],
      // The passage the run recorded and its reading of it are judgments, and the run's.
      instance: INTERNAL, reading: [INTERNAL],
    });
    expect((await rawQuery(`SELECT 1 FROM source_segments WHERE source_id = $1`, [open.id])).length).toBeGreaterThan(2);
  });

  it("is restricted when a run at public opens a restricted source, as it can until reads are held to a label", async () => {
    const restricted = await unopened(INTERNAL);
    expect(await openedBy(PUBLIC_LABEL, restricted)).toEqual({
      source: INTERNAL, segments: [INTERNAL], notices: [INTERNAL],
      instance: PUBLIC_LABEL, reading: [PUBLIC_LABEL],
    });
  });

  it("carries the source's label from each seam that writes it, inside a run and outside any", async () => {
    for (const [sourceLabel, otherLabel] of [[INTERNAL, PUBLIC_LABEL], [PUBLIC_LABEL, INTERNAL]] as const) {
      const source = await unopened(sourceLabel);
      await rawQuery(`UPDATE sources SET raw_content = $2 WHERE id = $1`, [source.id, PAGE]);
      // Outside any run, as a script or a worker calls them.
      await segmentSource(source.id);
      expect(await refreshSourceFacts(source.id)).toMatchObject({ events_recorded: 1, doi: source.doi });
      expect(await labelsOn("source_segments", source.id)).toEqual([sourceLabel]);
      expect(await labelsOn("source_events", source.id)).toEqual([sourceLabel]);
      // Inside a run at the other label: segmenting again replaces the
      // segments, and a second notice is recorded. Both are still the source's.
      await inRunAt(otherLabel, async () => {
        expect((await segmentSource(source.id)).segments).toBeGreaterThan(2);
        expect(await recordSourceEvent({ sourceId: source.id, kind: "retraction", noticeUrl: `https://doi.org/${source.doi}.r1`, detectedBy: "facts_fetch" }))
          .toEqual({ recorded: true });
      });
      expect(await labelsOn("source_segments", source.id)).toEqual([sourceLabel]);
      const events = (
        await rawQuery<{ kind: string; sensitivity_label: string }>(
          `SELECT kind, sensitivity_label FROM source_events WHERE source_id = $1`,
          [source.id]
        )
      ).sort((a, b) => (a.kind < b.kind ? -1 : 1));
      expect(events).toEqual([
        { kind: "correction", sensitivity_label: sourceLabel },
        { kind: "retraction", sensitivity_label: sourceLabel },
      ]);
      expect((await sourceRow(source.id)).sensitivity_label).toBe(sourceLabel);
    }
  });

  it("is not recorded against a source that does not exist, which fails as it always did", async () => {
    await expect(
      recordSourceEvent({ sourceId: randomUUID(), kind: "correction", noticeUrl: "https://doi.org/10.5555/never", detectedBy: "facts_fetch" })
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
  });
});

// The extraction of a submitted document runs at the label of its job, so
// what the worker reads out of the document carries the label the document
// was submitted at. The document's segments follow the document.
describe("a document a worker extracts", () => {
  async function ingested(label: string | null, known?: { url: string }) {
    const url = known?.url ?? pageUrl("submitted");
    const submit = () => submitSource({ url, content: PAGE });
    const { jobId, sourceId } = label ? await inRunAt(label, submit) : await submit();
    const queue = getLocalQueue("urlExtraction");
    const message = queue.splice(queue.findIndex((m) => m.jobId === jobId), 1)[0]!;
    stage.extracted = [{
      verbatim_text: QUOTE, context: null, proposed_canonical_form: `Night work raises diabetes risk (${randomUUID()}).`,
      claim_type: "empirical_verifiable", confidence: 0.9, importance: 0.5, contestation: 0.5,
      source_location: null, domains: [],
    }];
    // The worker gets the queued message and no context.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    await handleUrlExtraction(message);
    const [instance] = await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM claim_instances WHERE source_id = $1`, [sourceId]);
    dropPipeline(instance!.claim_id);
    return {
      source: (await sourceRow(sourceId)).sensitivity_label,
      instances: await labelsOn("claim_instances", sourceId),
      extractions: await labelsOn("source_extractions", sourceId),
      segments: await labelsOn("source_segments", sourceId),
    };
  }

  it("has its instances and its extraction record at the label it was submitted at, and its segments at the source's", async () => {
    // A document first recorded by the submission is at the submission's label, so all four agree.
    const at = (label: string) => ({ source: label, instances: [label], extractions: [label], segments: [label] });
    expect(await ingested(INTERNAL)).toEqual(at(INTERNAL));
    expect(await ingested(null)).toEqual(at(PUBLIC_LABEL));
    // A document the graph already held as public, submitted at a second label: the reading is the job's, the structure the document's.
    const known = await seedSource(PUBLIC_LABEL);
    expect(await ingested(INTERNAL, known)).toEqual({
      source: PUBLIC_LABEL, instances: [INTERNAL], extractions: [INTERNAL], segments: [PUBLIC_LABEL],
    });
  });
});

describe("a fetch into a source's own row", () => {
  it("made by a run at another label fills the text and the facts and leaves the source's label alone", async () => {
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const source = await seedSource(PUBLIC_LABEL, { url: `https://doi.org/${doi}` });
    stage.pages.set(source.url, PAGE);
    stage.works.set(doi, [{ doi: `${doi}.c1`, type: "correction", label: "Correction", updated: "2026-09-10T00:00:00Z" }]);

    const read = await inRunAt(INTERNAL, () => readSourceContent({ sourceId: source.id }));
    expect(read.origin).toBe("fetched");
    expect(await sourceRow(source.id)).toMatchObject({
      sensitivity_label: PUBLIC_LABEL, has_text: true, publisher: "A registry", checked: true,
    });
  });

  it("made for a document found again by its URL leaves the label it was first recorded at", async () => {
    const url = pageUrl("cited");
    const first = await inRunAt(INTERNAL, () => getOrCreateSource({ url }));
    expect((await sourceRow(first.id)).sensitivity_label).toBe(INTERNAL);
    // A submission outside any run carries the text. The row is found by its URL, whatever its label.
    const again = await getOrCreateSource({ url, title: "Now with text", content: PAGE });
    expect(again.id).toBe(first.id);
    expect(await sourceRow(first.id)).toMatchObject({ sensitivity_label: INTERNAL, has_text: true });
    // And the other way round: a run at a restricted label finds the public row.
    const open = await getOrCreateSource({ url: pageUrl("cited") });
    const found = await inRunAt(INTERNAL, () => getOrCreateSource({ url: open.url!, content: PAGE }));
    expect(found.id).toBe(open.id);
    expect(await sourceRow(open.id)).toMatchObject({ sensitivity_label: PUBLIC_LABEL, has_text: true });
  });

  it("made by the page-hash fill at startup leaves every label alone", async () => {
    const restricted = await seedSource(INTERNAL);
    const open = await seedSource(PUBLIC_LABEL);
    expect((await sourceRow(restricted.id)).page_url_hash).toBeNull();
    expect(await fillSourcePageHashes()).toBeGreaterThanOrEqual(2);
    expect(await sourceRow(restricted.id)).toMatchObject({ sensitivity_label: INTERNAL, page_url_hash: pageUrlHash(normalizePageUrl(restricted.url)!) });
    expect(await sourceRow(open.id)).toMatchObject({ sensitivity_label: PUBLIC_LABEL, page_url_hash: pageUrlHash(normalizePageUrl(open.url)!) });
  });
});

describe("work that starts from a source", () => {
  /** A cited source with a DOI and no text, and a notice Crossref holds against it. */
  async function unfetched(label: string) {
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const source = await seedSource(label, { url: `https://doi.org/${doi}` });
    await cite(source.id);
    stage.pages.set(source.url, PAGE);
    stage.works.set(doi, [{ doi: `${doi}.r1`, type: "retraction", label: "Retraction", updated: "2026-09-10T00:00:00Z" }]);
    return { ...source, doi };
  }
  const filled = async (id: string) => ({
    source: await sourceRow(id),
    segments: await labelsOn("source_segments", id),
    events: await labelsOn("source_events", id),
  });
  const filledAt = (label: string) => ({
    source: expect.objectContaining({ sensitivity_label: label, has_text: true, publisher: "A registry", checked: true }),
    segments: [label],
    events: [label],
  });

  it("is done by the source backfill at the source's label: the fetch, the segments and the notices", async () => {
    // Only this test's sources wait for the sweep.
    await rawQuery(`UPDATE sources SET facts_checked_at = now() WHERE facts_checked_at IS NULL`);
    await rawQuery(
      `INSERT INTO platform_flags (key, value) VALUES ($1, '{"after": null, "done": true}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SOURCE_BACKFILL_FLAG]
    );
    await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [SOURCE_SWEEP_LEASE_FLAG]);
    const config = loadConfig();
    const before = config.sourceBackfillPerTick;
    Object.assign(config, { sourceBackfillPerTick: 20 });
    try {
      const restricted = await unfetched(INTERNAL);
      const open = await unfetched(PUBLIC_LABEL);
      // The worker's tick runs outside any run.
      expect(currentLabel()).toBe(PUBLIC_LABEL);
      expect(await sourceBackfillTick()).toMatchObject({ taken: 2, fetched: 2, facts: 2, segmented: 2 });
      // Each source's page was fetched with that source's label in the air.
      expect(stage.fetchedAt.get(restricted.url)).toBe(INTERNAL);
      expect(stage.fetchedAt.get(open.url)).toBe(PUBLIC_LABEL);
      expect(await filled(restricted.id)).toEqual(filledAt(INTERNAL));
      expect(await filled(open.id)).toEqual(filledAt(PUBLIC_LABEL));
    } finally {
      Object.assign(config, { sourceBackfillPerTick: before });
      await rawQuery(`DELETE FROM platform_flags WHERE key = ANY($1::text[])`, [[SOURCE_BACKFILL_FLAG, SOURCE_SWEEP_LEASE_FLAG]]);
    }
  });

  it("is done at the source's label whatever context the worker is in", async () => {
    const restricted = await unfetched(INTERNAL);
    expect(await runWithUsageContext({ label: PUBLIC_LABEL }, () => fillSource(restricted.id))).toBe(true);
    expect(stage.fetchedAt.get(restricted.url)).toBe(INTERNAL);
    expect(await filled(restricted.id)).toEqual(filledAt(INTERNAL));
  });

  it("is recorded by the retraction poll at the label of the source each notice is against", async () => {
    const restricted = await unfetched(INTERNAL);
    const open = await unfetched(PUBLIC_LABEL);
    stage.notices = [restricted, open].map((s) => ({
      notice_doi: `${s.doi}.n1`, retracted_dois: [s.doi], type: "retraction", title: `Retraction of ${s.doi}`,
      updated: "2026-09-10T00:00:00Z", source: "publisher",
    }));
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const r = await retractionPollTick({ force: true });
    expect(r).toMatchObject({ skipped: false, notices: 2, matchedSources: 2, sourceEvents: 2 });
    const event = (id: string) =>
      rawQuery<{ kind: string; detected_by: string; sensitivity_label: string }>(
        `SELECT kind, detected_by, sensitivity_label FROM source_events WHERE source_id = $1`,
        [id]
      );
    expect(await event(restricted.id)).toEqual([{ kind: "retraction", detected_by: "crossref_poll", sensitivity_label: INTERNAL }]);
    expect(await event(open.id)).toEqual([{ kind: "retraction", detected_by: "crossref_poll", sensitivity_label: PUBLIC_LABEL }]);
    // The sources themselves are as they were.
    expect((await sourceRow(restricted.id)).sensitivity_label).toBe(INTERNAL);
  });

  it("is noted in a mandate's pipeline by the scheduler at the label of the source someone else ingested", async () => {
    const attributed = async (label: string) => {
      const funder = await seedUser("sources-plan");
      const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
      const source = await seedSource(label);
      // Another reader's ingest of the URL ran and finished.
      await rawQuery(
        `INSERT INTO jobs (type, status, input, completed_at)
         VALUES ('url_extraction', 'completed', jsonb_build_object('sourceId', $1::text, 'url', $2::text), now())`,
        [source.id, source.url]
      );
      await rawQuery(
        `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status)
         VALUES ('ingest', $1, 'standard', $2, 'Ingest', 1000000, 'done')`,
        [`ingest:${source.url}`, source.url]
      );
      await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
        grantId,
        JSON.stringify({ strategy: "s", items: [{ action: "ingest", url: source.url, rationale: "a source" }] }),
      ]);
      // The scheduler materializes the plan outside any run.
      expect(currentLabel()).toBe(PUBLIC_LABEL);
      const [item] = await materializePlanItems(grantId);
      expect(item!.ledger.status).toBe("done");
      return labelsWhere("grant_sources", "grant_id = $1 AND source_id = $2", [grantId, source.id]);
    };
    expect(await attributed(INTERNAL)).toEqual([INTERNAL]);
    expect(await attributed(PUBLIC_LABEL)).toEqual([PUBLIC_LABEL]);
  });

  it("takes the source's label over the one in the air, except through the seam meant for code a run also reaches", async () => {
    const source = await seedSource(INTERNAL);
    const at = () => Promise.resolve(currentLabel());
    expect(await runAtSourceLabel(source.id, at)).toBe(INTERNAL);
    expect(await runWithUsageContext({ label: PUBLIC_LABEL }, () => runAtSourceLabel(source.id, at))).toBe(INTERNAL);
    expect(await runAtSourceLabelOutsideAnyRun(source.id, at)).toBe(INTERNAL);
    expect(await runWithUsageContext({ label: PUBLIC_LABEL }, () => runAtSourceLabelOutsideAnyRun(source.id, at))).toBe(PUBLIC_LABEL);
    // A source that does not exist has nothing to run at: the work runs as it would have.
    expect(await runAtSourceLabel(randomUUID(), at)).toBe(PUBLIC_LABEL);
    // Reading the label writes nothing.
    expect((await sourceRow(source.id)).sensitivity_label).toBe(INTERNAL);
  });
});

describe("what a reader is shown", () => {
  let app: FastifyInstance;
  let rows: Awaited<ReturnType<typeof writeOneOfEach>>;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp();
    // Written at a second label, so a response that carried the column would carry a value to see.
    rows = await inRunAt(INTERNAL, writeOneOfEach);
    // A mandate's page lists its pipeline once its plan ingests something.
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      rows.ids.grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "ingest", url: rows.ids.url, rationale: "a source" }] }),
    ]);
    resetRecordedPages();
  });

  afterAll(async () => {
    await app.close();
  });

  const carriesIt = (text: string) => /sensitivity[_ ]?label/i.test(text);
  /** The label's name as a JSON value, which no response has another reason to hold. */
  const namesIt = (text: string) => text.includes(`"${INTERNAL}"`);

  it("has no view query_sql reads that exposes the column", async () => {
    // The public_read views name their columns, and Postgres stores a view
    // with its columns spelled out, so a column added to a table a view
    // reads does not appear in it.
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public_read' AND column_name = 'sensitivity_label'`
    );
    expect(exposed).toEqual([]);
    // The one view over a table altered here, and the view of sources, still read their rows.
    const [instance] = await rawQuery<Record<string, unknown>>(`SELECT * FROM public_read.instances WHERE id = $1`, [rows.ids.instance]);
    expect(instance).toMatchObject({ source_id: rows.ids.source, node_id: rows.ids.claim });
    expect(Object.keys(instance!)).not.toContain("sensitivity_label");
    const [source] = await rawQuery<Record<string, unknown>>(`SELECT * FROM public_read.sources WHERE id = $1`, [rows.ids.source]);
    expect(source).toBeDefined();
    expect(Object.keys(source!)).not.toContain("sensitivity_label");
    // No other view reads one of these tables.
    const readers = await rawQuery<{ viewname: string }>(
      `SELECT viewname FROM pg_views
        WHERE schemaname IN ('public', 'public_read')
          AND definition ~ ('\\m(' || array_to_string($1::text[], '|') || ')\\M')
        ORDER BY viewname`,
      [SOURCE_TABLES]
    );
    expect(readers.map((r) => r.viewname)).toEqual(["instances"]);
  });

  it("has no response of the source, claim, mandate or extension routes that carries it", async () => {
    const { ids } = rows;
    const [page] = await rawQuery<{ page_url_hash: string }>(`SELECT page_url_hash FROM sources WHERE id = $1`, [ids.source]);
    const urls = [
      `/sources/${ids.source}`,
      `/sources/${ids.source}/context`,
      `/sources/${ids.source}/document`,
      `/sources/${ids.source}/examinations`,
      `/sources/${ids.upstream}`,
      `/sources/${ids.upstream}/context`,
      ...["cursory", "standard", "deep"].map((d) => `/claims/${ids.claim}?information_depth=${d}`),
      `/claims/${ids.claim}/card`,
      `/claims/${ids.claim}/citation`,
      `/claims/${ids.claim}/provenance`,
      `/claims/${ids.claim}/record`,
      `/claims/${ids.claim}/events`,
      `/claims/${ids.claim}/nanopub`,
      `/claims/${ids.claim}/mira`,
      `/mandates/${ids.grantId}`,
      `/extension/shared?prefix=${ids.urlHash.slice(0, 4)}`,
      `/extension/shared/${ids.urlHash}`,
      `/extension/recorded/${page!.page_url_hash}`,
      `/changes`,
    ];
    const answered = new Map<string, string>();
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url });
      // A route that needs a key or finds nothing has shown nothing either way.
      if (res.statusCode === 200) answered.set(url, res.body);
      expect(carriesIt(res.body), `${url} (${res.statusCode})`).toBe(false);
      expect(namesIt(res.body), `${url} (${res.statusCode})`).toBe(false);
    }
    // The check means something only if the routes answered with the rows.
    expect([...answered.keys()]).toEqual(expect.arrayContaining([
      `/sources/${ids.source}`,
      `/sources/${ids.source}/context`,
      `/sources/${ids.source}/document`,
      `/sources/${ids.source}/examinations`,
      `/claims/${ids.claim}?information_depth=deep`,
      `/claims/${ids.claim}/provenance`,
      `/mandates/${ids.grantId}`,
      `/extension/shared/${ids.urlHash}`,
      `/extension/recorded/${page!.page_url_hash}`,
    ]));
    expect(answered.get(`/sources/${ids.source}`)).toContain(ids.eventNote);
    expect(answered.get(`/sources/${ids.source}`)).toContain(ids.interest);
    expect(answered.get(`/sources/${ids.source}/document`)).toContain(ids.instance);
    expect(answered.get(`/sources/${ids.source}/examinations`)).toContain(ids.finding);
    expect(answered.get(`/claims/${ids.claim}/provenance`)).toContain(ids.upstream);
    expect(answered.get(`/mandates/${ids.grantId}`)).toContain(ids.source);
    expect(answered.get(`/extension/shared/${ids.urlHash}`)).toContain(PHRASE_A);
    expect(answered.get(`/extension/recorded/${page!.page_url_hash}`)).toContain(ids.claim);
  });

  it("has no agent's read of a source, its passages, its map or its examinations that carries it", async () => {
    const { ids } = rows;
    const steward = { role: "claim-steward" as const, claimId: ids.claim };
    const researcherTools = createResearcherReadTools({ requests: false });
    const feedTools = createLookoutFeedTools({
      lookoutId: ids.lookout.lookoutId, grantId: ids.lookout.grantId, commissionLimitMicroUsd: 0, onIngested: () => {},
    });
    const [item] = await rawQuery<{ id: string }>(`SELECT id FROM lookout_feed_items WHERE lookout_id = $1 LIMIT 1`, [ids.lookout.lookoutId]);
    stage.pages.set(`${ids.lookout.site}/p/a`, `<html><body><article><p>The whole post.</p></article></body></html>`);
    stage.pages.set(`${ids.lookout.site}/p/b`, `<html><body><article><p>The whole post.</p></article></body></html>`);
    const reads: Array<[string, () => Promise<string | null>, string]> = [
      ["provenance_get_map", () => executeGetMap({}, steward), ids.instance],
      ["provenance_read_source", () => executeReadSource({ source_id: ids.source }, steward), "Rotating night work"],
      ["examination_outline", () => executeExaminationOutline({}, { role: "researcher", examinationId: ids.examination }), ids.source],
      ["get_source", () => researcherTools.execute("get_source", { source_id: ids.source }), ids.eventNote],
      ["get_source_examinations", () => researcherTools.execute("get_source_examinations", { source_id: ids.source }), ids.finding],
      ["get_source_context", () => researcherTools.execute("get_source_context", { source_id: ids.source }), ids.source],
      ["get_claim_instances", () => executeGovernanceTool("get_claim_instances", { claim_id: ids.claim }), ids.instance],
      // With every section asked for: the provenance section is the one that reads these tables.
      ["get_claim", () => executeGraphReadTool("get_claim", { claim_id: ids.claim, include: [...CLAIM_VIEW_INCLUDES] }), ids.source],
      ["feed_inbox", () => feedTools.execute("feed_inbox", { statuses: ["seen", "new"] }), item!.id],
      ["read_item", () => feedTools.execute("read_item", { item_id: item!.id, view: "full" }), "whole post"],
      ["pipeline_report", async () => JSON.stringify(await getMandatePipeline(ids.grantId)), ids.source],
      ["list_documents", async () => JSON.stringify(await listDocumentsForReview({ limit: 50 })), "documents"],
      ["the shared analysis", async () => JSON.stringify(await getSharedAnalysis(ids.urlHash)), PHRASE_A],
      ["the recorded page", async () => JSON.stringify(await getRecordedPage((await sourceRow(ids.source)).page_url_hash!)), ids.claim],
    ];
    for (const [tool, read, shows] of reads) {
      const out = await read();
      expect(out, tool).not.toBeNull();
      // The check means something only if the read returned the rows.
      expect(out!, tool).toContain(shows);
      expect(carriesIt(out!), tool).toBe(false);
      expect(namesIt(out!), tool).toBe(false);
    }
    // The claim view the API and MCP serve, bare and with each section on its own.
    for (const include of [[], ...CLAIM_VIEW_INCLUDES.map((section) => [section])]) {
      const view = JSON.stringify(await getClaimView(ids.claim, { include }));
      expect(carriesIt(view), include.join()).toBe(false);
      expect(namesIt(view), include.join()).toBe(false);
    }
  });

  it("has no write tool's reply that carries it", async () => {
    // The replies the recording tools gave while writing the rows above
    // spread the service's result into the reply. Written again here, at a
    // second label, each reply is read whole.
    const { ids } = rows;
    const steward = { role: "claim-steward" as const, claimId: ids.claim };
    const replies = await inRunAt(INTERNAL, async () => [
      await executeRecordReading({ instance_id: ids.instance, support: "supports" }, steward),
      await executeRecordRoot({ source_id: ids.upstream, status: "origin", basis: "Read once more." }, steward),
      await executeWriteMap({ summary: "It rests on one release.", material: true }, steward),
      await executeRecordSourceInterest({ scope: "claim", source_id: ids.source, party: "A party", stake: "A stake." }, steward),
      await executeStewardTool("record_claim_instance", {
        claim_id: ids.claim, url: pageUrl("another"), verbatim_text: "Another passage.", stance: "mentions",
      }),
    ]);
    for (const reply of replies) {
      expect(JSON.parse(reply), reply).toMatchObject({ success: true });
      expect(carriesIt(reply), reply).toBe(false);
      expect(namesIt(reply), reply).toBe(false);
    }
  });
});
