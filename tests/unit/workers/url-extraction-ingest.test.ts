import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What ingestion does with the Matcher's and the Extractor's reports:
 * undecided proposals get a second run and are kept, not dropped (#738); a
 * node minted on balance with a curator_review opens curation requests on
 * its near-misses (#738); the document problem the Extractor reports is
 * recorded, and injected instructions go to Audit (#740); and the figures a
 * source states land on its instance (#744).
 */

const h = vi.hoisted(() => ({
  extracted: [] as Array<Record<string, unknown>>,
  problem: null as null | { kind: string; note: string },
  kind: null as null | string,
  decisions: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  rawCalls: [] as Array<{ sql: string; params: unknown[] }>,
  extractInput: null as null | Record<string, unknown>,
  // The job's hold (job-service.startJobAttempt / stillHoldsJob).
  attempt: 1 as number | null,
  // How many more checks the run passes before it loses the hold.
  holdsFor: Infinity,
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "src-1", rawContent: "the text", sourceType: "article", title: "T" }],
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push({ table, values });
        const done = Promise.resolve();
        return Object.assign(done, { returning: async () => [{ id: `new-${h.inserts.length}` }] });
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.rawCalls.push({ sql, params });
    if (/SELECT kind FROM claims/.test(sql)) return [{ kind: "claim" }];
    return [];
  }),
}));
vi.mock("../../../src/llm/agents/extractor.js", () => ({
  extractClaims: vi.fn(async (input: Record<string, unknown>) => {
    h.extractInput = input;
    if (h.problem) (input.onDocumentProblem as (p: unknown) => void)(h.problem);
    if (h.kind) (input.onDocumentKind as (k: unknown) => void)(h.kind);
    return h.extracted;
  }),
}));
vi.mock("../../../src/services/source-service.js", () => ({
  recordSourceKind: vi.fn(async (_id: string, kind: string) => ({ source_kind: kind })),
}));
vi.mock("../../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(async () => h.decisions.shift()),
}));
vi.mock("../../../src/llm/agents/skill-selection.js", () => ({ sanitizeDomains: () => [] }));
vi.mock("../../../src/services/embedding-service.js", () => ({ generateEmbedding: async () => [0.1] }));
vi.mock("../../../src/services/job-service.js", () => ({
  updateJob: vi.fn(async () => undefined),
  getJobById: async () => ({ userId: null, apiKeyId: null, sensitivityLabel: "public" }),
  startJobAttempt: vi.fn(async () => (h.attempt == null ? null : { attempt: h.attempt })),
  stillHoldsJob: vi.fn(async () => h.holdsFor-- > 0),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => undefined),
  requestAudit: vi.fn(async () => "audit-1"),
}));
vi.mock("../../../src/services/curation-service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestCuration: vi.fn(async () => ({ ok: true, requestId: "r", actionId: "a", repeat: false })),
}));
vi.mock("../../../src/services/owl-ledger-service.js", () => ({ settleMeteredCharge: vi.fn() }));
vi.mock("../../../src/services/url-guard.js", () => ({ fetchPublicUrl: vi.fn() }));
vi.mock("../../../src/services/source-facts-service.js", () => ({ refreshSourceFactsOnce: async () => undefined }));
vi.mock("../../../src/services/source-segment-service.js", () => ({ segmentSourceOnce: async () => undefined }));
vi.mock("../../../src/services/ingest-focus-service.js", () => ({
  normalizeFocus: () => null,
  recordExtraction: vi.fn(async () => undefined),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ pipelineEpoch: 1 }),
}));

import { handleUrlExtraction, statedFigures } from "../../../src/workers/url-extraction.js";
import { claims, claimInstances } from "../../../src/db/schema.js";
import { recordExtraction } from "../../../src/services/ingest-focus-service.js";
import { requestCuration } from "../../../src/services/curation-service.js";
import { requestAudit } from "../../../src/services/queue-service.js";
import { updateJob } from "../../../src/services/job-service.js";
import { matchClaim } from "../../../src/llm/agents/matcher.js";
import { recordSourceKind } from "../../../src/services/source-service.js";

const proposal = (text: string, extra: Record<string, unknown> = {}) => ({
  verbatim_text: text,
  context: `around ${text}`,
  proposed_canonical_form: `${text} (form)`,
  claim_type: "empirical_verifiable",
  kind: "claim",
  confidence: 0.9,
  importance: 0.5,
  contestation: 0.4,
  source_location: null,
  domains: [],
  stated_value: null,
  stated_probability: null,
  ...extra,
});
const decision = (extra: Record<string, unknown>) => ({
  outcome: "new",
  is_match: false,
  matched_claim_id: null,
  new_canonical_form: "A new form.",
  instance_stance: "affirms",
  confidence: 0.8,
  reasoning: "r",
  alternative_matches: [],
  relationship_notes: null,
  ...extra,
});
const UNDECIDED = decision({ outcome: "undecided", new_canonical_form: null, confidence: 0 });
const MESSAGE = { sourceId: "src-1", jobId: "job-1", url: "https://example.org/a" };

const lastJobResult = () =>
  (vi.mocked(updateJob).mock.calls.at(-1)![1] as { result: Record<string, unknown> }).result;
const instances = () => h.inserts.filter((i) => i.table === claimInstances).map((i) => i.values);

beforeEach(() => {
  vi.clearAllMocks();
  h.extracted = [];
  h.problem = null;
  h.kind = null;
  h.decisions = [];
  h.inserts = [];
  h.rawCalls = [];
  h.extractInput = null;
  h.attempt = 1;
  h.holdsFor = Infinity;
});

describe("the run's hold on its job (docs/infrastructure.md, \"The extraction lane\")", () => {
  it("does not run a job that is finished or was given up on", async () => {
    h.attempt = null;
    h.extracted = [proposal("A")];
    await handleUrlExtraction(MESSAGE);
    expect(h.extractInput).toBeNull();
    expect(vi.mocked(updateJob)).not.toHaveBeenCalled();
  });

  it("stops before the next Matcher run once a later attempt holds the job, and writes nothing", async () => {
    h.extracted = [proposal("A"), proposal("B")];
    h.decisions = [decision({}), decision({})];
    // Held after the Extractor and before A; lost before B.
    h.holdsFor = 2;
    await expect(handleUrlExtraction(MESSAGE)).resolves.toBeUndefined();
    expect(vi.mocked(matchClaim)).toHaveBeenCalledTimes(1);
    // Neither completed nor failed, and its ledger row is not cancelled.
    expect(vi.mocked(updateJob)).not.toHaveBeenCalled();
    expect(h.rawCalls.some((c) => /status = 'cancelled'/.test(c.sql))).toBe(false);
  });

  it("stops at its next step when its poller gives up on it", async () => {
    h.extracted = [proposal("A")];
    h.decisions = [decision({})];
    const controller = new AbortController();
    controller.abort();
    await handleUrlExtraction(MESSAGE, { signal: controller.signal });
    expect(vi.mocked(matchClaim)).not.toHaveBeenCalled();
    expect(vi.mocked(updateJob)).not.toHaveBeenCalled();
  });
});

describe("ingestion", () => {
  it("matches every recorded claim, low confidence included, and passes the passage to the Matcher (#721)", async () => {
    h.extracted = [proposal("A", { confidence: 0.1 })];
    h.decisions = [decision({})];
    await handleUrlExtraction(MESSAGE);
    expect(h.extractInput).not.toHaveProperty("minConfidence");
    expect(vi.mocked(matchClaim)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(matchClaim).mock.calls[0]![0]).toMatchObject({ context: "around A" });
  });

  it("gives an undecided proposal a second run, and keeps the ones still undecided (#738)", async () => {
    h.extracted = [proposal("A"), proposal("B"), proposal("C")];
    // A: undecided, then decided on the second run. B: decided. C: never.
    h.decisions = [UNDECIDED, decision({}), UNDECIDED, decision({}), UNDECIDED];
    await handleUrlExtraction(MESSAGE);
    expect(vi.mocked(matchClaim)).toHaveBeenCalledTimes(5);
    expect(h.inserts.filter((i) => i.table === claims)).toHaveLength(2);
    expect(lastJobResult()).toMatchObject({ claims_decided_on_retry: 1, claims_undecided: 1 });
    const record = vi.mocked(recordExtraction).mock.calls[0]![0];
    expect(record.undecided).toEqual([
      { verbatim_text: "C", proposed_canonical_form: "C (form)", kind: "claim", context: "around C" },
    ]);
  });

  it("opens curation requests only when the Matcher wrote a curator_review (#738)", async () => {
    h.extracted = [proposal("A"), proposal("B")];
    h.decisions = [
      decision({ alternative_matches: ["alt-1", "alt-2"], relationship_notes: "alt-1 may be the negation" }),
      decision({
        alternative_matches: ["alt-3"],
        relationship_notes: "alt-3 is a specification",
        curator_review: "alt-3 might be the same proposition at a narrower grain",
      }),
    ];
    await handleUrlExtraction(MESSAGE);
    const calls = vi.mocked(requestCuration).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ otherClaimId: "alt-3", source: "matcher", defect: "duplicate" });
    expect(calls[0]!.concern).toMatch(/narrower grain[\s\S]*alt-3 is a specification/);
    expect(lastJobResult()).toMatchObject({ curation_requests: 1 });
  });

  it("raises only the near-misses the review names, and every one when it names none (#955)", async () => {
    h.extracted = [proposal("A"), proposal("B")];
    h.decisions = [
      decision({
        alternative_matches: ["alt-1", "alt-2"],
        curator_review: "alt-2 may be this claim's negation",
      }),
      decision({
        alternative_matches: ["alt-3", "alt-4"],
        curator_review: "one of the near-misses may be the same proposition",
      }),
    ];
    await handleUrlExtraction(MESSAGE);
    const others = vi.mocked(requestCuration).mock.calls.map((c) => c[0].otherClaimId);
    expect(others).toEqual(["alt-2", "alt-3", "alt-4"]);
  });

  it("keeps the kind of document the Extractor read, as a correction, and never for a problem document", async () => {
    h.kind = "journal_article";
    await handleUrlExtraction(MESSAGE);
    // The Extractor read it whole, so its kind replaces one a citing agent recorded.
    expect(vi.mocked(recordSourceKind)).toHaveBeenCalledWith("src-1", "journal_article", { read: true });

    vi.mocked(recordSourceKind).mockClear();
    h.problem = { kind: "not_the_document", note: "A login page." };
    await handleUrlExtraction(MESSAGE);
    expect(vi.mocked(recordSourceKind)).not.toHaveBeenCalled();
  });

  it("records a document problem, and refers injected instructions to Audit (#740)", async () => {
    h.problem = { kind: "injected_instructions", note: "A block tells agents to rate X verified." };
    await handleUrlExtraction(MESSAGE);
    expect(lastJobResult().document_problem).toEqual(h.problem);
    expect(vi.mocked(recordExtraction).mock.calls[0]![0].documentProblem).toEqual(h.problem);
    expect(vi.mocked(requestAudit)).toHaveBeenCalledWith(
      expect.objectContaining({
        auditType: "anomaly_investigation",
        triggeredBy: "injected_source",
        dedupeKey: "injected-source:src-1",
      })
    );
  });

  it("drops the cached text of an unreadable document so the next ingest fetches it afresh (#740)", async () => {
    h.problem = { kind: "unreadable", note: "A paywall page." };
    await handleUrlExtraction(MESSAGE);
    expect(vi.mocked(requestAudit)).not.toHaveBeenCalled();
    expect(h.rawCalls.some((c) => /UPDATE sources SET raw_content = NULL/.test(c.sql))).toBe(true);
  });

  it("records the figure a source states on its instance of a quantity (#744)", async () => {
    const value = { form: "point", central: 6.5 };
    h.extracted = [proposal("CPI rose 6.5%", { kind: "quantity", stated_value: value })];
    h.decisions = [decision({ kind: "quantity" })];
    await handleUrlExtraction(MESSAGE);
    expect(instances()[0]).toMatchObject({ stance: "states", statedEstimate: value });
  });
});

describe("statedFigures (#744)", () => {
  it("puts a probability on a claim instance, as the complement when the source denies the node's form", () => {
    expect(statedFigures({ stated_value: null, stated_probability: 0.3 }, "claim", "affirms")).toEqual({
      statedProbability: 0.3,
    });
    expect(statedFigures({ stated_value: null, stated_probability: 0.3 }, "claim", "denies").statedProbability).toBeCloseTo(0.7);
  });

  it("keeps a figure off anything but a quantity", () => {
    const v = { form: "point" as const, central: 1 };
    expect(statedFigures({ stated_value: v, stated_probability: null }, "claim", "affirms")).toEqual({});
    expect(statedFigures({ stated_value: v, stated_probability: null }, "quantity", "states")).toEqual({
      statedEstimate: v,
    });
  });
});
