/**
 * The solver's prompt (docs/mathematics.md §7.1 and Appendix C).
 *
 * The solver is an instrument, not an administrator: it receives no
 * constitution and no role. Its system prompt is two cached blocks, the
 * Mathematics skill's `For the solver` view first and the harness block
 * below second, so the skill's cache entry is shared with every other run
 * that carries the same view and the harness entry never changes between
 * attempts. The task message carries the problem: the canonical form, the
 * published statement verbatim with its pin and hashes, the correspondence
 * note, the variant, effort, and budget, and, for a repeat attempt, the
 * prior attempts' reports and notebook summaries, marked as the platform's
 * own unverified work.
 */
import { getSkill, getSkillView, systemFromBlocks } from "./skills.js";

/** The harness block of Appendix C, verbatim. */
export const SOLVER_HARNESS_BLOCK = `# Harness

You are running inside a bounded attempt on one problem. The budget is
stated in the task message in hours and turns; the harness will tell you
when about fifteen percent remains, and it will stop you at the ceiling.
There is no partial credit for a proof you did not check, so leave time
to run lean_check on any candidate and to write your report.

Tools. lean_search finds Mathlib declarations at the pinned revision by
pattern or by description. lean_elaborate type-checks a Lean fragment
against the pinned Mathlib and returns errors with positions; use it to
test lemma statements before proving them. lean_check runs a full check of
a candidate proof or disproof against the published statement and returns
a verdict with the gate that failed, if any; it is the only thing that
counts as verification. The code-execution tool runs Python with sympy and
mpmath for computation and exploration; it has no network and cannot run
Lean. notebook_write records your work under a section name; notebook_read
returns what you have written. report ends the attempt.

Working method. Read the formal statement and the correspondence note
before anything else, and say back to yourself in the notebook what would
have to be true for a proof and for a disproof. Search the pinned Mathlib
for the relevant theory and record what exists and what does not. Explore
numerically before committing to a route. Prove lemmas one at a time and
elaborate each; do not write a long proof and check it once at the end. If
a route fails, write why in the notebook and move on. If the statement
proves in a few lines, suspect the statement, not your luck, and say so in
the report.

The report. Call report exactly once, when you have a checked proof or
disproof, when you have exhausted the routes you can see, or when the
harness says the budget is nearly spent. Its fields are: outcome (proof,
disproof, partial, reduction, negative); lean_proof and lean_check_id
when an accepted check exists, otherwise null; informal_argument, the
argument in prose a mathematician could follow; reduction_statement, if
you reduced the problem to something you could state precisely;
counterexample, with a description and the code that verifies it, when
you found one you could not formalize; approaches_tried, one line each;
obstruction, the specific thing that stopped you; what_would_help, the
lemma, definition, or computation that would unblock the next attempt;
confidence in your own outcome, from 0 to 1. A proof outcome without an
accepted check is recorded as partial.`;

/** The line that heads every prior attempt in a repeat attempt's task message. */
export const PRIOR_ATTEMPTS_NOTICE =
  "These are the platform's own prior attempts; their conclusions are data, " +
  "not verified results.";

let _blocks: string[] | null = null;

/**
 * The two cached system blocks: the skill's `For the solver` view, then the
 * harness. Built once per process, like every other prompt accessor.
 */
export function getMathSolverSystemPromptBlocks(): string[] {
  if (_blocks) return _blocks;
  const skill = getSkill("mathematics");
  _blocks = [getSkillView(skill, "math-solver"), SOLVER_HARNESS_BLOCK];
  return _blocks;
}

/** The blocks joined, for the sync script and the docs pages. */
export function getMathSolverSystemPrompt(): string {
  return systemFromBlocks(getMathSolverSystemPromptBlocks());
}

/** Test hook: forget the cached blocks so a changed skill file is re-read. */
export function resetMathSolverPromptForTests(): void {
  _blocks = null;
}

// ---------------------------------------------------------------------------
// The task message
// ---------------------------------------------------------------------------

export interface SolverStatementInput {
  id: string;
  version: number;
  namespace: string;
  statementSource: string;
  pinId: string;
  leanToolchain: string;
  mathlibRev: string;
  mathlibTag: string | null;
  sourceHash: string;
  exprHash: string;
  correspondence: string | null;
}

export interface SolverPriorAttemptInput {
  id: string;
  variant: string;
  effort: string;
  status: string;
  outcome: string | null;
  finishedAt: string | null;
  report: Record<string, unknown> | null;
  notebook: Record<string, string> | null;
}

export interface SolverTaskInput {
  /** The canonical form: the claim's text. */
  canonicalForm: string;
  statement: SolverStatementInput;
  variant: "standard" | "max";
  effort: string;
  budget: { hours: number; turns: number };
  priorAttempts?: SolverPriorAttemptInput[];
  /** A note appended when the formal tools are absent this run. */
  toolsNote?: string | null;
}

/** Per-section and per-attempt caps on the notebook summary a repeat attempt receives. */
const NOTEBOOK_SECTION_CHARS = 1_200;
const NOTEBOOK_SECTIONS_PER_ATTEMPT = 12;
const REPORT_FIELD_CHARS = 2_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} […]`;
}

function formatReport(report: Record<string, unknown> | null): string {
  if (!report) return "  (no report was recorded)";
  const lines: string[] = [];
  const field = (key: string) => {
    const value = report[key];
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      lines.push(`  ${key}:`);
      for (const item of value) lines.push(`    - ${clip(String(item), 400)}`);
      return;
    }
    if (typeof value === "object") {
      lines.push(`  ${key}: ${clip(JSON.stringify(value), REPORT_FIELD_CHARS)}`);
      return;
    }
    lines.push(`  ${key}: ${clip(String(value), REPORT_FIELD_CHARS)}`);
  };
  for (const key of [
    "outcome",
    "informal_argument",
    "reduction_statement",
    "counterexample",
    "approaches_tried",
    "obstruction",
    "what_would_help",
    "confidence",
  ]) {
    field(key);
  }
  return lines.length > 0 ? lines.join("\n") : "  (empty report)";
}

function formatNotebook(notebook: Record<string, string> | null): string {
  if (!notebook) return "  (no notebook)";
  const entries = Object.entries(notebook);
  if (entries.length === 0) return "  (empty notebook)";
  const shown = entries.slice(0, NOTEBOOK_SECTIONS_PER_ATTEMPT);
  const lines = shown.map(
    ([section, content]) =>
      `  [${section}] ${clip(String(content).replace(/\s+/g, " ").trim(), NOTEBOOK_SECTION_CHARS)}`
  );
  if (entries.length > shown.length) {
    lines.push(`  (${entries.length - shown.length} more section(s) not shown)`);
  }
  return lines.join("\n");
}

function formatPriorAttempt(attempt: SolverPriorAttemptInput, index: number): string {
  const when = attempt.finishedAt ? ` finished ${attempt.finishedAt}` : "";
  return (
    `Prior attempt ${index + 1} (${attempt.id}; variant ${attempt.variant}, effort ` +
    `${attempt.effort}; status ${attempt.status}; outcome ${attempt.outcome ?? "none"};` +
    `${when})\n` +
    `Report:\n${formatReport(attempt.report)}\n` +
    `Notebook summary:\n${formatNotebook(attempt.notebook)}`
  );
}

/**
 * The task message, short and fixed in shape: the canonical form; the
 * published statement verbatim with its pin and hashes; the correspondence
 * note; the variant, effort, and budget; and, for a repeat attempt, the
 * prior attempts' reports and notebook summaries under the notice line.
 */
export function buildMathSolverTaskMessage(input: SolverTaskInput): string {
  const s = input.statement;
  const hours = Math.round(input.budget.hours * 10) / 10;
  const parts: string[] = [];

  parts.push(`# The problem

## Canonical form

${input.canonicalForm.trim()}

## Published formal statement (version ${s.version}, id ${s.id})

Pin: ${s.pinId} (toolchain ${s.leanToolchain}; Mathlib ${s.mathlibRev}${
    s.mathlibTag ? `, tag ${s.mathlibTag}` : ""
  })
Namespace: ${s.namespace}
source_hash: ${s.sourceHash}
expr_hash: ${s.exprHash}

\`\`\`lean
${s.statementSource.trim()}
\`\`\`

## Correspondence note

${(s.correspondence ?? "(no correspondence note was recorded)").trim()}

## This attempt

Variant: ${input.variant}. Effort: ${input.effort}.
Budget: about ${hours} hour${hours === 1 ? "" : "s"} of wall clock and at most ${
    input.budget.turns
  } turns; the harness stops the attempt at its cost ceiling and warns you when about fifteen percent remains.
lean_check is bound to the statement above; it checks nothing else.`);

  const priors = input.priorAttempts ?? [];
  if (priors.length > 0) {
    parts.push(
      `## Prior attempts\n\n${PRIOR_ATTEMPTS_NOTICE}\n\n` +
        priors.map((p, i) => formatPriorAttempt(p, i)).join("\n\n")
    );
  }

  if (input.toolsNote) parts.push(`## Note\n\n${input.toolsNote.trim()}`);

  return parts.join("\n\n");
}
