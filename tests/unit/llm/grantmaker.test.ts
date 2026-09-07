import { describe, it, expect } from "vitest";
import {
  validateMandate,
  type GrantMandate,
} from "../../../src/llm/agents/grantmaker.js";

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function mandate(overrides: Partial<GrantMandate> = {}): GrantMandate {
  return {
    title: "Metabolic health cruxes",
    objective: "Cover the contested causal claims behind dietary guidance.",
    plan: {
      strategy: "Assess the unassessed cruxes first.",
      items: [
        { action: "assess", claim_id: CLAIM_ID, rationale: "live crux" },
      ],
    },
    expected_cost_owls: 12,
    ...overrides,
  };
}

describe("validateMandate", () => {
  it("accepts a well-formed mandate", () => {
    expect(validateMandate(mandate())).toBeNull();
  });

  it("accepts ingest items with http(s) urls and no claim id", () => {
    expect(
      validateMandate(
        mandate({
          plan: {
            strategy: "Ingest the series, then cover it.",
            items: [
              {
                action: "ingest",
                url: "https://example.org/article",
                rationale: "seed the scope",
              },
              { action: "assess", claim_id: CLAIM_ID, rationale: "crux" },
            ],
          },
        })
      )
    ).toBeNull();
  });

  it("accepts formalize and attempt_proof items, which carry a claim_id (docs/mathematics.md §10.8)", () => {
    expect(
      validateMandate(
        mandate({
          plan: {
            strategy: "Formalize the first target, then attempt it.",
            items: [
              { action: "formalize", claim_id: CLAIM_ID, rationale: "target" },
              {
                action: "attempt_proof",
                claim_id: CLAIM_ID,
                variant: "max",
                is_calibration: true,
                lifetime_cap_owls: 800,
                rationale: "calibration control",
              },
            ],
          },
        })
      )
    ).toBeNull();
  });

  it("rejects formalize and attempt_proof items without a real claim id", () => {
    for (const action of ["formalize", "attempt_proof"] as const) {
      const bad = mandate({
        plan: {
          strategy: "s",
          items: [{ action, rationale: "r" }],
        },
      });
      expect(validateMandate(bad)).toContain("claim_id");
    }
  });

  it("rejects claim actions without a real claim id (no invented ids)", () => {
    const bad = mandate({
      plan: {
        strategy: "s",
        items: [{ action: "reassess", claim_id: "not-a-uuid", rationale: "r" }],
      },
    });
    expect(validateMandate(bad)).toContain("claim_id");
  });

  it("rejects ingest items with non-http urls", () => {
    const bad = mandate({
      plan: {
        strategy: "s",
        items: [
          { action: "ingest", url: "file:///etc/passwd", rationale: "r" },
        ],
      },
    });
    expect(validateMandate(bad)).toContain("http");
  });

  it("rejects empty plans and non-positive quotes", () => {
    expect(
      validateMandate(mandate({ plan: { strategy: "s", items: [] } }))
    ).toContain("at least one item");
    expect(validateMandate(mandate({ expected_cost_owls: 0 }))).toContain(
      "positive"
    );
  });
});
