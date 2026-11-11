/**
 * Plan items for work a feature carries out (src/llm/tools/feature-tools.ts,
 * ACTION_FEATURES): with the feature switched off the item is refused where
 * the agent proposes it, with a reason it can act on, because nothing could
 * run the work. The plan tools' schema and descriptions do not change, and
 * with every feature on neither does anything else.
 *
 * That an item a plan already holds opens no row is in
 * tests/db/plan-materialization.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { loadConfig } from "../../../src/config.js";
import {
  PLAN_ITEM_SCHEMA,
  PLAN_KIND_RULES,
  validatePlanItems,
  type PlanItem,
} from "../../../src/services/grant-service.js";
import { validateMandate, type GrantMandate } from "../../../src/llm/agents/grantmaker.js";
import { ACTION_FEATURES, actionUnavailable } from "../../../src/llm/tools/feature-tools.js";
import { FEATURE_NAMES } from "../../../src/features.js";

// The deployment's FEATURES_OFF as config loading parsed it: the loaded
// config is one object per process, so setting the list on it is what every
// module that asks reads.
const state = loadConfig() as { featuresOff: string[] };
const loaded = state.featuresOff;
afterAll(() => {
  state.featuresOff = loaded;
});

const CLAIM = "11111111-1111-4111-8111-111111111111";

const formalize: PlanItem = { action: "formalize", claim_id: CLAIM, rationale: "state it in Lean" };
const attempt: PlanItem = { action: "attempt_proof", claim_id: CLAIM, variant: "standard", rationale: "try it" };
const core: PlanItem[] = [
  { action: "assess", claim_id: CLAIM, rationale: "first pass" },
  { action: "reassess", claim_id: CLAIM, rationale: "fresh look" },
  { action: "deepen", claim_id: CLAIM, rationale: "its subtree" },
  { action: "ingest", url: "https://example.org/paper", rationale: "a source" },
  { action: "sweep", partition: "residual", rationale: "keep it consistent" },
  {
    action: "propose",
    kind: "claim",
    text: "Every even integer above two is a sum of two primes.",
    rationale: "The graph does not hold this proposition, and the mandate's subject turns on it.",
  },
];

const FORMALIZE_REFUSAL =
  "formalize is not available in this deployment: mathematics is switched off. Leave it out of the plan.";
const ATTEMPT_REFUSAL =
  "attempt_proof is not available in this deployment: mathematics is switched off. Leave it out of the plan.";

const mandate = (items: PlanItem[]): GrantMandate => ({
  title: "Goldbach",
  objective: "Map what is known about the conjecture.",
  plan: { strategy: "Start from the surveys.", items },
  expected_cost_owls: 10,
  funder_named: true,
  funder_stake: "none",
});

beforeEach(() => {
  state.featuresOff = [];
});

describe("the kinds of work that belong to a feature", () => {
  it("are plan actions, each under a feature that exists", () => {
    const actions = PLAN_ITEM_SCHEMA.properties.action.enum as readonly string[];
    for (const [kind, feature] of Object.entries(ACTION_FEATURES)) {
      expect(actions, kind).toContain(kind);
      expect(FEATURE_NAMES, kind).toContain(feature);
    }
    expect(ACTION_FEATURES).toEqual({ formalize: "mathematics", attempt_proof: "mathematics" });
  });

  it("are available while their feature is on, and say why when it is not", () => {
    for (const kind of Object.keys(ACTION_FEATURES)) {
      expect(actionUnavailable(kind, { featuresOff: [] }), kind).toBeNull();
      expect(actionUnavailable(kind, {}), kind).toBeNull();
      expect(actionUnavailable(kind, { featuresOff: ["extension", "prizes"] }), kind).toBeNull();
    }
    expect(actionUnavailable("formalize", { featuresOff: ["mathematics"] })).toBe(
      "formalize is not available in this deployment: mathematics is switched off"
    );
    expect(actionUnavailable("attempt_proof", { featuresOff: ["mathematics"] })).toBe(
      "attempt_proof is not available in this deployment: mathematics is switched off"
    );
  });

  it("never include a kind of the core product", () => {
    const all = { featuresOff: [...FEATURE_NAMES] };
    for (const kind of ["assess", "reassess", "deepen", "ingest", "sweep", "propose", "request", "no_such_kind", "toString"]) {
      expect(actionUnavailable(kind, all), kind).toBeNull();
    }
  });
});

describe("with every feature on", () => {
  it("accepts formalize and attempt_proof items as before", () => {
    expect(validatePlanItems([formalize, attempt, ...core])).toBeNull();
    expect(validatePlanItems([formalize, attempt], [], { featuresOff: [] })).toBeNull();
    expect(validateMandate(mandate([formalize, attempt, ...core]))).toBeNull();
    // The checks an item of these kinds already had still speak first.
    expect(validatePlanItems([{ ...attempt, variant: "strong" }])).toBe(
      "an attempt_proof item's variant is standard or max"
    );
    expect(validatePlanItems([{ action: "formalize", rationale: "r" }])).toMatch(/formalize item needs a claim_id/);
  });

  it("accepts them with a feature off that they do not belong to", () => {
    state.featuresOff = ["extension", "prizes"];
    expect(validatePlanItems([formalize, attempt, ...core])).toBeNull();
  });
});

describe("with mathematics off", () => {
  beforeEach(() => {
    state.featuresOff = ["mathematics"];
  });

  it("refuses a formalize item, with the reason and what to do", () => {
    expect(validatePlanItems([formalize])).toBe(FORMALIZE_REFUSAL);
    // Whatever else is wrong with the item, this is what the agent is told.
    expect(validatePlanItems([{ action: "formalize", rationale: "" }])).toBe(FORMALIZE_REFUSAL);
  });

  it("refuses an attempt_proof item, with the reason and what to do", () => {
    expect(validatePlanItems([attempt])).toBe(ATTEMPT_REFUSAL);
    expect(validatePlanItems([{ ...attempt, variant: "strong" }])).toBe(ATTEMPT_REFUSAL);
  });

  it("refuses the plan that carries one, on every path a plan is written by", () => {
    // propose_mandate, adjust_plan and extend_plan all validate through
    // validateMandate; the Grantor's submit_plan calls validatePlanItems.
    expect(validateMandate(mandate([...core, formalize]))).toBe(FORMALIZE_REFUSAL);
    expect(validateMandate(mandate([attempt, ...core]))).toBe(ATTEMPT_REFUSAL);
    expect(validatePlanItems([...core, attempt, formalize])).toBe(ATTEMPT_REFUSAL);
  });

  it("accepts every item of the core product", () => {
    expect(validatePlanItems(core)).toBeNull();
    expect(validateMandate(mandate(core))).toBeNull();
  });

  it("leaves the plan tools' schema and rules as they are", () => {
    expect(PLAN_ITEM_SCHEMA.properties.action.enum).toEqual([
      "propose", "assess", "reassess", "deepen", "ingest", "formalize", "attempt_proof", "sweep",
    ]);
    expect(PLAN_KIND_RULES).toContain("formalize and attempt_proof: mathematical claims");
  });
});
