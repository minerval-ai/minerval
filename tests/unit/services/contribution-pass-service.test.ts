import { describe, it, expect, vi, beforeEach } from "vitest";

// What an accepted contribution's pass does (#1222): a paid contribution's
// charge funds an express order; an unpaid one is raised to the General
// mandate's officers with the node's open reassess row.

const mocks = vi.hoisted(() => ({
  contribution: null as Record<string, unknown> | null,
  charge: null as { id: string; user_id: string } | null,
  assessRow: { id: "row-1" } as { id: string } | null,
  createOrder: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, order: { id: "order-1" } })),
  getGeneralMandate: vi.fn(async (): Promise<{ grantId: string } | null> => ({ grantId: "general-1" })),
  raiseToMandate: vi.fn(async (): Promise<{ id: string; folded: boolean } | null> => ({ id: "item-1", folded: false })),
  ensureAssessActions: vi.fn(async () => {}),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    if (sql.includes("FROM contributions")) return mocks.contribution ? [mocks.contribution] : [];
    if (sql.includes("FROM owl_ledger")) return mocks.charge ? [mocks.charge] : [];
    if (sql.includes("FROM actions")) return mocks.assessRow ? [mocks.assessRow] : [];
    return [];
  }),
}));
vi.mock("../../../src/services/order-service.js", () => ({ createOrder: mocks.createOrder }));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({ getGeneralMandate: mocks.getGeneralMandate }));
vi.mock("../../../src/services/mandate-inbox-service.js", () => ({ raiseToMandate: mocks.raiseToMandate }));
vi.mock("../../../src/services/action-service.js", () => ({
  ensureAssessActions: mocks.ensureAssessActions,
  ASSESS_GROUP: (id: string) => `assess:${id}`,
}));

import { passOnAccept, asksForPassOnAccept, raiseSummary } from "../../../src/services/contribution-pass-service.js";

const CLAIM = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  mocks.contribution = {
    contribution_type: "challenge",
    contributor_id: "c-1",
    review_status: "accepted",
    grant_id: null,
    content: "The Opus 4 evidence conflates stated belief with the outcome.",
  };
  mocks.charge = null;
  mocks.assessRow = { id: "row-1" };
  mocks.createOrder.mockClear().mockResolvedValue({ ok: true, order: { id: "order-1" } });
  mocks.getGeneralMandate.mockClear().mockResolvedValue({ grantId: "general-1" });
  mocks.raiseToMandate.mockClear().mockResolvedValue({ id: "item-1", folded: false });
});

describe("passOnAccept", () => {
  it("funds an express order from the charge a paid contribution carries", async () => {
    mocks.charge = { id: "charge-1", user_id: "u-1" };
    const r = await passOnAccept({ contributionId: "co-1", claimId: CLAIM });
    expect(r).toEqual({ kind: "ordered", orderId: "order-1" });
    expect(mocks.createOrder).toHaveBeenCalledWith({
      userId: "u-1",
      claimId: CLAIM,
      contributionId: "co-1",
      chargeEntryId: "charge-1",
    });
    expect(mocks.raiseToMandate).not.toHaveBeenCalled();
  });

  it("counts an order the contributor already has open on the node", async () => {
    mocks.charge = { id: "charge-1", user_id: "u-1" };
    mocks.createOrder.mockResolvedValue({ ok: false, code: "ORDER_ALREADY_OPEN", existingOrderId: "order-0" });
    const r = await passOnAccept({ contributionId: "co-1", claimId: CLAIM });
    expect(r).toEqual({ kind: "ordered", orderId: "order-0" });
    expect(mocks.raiseToMandate).not.toHaveBeenCalled();
  });

  it("raises an unpaid contribution's pass to the General mandate's officers, naming the row", async () => {
    const r = await passOnAccept({ contributionId: "co-1", claimId: CLAIM });
    expect(r).toEqual({ kind: "raised", grantId: "general-1" });
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.ensureAssessActions).toHaveBeenCalledWith(CLAIM);
    const call = (mocks.raiseToMandate.mock.calls as unknown as Array<[Record<string, any>]>)[0]![0];
    expect(call.grantId).toBe("general-1");
    expect(call.targetNodeId).toBe(CLAIM);
    expect(call.detail.action_id).toBe("row-1");
    expect(call.detail.contribution_id).toBe("co-1");
    expect(call.summary).toContain("accepted challenge");
  });

  it("raises instead when the paid order is refused", async () => {
    mocks.charge = { id: "charge-1", user_id: "u-1" };
    mocks.createOrder.mockResolvedValue({ ok: false, code: "CLAIM_NOT_ACTIVE", message: "merged" });
    const r = await passOnAccept({ contributionId: "co-1", claimId: CLAIM });
    expect(r.kind).toBe("raised");
  });

  it("asks for nothing when the contribution was not accepted (a ruling that rejects)", async () => {
    mocks.contribution!.review_status = "rejected";
    const r = await passOnAccept({ contributionId: "co-1", claimId: CLAIM });
    expect(r.kind).toBe("none");
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(mocks.raiseToMandate).not.toHaveBeenCalled();
  });

  it("asks for nothing for a type that is not a reason for a pass", async () => {
    mocks.contribution!.contribution_type = "propose_merge";
    const r = await passOnAccept({ contributionId: "co-1", claimId: CLAIM });
    expect(r.kind).toBe("none");
    expect(mocks.raiseToMandate).not.toHaveBeenCalled();
  });

  it("raises nothing where there is no General mandate, or no open row", async () => {
    mocks.getGeneralMandate.mockResolvedValueOnce(null);
    expect((await passOnAccept({ contributionId: "co-1", claimId: CLAIM })).kind).toBe("none");
    mocks.assessRow = null;
    expect((await passOnAccept({ contributionId: "co-1", claimId: CLAIM })).kind).toBe("none");
    expect(mocks.raiseToMandate).not.toHaveBeenCalled();
  });

  it("never throws into the hand-over", async () => {
    mocks.getGeneralMandate.mockRejectedValueOnce(new Error("db down"));
    await expect(passOnAccept({ contributionId: "co-1", claimId: CLAIM })).resolves.toEqual({ kind: "none", reason: "error" });
  });
});

describe("which contributions ask for a pass", () => {
  it("covers the types a Steward weighs and leaves the Curator's and requests' alone", () => {
    for (const t of ["challenge", "support", "propose_edit", "add_instance", "propose_argument", "add_estimate", "propose_answer"]) {
      expect(asksForPassOnAccept(t)).toBe(true);
    }
    for (const t of ["propose_merge", "propose_split", "propose_request", "answer_request", "propose_claim", "claim_prize", "state_view"]) {
      expect(asksForPassOnAccept(t)).toBe(false);
    }
  });

  it("gives the officers an excerpt, not the whole text", () => {
    const s = raiseSummary("challenge", "co-1", "x".repeat(5000));
    expect(s.length).toBeLessThan(1200);
    expect(s).toContain("did not pay");
  });
});
