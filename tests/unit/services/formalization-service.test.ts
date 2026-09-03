import { describe, it, expect, vi } from "vitest";

/**
 * The pure parts of the formalization service (docs/mathematics.md §5.4):
 * the namespace convention, the statement-file assembly that never
 * interpolates the canonical form, the normalization of a Steward's draft
 * into the checker-owned shape, and the SQL fragments the read models share.
 */

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
  getDb: () => {
    throw new Error("no database in this test");
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    formalizationReviewPeriodDays: 14,
    leanCpuHourCostMicroUsd: 200_000,
    leanCheckOverheadMicroUsd: 20_000,
    publicApiBaseUrl: "http://localhost:3000",
  }),
}));

import {
  ALLOWED_AXIOMS,
  assembleStatementFile,
  checkedKindSql,
  formalizationNamespace,
  leanCheckEvidenceUrl,
  normalizeStatementSource,
  statementDocstring,
} from "../../../src/services/formalization-service.js";

const CLAIM_ID = "9f2a1b3c-4d5e-4f60-8a71-000000000001";

describe("formalizationNamespace", () => {
  it("is Minerval.S<first 8 hex of the claim id>_v<version>", () => {
    expect(formalizationNamespace(CLAIM_ID, 1)).toBe("Minerval.S9f2a1b3c_v1");
    expect(formalizationNamespace(CLAIM_ID.toUpperCase(), 12)).toBe("Minerval.S9f2a1b3c_v12");
  });

  it("refuses an id that yields no hex prefix", () => {
    expect(() => formalizationNamespace("not-a-uuid", 1)).toThrow(/eight hex digits/);
  });
});

describe("assembleStatementFile", () => {
  const declarations = `def Statement : Prop :=
  ∀ n : ℕ, 2 < n → ¬ ∃ a b c : ℕ, 0 < a ∧ 0 < b ∧ 0 < c ∧ a ^ n + b ^ n = c ^ n
/-- Witness that the hypotheses are satisfiable. -/
example : ∃ n : ℕ, 2 < n := ⟨3, by norm_num⟩`;

  it("wraps the declarations in the checker's header, namespace, and fixed docstring", () => {
    const file = assembleStatementFile({ claimId: CLAIM_ID, version: 1, declarations });
    expect(file).toBe(`import Mathlib
set_option autoImplicit false
namespace Minerval.S9f2a1b3c_v1
/-- Statement 1 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/
def Statement : Prop :=
  ∀ n : ℕ, 2 < n → ¬ ∃ a b c : ℕ, 0 < a ∧ 0 < b ∧ 0 < c ∧ a ^ n + b ^ n = c ^ n
/-- Witness that the hypotheses are satisfiable. -/
example : ∃ n : ℕ, 2 < n := ⟨3, by norm_num⟩
end Minerval.S9f2a1b3c_v1
`);
  });

  it("never interpolates the canonical form: the docstring names only the version and the claim", () => {
    const doc = statementDocstring(CLAIM_ID, 3);
    expect(doc).toBe(
      "/-- Statement 3 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/"
    );
    // A canonical form containing `-/` would end the docstring; the
    // assembly takes no canonical text at all, so the file cannot carry it.
    const file = assembleStatementFile({ claimId: CLAIM_ID, version: 3, declarations });
    expect(file).not.toContain("every even");
    expect(file.split("/--").length - 1).toBe(2);
  });

  it("refuses declarations without a Statement definition", () => {
    expect(() =>
      assembleStatementFile({ claimId: CLAIM_ID, version: 1, declarations: "theorem t : True := trivial" })
    ).toThrow(/def Statement : Prop :=/);
  });
});

describe("normalizeStatementSource", () => {
  it("replaces the author's header, namespace, and docstring with the server's, keeping the rest verbatim", () => {
    const draft = `import Mathlib
import Mathlib.Tactic
set_option autoImplicit true
namespace Minerval.S9f2a1b3c_v9

/-- Fermat's last theorem: no three positive integers satisfy
    a^n + b^n = c^n for n > 2. -/
def Statement : Prop :=
  ∀ n : ℕ, 2 < n → ¬ ∃ a b c : ℕ, 0 < a ∧ 0 < b ∧ 0 < c ∧ a ^ n + b ^ n = c ^ n

/-- Witness that the hypotheses are satisfiable. -/
example : ∃ n : ℕ, 2 < n := ⟨3, by norm_num⟩
end Minerval.S9f2a1b3c_v9
`;
    const out = normalizeStatementSource(draft, { claimId: CLAIM_ID, version: 2 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source).toBe(`import Mathlib
set_option autoImplicit false
namespace Minerval.S9f2a1b3c_v2
/-- Statement 2 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/
def Statement : Prop :=
  ∀ n : ℕ, 2 < n → ¬ ∃ a b c : ℕ, 0 < a ∧ 0 < b ∧ 0 < c ∧ a ^ n + b ^ n = c ^ n

/-- Witness that the hypotheses are satisfiable. -/
example : ∃ n : ℕ, 2 < n := ⟨3, by norm_num⟩
end Minerval.S9f2a1b3c_v2
`);
    expect(out.source).not.toContain("Fermat");
  });

  it("accepts bare declarations and keeps local definitions before Statement", () => {
    const out = normalizeStatementSource(
      `def IsGood (n : ℕ) : Prop := 0 < n
def Statement : Prop := ∀ n : ℕ, IsGood (n + 1)`,
      { claimId: CLAIM_ID, version: 1 }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.declarations).toBe(`def IsGood (n : ℕ) : Prop := 0 < n
def Statement : Prop := ∀ n : ℕ, IsGood (n + 1)`);
    expect(out.source).toContain(`def IsGood (n : ℕ) : Prop := 0 < n
/-- Statement 1 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/
def Statement : Prop := ∀ n : ℕ, IsGood (n + 1)`);
  });

  it("refuses a draft without `def Statement : Prop :=`", () => {
    const out = normalizeStatementSource("theorem fermat : True := trivial", {
      claimId: CLAIM_ID,
      version: 1,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/def Statement : Prop :=/);
  });
});

describe("the check reference and the SQL fragments", () => {
  it("an argument cites a check by an evidence URL under /lean-checks/", () => {
    expect(leanCheckEvidenceUrl("abc")).toBe("/lean-checks/abc");
  });

  it("the machine-checked kind needs a published statement, an accepted verdict in an evidence mode, and a citing argument", () => {
    const sql = checkedKindSql("c.id");
    expect(sql).toContain("cf.status = 'published'");
    expect(sql).toContain("lc.verdict = 'accepted'");
    expect(sql).toContain("lc.mode IN ('prize', 'attempt', 'steward')");
    expect(sql).toContain("unnest(ar.evidence_urls)");
    expect(sql).toContain("/lean-checks/");
  });

  it("names the three allowed axioms", () => {
    expect([...ALLOWED_AXIOMS]).toEqual(["propext", "Classical.choice", "Quot.sound"]);
  });
});
