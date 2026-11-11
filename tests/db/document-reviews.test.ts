/**
 * Document reviews (#865) over real SQL. A review of a document for its own
 * sake is a request bearing on that document alone: its runs record onto one
 * examination linked to the request, opened with no facets for the
 * researcher to name; the source's context shows the reviews and the
 * requests bearing on it; the Curator's list gives the figures a reader
 * would weigh, ordered as asked, and files nothing; and requests can be
 * listed by the document they bear on.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { segmentSource } from "../../src/services/source-segment-service.js";

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => new Array(1536).fill(0).map((_, i) => (i === 7 ? 1 : 0))),
}));

import {
  addFacets,
  examinationForRequest,
  listExaminations,
  recordFinding,
} from "../../src/services/examination-service.js";
import { documentUnderReview, fileRequest, getRequest, listRequests } from "../../src/services/request-service.js";
import { getSourceReviews, listDocumentsForReview } from "../../src/services/source-context-service.js";

const TEXT = ["Methods", "A survey of managers in 61 firms.", "Conclusions", "Productivity rose."].join("\n\n");

async function seedSource(title = "The report", content: string | null = TEXT): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content) VALUES ($1, $2, $3) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, title, content]
  );
  return rows[0]!.id;
}

const ASK = {
  ask: "Review the report as a whole: what its survey measured and what it concludes beyond it.",
  why: "Many articles draw on it and state it more strongly than it states itself.",
  satisfiedBy: "A record on its page of what was examined and found.",
};

async function fileReview(sourceId: string): Promise<string> {
  const { id } = await fileRequest({ ...ASK, sourceIds: [sourceId], filer: { kind: "admin", agent: "curator" } });
  return id;
}

describe("a review of a document asked for in a request", () => {
  it("is a request on the document alone, kept by the Curator", async () => {
    const source = await seedSource();
    const claim = await seedClaim("productivity rose in the trial firms");
    const id = await fileReview(source);
    const request = (await getRequest(id))!;
    expect(request.keeper.kind).toBe("curator");
    expect(documentUnderReview(request)).toMatchObject({ id: source, title: "The report" });

    // On a node as well, or on two documents, it is not one document's review.
    const both = (await getRequest(
      (await fileRequest({ ...ASK, claimIds: [claim], sourceIds: [source], filer: { kind: "admin", agent: "claim_steward" } })).id
    ))!;
    expect(documentUnderReview(both)).toBeNull();
    const two = (await getRequest(
      (await fileRequest({ ...ASK, sourceIds: [source, await seedSource("Another")], filer: { kind: "admin", agent: "curator" } })).id
    ))!;
    expect(documentUnderReview(two)).toBeNull();
  });

  it("records every stage onto one examination, whose facets the researcher names", async () => {
    const source = await seedSource();
    await segmentSource(source);
    const requestId = await fileReview(source);

    const first = await examinationForRequest({ requestId, sourceId: source, brief: "the request as filed" });
    expect(first).toMatchObject({ scope: "document", trigger: "request", request_id: requestId, claim_id: null, facets: [] });
    const again = await examinationForRequest({ requestId, sourceId: source, brief: "the request, a later stage" });
    expect(again.id).toBe(first.id);

    const [segment] = await rawQuery<{ id: string }>(
      `SELECT id FROM source_segments WHERE source_id = $1 AND kind = 'passage' ORDER BY ordinal LIMIT 1`,
      [source]
    );
    const finding = {
      examinationId: first.id, segmentId: segment!.id, facet: "method",
      statement: "The survey asked managers whether productivity rose; it measured no output.",
      evidence: "Methods, first paragraph.", createdBy: "researcher",
    };
    await expect(recordFinding(finding)).rejects.toThrow(/checks no facets yet/);
    expect(await addFacets(first.id, ["Method", "how it is drawn on"])).toEqual(["method", "how_it_is_drawn_on"]);
    expect(await addFacets(first.id, ["method"])).toEqual(["method", "how_it_is_drawn_on"]);
    await recordFinding(finding);

    const [listed] = await listExaminations([source]);
    expect(listed).toMatchObject({
      id: first.id, scope: "document", trigger: "request", claim: null,
      request: { id: requestId, ask: ASK.ask, state: "open" },
      facets: ["method", "how_it_is_drawn_on"],
    });

    const reviews = await getSourceReviews(source);
    expect(reviews.document_reviews).toEqual([
      expect.objectContaining({
        examination_id: first.id, request: { id: requestId, ask: ASK.ask, state: "open" },
        segments_covered: 1, findings: 1,
      }),
    ]);
    expect(reviews.segments).toBeGreaterThan(0);
    expect(reviews.requests).toEqual([expect.objectContaining({ id: requestId, live: true })]);
  });

  it("lists requests by the document they bear on", async () => {
    const source = await seedSource();
    const other = await seedSource("Unrelated");
    const id = await fileReview(source);
    await fileReview(other);
    const { items } = await listRequests({ sourceId: source });
    expect(items.map((r) => r.id)).toEqual([id]);
  });
});

describe("the documents the graph rests on, for the Curator's judgment", () => {
  it("gives the figures, orders by the one asked for, and leaves out the reviewed on request", async () => {
    const quoted = await seedSource("Much quoted, often distorted");
    const cited = await seedSource("Cited by claims");
    const claimA = await seedClaim("a claim resting on the cited document");
    const claimB = await seedClaim("another claim resting on it");
    for (const claim of [claimA, claimB]) {
      await rawQuery(
        `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'text')`,
        [claim, cited]
      );
    }
    // Three articles draw on the quoted document, two of them distorting it.
    const claimC = await seedClaim("a claim stated in the articles");
    for (const fidelity of ["distorted", "strengthened", "faithful"]) {
      const article = await seedSource(`Article ${fidelity}`);
      const [inst] = await rawQuery<{ id: string }>(
        `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'text') RETURNING id`,
        [claimC, article]
      );
      await rawQuery(
        `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, fidelity, evidence, reasoning)
         VALUES ($1, $2, 'repeats', $3, 'the passage', 'read it')`,
        [inst!.id, quoted, fidelity]
      );
    }

    const byUses = await listDocumentsForReview({ order: "divergent_uses", limit: 50 });
    const q = byUses.documents.find((d) => d.source.id === quoted)!;
    expect(q).toMatchObject({ drawn_on_by: 3, divergent_uses: 2, claims: 1, reviews: 0, live_request_id: null });
    expect(byUses.documents.findIndex((d) => d.source.id === quoted))
      .toBeLessThan(byUses.documents.findIndex((d) => d.source.id === cited));

    const byClaims = await listDocumentsForReview({ order: "claims", limit: 50 });
    const c = byClaims.documents.find((d) => d.source.id === cited)!;
    expect(c).toMatchObject({ claims: 2, drawn_on_by: 0, chars: TEXT.length });
    expect(byClaims.documents.findIndex((d) => d.source.id === cited))
      .toBeLessThan(byClaims.documents.findIndex((d) => d.source.id === quoted));

    // Asking for a review shows as a live request; one done drops it from the unreviewed.
    const requestId = await fileReview(quoted);
    await examinationForRequest({ requestId, sourceId: quoted, brief: "b" });
    const all = await listDocumentsForReview({ order: "divergent_uses", limit: 50 });
    expect(all.documents.find((d) => d.source.id === quoted)).toMatchObject({ reviews: 1, live_request_id: requestId });
    const unreviewed = await listDocumentsForReview({ order: "divergent_uses", unreviewed: true, limit: 50 });
    expect(unreviewed.documents.some((d) => d.source.id === quoted)).toBe(false);
    expect(unreviewed.documents.some((d) => d.source.id === cited)).toBe(true);

    // Nothing was filed by listing.
    const [{ n }] = (await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM request_targets WHERE source_id = $1`,
      [cited]
    )) as [{ n: string }];
    expect(Number(n)).toBe(0);
  });
});
