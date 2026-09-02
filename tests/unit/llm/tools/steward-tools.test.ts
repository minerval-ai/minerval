import { describe, it, expect, vi, beforeEach } from "vitest";

const NEW_CLAIM_ID = "11111111-1111-1111-1111-111111111111";

const { insertedValues, updatedValues } = vi.hoisted(() => ({
  insertedValues: [] as Record<string, unknown>[],
  updatedValues: [] as Record<string, unknown>[],
}));

// Mock the DB so insert(...).values(...).returning() yields a deterministic id,
// and so the relationship insert (no .returning()) is awaitable. Capture every
// inserted row so tests can assert on the claim's steward_state (the #98 gate),
// and every update .set() payload so tests can assert on set_claim_importance.
vi.mock("../../../../src/db/client.js", () => {
  const values = (row: Record<string, unknown>) => {
    insertedValues.push(row);
    const p = Promise.resolve([{ id: NEW_CLAIM_ID }]);
    return Object.assign(p, { returning: () => Promise.resolve([{ id: NEW_CLAIM_ID }]) });
  };
  // Minimal query-builder stubs so update_claim_assessment's select (prev
  // subclaim summary → []) and update chains resolve.
  const select = () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
  const update = () => ({
    set: (row: Record<string, unknown>) => {
      updatedValues.push(row);
      return { where: async () => undefined };
    },
  });
  return {
    getDb: () => ({ insert: () => ({ values }), select, update }),
    rawQuery: vi.fn(async () => []),
  };
});

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
}));

const SOURCE_ID = "44444444-4444-4444-4444-444444444444";

// Found-or-created by URL, never enqueueing extraction — the tool must reuse
// the intake-review-safe path (getOrCreateSource), not submitSource.
vi.mock("../../../../src/services/source-service.js", () => ({
  getOrCreateSource: vi.fn(async (input: { url: string; title?: string }) => ({
    id: SOURCE_ID,
    url: input.url,
    title: input.title ?? input.url,
  })),
}));

import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";
import {
  enqueueClaimPipeline,
  enqueueSteward,
} from "../../../../src/services/queue-service.js";
import { rawQuery } from "../../../../src/db/client.js";

describe("steward add_decomposition_edge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
  });

  it("enqueues the newly created subclaim for the claim pipeline (not orphaned)", async () => {
    const parentId = "22222222-2222-2222-2222-222222222222";
    const out = await executeStewardTool("add_decomposition_edge", {
      parent_id: parentId,
      child_text: "Subclaim added by the steward",
      relation: "requires",
      reasoning: "needed dependency",
    });

    expect(JSON.parse(out).success).toBe(true);

    // Every minted claim is stamped with the current pipeline epoch, so cohorts
    // from before a prompt-era change stay identifiable (and archivable).
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.pipelineEpoch).toBeTruthy();

    // The regression this guards: the created claim must be enqueued (onboarded)
    // so its Steward structures/assesses it instead of it sitting `pending`
    // forever. Recursion no longer threads depth/ancestors — the child's Steward
    // calls match_claim before creating anything, so it links existing ancestors
    // rather than looping into them.
    expect(enqueueClaimPipeline).toHaveBeenCalledTimes(1);
    expect(enqueueClaimPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: NEW_CLAIM_ID,
        jobId: "steward",
      })
    );
  });

  it("does NOT enqueue a low-importance subclaim — leaves it an embedded stub (#98)", async () => {
    // A subclaim the Steward judged uncontested/peripheral (below the default
    // 0.25 threshold) is created but not recursively decomposed — the economic
    // brake against over-decomposing settled bedrock.
    const out = await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "In a field of characteristic != 2, the element 2 is invertible",
      relation: "assumes",
      reasoning: "settled algebra, uncontested",
      importance: 0.1,
    });

    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.child_claim_id).toBe(NEW_CLAIM_ID); // still created + embedded
    expect(enqueueClaimPipeline).not.toHaveBeenCalled(); // but not decomposed
    // Must be created 'deferred' — a claim left at the default 'pending' would be
    // picked up by the importance-ordered drain regardless of the missing enqueue.
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.stewardState).toBe("deferred");
  });

  it("still enqueues a clearly important subclaim as a normal pending claim", async () => {
    await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "SARS-CoV-2 most likely had a zoonotic origin",
      relation: "supports",
      reasoning: "live contested crux",
      importance: 0.7,
    });
    expect(enqueueClaimPipeline).toHaveBeenCalledTimes(1);
    // Not gated → left at the default steward_state (drain picks it up).
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.stewardState).toBeUndefined();
  });

  it("records contestation on the new subclaim without it affecting the gate (#172 phase 1)", async () => {
    // High contestation, importance below the deferral threshold: the gate must
    // still read only importance (phase 1 records, never acts), so the subclaim
    // defers even though the dispute is live.
    await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "A hotly argued but peripheral aside",
      relation: "supports",
      reasoning: "contested but peripheral",
      importance: 0.1,
      contestation: 0.9,
    });
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.contestation).toBe(0.9);
    expect(claimRow?.stewardState).toBe("deferred");
    expect(enqueueClaimPipeline).not.toHaveBeenCalled();
  });

  it("leaves contestation unset (NULL = not judged) when omitted", async () => {
    await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "Subclaim without a contestation judgment",
      relation: "requires",
      reasoning: "needed dependency",
    });
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow).not.toHaveProperty("contestation");
  });

  it("stores the seed prior on the claim row with the parent as its author (#285)", async () => {
    const parentId = "22222222-2222-2222-2222-222222222222";
    const out = await executeStewardTool("add_decomposition_edge", {
      parent_id: parentId,
      child_text: "Atmospheric CO2 concentration has risen since 1850",
      relation: "requires",
      reasoning: "load-bearing premise",
      seed_credence: 0.97,
      seed_note: "Directly measured at Mauna Loa since 1958 and via ice cores before.",
    });
    expect(JSON.parse(out).success).toBe(true);
    const claimRow = insertedValues.find((r) => "text" in r);
    // On the CLAIMS row — never an assessments row, so no is_current query,
    // history, or trajectory read can ever surface the seed as an assessment.
    expect(claimRow).toMatchObject({
      seedCredence: 0.97,
      seedNote: "Directly measured at Mauna Loa since 1958 and via ice cores before.",
      seedSourceClaimId: parentId,
    });
    expect(insertedValues.find((r) => "status" in r)).toBeUndefined();
  });

  it("clamps the seed credence into [0, 1] like every unit-interval input", async () => {
    await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "A subclaim with an out-of-range prior",
      relation: "supports",
      reasoning: "supporting evidence",
      seed_credence: 1.4,
    });
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow?.seedCredence).toBe(1);
    expect(claimRow?.seedSourceClaimId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("leaves all seed columns unset when no seed is given (extraction parity)", async () => {
    await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "Subclaim minted without a prior",
      relation: "requires",
      reasoning: "needed dependency",
    });
    const claimRow = insertedValues.find((r) => "text" in r);
    expect(claimRow).not.toHaveProperty("seedCredence");
    expect(claimRow).not.toHaveProperty("seedNote");
    expect(claimRow).not.toHaveProperty("seedSourceClaimId");
  });

  it("bounces a seed note long enough to be a full assessment", async () => {
    const out = await executeStewardTool("add_decomposition_edge", {
      parent_id: "22222222-2222-2222-2222-222222222222",
      child_text: "A subclaim whose seed note overreaches",
      relation: "requires",
      reasoning: "needed dependency",
      seed_credence: 0.8,
      seed_note: "x".repeat(2100),
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toMatch(/its own Steward/);
    // Nothing was written: the steward re-calls with a briefer note.
    expect(insertedValues.find((r) => "text" in r)).toBeUndefined();
  });
});

describe("steward record_claim_instance", () => {
  const CLAIM = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
  });

  /** Existence check passes; dedup check falls through to the default [] mock. */
  const claimExists = () =>
    vi.mocked(rawQuery).mockResolvedValueOnce([{ id: CLAIM }]);

  it("records a steward-encountered instance with provenance and metadata (#278)", async () => {
    claimExists();
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      url: "https://example.org/interview",
      title: "Interview transcript",
      original_text: "The vaccine rollout, she said, plainly reduced mortality.",
      context: "A retrospective on the 2021 rollout.",
      stance: "affirms",
      speaker: "Jane Doe",
      publication: "The Example Times",
      source_date: "2023-05",
      link: "https://example.org/interview#t=1204",
      confidence: 0.9,
    });

    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.instance_id).toBeTruthy();

    const row = insertedValues.find((r) => "originalText" in r);
    expect(row).toMatchObject({
      claimId: CLAIM,
      sourceId: SOURCE_ID,
      originalText: "The vaccine rollout, she said, plainly reduced mortality.",
      context: "A retrospective on the 2021 rollout.",
      stance: "affirms",
      confidence: 0.9,
      speaker: "Jane Doe",
      publication: "The Example Times",
      sourceDate: "2023-05",
      link: "https://example.org/interview#t=1204",
      // Distinguishes steward sightings from ingest-time extraction rows.
      createdBy: "claim_steward",
    });
  });

  it("normalizes a prose-cased stance and defaults confidence to 1", async () => {
    claimExists();
    await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      url: "https://example.org/oped",
      original_text: "This is simply not true.",
      stance: "DENIES",
    });
    const row = insertedValues.find((r) => "originalText" in r);
    expect(row?.stance).toBe("denies");
    expect(row?.confidence).toBe(1.0);
    // Metadata the steward didn't see stays unset (NULL), never guessed.
    expect(row?.speaker).toBeUndefined();
    expect(row?.sourceDate).toBeUndefined();
  });

  it("dedups on (claim, source) so re-assessments don't pile up duplicates", async () => {
    claimExists();
    // The dedup query finds an existing instance for this pair.
    vi.mocked(rawQuery).mockResolvedValueOnce([
      { id: "55555555-5555-5555-5555-555555555555", stance: "affirms" },
    ]);
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      url: "https://example.org/interview",
      original_text: "Restating the same claim on a re-read.",
      stance: "affirms",
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.deduplicated).toBe(true);
    expect(parsed.instance_id).toBe("55555555-5555-5555-5555-555555555555");
    expect(insertedValues.find((r) => "originalText" in r)).toBeUndefined();
  });

  it("flags a stance conflict with the already-recorded instance instead of writing", async () => {
    claimExists();
    vi.mocked(rawQuery).mockResolvedValueOnce([
      { id: "55555555-5555-5555-5555-555555555555", stance: "affirms" },
    ]);
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      url: "https://example.org/interview",
      original_text: "Actually the source denies it here.",
      stance: "denies",
    });
    const parsed = JSON.parse(out);
    expect(parsed.deduplicated).toBe(true);
    expect(parsed.message).toMatch(/stance differs/);
    expect(insertedValues.find((r) => "originalText" in r)).toBeUndefined();
  });

  it("bounces an out-of-enum stance without writing anything", async () => {
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      url: "https://example.org/a",
      original_text: "Some passage.",
      stance: "mentions",
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toMatch(/affirms/);
    expect(insertedValues).toHaveLength(0);
  });

  it("requires an http(s) url — an instance without provenance is not recordable", async () => {
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      original_text: "Some passage.",
      stance: "affirms",
    });
    expect(JSON.parse(out).success).toBe(false);
    expect(insertedValues).toHaveLength(0);
  });

  it("bounces a hallucinated claim id with a readable message (not an FK error)", async () => {
    // The existence check finds nothing (default rawQuery mock returns []).
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: "99999999-9999-9999-9999-999999999999",
      url: "https://example.org/a",
      original_text: "Some passage.",
      stance: "affirms",
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toMatch(/not found/i);
    expect(insertedValues).toHaveLength(0);
  });

  it("bounces a document-sized original_text (record the passage, not the page)", async () => {
    const out = await executeStewardTool("record_claim_instance", {
      claim_id: CLAIM,
      url: "https://example.org/a",
      original_text: "x".repeat(2100),
      stance: "affirms",
    });
    expect(JSON.parse(out).success).toBe(false);
    expect(insertedValues).toHaveLength(0);
  });
});

describe("steward log_stewardship_decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
  });

  it("persists a durable audit_log row (not just a bumped timestamp)", async () => {
    // The regression this guards (#100): the tool used to only touch
    // claims.updated_at, so the audit trail the constitution promises
    // ("Log All Changes") never actually existed.
    const out = await executeStewardTool("log_stewardship_decision", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      action_taken: "reassessed",
      reasoning: "Two new credible denying instances; moved SUPPORTED -> CONTESTED.",
    });

    expect(JSON.parse(out).success).toBe(true);
    const row = insertedValues.find((r) => "action" in r);
    expect(row).toMatchObject({
      claimId: "22222222-2222-2222-2222-222222222222",
      action: "reassessed",
      reasoning: "Two new credible denying instances; moved SUPPORTED -> CONTESTED.",
      createdBy: "claim_steward",
    });
  });
});

describe("steward notify_dependent_stewards", () => {
  const CLAIM = "33333333-3333-3333-3333-333333333333";
  const PARENT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const PARENT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifies every dependent when parent_ids is omitted", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([
      { parent_id: PARENT_A },
      { parent_id: PARENT_B },
    ]);
    const out = await executeStewardTool("notify_dependent_stewards", {
      claim_id: CLAIM,
      change_summary: "moved SUPPORTED -> CONTESTED",
    });
    expect(enqueueSteward).toHaveBeenCalledTimes(2);
    expect(JSON.parse(out).parent_claim_ids).toEqual([PARENT_A, PARENT_B]);
  });

  it("restricts the fan-out to parent_ids when the steward triages (#182)", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([
      { parent_id: PARENT_A },
      { parent_id: PARENT_B },
    ]);
    const out = await executeStewardTool("notify_dependent_stewards", {
      claim_id: CLAIM,
      change_summary: "confidence nudged within CONTESTED",
      parent_ids: [PARENT_A],
    });
    expect(enqueueSteward).toHaveBeenCalledTimes(1);
    expect(enqueueSteward).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: PARENT_A, trigger: "subclaim_change" })
    );
    expect(JSON.parse(out).parent_claim_ids).toEqual([PARENT_A]);
  });

  it("never enqueues an id that is not actually a dependent; reports it instead", async () => {
    // A hallucinated/stale parent_id must not trigger an unrelated claim's
    // Steward; the tool result names the dropped ids so the model can correct.
    vi.mocked(rawQuery).mockResolvedValueOnce([{ parent_id: PARENT_A }]);
    const out = await executeStewardTool("notify_dependent_stewards", {
      claim_id: CLAIM,
      change_summary: "s",
      parent_ids: [PARENT_A, PARENT_B],
    });
    expect(enqueueSteward).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(out);
    expect(parsed.parent_claim_ids).toEqual([PARENT_A]);
    expect(parsed.skipped_not_dependents).toEqual([PARENT_B]);
  });
});

describe("steward update_claim_assessment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
  });

  it("persists the reader-facing assessment distinctly from the reasoning trace", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "contested",
      confidence: 0.6,
      assessment: "The origin of SARS-CoV-2 remains genuinely disputed among experts.",
      reasoning_trace: "Instances split 1 affirm / 2 deny; market-origin and lab-leak both credible.",
    });
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.summary).toBe("The origin of SARS-CoV-2 remains genuinely disputed among experts.");
    expect(row?.reasoningTrace).toBe("Instances split 1 affirm / 2 deny; market-origin and lab-leak both credible.");
  });

  it("still accepts the legacy `summary` key from an in-flight older-prompt call", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "supported",
      confidence: 0.7,
      summary: "Legacy key still lands in the assessment column.",
      reasoning_trace: "Trace.",
    });
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.summary).toBe("Legacy key still lands in the assessment column.");
  });

  it("lowercase-normalizes the status so a prompt-cased VERIFIED can't leave the enum", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "VERIFIED",
      confidence: 0.9,
      assessment: "Well established.",
      reasoning_trace: "Traces to primary sources.",
    });
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.status).toBe("verified");
  });

  it("records the run's actual trigger and context on the assessment row (#182)", async () => {
    await executeStewardTool(
      "update_claim_assessment",
      {
        claim_id: "22222222-2222-2222-2222-222222222222",
        status: "contested",
        confidence: 0.5,
        assessment: "Now contested.",
        reasoning_trace: "A depended-on subclaim flipped.",
      },
      {
        trigger: "subclaim_change",
        context: "[subclaim_change] Subclaim X changed: moved to REFUTED",
      }
    );
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    // The regression this guards: every steward write stamped the generic
    // "steward_reassessment", so the cause of a re-assessment was
    // unrecoverable from the row.
    expect(row?.trigger).toBe("subclaim_change");
    expect(row?.triggerContext).toBe(
      "[subclaim_change] Subclaim X changed: moved to REFUTED"
    );
  });

  it("records the run's model on the assessment row (#294)", async () => {
    await executeStewardTool(
      "update_claim_assessment",
      {
        claim_id: "22222222-2222-2222-2222-222222222222",
        status: "supported",
        confidence: 0.7,
        assessment: "Supported.",
        reasoning_trace: "Trace.",
      },
      { trigger: "structure_and_assess", model: "claude-fable-5-1" }
    );
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    // Every verdict names its assessor: the model id the run resolved to.
    expect(row?.model).toBe("claude-fable-5-1");
  });

  it("writes a null model when the run doesn't carry one (legacy call sites)", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "supported",
      confidence: 0.7,
      assessment: "Fine.",
      reasoning_trace: "Trace.",
    });
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.model).toBeNull();
  });

  it("still stamps steward_reassessment when no run info is threaded", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "supported",
      confidence: 0.7,
      assessment: "Fine.",
      reasoning_trace: "Trace.",
    });
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.trigger).toBe("steward_reassessment");
    expect(row?.triggerContext).toBeNull();
  });

  it("falls back to the reasoning trace when the assessment is omitted (never writes blank)", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "verified",
      confidence: 0.9,
      reasoning_trace: "Traces to primary sources; no credible challenge.",
    });
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.summary).toBe("Traces to primary sources; no credible challenge.");
  });

  it("persists marginal_yield on the assessment, and null when not stated (#172 phase 1)", async () => {
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "verified",
      confidence: 0.95,
      assessment: "Settled; traces to primary sources.",
      reasoning_trace: "Uncontested fact, now assessed.",
      marginal_yield: 0.05,
    });
    let row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.marginalYield).toBe(0.05);

    insertedValues.length = 0;
    await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "supported",
      confidence: 0.7,
      assessment: "Supported.",
      reasoning_trace: "No yield judgment stated.",
    });
    row = insertedValues.find((r) => "reasoningTrace" in r);
    // null, not 0: "not stated" must stay distinct from "judged zero-yield".
    expect(row?.marginalYield).toBeNull();
  });

  it("bounces a [[claim:<uuid>]] link to a claim that does not exist (#203)", async () => {
    const ghost = "99999999-9999-9999-9999-999999999999";
    // The existence check finds nothing (default rawQuery mock returns []).
    const out = await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "supported",
      confidence: 0.7,
      assessment: `Rests on [[claim:${ghost}|a hallucinated subclaim]].`,
      reasoning_trace: "Trace.",
    });
    const parsed = JSON.parse(out);
    // A dead link would sit in front of every reader; the write must not land.
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain(ghost);
    expect(insertedValues.find((r) => "reasoningTrace" in r)).toBeUndefined();
  });

  it("persists assessment prose whose [[claim:<uuid>]] links all exist (#203)", async () => {
    const linked = "33333333-3333-3333-3333-333333333333";
    vi.mocked(rawQuery).mockResolvedValueOnce([{ id: linked }]);
    const out = await executeStewardTool("update_claim_assessment", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      status: "supported",
      confidence: 0.7,
      assessment: `Rests on [[claim:${linked}|the measured figure]].`,
      reasoning_trace: `The trace also cites [[claim:${linked}]].`,
    });
    expect(JSON.parse(out).success).toBe(true);
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    // Link markup is stored verbatim; renderers resolve it at display time.
    expect(row?.summary).toBe(`Rests on [[claim:${linked}|the measured figure]].`);
  });
});

describe("steward set_claim_importance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    updatedValues.length = 0;
  });

  it("records contestation alongside importance when stated (#172 phase 1)", async () => {
    const out = await executeStewardTool("set_claim_importance", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      importance: 0.6,
      contestation: 0.8,
      reasoning: "Consequential and actively argued.",
    });
    expect(JSON.parse(out).success).toBe(true);
    const row = updatedValues.find((r) => "importance" in r);
    expect(row?.importance).toBe(0.6);
    expect(row?.contestation).toBe(0.8);
  });

  it("leaves the stored contestation untouched when omitted (no reset to unjudged)", async () => {
    await executeStewardTool("set_claim_importance", {
      claim_id: "22222222-2222-2222-2222-222222222222",
      importance: 0.4,
      reasoning: "Notable.",
    });
    const row = updatedValues.find((r) => "importance" in r);
    expect(row).not.toHaveProperty("contestation");
  });
});
