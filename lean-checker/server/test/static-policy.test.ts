import { describe, expect, it } from "vitest";
import { blankCommentsAndStrings, scanStaticPolicy, UNAMBIGUOUS_TOKENS } from "../src/static-policy.js";

const ok = (src: string, profile: "submission" | "statement" | "scratch" = "submission") =>
  scanStaticPolicy(src, profile);

describe("static policy: unambiguous tokens", () => {
  it.each(UNAMBIGUOUS_TOKENS)("refuses `%s` as a whole word", (token) => {
    const r = ok(`theorem t : True := by\n  ${token}\n`);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.token)).toContain(token);
    expect(r.violations[0]!.line).toBe(2);
    expect(r.violations[0]!.column).toBe(2);
  });

  it("does not mistake PartialOrder for partial", () => {
    const r = ok("theorem t (α : Type) [PartialOrder α] (a : α) : a ≤ a := le_refl a\n");
    expect(r.ok).toBe(true);
  });

  it("does not mistake `important` in a comment for `import`", () => {
    const r = ok("-- this step is important\ntheorem t : True := trivial\n");
    expect(r.ok).toBe(true);
  });

  it("does not mistake `imported`, `sorry_lemma`, `unsafeCast'` or `Nat.partialOrder` for tokens", () => {
    const r = ok("theorem imported_sorry_lemma (unsafeCast' : Nat) : Nat.partialOrder = Nat.partialOrder := rfl\n");
    expect(r.ok).toBe(true);
  });

  it("refuses tokens glued to non-identifier characters", () => {
    expect(ok("theorem t : True := by exact (sorry)\n").ok).toBe(false);
    expect(ok("theorem t : True := by\n  first | trivial | admit\n").ok).toBe(false);
    expect(ok("theorem t : True := «sorry»\n").ok).toBe(false);
    expect(ok("exact Lean.ofReduceBool _ _ rfl\n").ok).toBe(false);
  });

  it("refuses `sorry` in a helper lemma, not just the target", () => {
    const r = ok("theorem helper : 1 = 1 := by sorry\ntheorem proof : 1 = 1 := helper\n");
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ token: "sorry", line: 1 });
  });

  it("ignores `sorry` inside comments, docstrings, nested block comments, and strings", () => {
    const src = [
      "/-- sorry, this is documentation -/",
      "/- outer /- nested sorry -/ still a comment -/",
      "-- sorry",
      "theorem t : \"sorry\".length = 5 := rfl",
      "theorem u : 'x' = 'x' := rfl -- admit nothing",
    ].join("\n");
    expect(ok(src).ok).toBe(true);
  });

  it("refuses an `import` anywhere in a submission", () => {
    const r = ok("theorem t : True := trivial\nimport Mathlib.Tactic\n");
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ token: "import", line: 2, column: 0 });
  });

  it("refuses the extended tokens too", () => {
    for (const bad of [
      "@[implemented_by foo] def bar : Nat := 1",
      "@[extern \"c_fn\"] def bar : Nat := 1",
      "@[csimp] theorem bar : @id = @id := rfl",
      "opaque bad : False",
      "#eval IO.println \"hi\"",
      "run_cmd logInfo \"hi\"",
      "macro \"foo\" : tactic => `(tactic| trivial)",
      "syntax \"foo\" : tactic",
      "elab \"foo\" : tactic => pure ()",
      "initialize x : Nat ← pure 1",
      "theorem t : 2 ^ 3 = 8 := by decide +native",
      "exact Lean.trustCompiler",
      "exact sorryAx _ false",
    ]) {
      expect(ok(bad).ok, bad).toBe(false);
    }
  });
});

describe("static policy: set_option allowlist", () => {
  it("allows maxHeartbeats up to 4,000,000 and maxRecDepth up to 8192", () => {
    expect(ok("set_option maxHeartbeats 4000000 in\ntheorem t : True := trivial\n").ok).toBe(true);
    expect(ok("set_option maxRecDepth 8192 in\ntheorem t : True := trivial\n").ok).toBe(true);
    expect(ok("set_option maxHeartbeats 400000\n").ok).toBe(true);
  });

  it("refuses values above the ceilings and non-integer values", () => {
    const r1 = ok("set_option maxHeartbeats 4000001 in\ntheorem t : True := trivial\n");
    expect(r1.ok).toBe(false);
    expect(r1.violations[0]!.reason).toMatch(/exceeds the ceiling/);
    expect(ok("set_option maxRecDepth 8193\n").ok).toBe(false);
    expect(ok("set_option maxHeartbeats 0x100\n").ok).toBe(false);
  });

  it("refuses every debug.* option and anything else off the allowlist", () => {
    const r = ok("set_option debug.skipKernelTC true in\ntheorem t : True := trivial\n");
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ token: "set_option debug.skipKernelTC", line: 1 });
    expect(r.violations[0]!.reason).toMatch(/debug/);
    expect(ok("set_option autoImplicit true\n").ok).toBe(false);
    expect(ok("set_option synthInstance.maxHeartbeats 100000\n").ok).toBe(false);
    expect(ok("set_option pp.all true in\n#check 1\n").ok).toBe(false);
  });
});

describe("static policy: scratch profile", () => {
  it("allows sorry, admit, native_decide, and pp options while iterating", () => {
    const src = "set_option pp.all true in\ntheorem t : 2 ^ 3 = 8 := by native_decide\ntheorem u : True := by sorry\n";
    expect(ok(src, "scratch").ok).toBe(true);
  });

  it("still refuses imports, elaboration-time execution, and debug options", () => {
    expect(ok("import Mathlib.Tactic\n", "scratch").ok).toBe(false);
    expect(ok("#eval 1 + 1\n", "scratch").ok).toBe(false);
    expect(ok("set_option debug.skipKernelTC true\n", "scratch").ok).toBe(false);
    expect(ok("macro \"x\" : tactic => `(tactic| trivial)\n", "scratch").ok).toBe(false);
  });
});

describe("blankCommentsAndStrings", () => {
  it("preserves length, newlines, and positions", () => {
    const comment = "-- comment";
    const block = "/- block\nstill -/";
    const str = "\"str\\\"ing\"";
    const chr = "'c'";
    const src = `a ${comment}\nb ${block} c ${str} ${chr} d'\n`;
    const out = blankCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    const blank = (t: string) => t.replace(/[^\n]/g, " ");
    expect(out).toBe(`a ${blank(comment)}\nb ${blank(block)} c ${blank(str)} ${blank(chr)} d'\n`);
  });

  it("handles an unterminated block comment or string without looping", () => {
    expect(blankCommentsAndStrings("/- never closed\nsorry")).not.toContain("sorry");
    expect(blankCommentsAndStrings('"never closed\nsorry')).not.toContain("sorry");
  });
});
