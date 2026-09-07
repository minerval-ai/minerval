import { describe, it, expect, beforeEach } from "vitest";

/**
 * The solver's prompt (docs/mathematics.md §7.1, Appendix C): one short
 * block written without the constitution, the skill, or the graph's
 * vocabulary; and a task message of fixed shape that carries the statement
 * verbatim, its pin and hashes, the note relating it to the words, the
 * budget in dollars, and the earlier attempts under the notice that they
 * are unverified.
 */
import {
  PRIOR_ATTEMPTS_NOTICE,
  SOLVER_SYSTEM_PROMPT,
  buildMathSolverTaskMessage,
  getMathSolverSystemPrompt,
  getMathSolverSystemPromptBlocks,
  resetMathSolverPromptForTests,
  type SolverTaskInput,
} from "../../../../src/llm/prompts/math-solver.js";

beforeEach(() => resetMathSolverPromptForTests());

describe("getMathSolverSystemPromptBlocks", () => {
  it("is one block, the standalone prompt verbatim", () => {
    const blocks = getMathSolverSystemPromptBlocks();
    expect(blocks).toEqual([SOLVER_SYSTEM_PROMPT]);
    expect(blocks[0]).toMatch(/^You are working alone on one open problem in mathematics\./);
    expect(blocks[0]).toContain("report ends the attempt.");
    expect(blocks[0]).toContain("A proof outcome without an accepted check is\nrecorded as partial.");
  });

  it("assumes no knowledge of the platform: none of the graph's terms appear", () => {
    const text = SOLVER_SYSTEM_PROMPT.toLowerCase();
    for (const term of ["minerval", "claim graph", "steward", "constitution", "mandate", "owl", "importance", "bounty", "prize", "administrator", "skill"]) {
      expect(text, term).not.toContain(term);
    }
    // No clock or turn budget: the budget is metered work in dollars, paced by a token countdown.
    expect(text).not.toMatch(/\bhours?\b/);
    expect(text).not.toMatch(/\bturns?\b/);
    expect(text).toContain("stated in dollars");
    expect(text).toContain("running count of the tokens you have left");
    // Under 100 lines: short enough to leave the problem in front of it.
    expect(SOLVER_SYSTEM_PROMPT.split("\n").length).toBeLessThan(100);
  });

  it("carries no constitution and no administrator's section", () => {
    const joined = getMathSolverSystemPromptBlocks().join("\n");
    expect(joined).not.toContain("# Your Specific Role");
    expect(joined).not.toContain("## For the Claim Steward");
    expect(joined).not.toContain("## For every administrator");
    expect(joined).not.toContain("## Standards for judging");
  });

  it("is one constant, reused across attempts so the cache entry never varies", () => {
    const a = getMathSolverSystemPromptBlocks();
    const b = getMathSolverSystemPromptBlocks();
    expect(a).toBe(b);
    resetMathSolverPromptForTests();
    expect(getMathSolverSystemPromptBlocks()).toBe(a);
    expect(getMathSolverSystemPrompt()).toBe(SOLVER_SYSTEM_PROMPT);
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
      budget: { usd: 187.5 },
    });
    expect(msg).toContain("For every natural number n, n + 0 = n.");
    expect(msg).toContain(statement.statementSource);
    expect(msg).toContain("Pin: mathlib-v4.33.1 (toolchain leanprover/lean4:v4.33.1; Mathlib abc123, tag v4.33.1)");
    expect(msg).toContain("source_hash: src-hash");
    expect(msg).toContain("expr_hash: expr-hash");
    expect(msg).toContain("Namespace: Minerval.S0a1b2c3d_v2");
    expect(msg).toContain("The formal statement renders the informal claim exactly.");
    expect(msg).toContain("Effort: max.");
    expect(msg).toContain("Budget: about $187.50 of metered work");
    expect(msg).not.toContain("Variant:");
    expect(msg).not.toMatch(/\bhours?\b|\bturns?\b/);
    expect(msg).toContain("## In words");
    expect(msg).toContain("## How the formal statement relates to the words");
    expect(msg).not.toContain("## Earlier attempts");
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
    expect(msg).toContain("## Earlier attempts");
    expect(msg).toContain(PRIOR_ATTEMPTS_NOTICE);
    expect(msg).toContain("Earlier attempt 1 (a1; effort high; status completed; outcome negative;");
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
      budget: { usd: 75 },
      toolsNote: "No checker is configured this run.",
    });
    expect(msg).toContain("(no note was recorded)");
    expect(msg).toContain("Budget: about $75 of metered work");
    expect(msg).toContain("## Note\n\nNo checker is configured this run.");
  });
});
