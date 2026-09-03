import { describe, expect, it } from "vitest";
import { exprHash, normalizeSource, sourceHash, submissionSha256 } from "../src/hashes.js";
import { assembleScratch, assembleSubmission, parseStatement, submissionHeader, targetName } from "../src/statement.js";
import { NS, STATEMENT } from "./helpers.js";

describe("statement convention", () => {
  it("accepts the convention's example and derives the namespace, claim, version, and witness", () => {
    const p = parseStatement(STATEMENT);
    expect(p.ok).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.namespace).toBe(NS);
    expect(p.claim_hex).toBe("0000a001");
    expect(p.version).toBe(1);
    expect(p.witness_present).toBe(false);
  });

  it("sees a witness example", () => {
    const src = STATEMENT.replace(`end ${NS}`, `/-- Witness. -/\nexample : ∃ n : ℕ, 0 < n := ⟨1, Nat.one_pos⟩\nend ${NS}`);
    expect(parseStatement(src).witness_present).toBe(true);
  });

  it("allows a module docstring and comments before the import", () => {
    const src = `/-! A statement. -/\n-- comment\n${STATEMENT}`;
    expect(parseStatement(src).ok).toBe(true);
  });

  it("requires `import Mathlib` first and nothing else imported", () => {
    const p1 = parseStatement(STATEMENT.replace("import Mathlib\n", ""));
    expect(p1.ok).toBe(false);
    expect(p1.errors[0]!.message).toMatch(/import Mathlib/);
    const p2 = parseStatement(STATEMENT.replace("import Mathlib\n", "import Mathlib\nimport Std\n"));
    expect(p2.ok).toBe(false);
    expect(p2.errors.some((e) => /only Mathlib/.test(e.message))).toBe(true);
  });

  it("requires autoImplicit off before the namespace", () => {
    const p = parseStatement(STATEMENT.replace("set_option autoImplicit false\n", ""));
    expect(p.ok).toBe(false);
    expect(p.errors[0]!.message).toMatch(/autoImplicit/);
    const after = STATEMENT.replace("set_option autoImplicit false\n", "").replace(`namespace ${NS}\n`, `namespace ${NS}\nset_option autoImplicit false\n`);
    expect(parseStatement(after).errors.some((e) => /before the namespace/.test(e.message))).toBe(true);
  });

  it("requires the namespace shape and a matching end", () => {
    const p = parseStatement(STATEMENT.replaceAll(NS, "Minerval.S9f2a_v1"));
    expect(p.ok).toBe(false);
    expect(p.errors[0]!.message).toMatch(/8 hex/);
    const p2 = parseStatement(STATEMENT.replace(`end ${NS}`, "end Minerval.S0000a002_v1"));
    expect(p2.errors.some((e) => /last line must be/.test(e.message))).toBe(true);
    const p3 = parseStatement(STATEMENT.replace(`end ${NS}\n`, `end ${NS}\nnamespace Minerval.S0000a002_v1\nend Minerval.S0000a002_v1\n`));
    expect(p3.errors.some((e) => /exactly one namespace/.test(e.message))).toBe(true);
  });

  it("requires `def Statement : Prop :=` and refuses a theorem or axiom named Statement", () => {
    const p = parseStatement(STATEMENT.replace("def Statement : Prop :=", "def Claim : Prop :="));
    expect(p.errors[0]!.message).toMatch(/def Statement : Prop :=/);
    const p2 = parseStatement(STATEMENT.replace("def Statement : Prop :=", "theorem Statement : True :="));
    expect(p2.ok).toBe(false);
  });

  it("applies the static policy to the body but not to the header lines", () => {
    const p = parseStatement(STATEMENT.replace("∀ n : ℕ, n + 0 = n", "sorry"));
    expect(p.ok).toBe(false);
    expect(p.policy.violations[0]!.token).toBe("sorry");
    expect(p.policy.violations[0]!.line).toBe(6);
    expect(parseStatement(STATEMENT).policy.ok).toBe(true);
  });
});

describe("submission assembly", () => {
  it("prepends a header whose only import is the statement module", () => {
    const { file, headerLines } = assembleSubmission(NS, "theorem x : True := trivial");
    const lines = file.split("\n");
    expect(lines[0]).toBe("import MinervalCheck.Statement");
    expect(lines[1]).toBe("set_option autoImplicit false");
    expect(lines[headerLines]).toBe("theorem x : True := trivial");
    expect(file.endsWith("\n")).toBe(true);
    expect(submissionHeader(NS).text.match(/import/g)).toHaveLength(1);
  });

  it("never interpolates anything but the namespace into the header", () => {
    const { text } = submissionHeader(NS);
    expect(text).not.toContain("canonical");
    expect(text).toContain(NS);
  });

  it("names the target by kind", () => {
    expect(targetName(NS, "proof")).toBe(`${NS}.proof`);
    expect(targetName(NS, "disproof")).toBe(`${NS}.disproof`);
  });

  it("builds scratch files with and without a statement", () => {
    expect(assembleScratch("x", true).file.startsWith("import MinervalCheck.Statement\n")).toBe(true);
    expect(assembleScratch("x", false).file.startsWith("import Mathlib\n")).toBe(true);
  });
});

describe("hashes", () => {
  it("normalises line endings, trailing whitespace, and trailing blank lines", () => {
    expect(normalizeSource("a \r\nb\t\r\n\r\n\r\n")).toBe("a\nb\n");
    expect(normalizeSource("a\nb")).toBe("a\nb\n");
  });

  it("source_hash is stable across normalisation and changes with the pin", () => {
    const h1 = sourceHash(STATEMENT, "mathlib-v4.33.0");
    const h2 = sourceHash(STATEMENT.replace(/\n/g, "  \r\n") + "\n\n", "mathlib-v4.33.0");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash(STATEMENT, "mathlib-v4.34.0")).not.toBe(h1);
    expect(sourceHash(STATEMENT.replace("n + 0", "0 + n"), "mathlib-v4.33.0")).not.toBe(h1);
  });

  it("expr_hash depends only on the pp.all text", () => {
    const pp = "∀ (n : Nat), @Eq.{1} Nat n n";
    expect(exprHash(pp)).toBe(exprHash(`  ${pp}\n`));
    expect(exprHash(pp)).not.toBe(exprHash(pp.replace("n n", "n m")));
    expect(exprHash(pp)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submission_sha256 is over the bytes exactly as received", () => {
    expect(submissionSha256("a\n")).not.toBe(submissionSha256("a\r\n"));
    expect(submissionSha256("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });
});
