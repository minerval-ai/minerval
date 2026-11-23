/**
 * The check of a safety case's form (src/services/case-form.ts, #1211):
 * form is checked, content is judged. The check reads the exported form of
 * a case and no database.
 */
import { describe, it, expect } from "vitest";
import {
  CASE_EXPORT_FORMAT,
  checkCaseForm,
  countsAgainst,
  misplacement,
  readCaseExport,
  type CaseExportElement,
} from "../../../src/services/case-form.js";

const node = (id: string) => ({ id, kind: "claim", text: id, judgment: null });
const el = (id: string, type: string, parent: string | null, rest: Partial<CaseExportElement> = {}): CaseExportElement => ({
  id,
  type,
  parent,
  statement: id,
  ...(type === "step" ? {} : { node: node(id) }),
  ...rest,
});

/** A well formed case: a concretion to one claim, which bottoms out in evidence, each step with its side claim. */
const SOUND: CaseExportElement[] = [
  el("top", "claim", null),
  el("s1", "step", "top", { block: "concretion" }),
  el("s1-side", "side_claim", "s1", { departure: "Taken as given." }),
  el("c1", "claim", "s1"),
  el("s2", "step", "c1", { block: "evidence_incorporation" }),
  el("s2-side", "side_claim", "s2", { departure: "Taken as given." }),
  el("e1", "evidence", "s2"),
];
const rules = (elements: CaseExportElement[], framework = "assurance_2_cae") =>
  checkCaseForm(elements, framework).filter((f) => !f.departure).map((f) => `${f.rule}@${f.element}`);

describe("the check of a case's form", () => {
  it("passes a case whose every step is a known block with a side claim and whose leaves are evidence", () => {
    expect(rules(SOUND)).toEqual([]);
    // The side claims no step argues for are still failures of form, each with the departure the Steward stated.
    expect(checkCaseForm(SOUND, "assurance_2_cae").map((f) => [f.rule, f.departure])).toEqual([
      ["undeveloped_claim", "Taken as given."],
      ["undeveloped_claim", "Taken as given."],
    ]);
  });

  it("finds a step with no side claim, and says of a substitution that nothing says why it transfers", () => {
    const without = SOUND.filter((e) => e.id !== "s1-side").map((e) => (e.id === "s1" ? { ...e, block: "substitution" } : e));
    const found = checkCaseForm(without, "assurance_2_cae").find((f) => f.rule === "no_side_claim")!;
    expect(found.element).toBe("s1");
    expect(found.message).toMatch(/substitution has no side claim/);
  });

  it("finds a block the framework does not have, a leaf that is not evidence, and evidence under another block", () => {
    expect(rules(SOUND.map((e) => (e.id === "s1" ? { ...e, block: "analogy" } : e)))).toContain("unknown_block@s1");
    expect(rules(SOUND.filter((e) => !["s2", "s2-side", "e1"].includes(e.id)))).toContain("undeveloped_claim@c1");
    expect(rules(SOUND.filter((e) => e.id !== "e1"))).toContain("no_evidence@s2");
    expect(rules([...SOUND, el("e2", "evidence", "s1")])).toContain("evidence_outside_incorporation@e2");
    expect(rules(SOUND.filter((e) => !["c1", "s2", "s2-side", "e1"].includes(e.id)))).toContain("no_subclaims@s1");
  });

  it("checks what a structure is whatever the framework, and the framework's rules only where it is named", () => {
    const bare = [el("top", "claim", null), el("s1", "step", "top", { block: "decomposition" })];
    expect(rules(bare, "none")).toEqual([]);
    expect(rules(bare)).toEqual(expect.arrayContaining(["no_side_claim@s1", "no_subclaims@s1"]));
    expect(rules([el("a", "claim", null), el("b", "claim", null)], "none")).toEqual(["several_top_claims@b"]);
    expect(rules([el("s", "step", null, { block: "decomposition" })], "none")).toEqual(expect.arrayContaining(["no_top_claim@null", "misplaced@s"]));
    expect(rules([el("top", "claim", null), el("x", "claim", "gone")], "none")).toEqual(["orphan@x"]);
    expect(rules([el("top", "claim", null), el("d", "defeater", "top", { standing: "answered" })], "none")).toEqual(["answered_without_subcase@d"]);
    expect(rules([el("top", "claim", null), el("d", "defeater", "top", { standing: "refuted" })], "none")).toEqual(["unknown_standing@d"]);
  });

  it("says where each kind of element may hang", () => {
    expect(misplacement("claim", null)).toBeNull();
    expect(misplacement("claim", "defeater")).toBeNull();
    expect(misplacement("defeater", "evidence")).toBeNull();
    expect(misplacement("step", "side_claim")).toBeNull();
    expect(misplacement("evidence", "claim")).toMatch(/hangs under a step/);
    expect(misplacement("defeater", "defeater")).toMatch(/not under a defeater/);
    expect(misplacement("step", null)).toMatch(/Only the case's top claim/);
  });
});

describe("what counts against a case that carries the burden", () => {
  it("is an open defeater, a sustained one nobody accepted, and a failure of form with no stated departure", () => {
    const elements = [
      ...SOUND,
      el("open", "defeater", "c1", { standing: "open" }),
      el("kept", "defeater", "e1", { standing: "sustained" }),
      el("residual", "defeater", "top", { standing: "sustained", accepted_by: "The board", acceptance: "In its minute of May." }),
      el("stray", "step", "top", { block: "calculation" }),
    ];
    const against = countsAgainst(elements, checkCaseForm(elements, "assurance_2_cae"));
    expect(against.map((a) => `${a.kind}@${a.element}`).sort()).toEqual([
      "form@stray",
      "form@stray",
      "open_defeater@open",
      "sustained_defeater_not_accepted@kept",
    ]);
  });
});

describe("reading an export back", () => {
  it("checks the form afresh from the elements, and refuses what is not an export", () => {
    const doc = { format: CASE_EXPORT_FORMAT, case: { framework: "assurance_2_cae" }, elements: SOUND.filter((e) => e.id !== "s1-side"), form: { failures: [] } };
    expect(readCaseExport(doc).failures.map((f) => f.rule)).toContain("no_side_claim");
    expect(() => readCaseExport({ format: "something-else", elements: [] })).toThrow(/Not a case export/);
    expect(() => readCaseExport(null)).toThrow(/Not a case export/);
  });
});
