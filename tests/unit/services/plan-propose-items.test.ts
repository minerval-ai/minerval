import { describe, it, expect, vi } from "vitest";

/**
 * A mandate's propose plan items (#656), the pure half: what a well-formed
 * one carries, how other items and the mandate's scope name it, and its
 * stored form. Filing it and binding the plan to its node is the DB
 * suite's (tests/db/plan-proposals).
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import {
  normalizePlanItems,
  validatePlanItems,
  PLAN_ITEM_SCHEMA,
  PLAN_KIND_RULES,
  type PlanItem,
} from "../../../src/services/grant-service.js";
import { validateMandate, type GrantMandate } from "../../../src/llm/agents/grantmaker.js";
import { GRANTMAKER_CONTRIBUTION_TYPES } from "../../../src/services/contribution-service.js";
import { PROPOSAL_TYPE_FOR_KIND, intakeContributionTypeEnum, proposedNodeKind } from "../../../src/schemas/common.js";
import { NODE_KINDS } from "../../../src/schemas/kinds.js";

const WHY = "The graph holds this in no wording, and the mandate is about it.";
const CLAIM_ID = "00000000-0000-4000-8000-000000000000";
const items = (...xs: Array<Record<string, unknown>>) => xs as unknown as PlanItem[];
const propose = (extra: Record<string, unknown> = {}) => ({
  action: "propose",
  kind: "question",
  text: "What limits the supply of new housing?",
  rationale: WHY,
  ...extra,
});

describe("propose plan items", () => {
  it("is a plan kind the Grantmaker's tools offer, for every node kind alike", () => {
    const props = PLAN_ITEM_SCHEMA.properties as Record<string, { enum?: string[] }>;
    expect(props.action!.enum).toContain("propose");
    expect(props.kind!.enum).toEqual([...NODE_KINDS]);
    expect(PLAN_KIND_RULES).toContain("propose:");
    for (const kind of NODE_KINDS) {
      expect(validatePlanItems(items(propose({ kind })))).toBeNull();
      // Each kind has its own intake type, which a mandate may submit.
      const type = PROPOSAL_TYPE_FOR_KIND[kind];
      expect(intakeContributionTypeEnum.options).toContain(type);
      expect(GRANTMAKER_CONTRIBUTION_TYPES).toContain(type);
      expect(proposedNodeKind(type)).toBe(kind);
    }
    expect(proposedNodeKind("propose_source")).toBeNull();
  });

  it("needs a kind, a wording, and a rationale long enough to be the proposal's public record", () => {
    expect(validatePlanItems(items(propose({ kind: "topic" })))).toMatch(/needs a kind/);
    expect(validatePlanItems(items(propose({ text: "  " })))).toMatch(/needs text/);
    expect(validatePlanItems(items(propose({ text: "x".repeat(2001) })))).toMatch(/over 2000 characters/);
    expect(validatePlanItems(items(propose({ rationale: "wanted" })))).toMatch(/why the\s+graph needs the node/);
  });

  it("lets a claim item name a proposal by its ref in place of a node id", () => {
    const ok = items(propose({ ref: "root" }), { action: "deepen", claim_ref: "root", rationale: "r" });
    expect(validatePlanItems(ok)).toBeNull();
    // Order does not matter: the ref is the plan's, not a position.
    expect(validatePlanItems([...ok].reverse())).toBeNull();
    expect(validatePlanItems(items({ action: "deepen", claim_ref: "root", rationale: "r" }))).toMatch(
      /names no propose item/
    );
    expect(validatePlanItems(items({ action: "deepen", rationale: "r" }))).toMatch(/claim_id .* or the claim_ref/);
    expect(validatePlanItems(items(propose({ ref: "Not A Label" })))).toMatch(/label of at most 40/);
    expect(validatePlanItems(items(propose({ ref: "root" }), propose({ ref: "root" })))).toMatch(/already used/);
  });

  it("checks refs against the plan the items are joining", () => {
    const joining = items({ action: "assess", claim_ref: "root", rationale: "r" });
    expect(validatePlanItems(joining, ["root"])).toBeNull();
    expect(validatePlanItems(joining, ["other"])).toMatch(/names no propose item/);
    expect(validatePlanItems(items(propose({ ref: "root" })), ["root"])).toMatch(/already used/);
  });

  it("stores what was proposed and nothing the materializer is to write", () => {
    const [stored, dependent, plain] = normalizePlanItems(
      items(
        propose({ ref: "root", text: "  What limits the supply of new housing?  ", claim_id: CLAIM_ID, contribution_id: CLAIM_ID }),
        { action: "assess", claim_ref: "root", rationale: "r" },
        { action: "assess", claim_id: CLAIM_ID, claim_ref: "root", kind: "claim", text: "t", ref: "x", rationale: "r" }
      )
    );
    expect(stored).toEqual({
      action: "propose",
      rationale: WHY,
      kind: "question",
      text: "What limits the supply of new housing?",
      ref: "root",
    });
    expect(dependent).toEqual({ action: "assess", rationale: "r", claim_ref: "root" });
    // An item that already has its node is an ordinary item.
    expect(plain).toEqual({ action: "assess", rationale: "r", claim_id: CLAIM_ID });
  });
});

describe("a mandate scoped to a proposal", () => {
  const mandate = (overrides: Partial<GrantMandate> = {}): GrantMandate => ({
    title: "Housing supply",
    objective: "Work the question down.",
    plan: {
      strategy: "Propose the question, then deepen it.",
      items: items(propose({ ref: "root" }), { action: "deepen", claim_ref: "root", rationale: "r" }),
    },
    expected_cost_owls: 12,
    funder_named: false,
    funder_stake: "none",
    ...overrides,
  });

  it("takes scope_ref in place of scope_claim_id, naming a propose item in the plan", () => {
    expect(validateMandate(mandate({ scope_ref: "root" }))).toBeNull();
    expect(validateMandate(mandate({ scope_ref: "elsewhere" }))).toMatch(/names no propose item/);
    expect(validateMandate(mandate({ scope_ref: "root", scope_claim_id: CLAIM_ID }))).toMatch(/not both/);
  });
});
