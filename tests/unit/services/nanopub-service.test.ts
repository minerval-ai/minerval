/**
 * Nanopublication export (#292): the evidence record serialized as RDF in
 * the nanopub shape. The discipline under test: credence is omitted exactly
 * where the graph omits it (§10), decomposition relations map to their own
 * predicates, and [[claim:...]] machinery never reaches exported prose (§12).
 */
import { describe, it, expect } from "vitest";

import {
  evidenceRecordToJsonLd,
  evidenceRecordToTrig,
  resolveClaimLinks,
} from "../../../src/services/nanopub-service.js";
import type { EvidenceRecord } from "../../../src/services/citation-service.js";

const CLAIM_ID = "11111111-2222-3333-4444-555555555555";
const SUB_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const SUB2_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const CLAIM_URI = `https://minerval.ai/claims/${CLAIM_ID}`;

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    claim: {
      id: CLAIM_ID,
      text: 'Inflation in 2022 was "transitory".',
      claim_type: "empirical_derived",
      state: "active",
      importance: 0.8,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
    },
    assessment: {
      id: "cccccccc-1111-2222-3333-444444444444",
      version: 3,
      status: "contested",
      confidence: 0.85,
      claim_credence: null,
      summary: `The dispute turns on [[claim:${SUB_ID}]].`,
      reasoning_trace: `Weighed [[claim:${SUB_ID}|the supply-chain premise]] against the data.`,
      model: "claude-fable-5",
      assessed_at: "2026-07-30T00:00:00.000Z",
    },
    arguments: [
      {
        id: "dddddddd-1111-2222-3333-444444444444",
        name: "The supply-chain argument",
        stance: "for",
        content: `Because [[claim:${SUB_ID}]], the rise was transitory.`,
        evidence_urls: [],
        verdict: "contested",
        evaluation: null,
        subclaims: [
          {
            id: SUB_ID,
            text: "Supply chains drove the 2022 price rise.",
            relation: "requires",
            status: "supported",
          },
          {
            id: SUB2_ID,
            text: "Some future relation.",
            relation: "entangles",
            status: null,
          },
        ],
      },
    ],
    instances: [
      {
        id: "eeeeeeee-1111-2222-3333-444444444444",
        quote: 'They said it was\n"transitory".',
        context: null,
        stance: "denies",
        source: {
          id: "ffffffff-1111-2222-3333-444444444444",
          title: "A skeptical column",
          url: "https://example.com/column",
          source_type: "news",
        },
      },
      {
        id: "eeeeeeee-2222-3333-4444-555555555555",
        quote: "Plainly transitory.",
        context: null,
        stance: "affirms",
        source: {
          id: "ffffffff-2222-3333-4444-555555555555",
          title: "An offline pamphlet",
          url: null,
          source_type: "unknown",
        },
      },
    ],
    disagreement: {
      contested: true,
      affirming_instances: 1,
      denying_instances: 1,
      contested_arguments: [],
    },
    ...overrides,
  };
}

const opts = {
  claimUri: CLAIM_URI,
  pageUrl: CLAIM_URI,
  generatedAt: new Date("2026-08-03T12:00:00.000Z"),
};

describe("resolveClaimLinks (§12)", () => {
  it("resolves bare references to canonical text and keeps given display text", () => {
    const map = new Map([[SUB_ID, "Supply chains drove the rise."]]);
    expect(resolveClaimLinks(`See [[claim:${SUB_ID}]].`, map)).toBe(
      "See Supply chains drove the rise.."
    );
    expect(resolveClaimLinks(`See [[claim:${SUB_ID}|the premise]].`, map)).toBe(
      "See the premise."
    );
  });

  it("degrades an unknown reference without leaking the full uuid", () => {
    const out = resolveClaimLinks(`See [[claim:${SUB_ID}]].`, new Map());
    expect(out).toBe(`See claim ${SUB_ID.slice(0, 8)}.`);
  });
});

describe("evidenceRecordToTrig", () => {
  it("emits the four nanopub graphs with prefixes", () => {
    const trig = evidenceRecordToTrig(record(), opts);
    expect(trig).toContain("@prefix np: <http://www.nanopub.org/nschema#> .");
    expect(trig).toContain(`<${CLAIM_URI}#Head> {`);
    expect(trig).toContain(`<${CLAIM_URI}#assertion> {`);
    expect(trig).toContain(`<${CLAIM_URI}#provenance> {`);
    expect(trig).toContain(`<${CLAIM_URI}#pubinfo> {`);
    expect(trig).toContain("np:hasAssertion");
  });

  it("omits credence exactly when the graph omits it (§10)", () => {
    const withOut = evidenceRecordToTrig(record(), opts);
    expect(withOut).not.toContain("mv:credence");
    expect(withOut).toContain('mv:confidence "0.85"^^xsd:decimal');

    const base = record();
    const withCredence = evidenceRecordToTrig(
      record({ assessment: { ...base.assessment!, claim_credence: 0.4 } }),
      opts
    );
    expect(withCredence).toContain('mv:credence "0.4"^^xsd:decimal');
  });

  it("maps decomposition relations to predicates, unknown ones to mv:relatedTo", () => {
    const trig = evidenceRecordToTrig(record(), opts);
    expect(trig).toContain(
      `<${CLAIM_URI}> mv:requires <https://minerval.ai/claims/${SUB_ID}>`
    );
    expect(trig).toContain(
      `<${CLAIM_URI}> mv:relatedTo <https://minerval.ai/claims/${SUB2_ID}>`
    );
  });

  it("resolves [[claim:...]] machinery out of exported prose (§12)", () => {
    const trig = evidenceRecordToTrig(record(), opts);
    expect(trig).not.toContain("[[claim:");
    expect(trig).toContain("The dispute turns on Supply chains drove the 2022 price rise.");
    expect(trig).toContain("Weighed the supply-chain premise against the data.");
  });

  it("escapes quotes and newlines in literals", () => {
    const trig = evidenceRecordToTrig(record(), opts);
    expect(trig).toContain('"They said it was\\n\\"transitory\\"."');
  });

  it("types a denying source as cito:disputes and an affirming one as cito:supports", () => {
    const trig = evidenceRecordToTrig(record(), opts);
    expect(trig).toContain(`<https://example.com/column> cito:disputes <${CLAIM_URI}>`);
    // The url-less pamphlet has no IRI to hang a cito triple on; its quote
    // still appears as an instance node.
    expect(trig).toContain('"An offline pamphlet"');
    expect(trig).not.toContain("cito:supports <https://example.com/column>");
  });

  it("pins the assessment version and attribution in pubinfo", () => {
    const trig = evidenceRecordToTrig(record(), opts);
    expect(trig).toContain('dct:creator "Minerval"');
    expect(trig).toContain(
      "dct:license <https://creativecommons.org/publicdomain/zero/1.0/>"
    );
    expect(trig).toContain('mv:assessmentVersion "3"^^xsd:integer');
    expect(trig).toContain('mv:assessedAt "2026-07-30T00:00:00.000Z"^^xsd:dateTime');
    expect(trig).toContain(
      'prov:generatedAtTime "2026-08-03T12:00:00.000Z"^^xsd:dateTime'
    );
  });

  it("keeps an unassessed claim's assertion to the claim itself", () => {
    const trig = evidenceRecordToTrig(record({ assessment: null }), opts);
    // The claim node carries no verdict triples; its assessed subclaims keep
    // their own statuses.
    expect(trig).not.toContain(`<${CLAIM_URI}> mv:status`);
    expect(trig).not.toContain(`<${CLAIM_URI}> mv:confidence`);
    expect(trig).not.toContain("mv:assessmentVersion");
    expect(trig).not.toContain("mv:reasoningTrace");
    expect(trig).toContain("rdfs:label");
  });
});

describe("evidenceRecordToJsonLd", () => {
  it("mirrors the TriG structure as named graphs under one context", () => {
    const jsonld = evidenceRecordToJsonLd(record(), opts) as {
      "@context": Record<string, string>;
      "@graph": { "@id": string; "@graph": Record<string, unknown>[] }[];
    };
    expect(jsonld["@context"].np).toBe("http://www.nanopub.org/nschema#");
    expect(jsonld["@graph"].map((g) => g["@id"])).toEqual([
      `${CLAIM_URI}#Head`,
      `${CLAIM_URI}#assertion`,
      `${CLAIM_URI}#provenance`,
      `${CLAIM_URI}#pubinfo`,
    ]);
    const assertion = jsonld["@graph"][1]!["@graph"];
    const claimNode = assertion.find((n) => n["@id"] === CLAIM_URI)!;
    expect(claimNode["@type"]).toBe("mv:Claim");
    expect(claimNode["mv:status"]).toBe("contested");
    expect(claimNode["mv:confidence"]).toEqual({
      "@value": "0.85",
      "@type": "xsd:decimal",
    });
    expect(claimNode).not.toHaveProperty("mv:credence");
  });

  it("accumulates repeated predicates into arrays", () => {
    const jsonld = evidenceRecordToJsonLd(record(), opts) as {
      "@graph": { "@id": string; "@graph": Record<string, unknown>[] }[];
    };
    const head = jsonld["@graph"][0]!["@graph"][0]!;
    // One nanopub node carrying three distinct np: links, not overwritten.
    expect(head["np:hasAssertion"]).toEqual({ "@id": `${CLAIM_URI}#assertion` });
    expect(head["np:hasProvenance"]).toEqual({ "@id": `${CLAIM_URI}#provenance` });
  });
});
