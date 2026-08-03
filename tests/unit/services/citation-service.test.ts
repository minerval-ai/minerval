/**
 * "Cite this claim" formatters (#290): the conventional citation renderings
 * are pure functions over a pinned assessment version, so they are tested
 * directly — the citation must name the assessment as of a moment (claim id +
 * assessment version + retrieval date) so it stays reproducible.
 */
import { describe, it, expect } from "vitest";

import {
  CITATION_AUTHOR,
  formatBibtex,
  formatCslJson,
  formatTextCitation,
  type CitationInput,
} from "../../../src/services/citation-service.js";

const CLAIM_ID = "11111111-2222-3333-4444-555555555555";
const ASSESSMENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const assessed: CitationInput = {
  title: "Inflation in 2022 was driven primarily by supply-chain disruption.",
  claimId: CLAIM_ID,
  assessmentId: ASSESSMENT_ID,
  assessmentVersion: 3,
  status: "contested",
  assessedAt: new Date("2026-07-30T12:00:00.000Z"),
  retrievedAt: new Date("2026-08-03T09:30:00.000Z"),
  url: `https://minerval.ai/claims/${CLAIM_ID}`,
};

const unassessed: CitationInput = {
  ...assessed,
  assessmentId: null,
  assessmentVersion: null,
  status: null,
  assessedAt: null,
};

describe("formatTextCitation", () => {
  it("pins author, claim id, assessment version, dates, and URL", () => {
    const text = formatTextCitation(assessed);
    expect(text).toBe(
      `Minerval. “${assessed.title}” Claim ${CLAIM_ID}, ` +
        `assessment v3 (contested), assessed 2026-07-30. ` +
        `Retrieved 2026-08-03, from https://minerval.ai/claims/${CLAIM_ID}.`
    );
  });

  it("cites an unassessed claim honestly, without a version", () => {
    const text = formatTextCitation(unassessed);
    expect(text).toContain("unassessed");
    expect(text).not.toContain("assessment v");
  });
});

describe("formatBibtex", () => {
  it("emits a @misc entry with Minerval as corporate author", () => {
    const bib = formatBibtex(assessed);
    expect(bib).toContain(`@misc{minerval_claim_${CLAIM_ID.slice(0, 8)},`);
    expect(bib).toContain("author       = {{Minerval}},");
    expect(bib).toContain("year         = {2026},");
    expect(bib).toContain(`url          = {https://minerval.ai/claims/${CLAIM_ID}},`);
    expect(bib).toContain("urldate      = {2026-08-03},");
    expect(bib).toContain(
      `note         = {Claim ${CLAIM_ID}; assessment v3 (contested), assessed 2026-07-30}`
    );
  });

  it("escapes LaTeX special characters in the canonical form", () => {
    const bib = formatBibtex({
      ...assessed,
      title: "GDP grew ~2% in Q4 & R{&}D _spending_ rose #1.",
    });
    expect(bib).toContain("\\%");
    expect(bib).toContain("\\&");
    expect(bib).toContain("\\_");
    expect(bib).toContain("\\#");
    expect(bib).toContain("\\textasciitilde{}");
    expect(bib).toContain("\\{");
    expect(bib).toContain("\\}");
  });

  it("falls back to the retrieval year for an unassessed claim", () => {
    expect(formatBibtex(unassessed)).toContain("year         = {2026},");
    expect(formatBibtex(unassessed)).toContain("unassessed");
  });
});

describe("formatCslJson", () => {
  it("emits a CSL item pinned to the assessment version", () => {
    const csl = formatCslJson(assessed);
    expect(csl).toEqual({
      id: `minerval-claim-${CLAIM_ID.slice(0, 8)}`,
      type: "webpage",
      title: assessed.title,
      author: [{ literal: CITATION_AUTHOR }],
      "container-title": CITATION_AUTHOR,
      URL: assessed.url,
      issued: { "date-parts": [[2026, 7, 30]] },
      version: "3",
      accessed: { "date-parts": [[2026, 8, 3]] },
      note: `Claim ${CLAIM_ID}; assessment v3 (contested), assessed 2026-07-30`,
    });
  });

  it("omits issued/version for an unassessed claim", () => {
    const csl = formatCslJson(unassessed);
    expect(csl).not.toHaveProperty("issued");
    expect(csl).not.toHaveProperty("version");
    expect(csl.accessed).toEqual({ "date-parts": [[2026, 8, 3]] });
  });
});
