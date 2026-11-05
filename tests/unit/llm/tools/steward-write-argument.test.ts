import { describe, it, expect, vi, beforeEach } from "vitest";

// write_argument (#747): links are required only when the argument has
// attached subclaims, basis subclaims are linkable as in evaluate_argument,
// and the label itself is not a written form.

const ARG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLAIM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SUB_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BASIS_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const STRANGER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

vi.mock("../../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
}));

vi.mock("../../../../src/services/argument-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/services/argument-service.js")>();
  return {
    ...actual,
    getArgument: vi.fn(),
    getArgumentSubclaims: vi.fn(async () => [] as { id: string; text: string }[]),
    setArgumentContent: vi.fn(async () => ({})),
  };
});

vi.mock("../../../../src/services/relationship-service.js", () => ({
  insertRelationshipEdge: vi.fn(),
  attachEdgeToArgument: vi.fn(),
  getClaimBasisSubclaims: vi.fn(async () => [] as { id: string; text: string }[]),
}));

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1]),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
}));

import { executeStewardTool, getStewardToolDefinitions } from "../../../../src/llm/tools/steward-tools.js";
import { getClaimBasisSubclaims } from "../../../../src/services/relationship-service.js";
import {
  getArgument,
  getArgumentSubclaims,
  setArgumentContent,
} from "../../../../src/services/argument-service.js";

const LABEL = "The argument from the unlinked early cases";
const argument = {
  id: ARG_ID,
  claimId: CLAIM_ID,
  name: "Unlinked early cases",
  description: LABEL,
  stance: "for",
  content: LABEL,
  retiredAt: null,
  retiredReason: null,
};

function write(content: string) {
  return executeStewardTool("write_argument", { argument_id: ARG_ID, content }).then(
    (out) => JSON.parse(out) as { success: boolean; message: string }
  );
}

describe("steward write_argument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getArgument).mockResolvedValue(argument as never);
    vi.mocked(getArgumentSubclaims).mockResolvedValue([]);
    vi.mocked(getClaimBasisSubclaims).mockResolvedValue([]);
  });

  it("accepts a form with no links when the argument has no attached subclaims", async () => {
    const out = await write("Every group of prime order is cyclic, so by Lagrange's theorem the claim follows.");
    expect(out.success).toBe(true);
    expect(setArgumentContent).toHaveBeenCalled();
  });

  it("refuses a form with no links when subclaims are attached, naming ungroup_subclaim", async () => {
    vi.mocked(getArgumentSubclaims).mockResolvedValue([{ id: SUB_ID, text: "The first cases had no market link" }]);
    const out = await write("The early cases point away from the market.");
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/ungroup_subclaim/);
    expect(setArgumentContent).not.toHaveBeenCalled();
  });

  it("refuses the label itself", async () => {
    const out = await write(LABEL);
    expect(out.success).toBe(false);
    expect(setArgumentContent).not.toHaveBeenCalled();
  });

  it("accepts a link to the claim's ungrouped basis, as evaluate_argument does", async () => {
    vi.mocked(getArgumentSubclaims).mockResolvedValue([{ id: SUB_ID, text: "The first cases had no market link" }]);
    vi.mocked(getClaimBasisSubclaims).mockResolvedValue([{ id: BASIS_ID, text: "Case records are complete" }]);
    const out = await write(`Because [[claim:${SUB_ID}]], and given [[claim:${BASIS_ID}]], the claim follows.`);
    expect(out.success).toBe(true);
  });

  it("refuses a link to a claim outside the argument and the basis", async () => {
    const out = await write(`Because [[claim:${STRANGER_ID}]], the claim follows.`);
    expect(out.success).toBe(false);
    expect(out.message).toContain(STRANGER_ID);
  });

  it("refuses a retired argument", async () => {
    vi.mocked(getArgument).mockResolvedValue({ ...argument, retiredAt: new Date() } as never);
    const out = await write("Some prose.");
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/retired/);
  });

  it("states the caps it enforces and gives no fill-in template (#751)", () => {
    const tools = getStewardToolDefinitions();
    const writeTool = tools.find((t) => t.name === "write_argument")!;
    const content = (writeTool.input_schema as { properties: Record<string, { description: string }> }).properties
      .content!.description;
    expect(content).toMatch(/1,000 characters/);
    expect(writeTool.description).not.toMatch(/Because \[\[claim/);
    const evaluate = tools.find((t) => t.name === "evaluate_argument")!;
    const evaluation = (evaluate.input_schema as { properties: Record<string, { description: string }> }).properties
      .evaluation!.description;
    expect(evaluation).toMatch(/1,200 characters/);
    expect(evaluation).not.toMatch(/Two to four sentences/);
  });
});
