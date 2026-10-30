/**
 * MIRA export (#515): a node and the structure around it as a MIRA graph in
 * JSON-LD. Every export is validated against MIRA's own SHACL shapes
 * (docs/mira/, pinned from MIRA-science/schema). The disciplines under test
 * are the nanopub's: credence omitted where the graph omits it (§10), no
 * [[claim:...]] machinery in exported prose (§12), CC0 stated; and a
 * mandate's request names no party (§12/§19).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import {
  buildMiraDocument,
  type JsonLdNode,
  type MiraDocument,
  type MiraInput,
} from "../../../src/services/mira-service.js";
import type { EvidenceRecord } from "../../../src/services/citation-service.js";
import type { QuestionDetailView } from "../../../src/services/question-service.js";
import type { RequestView } from "../../../src/services/request-service.js";
import { miraToNQuads, validateMira } from "../../mira-shacl.js";

async function expectValid(doc: unknown) {
  const report = await validateMira(doc);
  expect(report.messages).toEqual([]);
  expect(report.conforms).toBe(true);
}

const CLAIM_ID = "11111111-2222-3333-4444-555555555555";
const SUB_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const SUB2_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const Q_ID = "99999999-1111-2222-3333-444444444444";
const ANS_ID = "88888888-1111-2222-3333-444444444444";
const ANS2_ID = "77777777-1111-2222-3333-444444444444";
const SRC_ID = "ffffffff-1111-2222-3333-444444444444";
const SRC2_ID = "ffffffff-2222-3333-4444-555555555555";
const REQ_ID = "66666666-1111-2222-3333-444444444444";

const WEB = "https://minerval.ai";
const uri = (id: string) => `https://w3id.org/minerval/claim/${id}`;
const opts = {
  webBaseUrl: WEB,
  pageUrl: `${WEB}/claims/${CLAIM_ID}`,
  generatedAt: new Date("2026-10-30T12:00:00.000Z"),
  claimUri: uri,
};

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    claim: {
      id: CLAIM_ID,
      text: 'Inflation in 2022 was "transitory".',
      kind: "claim",
      claim_type: "empirical_derived",
      state: "active",
      importance: 0.8,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
    },
    assessment: {
      id: "cccccccc-1111-2222-3333-444444444444",
      version: 3,
      status: "inconclusive",
      confidence: 0.85,
      claim_credence: null,
      summary: `The dispute turns on [[claim:${SUB_ID}]].`,
      reasoning_trace: `Weighed [[claim:${SUB_ID}|the supply-chain premise]] against the data.`,
      model: "claude-opus-5-5",
      assessed_at: "2026-07-30T00:00:00.000Z",
    },
    arguments: [
      {
        id: "dddddddd-1111-2222-3333-444444444444",
        name: "The supply-chain argument",
        stance: "for",
        content: `Because [[claim:${SUB_ID}]], the rise was transitory.`,
        evidence_urls: [],
        verdict: "likely",
        decisive: false,
        evaluation: null,
        subclaims: [
          { id: SUB_ID, text: "Supply chains drove the 2022 price rise.", relation: "requires", status: "supported" },
        ],
      },
      {
        id: "dddddddd-2222-2222-3333-444444444444",
        name: null,
        stance: "against",
        content: "Unevaluated.",
        evidence_urls: [],
        verdict: null,
        decisive: null,
        evaluation: null,
        subclaims: [
          { id: SUB2_ID, text: "Wages kept rising into 2023.", relation: "entangles", status: null },
        ],
      },
    ],
    instances: [
      {
        id: "eeeeeeee-1111-2222-3333-444444444444",
        quote: 'They said it was "transitory".',
        context: "From the opening paragraph.",
        stance: "denies",
        source: { id: SRC_ID, title: "A skeptical column", url: "https://example.com/column", source_type: "news" },
      },
      {
        id: "eeeeeeee-2222-3333-4444-555555555555",
        quote: "Plainly transitory.",
        context: null,
        stance: "affirms",
        source: { id: SRC2_ID, title: "An offline pamphlet", url: null, source_type: "unknown" },
      },
    ],
    disagreement: {
      contestation: 0.7,
      affirming_instances: 1,
      denying_instances: 1,
      posing_instances: 0,
      arguments_on_unsettled_premises: [],
    },
    ...overrides,
  };
}

function request(overrides: Partial<RequestView> = {}): RequestView {
  return {
    id: REQ_ID,
    ask: `The full text of the source behind [[claim:${SUB_ID}]].`,
    why: "The premise rests on a table we have only in summary.",
    satisfied_by: "A copy of the report with table 3.",
    who_could: null,
    addressed_to: null,
    bears_on: [
      { id: CLAIM_ID, text: 'Inflation in 2022 was "transitory".', kind: "claim" },
      { id: Q_ID, text: "What drove 2022 inflation?", kind: "question" },
    ],
    bears_on_sources: [{ id: SRC_ID, title: "A skeptical column", url: "https://example.com/column" }],
    bears_on_text: null,
    filed_by: { kind: "mandate", label: "a funded mandate" },
    keeper: { kind: "curator", label: "the Curator" },
    state: "in_progress",
    state_note: null,
    filed_at: new Date("2026-10-01T00:00:00.000Z"),
    work: [{ by: "Researcher", outcome: null, summary: "Writing to the authors.", at: new Date("2026-10-02T00:00:00.000Z"), funded_by: null }],
    ...overrides,
  };
}

function input(overrides: Partial<MiraInput> = {}): MiraInput {
  return { record: record(), question: null, answers_questions: [], requests: [], ...overrides };
}

const byId = (doc: MiraDocument, id: string) => doc["@graph"].find((n) => n["@id"] === id) as JsonLdNode;
const ofType = (doc: MiraDocument, type: string) => doc["@graph"].filter((n) => n["@type"] === type);

describe("the validator", () => {
  it("accepts MIRA's own sample data", async () => {
    const sample = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/mira-sample-data.json", import.meta.url)), "utf8")
    );
    await expectValid(sample);
  });

  it("rejects a property MIRA's closed shapes do not allow", async () => {
    const doc = buildMiraDocument(input(), opts);
    byId(doc, uri(CLAIM_ID))["mv:status"] = "supported";
    const report = await validateMira(doc);
    expect(report.conforms).toBe(false);
    expect(report.messages.join("\n")).toContain("closed shape");
  });
});

describe("buildMiraDocument: a claim", () => {
  it("conforms to MIRA's shapes", async () => {
    await expectValid(buildMiraDocument(input({ requests: [request()] }), opts));
  });

  it("uses MIRA's context and states the export's terms", () => {
    const doc = buildMiraDocument(input(), opts);
    expect(doc["@context"][0]).toBe("https://purl.org/mira-science/mira.jsonld");
    expect(byId(doc, `${uri(CLAIM_ID)}#mira`)).toMatchObject({
      "@type": "mv:MiraExport",
      "mv:root": { "@id": uri(CLAIM_ID) },
      "dct:license": { "@id": "https://creativecommons.org/publicdomain/zero/1.0/" },
    });
    expect(byId(doc, uri(CLAIM_ID))).toMatchObject({
      "@type": "Claim",
      title: 'Inflation in 2022 was "transitory".',
      creator: `${WEB}/#minerval`,
    });
  });

  it("keeps the assessment beside the claim, and omits credence where the graph omits it (§10)", () => {
    const rec = byId(buildMiraDocument(input(), opts), `${uri(CLAIM_ID)}#record`);
    expect(rec).toMatchObject({
      "mv:describes": { "@id": uri(CLAIM_ID) },
      "mv:status": "inconclusive",
      "mv:confidence": { "@value": "0.85", "@type": "xsd:decimal" },
    });
    expect(rec).not.toHaveProperty("mv:credence");

    const r = record();
    r.assessment!.claim_credence = 0.62;
    expect(byId(buildMiraDocument(input({ record: r }), opts), `${uri(CLAIM_ID)}#record`)["mv:credence"]).toEqual({
      "@value": "0.62",
      "@type": "xsd:decimal",
    });
  });

  it("resolves [[claim:...]] machinery in every piece of prose (§12)", async () => {
    const doc = buildMiraDocument(input({ requests: [request()] }), opts);
    expect(JSON.stringify(doc)).not.toContain("[[claim:");
    expect(await miraToNQuads(doc)).not.toContain("[[claim:");
    expect(byId(doc, `${uri(CLAIM_ID)}#record`)["mv:reasoningTrace"]).toBe(
      "Weighed the supply-chain premise against the data."
    );
  });

  it("maps premises to MIRA's supports and opposes by the argument's stance, keeping each edge's kind", () => {
    const doc = buildMiraDocument(input(), opts);
    expect(byId(doc, uri(SUB_ID))).toMatchObject({ "@type": "Claim", supports: uri(CLAIM_ID) });
    expect(byId(doc, uri(SUB2_ID))).toMatchObject({ "@type": "Claim", opposes: uri(CLAIM_ID) });
    expect(ofType(doc, "mv:Edge").map((e) => e["mv:relation"])).toEqual(["requires", "entangles"]);
    const [first, second] = ofType(doc, "mv:Argument");
    expect(first).toMatchObject({ "rdfs:label": "The supply-chain argument", "mv:verdict": "likely" });
    expect(first).toHaveProperty("mv:decisive");
    expect(second).not.toHaveProperty("mv:decisive");
  });

  it("records instances as Evidence from their sources", () => {
    const doc = buildMiraDocument(input(), opts);
    const evidence = ofType(doc, "Evidence");
    expect(evidence[0]).toMatchObject({
      observationStatement: uri(CLAIM_ID),
      opposes: uri(CLAIM_ID),
      sourceDocument: "https://example.com/column",
      content: 'They said it was "transitory".',
      description: { "@type": "Item", content: "From the opening paragraph." },
    });
    expect(evidence[1]).toMatchObject({ supports: uri(CLAIM_ID), sourceDocument: `${WEB}/sources/${SRC2_ID}` });
    expect(byId(doc, `${WEB}/sources/${SRC2_ID}`)).toMatchObject({ "@type": "SourceDocument", title: "An offline pamphlet" });
    expect(ofType(doc, "mv:Instance").map((i) => i["mv:stance"])).toEqual(["denies", "affirms"]);
  });

  it("links a claim to the questions it answers with MIRA's addresses", async () => {
    const doc = buildMiraDocument(
      input({ answers_questions: [{ id: Q_ID, text: "What drove 2022 inflation?", standing: "leaning" }] }),
      opts
    );
    await expectValid(doc);
    expect(byId(doc, uri(CLAIM_ID)).addresses).toBe(uri(Q_ID));
    expect(byId(doc, uri(Q_ID))).toMatchObject({ "@type": "Question" });
    expect(byId(doc, `${uri(Q_ID)}#record`)).toMatchObject({ "mv:standing": "leaning" });
  });

  it("exports requests: claims as request_target, everything else on the record, a mandate unnamed (§12/§19)", () => {
    const doc = buildMiraDocument(input({ requests: [request()] }), opts);
    const req = byId(doc, `${WEB}/requests/${REQ_ID}`);
    expect(req).toMatchObject({
      "@type": "Request",
      title: "The full text of the source behind Supply chains drove the 2022 price rise..",
      request_target: uri(CLAIM_ID),
      creator: [{ "@type": "UserAccount", accountName: "a funded mandate" }, `${WEB}/#minerval`],
    });
    expect(byId(doc, `${WEB}/requests/${REQ_ID}#record`)).toMatchObject({
      "mv:state": "in_progress",
      "mv:bearsOn": [{ "@id": uri(CLAIM_ID) }, { "@id": uri(Q_ID) }, { "@id": "https://example.com/column" }],
    });
    expect(ofType(doc, "mv:RequestWork")).toHaveLength(1);
  });

  it("conforms with no assessment and no evidence", async () => {
    await expectValid(buildMiraDocument(input({ record: record({ assessment: null, arguments: [], instances: [] }) }), opts));
  });
});

describe("buildMiraDocument: a question", () => {
  function question(): QuestionDetailView {
    return {
      standing: "leaning",
      assessment: {
        standing: "leaning",
        summary: `Leaning toward [[claim:${ANS_ID}]].`,
        reasoning_trace: "Weighed both answers.",
        model: "claude-opus-5-5",
        assessed_at: new Date("2026-10-02T00:00:00.000Z"),
        favored_ids: [ANS_ID],
      },
      incomplete: null,
      presuppositions: [{ id: SUB_ID, text: "Prices rose in 2022.", kind: "claim", status: "supported", standing: null }],
      subquestions: [],
      answers: [
        { id: ANS_ID, text: "Supply shocks.", kind: "claim", status: "supported", credence: 0.7, estimate: null, unit: null, favored: true, basis: "quality" },
        { id: ANS2_ID, text: "Monetary expansion.", kind: "claim", status: "doubtful", credence: null, estimate: null, unit: null, favored: false, basis: "prominence" },
      ],
      relations: [{ a: ANS2_ID, b: ANS_ID, relation: "compatible" }],
      depended_on_by: [],
      instances: [
        { id: "eeeeeeee-3333-3333-4444-555555555555", role: "answers", verbatim_text: "Supply shocks did it.", source_title: "A paper", source_url: null, source_type: "paper", answer_id: ANS_ID },
        { id: "eeeeeeee-4444-3333-4444-555555555555", role: "asks", verbatim_text: "What drove it?", source_title: "A paper", source_url: null, source_type: "paper", answer_id: null },
      ],
    };
  }

  function questionInput(): MiraInput {
    const source = { id: SRC_ID, title: "A paper", url: null, source_type: "paper" };
    return input({
      record: record({
        claim: { ...record().claim, id: Q_ID, kind: "question", text: "What drove 2022 inflation?" },
        assessment: null,
        arguments: [],
        instances: [
          { id: "eeeeeeee-3333-3333-4444-555555555555", quote: "Supply shocks did it.", context: null, stance: "answers", source },
          { id: "eeeeeeee-4444-3333-4444-555555555555", quote: "What drove it?", context: null, stance: "asks", source },
        ],
      }),
      question: question(),
    });
  }

  it("conforms to MIRA's shapes", async () => {
    await expectValid(buildMiraDocument(questionInput(), opts));
  });

  it("exports the root as a Question its answers address, with its standing beside it", () => {
    const doc = buildMiraDocument(questionInput(), opts);
    expect(byId(doc, uri(Q_ID))["@type"]).toBe("Question");
    expect(byId(doc, uri(ANS_ID))).toMatchObject({ "@type": "Claim", addresses: uri(Q_ID) });
    expect(byId(doc, uri(ANS2_ID))).toMatchObject({ addresses: uri(Q_ID) });
    expect(byId(doc, `${uri(Q_ID)}#record`)).toMatchObject({
      "mv:standing": "leaning",
      "mv:favors": { "@id": uri(ANS_ID) },
      "rdfs:comment": "Leaning toward Supply shocks..",
    });
    expect(byId(doc, `${uri(ANS_ID)}#record`)["mv:credence"]).toEqual({ "@value": "0.7", "@type": "xsd:decimal" });
    expect(byId(doc, `${uri(ANS2_ID)}#record`)).not.toHaveProperty("mv:credence");
    expect(ofType(doc, "mv:AnswerRelation")[0]).toMatchObject({ "mv:relation": "compatible" });
    expect(ofType(doc, "mv:Edge").map((e) => [e["mv:relation"], e["mv:answerBasis"]])).toEqual([
      ["answers", "quality"],
      ["answers", "prominence"],
      ["presupposes", undefined],
    ]);
  });

  it("records an answering source as Evidence for its answer, and an asking source on its instance alone", () => {
    const doc = buildMiraDocument(questionInput(), opts);
    const evidence = ofType(doc, "Evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ observationStatement: uri(ANS_ID), supports: uri(ANS_ID) });
    const instances = ofType(doc, "mv:Instance");
    expect(instances.map((i) => i["mv:stance"])).toEqual(["answers", "asks"]);
    expect(instances[1]).not.toHaveProperty("mv:evidence");
  });
});
