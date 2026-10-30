/**
 * MIRA export (#515): a node and the structure around it as MIRA records.
 * Every bundle is held to the pinned profile schema
 * (docs/mira/minerval-mira-0.1.schema.json). The disciplines under test are
 * the nanopub's: credence omitted where the graph omits it (§10), no
 * [[claim:...]] machinery in exported prose (§12), CC0 stated; and a
 * mandate's request names no party (§12/§19).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

import { buildMiraBundle, type MiraInput } from "../../../src/services/mira-service.js";
import type { EvidenceRecord } from "../../../src/services/citation-service.js";
import type { QuestionDetailView } from "../../../src/services/question-service.js";
import type { RequestView } from "../../../src/services/request-service.js";

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../docs/mira/minerval-mira-0.1.schema.json", import.meta.url)),
    "utf8"
  )
);
const ajv = new Ajv({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;
addFormats(ajv);
const validate = ajv.compile(schema);

function expectValid(bundle: unknown) {
  const ok = validate(bundle);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

const CLAIM_ID = "11111111-2222-3333-4444-555555555555";
const SUB_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const SUB2_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const Q_ID = "99999999-1111-2222-3333-444444444444";
const ANS_ID = "88888888-1111-2222-3333-444444444444";
const ANS2_ID = "77777777-1111-2222-3333-444444444444";
const SRC_ID = "ffffffff-1111-2222-3333-444444444444";
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
          { id: SUB2_ID, text: "Some future relation.", relation: "entangles", status: null },
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
          { id: SUB_ID, text: "Supply chains drove the 2022 price rise.", relation: "requires", status: "supported" },
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
        source: { id: SRC_ID, title: "A skeptical column", url: "https://example.com/column", source_type: "news" },
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
    bears_on: [{ id: CLAIM_ID, text: 'Inflation in 2022 was "transitory".', kind: "claim" }],
    bears_on_sources: [{ id: SRC_ID, title: "A skeptical column", url: "https://example.com/column" }],
    bears_on_text: null,
    filed_by: { kind: "mandate", label: "a funded mandate" },
    keeper: { kind: "steward", label: "the claim's Steward" },
    state: "open",
    state_note: null,
    filed_at: new Date("2026-10-01T00:00:00.000Z"),
    work: [],
    ...overrides,
  };
}

function input(overrides: Partial<MiraInput> = {}): MiraInput {
  return { record: record(), question: null, answers_questions: [], requests: [], ...overrides };
}

describe("buildMiraBundle: a claim", () => {
  it("validates against the pinned profile schema", () => {
    expectValid(buildMiraBundle(input({ requests: [request()] }), opts));
  });

  it("puts the root first and names each record once", () => {
    const bundle = buildMiraBundle(input(), opts);
    expect(bundle.root).toBe(uri(CLAIM_ID));
    expect(bundle.records[0]).toMatchObject({ id: uri(CLAIM_ID), type: "claim" });
    const ids = bundle.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // One source record, though two instances cite it.
    expect(bundle.records.filter((r) => r.type === "source")).toHaveLength(1);
    expect(bundle.license).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
  });

  it("omits credence where the graph omits it (§10), and states it where it is stated", () => {
    const without = buildMiraBundle(input(), opts);
    expect(without.records[0]!.extensions!.mv).not.toHaveProperty("credence");

    const r = record();
    r.assessment!.claim_credence = 0.62;
    const withIt = buildMiraBundle(input({ record: r }), opts);
    expect(withIt.records[0]!.extensions!.mv.credence).toBe(0.62);
  });

  it("resolves [[claim:...]] machinery in every piece of prose (§12)", () => {
    const json = JSON.stringify(buildMiraBundle(input({ requests: [request()] }), opts));
    expect(json).not.toContain("[[claim:");
    const mv = buildMiraBundle(input(), opts).records[0]!.extensions!.mv;
    expect(mv.summary).toBe("The dispute turns on Supply chains drove the 2022 price rise..");
    expect(mv.reasoning_trace).toBe("Weighed the supply-chain premise against the data.");
  });

  it("maps decomposition edges to links once each, degrading unknown relations", () => {
    const root = buildMiraBundle(input(), opts).records[0] as { links: { rel: string; target: string }[] };
    expect(root.links).toEqual([
      { rel: "requires", target: uri(SUB_ID) },
      { rel: "related_to", target: uri(SUB2_ID) },
    ]);
  });

  it("keeps arguments under the extension and exports decisiveness only once evaluated", () => {
    const args = buildMiraBundle(input(), opts).records[0]!.extensions!.mv.arguments as Record<string, unknown>[];
    expect(args[0]).toMatchObject({ name: "The supply-chain argument", verdict: "likely", decisive: false });
    expect(args[1]).not.toHaveProperty("decisive");
    expect(args[1]).not.toHaveProperty("name");
  });

  it("maps stances to evidence relations", () => {
    const evidence = buildMiraBundle(input(), opts).records.filter((r) => r.type === "evidence");
    expect(evidence.map((e) => (e as { relation: string }).relation)).toEqual(["disputes", "supports"]);
    expect(evidence[0]).toMatchObject({ source: `${WEB}/sources/${SRC_ID}`, context: "From the opening paragraph." });
  });

  it("links a claim to the questions it answers", () => {
    const bundle = buildMiraBundle(
      input({ answers_questions: [{ id: Q_ID, text: "What drove 2022 inflation?", standing: "leaning" }] }),
      opts
    );
    expectValid(bundle);
    expect((bundle.records[0] as { links: unknown[] }).links).toContainEqual({ rel: "answers", target: uri(Q_ID) });
    expect(bundle.records.find((r) => r.id === uri(Q_ID))).toMatchObject({
      type: "question",
      extensions: { mv: { stub: true, standing: "leaning" } },
    });
  });

  it("attributes a mandate's request without naming a party (§12/§19)", () => {
    const bundle = buildMiraBundle(input({ requests: [request()] }), opts);
    const req = bundle.records.find((r) => r.type === "request")!;
    expect(req.attribution[0]).toEqual({
      name: "a funded mandate",
      kind: "mandate",
      role: "filer",
      at: "2026-10-01T00:00:00.000Z",
    });
    expect(req).toMatchObject({
      bears_on: [uri(CLAIM_ID), `${WEB}/sources/${SRC_ID}`],
      ask: "The full text of the source behind Supply chains drove the 2022 price rise..",
    });
  });

  it("is held to the schema: an unmapped field or relation fails it", () => {
    const bundle = JSON.parse(JSON.stringify(buildMiraBundle(input(), opts)));
    bundle.records.find((r: { type: string }) => r.type === "evidence").relation = "affirms";
    expect(validate(bundle)).toBe(false);
    const extra = JSON.parse(JSON.stringify(buildMiraBundle(input(), opts)));
    extra.records[0].importance = 0.8;
    expect(validate(extra)).toBe(false);
  });

  it("validates an unassessed claim with no evidence", () => {
    expectValid(
      buildMiraBundle(input({ record: record({ assessment: null, arguments: [], instances: [] }) }), opts)
    );
  });
});

describe("buildMiraBundle: a question", () => {
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
      ],
    };
  }

  function questionInput(): MiraInput {
    return input({
      record: record({
        claim: { ...record().claim, id: Q_ID, kind: "question", text: "What drove 2022 inflation?" },
        assessment: null,
        arguments: [],
        instances: [
          {
            id: "eeeeeeee-3333-3333-4444-555555555555",
            quote: "Supply shocks did it.",
            context: null,
            stance: "answers",
            source: { id: SRC_ID, title: "A paper", url: null, source_type: "paper" },
          },
        ],
      }),
      question: question(),
    });
  }

  it("validates against the pinned profile schema", () => {
    expectValid(buildMiraBundle(questionInput(), opts));
  });

  it("exports the root as a question linked to its answers and presuppositions", () => {
    const bundle = buildMiraBundle(questionInput(), opts);
    const root = bundle.records[0] as { type: string; links: unknown[]; extensions: { mv: Record<string, unknown> } };
    expect(root.type).toBe("question");
    expect(root.links).toEqual([
      { rel: "answered_by", target: uri(ANS_ID) },
      { rel: "answered_by", target: uri(ANS2_ID) },
      { rel: "presupposes", target: uri(SUB_ID) },
    ]);
    expect(root.extensions.mv).toMatchObject({
      standing: "leaning",
      favored_answers: [uri(ANS_ID)],
      summary: "Leaning toward Supply shocks..",
    });
    expect(root.extensions.mv).not.toHaveProperty("status");
  });

  it("carries answer relations both ways and credence only where stated", () => {
    const bundle = buildMiraBundle(questionInput(), opts);
    const ans = bundle.records.find((r) => r.id === uri(ANS_ID)) as { links: unknown[]; extensions: { mv: Record<string, unknown> } };
    const ans2 = bundle.records.find((r) => r.id === uri(ANS2_ID)) as { links: unknown[]; extensions: { mv: Record<string, unknown> } };
    expect(ans.links).toEqual([
      { rel: "answers", target: uri(Q_ID) },
      { rel: "compatible_with", target: uri(ANS2_ID) },
    ]);
    expect(ans2.links).toContainEqual({ rel: "compatible_with", target: uri(ANS_ID) });
    expect(ans.extensions.mv.credence).toBe(0.7);
    expect(ans2.extensions.mv).not.toHaveProperty("credence");
  });

  it("names the matched answer on an answering instance", () => {
    const ev = buildMiraBundle(questionInput(), opts).records.find((r) => r.type === "evidence");
    expect(ev).toMatchObject({ relation: "answers", target: uri(Q_ID), answer: uri(ANS_ID) });
  });
});
