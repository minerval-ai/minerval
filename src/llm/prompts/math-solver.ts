/**
 * The solver's prompt (docs/mathematics.md §7.1 and Appendix C).
 *
 * The solver is an instrument, not an administrator: it receives no
 * constitution, no role, and no domain skill. Its system prompt is the one
 * short block below, written for a reader who knows mathematics and Lean
 * and nothing about this platform, so that nothing in it competes with the
 * problem for attention. The task message carries the problem: the
 * statement in words, the formal statement verbatim with its pin and
 * hashes, the note relating the two, the effort and the budget in dollars,
 * and, for a repeat attempt, the earlier attempts' reports and notebook
 * summaries, marked as unverified.
 */

/** The solver's whole system prompt, Appendix C verbatim. */
export const SOLVER_SYSTEM_PROMPT = `You are working alone on one open problem in mathematics. The problem is
stated twice in the message that follows: once in words, and once as a
formal statement in Lean 4 against a pinned version of Mathlib. The formal
statement is the one that counts. Your job is to prove it or disprove it
in Lean so that the checker accepts the result or, failing that, to leave
the most useful honest account of what you tried, where it broke, and what
would help a later attempt.

What counts. A result is proved only when lean_check accepts it: a theorem
whose type is exactly the statement, or exactly its negation, compiled
under the pinned toolchain, using no axioms beyond Lean's standard three
(propext, Classical.choice, and Quot.sound), with no sorry, no
native_decide, no unsafe or partial declarations, and no axioms of your
own. Nothing else is a proof: not an argument in prose, not a numerical
check, not a proof that elaborates but was never checked against the
statement. A computational counterexample is a strong lead, and you should
report it with the code that verifies it, but it is not a disproof until
it is a checked Lean disproof.

The statement was written by someone else and might be wrong. Read it
before anything else, together with the note on how it relates to the
problem in words, and write down what would have to be true for a proof
and for a disproof. If the statement proves in a few lines, or is
vacuous, or does not say what the words say, suspect the statement,
not your luck: report that as the finding, with the reason. Do not weaken
the problem and prove the weaker thing.

Tools. lean_search finds Mathlib declarations at the pinned revision, by
name pattern or by description. lean_elaborate type-checks a Lean fragment
against the pinned Mathlib and returns diagnostics with positions; use it
to test lemma statements before you try to prove them and to check each
lemma as you go. lean_check runs the full check of a candidate proof or
disproof against the statement and returns the verdict and, on failure,
the gate that failed. It is bound to this statement and checks nothing
else, and it is the only verification there is. Each check is a full
build billed to the attempt's budget, slower and dearer than
lean_elaborate, so test fragments with lean_elaborate first; the checker
also has a daily capacity, and a check it refuses for the day says so in
its result. The code
execution tool runs Python with sympy and mpmath for computation and
exploration; it has no network access and cannot run Lean. notebook_write
records your work under a section name and notebook_read returns it; the
notebook outlives the attempt and is what a later attempt on this
statement reads, so write each approach down when you start it and what
happened when you leave it. When earlier attempts exist,
read_earlier_attempt returns one in full, its notebook and its report with
any Lean source, where the summary in the message shortens them. report
ends the attempt.

Working method. Search Mathlib for the relevant theory before you build
anything, and record what exists and what does not. Explore numerically
before you commit to a route. Prove lemmas one at a time and elaborate
each one; do not write a long proof and check it once at the end. When a
route fails, write down why and move on. Prefer a checked partial result
you can state precisely to a longer argument nobody has verified.

Budget. The attempt has a fixed budget of metered work, stated in dollars
in the message that follows; it covers your own tokens, checker time, and
container time. As you work you will see what you have spent in dollars
and how far the rest goes at your recent rate, a notice when about
fifteen percent of the budget remains, and a hard stop at the ceiling
whether or not you have reported. There is
no credit for a proof you did not check, so keep enough for a final
lean_check on any candidate and for the report.

The report. Call report exactly once: when you have a checked proof or
disproof, when you have exhausted the routes you can see, or when the
notice says the budget is nearly spent. A negative report with a precise
obstruction is a good outcome. A proof outcome without an accepted check
is recorded as partial.`;

/** The line that heads every earlier attempt in a repeat attempt's task message. */
export const PRIOR_ATTEMPTS_NOTICE =
  "These are earlier attempts on this same statement by the same system, " +
  "not by you. Their conclusions are data, not verified results.";

const SOLVER_SYSTEM_BLOCKS: readonly string[] = Object.freeze([SOLVER_SYSTEM_PROMPT]);

/** The system prompt as blocks: one block, so the cache entry never varies between attempts. */
export function getMathSolverSystemPromptBlocks(): string[] {
  return SOLVER_SYSTEM_BLOCKS as string[];
}

/** The prompt as one string, for the sync script and the docs pages. */
export function getMathSolverSystemPrompt(): string {
  return SOLVER_SYSTEM_PROMPT;
}

/** Kept for callers that reset prompt caches between tests; the prompt is a constant. */
export function resetMathSolverPromptForTests(): void {}

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
  /** The attempt's ceiling in dollars of metered work (the same number as owls at cost). */
  budget: { usd: number };
  priorAttempts?: SolverPriorAttemptInput[];
  /** A note appended when the formal tools are absent this run. */
  toolsNote?: string | null;
}

/**
 * How long the summary of an earlier attempt runs in the task message. These
 * shorten a summary, not what the solver can see: read_earlier_attempt
 * returns any earlier attempt in full (#758), and every shortened field says
 * so.
 */
const NOTEBOOK_SECTION_CHARS = 1_200;
const NOTEBOOK_SECTIONS_PER_ATTEMPT = 12;
const REPORT_FIELD_CHARS = 2_000;

const MORE = " […; read_earlier_attempt has the rest]";

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${MORE}`;
}

/**
 * Collapse whitespace in prose but keep fenced code as written: Lean is
 * layout-sensitive, and a lemma flattened onto one line is unusable (#758).
 */
export function tidyKeepingCode(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) => (i % 2 === 1 ? `\n${part.trim()}\n` : part.replace(/\s+/g, " ")))
    .join("")
    .trim();
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
  // The Lean source is not summarized: a fragment of a proof is worse than
  // none. The summary says it exists and how to read it.
  const leanProof = report.lean_proof;
  if (typeof leanProof === "string" && leanProof.trim()) {
    lines.push(`  lean_proof: ${leanProof.length} characters of Lean; read_earlier_attempt returns it`);
  }
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
      `  [${section}] ${clip(tidyKeepingCode(String(content)), NOTEBOOK_SECTION_CHARS)}`
  );
  if (entries.length > shown.length) {
    lines.push(`  (${entries.length - shown.length} more section(s) not shown; read_earlier_attempt returns them)`);
  }
  return lines.join("\n");
}

function formatPriorAttempt(attempt: SolverPriorAttemptInput, index: number): string {
  const when = attempt.finishedAt ? ` finished ${attempt.finishedAt}` : "";
  return (
    `Earlier attempt ${index + 1} (${attempt.id}; effort ${attempt.effort}; ` +
    `status ${attempt.status}; outcome ${attempt.outcome ?? "none"};` +
    `${when})\n` +
    `Report:\n${formatReport(attempt.report)}\n` +
    `Notebook summary:\n${formatNotebook(attempt.notebook)}`
  );
}

/** Dollars, whole or to the cent, for the task message. */
function formatBudgetUsd(usd: number): string {
  const rounded = Math.round(usd * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/**
 * The task message, short and fixed in shape and written in plain terms:
 * the problem in words; the formal statement verbatim with its pin and
 * hashes; the note relating the two; the effort and the budget in dollars;
 * and, for a repeat attempt, the earlier attempts' reports and notebook
 * summaries under the notice line.
 */
export function buildMathSolverTaskMessage(input: SolverTaskInput): string {
  const s = input.statement;
  const parts: string[] = [];

  parts.push(`# The problem

## In words

${input.canonicalForm.trim()}

## The formal statement (version ${s.version}, id ${s.id})

Pin: ${s.pinId} (toolchain ${s.leanToolchain}; Mathlib ${s.mathlibRev}${
    s.mathlibTag ? `, tag ${s.mathlibTag}` : ""
  })
Namespace: ${s.namespace}
source_hash: ${s.sourceHash}
expr_hash: ${s.exprHash}

\`\`\`lean
${s.statementSource.trim()}
\`\`\`

## How the formal statement relates to the words

${(s.correspondence ?? "(no note was recorded)").trim()}

## This attempt

Effort: ${input.effort}.
Budget: about ${formatBudgetUsd(input.budget.usd)} of metered work (your tokens, checker time, and container time). As you work you will see what you have spent, in dollars; a notice comes when about fifteen percent remains; the attempt stops at the ceiling.
lean_check is bound to the statement above; it checks nothing else.
If a tool fails, or behaves otherwise than its description says, raise_issue reports it to the people who maintain the tools; a hard problem is not a tool failure.`);

  const priors = input.priorAttempts ?? [];
  if (priors.length > 0) {
    parts.push(
      `## Earlier attempts\n\n${PRIOR_ATTEMPTS_NOTICE} What follows is a summary of each; read_earlier_attempt returns one in full.\n\n` +
        priors.map((p, i) => formatPriorAttempt(p, i)).join("\n\n")
    );
  }

  if (input.toolsNote) parts.push(`## Note\n\n${input.toolsNote.trim()}`);

  return parts.join("\n\n");
}
