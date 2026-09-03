/**
 * The statement convention of design section 5.4.
 *
 * The statement file is checker-owned: the server validates that a file
 * follows the convention, derives the namespace from it, writes it into the
 * work directory itself, and compiles it as the module
 * `MinervalCheck.Statement`. A submission never touches that file; it is
 * compiled as `MinervalCheck.Submission` after a header the checker
 * supplies, whose `import MinervalCheck.Statement` is the only import (Lean
 * imports are transitive, so Mathlib comes with it).
 *
 * The canonical form of the claim is never interpolated anywhere: a `-/`
 * inside it would end a docstring and turn the rest into source. The
 * docstring the convention shows says only "the canonical form is in the
 * correspondence note".
 */
import { blankCommentsAndStrings, scanStaticPolicy, type Violation } from "./static-policy.js";

export const STATEMENT_MODULE = "MinervalCheck.Statement";
export const SUBMISSION_MODULE = "MinervalCheck.Submission";
export const SCRATCH_MODULE = "MinervalCheck.Scratch";
export const STATEMENT_CONSTANT = "Statement";

/** `Minerval.S<8 hex of claim id>_v<version>` (section 5.1). */
export const NAMESPACE_PATTERN = /^Minerval\.S([0-9a-f]{8})_v([1-9]\d*)$/;

export interface StatementParse {
  ok: boolean;
  errors: Array<{ message: string; line: number; column: number }>;
  namespace: string | null;
  claim_hex: string | null;
  version: number | null;
  witness_present: boolean;
  /** The static-policy result over the body (header lines excluded). */
  policy: { ok: boolean; violations: Violation[] };
}

interface TokenLine {
  index: number; // 0-based line number
  text: string; // blanked, trimmed
}

function tokenLines(blanked: string): TokenLine[] {
  return blanked
    .split("\n")
    .map((text, index) => ({ index, text: text.trim() }))
    .filter((l) => l.text.length > 0);
}

/**
 * Validate the convention. Comments and blank lines may appear anywhere
 * (a module docstring before the import is fine); the order of the
 * required lines is fixed.
 */
export function parseStatement(source: string): StatementParse {
  const errors: StatementParse["errors"] = [];
  const blanked = blankCommentsAndStrings(source);
  const lines = tokenLines(blanked);
  const err = (message: string, line = 1, column = 0) => errors.push({ message, line, column });

  const first = lines[0];
  if (!first || first.text !== "import Mathlib") {
    err(
      "the first line of a statement must be exactly `import Mathlib`",
      first ? first.index + 1 : 1
    );
  }
  for (const l of lines.slice(1)) {
    if (/^import\b/.test(l.text)) err("a statement may import only Mathlib, on its first line", l.index + 1);
  }

  const autoImplicit = lines.find((l) => /^set_option\s+autoImplicit\s+false$/.test(l.text));
  if (!autoImplicit) err("a statement must contain `set_option autoImplicit false` before its namespace");

  const namespaceLines = lines.filter((l) => /^namespace\b/.test(l.text));
  let namespace: string | null = null;
  let claimHex: string | null = null;
  let version: number | null = null;
  if (namespaceLines.length !== 1) {
    err(`a statement must open exactly one namespace, found ${namespaceLines.length}`);
  } else {
    const nsLine = namespaceLines[0]!;
    const name = nsLine.text.replace(/^namespace\s+/, "");
    const m = NAMESPACE_PATTERN.exec(name);
    if (!m) {
      err(`the namespace must match Minerval.S<8 hex>_v<n>, got \`${name}\``, nsLine.index + 1);
    } else {
      namespace = name;
      claimHex = m[1]!;
      version = Number(m[2]);
      if (autoImplicit && autoImplicit.index > nsLine.index) {
        err("`set_option autoImplicit false` must come before the namespace", autoImplicit.index + 1);
      }
      const last = lines[lines.length - 1]!;
      if (last.text !== `end ${name}`) {
        err(`the last line must be \`end ${name}\``, last.index + 1);
      }
    }
  }

  const defRe = /(^|\s)(?:noncomputable\s+)?def\s+Statement\s*:\s*Prop\s*:=/u;
  if (!defRe.test(blanked)) {
    err("a statement must declare `def Statement : Prop :=` inside its namespace");
  }
  const otherStatement = /(^|\s)(theorem|lemma|abbrev|instance|axiom|opaque)\s+Statement\b/u.exec(blanked);
  if (otherStatement) err("`Statement` must be a `def`, nothing else");

  const witness_present = /(^|\s)example\s*:/u.test(blanked);

  // The header lines are the convention's, not the author's: blank them
  // before the policy scan so `import Mathlib` and the autoImplicit option
  // are not violations.
  const policySource = source
    .split("\n")
    .map((text, index) => {
      const t = blanked.split("\n")[index]?.trim() ?? "";
      if (t === "import Mathlib" || /^set_option\s+autoImplicit\s+false$/.test(t)) {
        return " ".repeat(text.length);
      }
      return text;
    })
    .join("\n");
  const policy = scanStaticPolicy(policySource, "statement");

  return {
    ok: errors.length === 0 && policy.ok,
    errors,
    namespace,
    claim_hex: claimHex,
    version,
    witness_present,
    policy,
  };
}

/**
 * The header the checker supplies for a submission. It is the only place an
 * `import` may appear, and `autoImplicit` is forced off again so a
 * submission cannot rely on unbound names elaborating as universally
 * quantified variables. The trailing comment marks the seam for a reader of
 * the assembled file; diagnostics are reported relative to the submission,
 * so the header's line count is returned with it.
 */
export function submissionHeader(namespace: string): { text: string; lines: number } {
  const text =
    `import ${STATEMENT_MODULE}\n` +
    `set_option autoImplicit false\n` +
    `-- Minerval checker header for ${namespace}. The submission begins on the next line.\n`;
  return { text, lines: 3 };
}

export function assembleSubmission(namespace: string, submission: string): { file: string; headerLines: number } {
  const header = submissionHeader(namespace);
  const body = submission.endsWith("\n") ? submission : submission + "\n";
  return { file: header.text + body, headerLines: header.lines };
}

/** The header for a scratch file: the statement when one is given, else Mathlib. */
export function scratchHeader(withStatement: boolean): { text: string; lines: number } {
  const text = withStatement
    ? `import ${STATEMENT_MODULE}\n-- Minerval scratch header. The scratch source begins on the next line.\n`
    : `import Mathlib\n-- Minerval scratch header. The scratch source begins on the next line.\n`;
  return { text, lines: 2 };
}

export function assembleScratch(source: string, withStatement: boolean): { file: string; headerLines: number } {
  const header = scratchHeader(withStatement);
  const body = source.endsWith("\n") ? source : source + "\n";
  return { file: header.text + body, headerLines: header.lines };
}

/** `Minerval.S..._v1.proof` or `.disproof` (section 5.4). */
export function targetName(namespace: string, kind: "proof" | "disproof"): string {
  return `${namespace}.${kind}`;
}
