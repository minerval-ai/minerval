import { describe, it, expect, vi, beforeEach } from "vitest";

// Only a node's own Steward writes to it (Part VIII; #757). The write tools
// refuse a target that is not the run's node and name the route that
// reaches it; a figure or a reading may go on any quantity.

const OWN = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ARG = "33333333-3333-3333-3333-333333333333";

const { usage, argumentClaim, writes } = vi.hoisted(() => ({
  usage: { claimId: "11111111-1111-1111-1111-111111111111" as string | undefined },
  argumentClaim: { id: "11111111-1111-1111-1111-111111111111" },
  writes: { count: 0 },
}));

vi.mock("../../../../src/llm/usage-context.js", () => ({
  getUsageContext: () => usage,
}));

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => {
    writes.count++;
    throw new Error("no write should reach the database");
  },
  withTransaction: vi.fn(async () => {
    writes.count++;
    throw new Error("no write should reach the database");
  }),
  rawQuery: vi.fn(async (sql: string) => {
    if (sql.includes("FROM arguments WHERE id")) return [{ claim_id: argumentClaim.id }];
    if (sql.includes("SELECT kind FROM claims") || sql.includes("FROM claims")) return [{ kind: "quantity" }];
    return [];
  }),
}));

vi.mock("../../../../src/services/quantity-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/quantity-service.js")>()),
  recordEstimate: vi.fn(async () => ({ id: "est" })),
  setStatedEstimate: vi.fn(async () => {}),
}));

import { ownershipRefusal } from "../../../../src/llm/tools/steward-ownership.js";
import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";
import { executeKindTool } from "../../../../src/llm/tools/kind-tools.js";
import { recordEstimate } from "../../../../src/services/quantity-service.js";

beforeEach(() => {
  vi.clearAllMocks();
  usage.claimId = OWN;
  argumentClaim.id = OWN;
  writes.count = 0;
});

describe("ownershipRefusal", () => {
  it("lets a write to the run's own node through", async () => {
    expect(await ownershipRefusal("update_claim_assessment", { claim_id: OWN })).toBeNull();
  });

  it("refuses a write to another node and names the routes", async () => {
    const out = JSON.parse((await ownershipRefusal("set_claim_importance", { claim_id: OTHER }))!);
    expect(out.success).toBe(false);
    expect(out.message).toContain(OTHER);
    expect(out.message).toMatch(/escalate_to_curator/);
    expect(out.message).toMatch(/file_request/);
  });

  it("follows an argument to its claim", async () => {
    argumentClaim.id = OTHER;
    const out = await ownershipRefusal("evaluate_argument", { argument_id: ARG });
    expect(out).not.toBeNull();
    argumentClaim.id = OWN;
    expect(await ownershipRefusal("evaluate_argument", { argument_id: ARG })).toBeNull();
  });

  it("lets a figure or reading go on any quantity", async () => {
    expect(await ownershipRefusal("record_estimate", { quantity_id: OTHER })).toBeNull();
    expect(await ownershipRefusal("record_quantity_reading", { claim_id: OTHER })).toBeNull();
  });

  it("checks nothing outside a Steward run", async () => {
    usage.claimId = undefined;
    expect(await ownershipRefusal("update_claim_assessment", { claim_id: OTHER })).toBeNull();
  });

  it("leaves escalation to any node alone", async () => {
    expect(await ownershipRefusal("escalate_to_curator", { claim_id: OTHER })).toBeNull();
  });
});

describe("the executors", () => {
  it("refuse update_claim_assessment on another node before writing", async () => {
    const out = JSON.parse(
      await executeStewardTool("update_claim_assessment", {
        claim_id: OTHER,
        status: "supported",
        confidence: 0.7,
        assessment: "x",
        reasoning_trace: "y",
      })
    );
    expect(out.success).toBe(false);
    expect(writes.count).toBe(0);
  });

  it("refuse a claim Steward's update_quantity_estimate on a dependency", async () => {
    const out = JSON.parse(
      (await executeKindTool(
        "update_quantity_estimate",
        { claim_id: OTHER, estimate: { form: "point", central: 3 }, assessment: "a", work: "w" },
        { role: "claim_steward", claimId: OWN }
      ))!
    );
    expect(out.success).toBe(false);
    expect(recordEstimate).not.toHaveBeenCalled();
  });

  it("record a quantity Steward's marginal_yield with its estimate (#755)", async () => {
    usage.claimId = OTHER;
    const out = JSON.parse(
      (await executeKindTool(
        "update_quantity_estimate",
        { claim_id: OTHER, estimate: { form: "point", central: 3 }, assessment: "a", work: "w", marginal_yield: 1.4 },
        { role: "claim_steward", claimId: OTHER }
      ))!
    );
    expect(out.success).toBe(true);
    expect(recordEstimate).toHaveBeenCalledWith(expect.objectContaining({ claimId: OTHER, marginalYield: 1 }));
  });
});
