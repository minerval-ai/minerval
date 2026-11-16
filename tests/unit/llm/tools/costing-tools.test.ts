/**
 * cost_sheet (skills/costing): the ledger section prices every kind of work
 * a mandate can fund from the metered cost of its finished rows, and a kind
 * with too few runs falls back to its prior and says so.
 */
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (sql: string): Promise<unknown[]> => {
    if (sql.includes("FROM actions")) {
      return [
        // Enough runs: the live percentiles stand.
        { kind: "assess", variant: "strong", runs: 12, p50: "1500000", p80: "2500000" },
        // Too few: the ceiling is the prior.
        { kind: "ingest", variant: "standard", runs: 2, p50: "300000", p80: "400000" },
      ];
    }
    return [];
  }),
}));

vi.mock("../../../../src/db/client.js", () => ({ rawQuery: mocks.rawQuery }));
vi.mock("../../../../src/config.js", () => ({ loadConfig: () => ({ owlCostMicroUsd: 1_000_000 }) }));
vi.mock("../../../../src/services/cost-estimate-service.js", () => ({
  stewardTierCostEstimates: async () => ({ standardMicroUsd: 500_000, strongMicroUsd: 2_000_000 }),
  estimateLedgerKindCostMicroUsd: async (kind: string) => (kind === "request_scope" ? 600_000 : 250_000),
}));
vi.mock("../../../../src/services/allocation-policy-service.js", () => ({
  getEffectiveAllocationPolicy: async () => ({
    est_formalize_cost_owls: 8,
    est_attempt_standard_cost_owls: 60,
    est_attempt_max_cost_owls: 150,
    est_prize_review_cost_owls: 12,
  }),
}));
vi.mock("../../../../src/services/contribution-service.js", () => ({
  reviewCostEstimateMicroUsd: async () => 300_000,
}));
vi.mock("../../../../src/services/research-run-service.js", () => ({
  RESEARCH_MODEL_TIERS: ["cheap"],
  modelForTier: () => "m",
}));
vi.mock("../../../../src/llm/tools/elicit-tools.js", () => ({ elicitConfigured: () => false }));

import { registerCostingTools } from "../../../../src/llm/tools/costing-tools.js";

async function costSheet(): Promise<Record<string, any>> {
  let exec: ((input: Record<string, unknown>, ctx: unknown) => Promise<string>) | null = null;
  registerCostingTools((name, e) => {
    if (name === "cost_sheet") exec = e as typeof exec;
  });
  return JSON.parse(await exec!({}, { role: "grantmaker" }));
}

describe("cost_sheet ledger_work", () => {
  it("prices each kind of mandate work from its metered rows, or its prior when the rows are thin", async () => {
    const sheet = await costSheet();
    const line = (kind: string, variant: string) =>
      sheet.ledger_work.find((l: any) => l.kind === kind && l.variant === variant);

    expect(line("assess", "strong")).toMatchObject({ runs_last_30_days: 12, typical_usd: 1.5, ceiling_usd: 2.5 });
    expect(line("assess", "strong").note).toBeUndefined();

    // Two runs is too few: the ceiling is the ingest prior (the ledger's own
    // figure, not the submitter's cap), and the line says so.
    expect(line("ingest", "standard")).toMatchObject({ runs_last_30_days: 2, ceiling_usd: 0.25 });
    expect(line("ingest", "standard").note).toMatch(/prior/);

    // A kind with no runs yet still appears, priced from its prior.
    expect(line("attempt_proof", "max")).toMatchObject({ runs_last_30_days: 0, ceiling_usd: 150 });
    expect(line("formalize", "standard")).toMatchObject({ ceiling_usd: 8 });
    expect(line("request", "scope")).toMatchObject({ ceiling_usd: 0.6 });
    // No prior exists for a review pass; the line says to price it from the steps.
    expect(line("mandate_review", "standard").note).toMatch(/from the steps/);

    expect(sheet.contribution_review_usd).toBe(0.3);
  });
});
