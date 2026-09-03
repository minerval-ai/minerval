/**
 * The static-policy portion of the golden fixture (design section 12.2),
 * asserted without Lean: the cases the static gate decides must be
 * refused with the expected token, and every other case must pass the
 * gate so that it reaches the checker at all. The full fixture runs against
 * a live checker with scripts/run-golden.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStatement } from "../src/statement.js";
import { scanStaticPolicy } from "../src/static-policy.js";
import { staticRejection } from "../src/verdict.js";

interface Fixture {
  version: number;
  gates: string[];
  cases: Array<{
    name: string;
    kind: "check" | "elaborate";
    check_kind?: "proof" | "disproof";
    statement_source: string;
    submission_source?: string;
    expected: {
      verdict?: string;
      failing_gate?: string | null;
      static_token?: string;
      defense_in_depth_gate?: string;
      elaborates?: boolean;
      convention_ok?: boolean;
    };
  }>;
}

const fixture = JSON.parse(readFileSync(new URL("../../golden/lean-checks.json", import.meta.url), "utf8")) as Fixture;

describe("golden fixture: shape", () => {
  it("has the section 12.2 cases", () => {
    const names = fixture.cases.map((c) => c.name);
    for (const required of [
      "sorry-in-helper",
      "custom-axiom",
      "native-decide",
      "opaque-false",
      "csimp-smuggle",
      "weaker-hypothesis",
      "negation-as-proof",
      "vacuous-statement",
      "local-prime-redefinition",
      "comments-address-reviewer",
      "newer-mathlib-name",
      "debug-skip-kernel",
      "universe-polymorphic-target",
      "extra-import",
      "riemann-hypothesis",
      "fermat-last-theorem",
      "twin-primes",
    ]) {
      expect(names, required).toContain(required);
    }
    expect(fixture.gates).toEqual(["static_policy", "compile", "target", "axioms", "declarations", "replay"]);
    for (const c of fixture.cases) {
      if (c.kind === "check") {
        expect(["accepted", "rejected", "error"], c.name).toContain(c.expected.verdict);
        expect(typeof c.submission_source, c.name).toBe("string");
        if (c.expected.verdict === "accepted") expect(c.expected.failing_gate, c.name).toBeNull();
        else expect(fixture.gates, c.name).toContain(c.expected.failing_gate);
      } else {
        expect(typeof c.expected.elaborates, c.name).toBe("boolean");
      }
    }
  });
});

describe("golden fixture: what the static gate decides", () => {
  const checks = fixture.cases.filter((c) => c.kind === "check");

  it.each(checks.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const stmt = parseStatement(c.statement_source);
    expect(stmt.ok, `statement of ${c.name}: ${JSON.stringify(stmt.errors)}`).toBe(true);
    const policy = scanStaticPolicy(c.submission_source!, "submission");
    if (c.expected.failing_gate === "static_policy") {
      expect(policy.ok).toBe(false);
      expect(policy.violations.map((v) => v.token)).toContain(c.expected.static_token);
      const outcome = staticRejection(policy.violations);
      expect(outcome.verdict).toBe("rejected");
      expect(outcome.failed_gate).toBe("static_policy");
      if (c.expected.defense_in_depth_gate) expect(fixture.gates).toContain(c.expected.defense_in_depth_gate);
    } else {
      expect(policy.ok, `the gate must not refuse ${c.name}: ${JSON.stringify(policy.violations)}`).toBe(true);
    }
  });
});

describe("golden fixture: what the convention decides", () => {
  const elaborations = fixture.cases.filter((c) => c.kind === "elaborate");

  it.each(elaborations.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const stmt = parseStatement(c.statement_source);
    expect(stmt.ok, JSON.stringify(stmt.errors)).toBe(c.expected.convention_ok ?? true);
    if (stmt.ok) expect(stmt.namespace).toMatch(/^Minerval\.S[0-9a-f]{8}_v\d+$/);
  });
});
