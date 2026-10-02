/**
 * Examinations (#507, phase 5) over real SQL: an examination is opened on a
 * document in the claim's map, records coverage and passage-anchored
 * findings within its own facets and document, a claim Steward's reading
 * cites findings about its own source, the Audit agent annotates one, and
 * the listing shows all of it, attributed, with no status on anything.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { segmentSource } from "../../src/services/source-segment-service.js";
import {
  ExaminationError,
  citeFindings,
  getExaminationOutline,
  linkResearchRun,
  listExaminations,
  noteFinding,
  openExamination,
  recordCoverage,
  recordFinding,
} from "../../src/services/examination-service.js";

const TEXT = [
  "Results",
  "Rotating night work was associated with a 1.4-fold higher risk.",
  "Table 3. Hazard ratios",
  "Discussion",
  "These findings suggest a causal role for circadian disruption.",
].join("\n\n");

async function seedSource(content: string | null = TEXT): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content) VALUES ($1, 'Registry study', $2) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, content]
  );
  return rows[0]!.id;
}

async function seedInstance(claimId: string, sourceId: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text)
     VALUES ($1, $2, 'Rotating night work was associated with a 1.4-fold higher risk') RETURNING id`,
    [claimId, sourceId]
  );
  return rows[0]!.id;
}

async function segmentIds(sourceId: string): Promise<Map<string, string>> {
  const rows = await rawQuery<{ id: string; kind: string; label: string | null; ordinal: number }>(
    `SELECT id, kind, label, ordinal FROM source_segments WHERE source_id = $1 ORDER BY ordinal`,
    [sourceId]
  );
  return new Map(rows.map((r) => [r.label ?? `${r.kind}-${r.ordinal}`, r.id]));
}

describe("examinations", () => {
  it("runs end to end: open, outline, coverage, findings, citation, note, listing", async () => {
    const source = await seedSource();
    const claim = await seedClaim("night work raises diabetes risk");
    const instance = await seedInstance(claim, source);
    await segmentSource(source);

    const exam = await openExamination({
      scope: "claim", trigger: "claim", claimId: claim, grantId: null, sourceId: source,
      brief: "Check whether Table 3 shows the 1.4-fold figure.", facets: ["Data", "method", "data"],
      requestedBy: "claim_steward",
    });
    expect(exam.facets).toEqual(["data", "method"]);
    const run = await rawQuery<{ id: string }>(
      `INSERT INTO research_runs (claim_id, requested_by, task, model, model_tier, ceiling_micro_usd, spent_micro_usd, status)
       VALUES ($1, 'claim_steward', 'brief', 'm', 'standard', 1000000, 420000, 'completed') RETURNING id`,
      [claim]
    );
    await linkResearchRun(exam.id, run[0]!.id);

    const outline = await getExaminationOutline(exam.id);
    expect(outline.segments.map((s) => s.kind)).toEqual(["section", "passage", "table", "section", "passage"]);
    expect(outline.segments[1]!.preview).toMatch(/^Rotating night work/);
    const ids = await segmentIds(source);
    const table = ids.get("Table 3")!;
    const resultPassage = outline.segments[1]!.segment_id;

    expect(await recordCoverage({ examinationId: exam.id, segmentIds: [resultPassage, table], facet: "data" })).toEqual({ recorded: 2, facet: "data" });
    expect((await recordCoverage({ examinationId: exam.id, segmentIds: [table], facet: "data" })).recorded).toBe(0);
    await expect(recordCoverage({ examinationId: exam.id, segmentIds: [table], facet: "verdict" })).rejects.toThrow(/facet must be one/);
    const stranger = await seedSource("Elsewhere\n\nOther text.");
    await segmentSource(stranger);
    const strangerSeg = [...(await segmentIds(stranger)).values()][0]!;
    await expect(recordCoverage({ examinationId: exam.id, segmentIds: [strangerSeg], facet: "data" })).rejects.toThrow(/Not segments of the examined document/);

    const finding = await recordFinding({
      examinationId: exam.id, segmentId: table, facet: "method",
      statement: "Table 3 reports the hazard ratio adjusted for BMI only.", evidence: "Table 3, footnote b.",
      createdBy: "researcher",
    });
    // A finding covers its passage for its facet.
    const cov = await rawQuery<{ facet: string }>(
      `SELECT facet FROM examination_coverage WHERE examination_id = $1 AND segment_id = $2 ORDER BY facet`,
      [exam.id, table]
    );
    expect(cov.map((c) => c.facet)).toEqual(["data", "method"]);

    await expect(citeFindings({ claimId: claim, instanceId: instance, findingIds: [finding.id], createdBy: "claim_steward" }))
      .rejects.toThrow(/Record a reading of this instance first/);
    await rawQuery(`INSERT INTO claim_instance_readings (instance_id, support) VALUES ($1, 'overstates')`, [instance]);
    const cited = await citeFindings({ claimId: claim, instanceId: instance, findingIds: [finding.id], createdBy: "claim_steward" });
    expect(cited.cited).toBe(1);
    expect((await citeFindings({ claimId: claim, instanceId: instance, findingIds: [finding.id], createdBy: "claim_steward" })).cited).toBe(0);
    const otherClaim = await seedClaim("another claim");
    await expect(citeFindings({ claimId: otherClaim, instanceId: instance, findingIds: [finding.id], createdBy: "claim_steward" }))
      .rejects.toThrow(/belongs to another claim/);

    await noteFinding({ findingId: finding.id, note: "The footnote adjusts for age as well.", createdBy: "audit_agent" });

    const [listed] = await listExaminations([source]);
    expect(listed).toMatchObject({
      id: exam.id, scope: "claim", trigger: "claim", claim: { id: claim }, facets: ["data", "method"],
      runs: [{ id: run[0]!.id, status: "completed", spent_usd: 0.42 }],
    });
    expect(listed!.coverage).toHaveLength(3);
    expect(listed!.findings).toEqual([
      expect.objectContaining({
        id: finding.id, segment_label: "Table 3", facet: "method", created_by: "researcher",
        audit_notes: [expect.objectContaining({ note: "The footnote adjusts for age as well.", created_by: "audit_agent" })],
        cited_by_claims: [claim],
      }),
    ]);
  });

  it("refuses a claim-scoped examination of a document outside the claim's map, and bad facets", async () => {
    const claim = await seedClaim("a claim");
    const outside = await seedSource();
    const base = {
      scope: "claim", trigger: "claim", claimId: claim, grantId: null, sourceId: outside,
      brief: "b", facets: ["data"], requestedBy: "claim_steward",
    };
    await expect(openExamination(base)).rejects.toThrow(ExaminationError);
    await expect(openExamination({ ...base, scope: "document", claimId: null, facets: [] })).rejects.toThrow(/facets is required/);
    await expect(openExamination({ ...base, scope: "document", claimId: null, facets: ["has space!"] })).rejects.toThrow(/short label/);
    // A document review needs no claim.
    const review = await openExamination({ ...base, scope: "document", trigger: "mandate", claimId: null, grantId: null });
    expect(review.scope).toBe("document");
  });
});
