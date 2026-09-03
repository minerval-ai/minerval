/**
 * The static policy of design section 5.5, applied before any Lean process
 * starts.
 *
 * This is a word-boundary token scan over the source with comments and
 * string literals blanked out, not a parse: `PartialOrder` is not `partial`
 * (word boundary), "important" in a comment is not `import` (word boundary
 * and comment blanking), and `«sorry»` is rejected as `sorry` because the
 * guillemets are not identifier characters, which errs on the side of
 * refusing. The checker executable and the axiom closure are the authority
 * for anything this scan cannot see; the scan exists to turn away the
 * obvious cheaply and to keep elaboration-time execution (`#eval`,
 * `initialize`, custom `macro`s) out of the Lean process altogether.
 *
 * Three profiles:
 * - `submission`: the full list. A prize or attempt submission.
 * - `statement`: the full list minus the header lines the convention
 *   requires (`import Mathlib`, `set_option autoImplicit false`), which the
 *   statement parser blanks before calling this.
 * - `scratch`: iteration on the warm lane. `sorry`, `admit`, and
 *   `native_decide` are allowed because a draft is allowed to be
 *   incomplete; imports, elaboration-time execution, and `debug.*` options
 *   are not, because the warm lane is shared.
 */

export type PolicyProfile = "submission" | "statement" | "scratch";

export interface Violation {
  token: string;
  line: number; // 1-based
  column: number; // 0-based, like Lean's own positions
  reason: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: Violation[];
}

/**
 * The tokens section 5.5 calls unambiguous: the route gate in the API
 * refuses exactly these, and the checker refuses them too.
 */
export const UNAMBIGUOUS_TOKENS = [
  "sorry",
  "admit",
  "axiom",
  "native_decide",
  "import",
  "unsafe",
  "partial",
] as const;

/**
 * The rest of section 5.5's list. Also refused here, on the blanked
 * source, because none of them has a legitimate use in a prize proof and
 * every one of them is either an escape from the kernel or a way to run
 * code at elaboration time.
 */
export const EXTENDED_TOKENS = [
  "sorryAx",
  "implemented_by",
  "extern",
  "csimp",
  "opaque",
  "ofReduceBool",
  "trustCompiler",
  "#eval",
  "#exit",
  "run_cmd",
  "run_tac",
  "elab",
  "elab_rules",
  "macro",
  "macro_rules",
  "syntax",
  "initialize",
  "builtin_initialize",
] as const;

/** What the shared warm lane refuses from semi-trusted iteration. */
export const SCRATCH_TOKENS = [
  "import",
  "unsafe",
  "implemented_by",
  "extern",
  "#eval",
  "#exit",
  "run_cmd",
  "run_tac",
  "elab",
  "elab_rules",
  "macro",
  "macro_rules",
  "syntax",
  "initialize",
  "builtin_initialize",
] as const;

/** The `set_option` allowlist of section 5.5 and its ceilings. */
export const OPTION_ALLOWLIST: Record<string, number> = {
  maxHeartbeats: 4_000_000,
  maxRecDepth: 8192,
};

const REASONS: Record<string, string> = {
  sorry: "a proof may not contain `sorry`",
  admit: "a proof may not contain `admit` (it is `sorry`)",
  sorryAx: "a proof may not refer to `sorryAx`",
  axiom: "a submission may not declare axioms",
  native_decide: "`native_decide` trusts the compiler, not the kernel",
  import: "a submission may not import anything; the checker header is the only import",
  unsafe: "`unsafe` declarations are not checked by the kernel",
  partial: "`partial` definitions are not checked for termination and compile to opaque constants",
  implemented_by: "`implemented_by` substitutes unchecked code",
  extern: "`extern` binds to foreign code",
  csimp: "`csimp` rewrites compiled code",
  opaque: "a submission may not declare opaque constants",
  ofReduceBool: "`Lean.ofReduceBool` trusts the compiler",
  trustCompiler: "`Lean.trustCompiler` trusts the compiler",
  "#eval": "a submission may not run code at elaboration time",
  "#exit": "`#exit` stops elaboration early",
  run_cmd: "a submission may not run commands at elaboration time",
  run_tac: "a submission may not run tactics at elaboration time",
  elab: "custom elaborators are not allowed in v1",
  elab_rules: "custom elaborators are not allowed in v1",
  macro: "custom macros are not allowed in v1",
  macro_rules: "custom macros are not allowed in v1",
  syntax: "custom syntax is not allowed in v1",
  initialize: "`initialize` runs code when the module is loaded",
  builtin_initialize: "`builtin_initialize` runs code when the module is loaded",
};

/**
 * Lean identifier characters, approximately: letters in any script, digits,
 * `_`, `'`, `!`, `?`, and the subscript block. Anything else ends a word.
 * Over-approximating the identifier alphabet only ever turns a true match
 * into a non-match inside a longer identifier, which is the safe direction
 * for `PartialOrder`-style names; the axiom closure catches what a longer
 * identifier could hide.
 */
const IDENT_CHAR = /[\p{L}\p{N}_'!?₀-ₜᵢ-ᵪ]/u;

export function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_CHAR.test(ch);
}

/**
 * Replace every comment and string literal with spaces of the same length
 * (newlines kept) so that later scans report the original positions.
 * Handles `--` line comments, nested `/- -/` block comments (doc comments
 * included), `"..."` strings with backslash escapes, and `'x'` character
 * literals; `'` is also an identifier character (`h'`), so a quote is only
 * a character literal when it is not glued to an identifier.
 */
export function blankCommentsAndStrings(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(source[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "-" && next === "-") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "-") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "-") {
          depth++;
          j += 2;
        } else if (source[j] === "-" && source[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') {
        if (source[j] === "\\") j++;
        j++;
      }
      j = Math.min(n, j + 1);
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "'" && !isIdentChar(source[i - 1])) {
      // 'a', '\n', '\x41', '\u{1F600}': a quote, one escaped or plain
      // character, a quote. Anything else is not a character literal.
      let j = i + 1;
      if (source[j] === "\\") {
        j++;
        if (source[j] === "u" && source[j + 1] === "{") {
          while (j < n && source[j] !== "}") j++;
        } else if (source[j] === "x") {
          j += 2;
        }
      }
      j++;
      if (source[j] === "'") {
        blank(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    out.push(ch as string);
    i++;
  }
  return out.join("");
}

function positionOf(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let k = 0; k < offset; k++) {
    if (source[k] === "\n") {
      line++;
      lastNl = k;
    }
  }
  return { line, column: offset - lastNl - 1 };
}

function findWholeWord(blanked: string, token: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = blanked.indexOf(token, from);
    if (at < 0) break;
    const before = blanked[at - 1];
    const after = blanked[at + token.length];
    if (!isIdentChar(before) && !isIdentChar(after)) hits.push(at);
    from = at + token.length;
  }
  return hits;
}

/**
 * `set_option name value` and `set_option name value in`: the option name
 * and its value, with the offset of the keyword.
 */
const SET_OPTION = /\bset_option\s+([A-Za-z_][\w.]*)\s+([^\s]+)/gu;
const DECIDE_NATIVE = /\bdecide\s*\+\s*native\b/gu;

export function scanStaticPolicy(source: string, profile: PolicyProfile): PolicyResult {
  const blanked = blankCommentsAndStrings(source);
  const violations: Violation[] = [];
  const push = (token: string, offset: number, reason: string) => {
    const { line, column } = positionOf(source, offset);
    violations.push({ token, line, column, reason });
  };

  const tokens: readonly string[] =
    profile === "scratch" ? SCRATCH_TOKENS : [...UNAMBIGUOUS_TOKENS, ...EXTENDED_TOKENS];
  for (const token of tokens) {
    for (const at of findWholeWord(blanked, token)) {
      push(token, at, REASONS[token] ?? `\`${token}\` is not allowed`);
    }
  }

  if (profile !== "scratch") {
    for (const m of blanked.matchAll(DECIDE_NATIVE)) {
      push("decide +native", m.index, "`decide +native` trusts the compiler, not the kernel");
    }
  }

  for (const m of blanked.matchAll(SET_OPTION)) {
    const name = m[1] ?? "";
    const raw = m[2] ?? "";
    const offset = m.index;
    if (name.startsWith("debug.")) {
      push(`set_option ${name}`, offset, `\`${name}\` is a debug option; every debug.* option is rejected`);
      continue;
    }
    if (profile === "scratch") continue;
    const ceiling = OPTION_ALLOWLIST[name];
    if (ceiling === undefined) {
      push(
        `set_option ${name}`,
        offset,
        `\`${name}\` is not in the option allowlist (maxHeartbeats up to ${OPTION_ALLOWLIST.maxHeartbeats}, maxRecDepth up to ${OPTION_ALLOWLIST.maxRecDepth})`
      );
      continue;
    }
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) {
      push(`set_option ${name}`, offset, `\`${name}\` needs a plain integer value, got \`${raw}\``);
    } else if (value > ceiling) {
      push(`set_option ${name}`, offset, `\`${name} ${raw}\` exceeds the ceiling of ${ceiling}`);
    }
  }

  violations.sort((a, b) => a.line - b.line || a.column - b.column);
  return { ok: violations.length === 0, violations };
}
