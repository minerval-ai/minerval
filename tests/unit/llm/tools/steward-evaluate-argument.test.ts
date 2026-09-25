import { describe, it, expect, vi, beforeEach } from "vitest";

const ARG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLAIM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SUB_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ASSESSMENT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const { insertedValues } = vi.hoisted(() => ({
  insertedValues: [] as Record<string, unknown>[],
}));

// Minimal query-builder stubs: the current-assessment lookup resolves to a
// deterministic id, updates/inserts are awaitable, and inserted rows are
// captured for assertions.
vi.mock("../../../../src/db/client.js", () => {
  const values = (row: Record<string, unknown>) => {
    insertedValues.push(row);
    const p = Promise.resolve([{ id: ASSESSMENT_ID }]);
    return Object.assign(p, {
      returning: () => Promise.resolve([{ id: ASSESSMENT_ID }]),
    });
  };
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ id: ASSESSMENT_ID }] }),
    }),
  });
  const update = () => ({ set: () => ({ where: async () => undefined }) });
  return {
    getDb: () => ({ insert: () => ({ values }), select, update }),
    rawQuery: vi.fn(async () => []),
  };
});

// Keep the pure helpers (parseClaimLinks, isArgumentVerdict) real; mock only
// the DB-touching functions.
vi.mock("../../../../src/services/argument-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../src/services/argument-service.js")
  >();
  return {
    ...actual,
    getArgument: vi.fn(),
    getArgumentSubclaims: vi.fn(async () => [] as { id: string; text: string }[]),
    setArgumentEvaluation: vi.fn(async () => ({ id: "eval" })),
    getEvaluationStateForClaim: vi.fn(async () => []),
  };
});

// The parent claim's ungrouped basis (#434): linkable from an evaluation.
vi.mock("../../../../src/services/relationship-service.js", () => ({
  insertRelationshipEdge: vi.fn(),
  attachEdgeToArgument: vi.fn(),
  getClaimBasisSubclaims: vi.fn(async () => [] as { id: string; text: string }[]),
}));

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
  enqueueCurator: vi.fn(async () => {}),
}));

import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";
import { getClaimBasisSubclaims } from "../../../../src/services/relationship-service.js";
import {
  getArgument,
  getArgumentSubclaims,
  setArgumentEvaluation,
  getEvaluationStateForClaim,
} from "../../../../src/services/argument-service.js";

const namedArgument = {
  id: ARG_ID,
  claimId: CLAIM_ID,
  name: "Cosmological argument",
  description: "First-cause line",
  stance: "for",
  content: `Because [[claim:${SUB_ID}]], the claim follows.`,
  evidenceUrls: [],
  createdBy: "claim_steward",
  createdAt: new Date(),
};

describe("steward evaluate_argument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    vi.mocked(getArgument).mockResolvedValue(namedArgument as never);
    vi.mocked(getArgumentSubclaims).mockResolvedValue([
      { id: SUB_ID, text: "Everything that begins to exist has a cause" },
    ]);
  });

  it("records the evaluation, stamped with the claim's current assessment", async () => {
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "HOLDS",
      evaluation: `The inference is valid; the argument stands or falls with [[claim:${SUB_ID}]], which remains contested.`,
    });

    expect(JSON.parse(out).success).toBe(true);
    expect(setArgumentEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        argumentId: ARG_ID,
        // Prompt-cased verdicts are normalized, like assessment statuses.
        verdict: "holds",
        assessmentId: ASSESSMENT_ID,
        createdBy: "claim_steward",
      })
    );
  });

  it("accepts a link to one of the claim's ungrouped basis subclaims (#434)", async () => {
    const BASIS_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    vi.mocked(getClaimBasisSubclaims).mockResolvedValueOnce([
      { id: BASIS_ID, text: "Credit can attach to a non-human system" },
    ]);
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "holds",
      evaluation:
        `Granting [[claim:${BASIS_ID}]], the inference goes through and rests ` +
        `on [[claim:${SUB_ID}]].`,
    });
    expect(JSON.parse(out).success).toBe(true);
    expect(getClaimBasisSubclaims).toHaveBeenCalledWith(CLAIM_ID);
    expect(setArgumentEvaluation).toHaveBeenCalledTimes(1);
  });

  it("rejects an off-enum verdict", async () => {
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "sound",
      evaluation: `Stands on [[claim:${SUB_ID}]].`,
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("holds_with_caveats");
    expect(setArgumentEvaluation).not.toHaveBeenCalled();
  });

  it("rejects an evaluation of an unnamed argument", async () => {
    vi.mocked(getArgument).mockResolvedValue({
      ...namedArgument,
      name: null,
    } as never);
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "holds",
      evaluation: `Stands on [[claim:${SUB_ID}]].`,
    });
    expect(JSON.parse(out).success).toBe(false);
    expect(setArgumentEvaluation).not.toHaveBeenCalled();
  });

  it("requires a load-bearing link when the argument has attached subclaims", async () => {
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "holds",
      evaluation: "The inference is valid and the premises are all solid.",
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("[[claim:");
    expect(setArgumentEvaluation).not.toHaveBeenCalled();
  });

  it("allows zero links when the argument's premises live only in its prose", async () => {
    vi.mocked(getArgumentSubclaims).mockResolvedValue([]);
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "holds_with_caveats",
      evaluation:
        "The inference goes through only if the minor premise stated in the written form is granted.",
    });
    expect(JSON.parse(out).success).toBe(true);
    expect(setArgumentEvaluation).toHaveBeenCalled();
  });

  it("rejects links to claims outside the argument", async () => {
    const stranger = "99999999-9999-9999-9999-999999999999";
    const out = await executeStewardTool("evaluate_argument", {
      argument_id: ARG_ID,
      verdict: "fails",
      evaluation: `The conclusion does not follow from [[claim:${stranger}]].`,
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain(stranger);
    expect(setArgumentEvaluation).not.toHaveBeenCalled();
  });
});

describe("steward update_claim_assessment evaluation nudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
  });

  it("lists named arguments whose evaluations are missing or stale", async () => {
    vi.mocked(getEvaluationStateForClaim).mockResolvedValue([
      {
        argument_id: ARG_ID,
        argument_name: "Cosmological argument",
        verdict: null,
        content: null,
        stale: false,
      },
      {
        argument_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        argument_name: "Teleological argument",
        verdict: "holds",
        content: "…",
        stale: true,
      },
    ]);

    const out = await executeStewardTool("update_claim_assessment", {
      claim_id: CLAIM_ID,
      status: "contested",
      confidence: 0.7,
      assessment: "Genuinely disputed.",
      reasoning_trace: "Both sides credible.",
    });

    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('"Cosmological argument"');
    expect(parsed.message).toContain("no evaluation yet");
    expect(parsed.message).toContain('"Teleological argument"');
    expect(parsed.message).toContain("predate this assessment");
  });

  it("adds no nudge when every evaluation is current", async () => {
    vi.mocked(getEvaluationStateForClaim).mockResolvedValue([
      {
        argument_id: ARG_ID,
        argument_name: "Cosmological argument",
        verdict: "holds",
        content: "…",
        stale: false,
      },
    ]);

    const out = await executeStewardTool("update_claim_assessment", {
      claim_id: CLAIM_ID,
      status: "contested",
      confidence: 0.7,
      assessment: "Genuinely disputed.",
      reasoning_trace: "Both sides credible.",
    });

    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.message).not.toContain("evaluate_argument");
    expect(parsed.message).not.toContain("predate");
  });
});
