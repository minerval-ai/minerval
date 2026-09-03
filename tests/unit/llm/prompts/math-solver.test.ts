import { describe, it, expect, beforeEach } from "vitest";

/**
 * The solver's prompt (docs/mathematics.md §7.1, Appendix C): two cached
 * blocks, the skill's `For the solver` view and the harness verbatim, with
 * no constitution and no other role's section; and a task message of fixed
 * shape that carries the statement verbatim, its pin and hashes, the
 * correspondence note, the budget, and the prior attempts under the notice
 * that they are the platform's own unverified work.
 */
import {
  PRIOR_ATTEMPTS_NOTICE,
  SOLVER_HARNESS_BLOCK,
  buildMathSolverTaskMessage,
  getMathSolverSystemPrompt,
  getMathSolverSystemPromptBlocks,
  resetMathSolverPromptForTests,
  type SolverTaskInput,
} from "../../../../src/llm/prompts/math-solver.js";

beforeEach(() => resetMathSolverPromptForTests());

describe("getMathSolverSystemPromptBlocks", () => {
  it("is the skill's solver view first, then the harness block verbatim", () => {
    const blocks = getMathSolverSystemPromptBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/^# Domain skill: Mathematics \(version \d+\)/);
    expect(blocks[0]).toContain("## For the solver");
    expect(blocks[0]).toContain("You are an instrument of the Minerval claim graph");
    expect(blocks[1]).toBe(SOLVER_HARNESS_BLOCK);
    expect(blocks[1]).toMatch(/^# Harness\n/);
    expect(blocks[1]).toContain("report ends the attempt.");
    expect(blocks[1]).toContain("A proof outcome without an\naccepted check is recorded as partial.");
  });

  it("carries no constitution and no administrator's section", () => {
    const joined = getMathSolverSystemPromptBlocks().join("\n");
    expect(joined).not.toContain("# Your Specific Role");
    expect(joined).not.toContain("## For the Claim Steward");
    expect(joined).not.toContain("## For every administrator");
    expect(joined).not.toContain("## Standards for judging");
  });

  it("is built once and reused", () => {
    const a = getMathSolverSystemPromptBlocks();
    const b = getMathSolverSystemPromptBlocks();
    expect(a).toBe(b);
    resetMathSolverPromptForTests();
    expect(getMathSolverSystemPromptBlocks()).not.toBe(a);
  });

  it("joins the blocks for the docs pages", () => {
    const [skill, harness] = getMathSolverSystemPromptBlocks();
    expect(getMathSolverSystemPrompt()).toBe(`${skill}\n\n---\n\n${harness}`);
  });
});

const statement: SolverTaskInput["statement"] = {
  id: "f1f1f1f1-0000-4000-8000-000000000001",
  version: 2,
  namespace: "Minerval.S0a1b2c3d_v2",
  statementSource:
    "import Mathlib\nnamespace Minerval.S0a1b2c3d_v2\ndef Statement : Prop := ∀ n : ℕ, n + 0 = n\nend Minerval.S0a1b2c3d_v2",
  pinId: "mathlib-v4.33.1",
  leanToolchain: "leanprover/lean4:v4.33.1",
  mathlibRev: "abc123",
  mathlibTag: "v4.33.1",
  sourceHash: "src-hash",
  exprHash: "expr-hash",
  correspondence: "The formal statement renders the informal claim exactly.",
};

describe("buildMathSolverTaskMessage", () => {
  it("carries the canonical form, the statement verbatim with pin and hashes, the note, and the budget", () => {
    const msg = buildMathSolverTaskMessage({
      canonicalForm: "For every natural number n, n + 0 = n.",
      statement,
      variant: "max",
      effort: "max",
      budget: { hours: 6, turns: 500 },
    });
    expect(msg).toContain("For every natural number n, n + 0 = n.");
    expect(msg).toContain(statement.statementSource);
    expect(msg).toContain("Pin: mathlib-v4.33.1 (toolchain leanprover/lean4:v4.33.1; Mathlib abc123, tag v4.33.1)");
    expect(msg).toContain("source_hash: src-hash");
    expect(msg).toContain("expr_hash: expr-hash");
    expect(msg).toContain("Namespace: Minerval.S0a1b2c3d_v2");
    expect(msg).toContain("The formal statement renders the informal claim exactly.");
    expect(msg).toContain("Variant: max. Effort: max.");
    expect(msg).toContain("about 6 hours of wall clock and at most 500 turns");
    expect(msg).not.toContain("## Prior attempts");
    expect(msg).not.toContain(PRIOR_ATTEMPTS_NOTICE);
  });

  it("marks prior attempts as the platform's own unverified work, with their reports and notebook summaries", () => {
    const msg = buildMathSolverTaskMessage({
      canonicalForm: "c",
      statement,
      variant: "standard",
      effort: "high",
      budget: { hours: 6, turns: 500 },
      priorAttempts: [
        {
          id: "a1",
          variant: "standard",
          effort: "high",
          status: "completed",
          outcome: "negative",
          finishedAt: "2026-08-01T00:00:00.000Z",
          report: {
            outcome: "negative",
            approaches_tried: ["induction on n", "simp"],
            obstruction: "the lemma Nat.add_zero was not found",
            what_would_help: "a search for add_zero",
            confidence: 0.4,
          },
          notebook: { plan: "try induction first", "dead end": "simp did nothing" },
        },
      ],
    });
    expect(msg).toContain("## Prior attempts");
    expect(msg).toContain(PRIOR_ATTEMPTS_NOTICE);
    expect(msg).toContain("Prior attempt 1 (a1; variant standard, effort high; status completed; outcome negative;");
    expect(msg).toContain("- induction on n");
    expect(msg).toContain("obstruction: the lemma Nat.add_zero was not found");
    expect(msg).toContain("[plan] try induction first");
    expect(msg).toContain("[dead end] simp did nothing");
  });

  it("appends the tools note when the formal tools are absent", () => {
    const msg = buildMathSolverTaskMessage({
      canonicalForm: "c",
      statement: { ...statement, correspondence: null },
      variant: "standard",
      effort: "high",
      budget: { hours: 1, turns: 10 },
      toolsNote: "No checker is configured this run.",
    });
    expect(msg).toContain("(no correspondence note was recorded)");
    expect(msg).toContain("## Note\n\nNo checker is configured this run.");
    expect(msg).toContain("about 1 hour of wall clock");
  });
});
