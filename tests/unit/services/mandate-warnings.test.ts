import { describe, expect, it } from "vitest";
import {
  draftWarnings,
  parseGrantmakerWarnings,
  unacknowledged,
  WARNING_MAX_CHARS,
  WARNINGS_MAX,
} from "../../../src/services/mandate-warnings.js";
import { alwaysAsks } from "../../../src/llm/tools/assistant-tools.js";

describe("a drafted mandate's warnings", () => {
  it("adds one when an anonymous funder's stake is shown, and none for a named funder or no stake", () => {
    const anon = draftWarnings({ funder_named: false, funder_stake: "I sit on the board of the largest operator." });
    expect(anon).toHaveLength(1);
    expect(anon[0]).toMatchObject({ about: "identity", raised_by: "platform" });
    expect(anon[0]!.text).toContain("largest operator");
    expect(draftWarnings({ funder_named: true, funder_stake: "I sit on the board." })).toEqual([]);
    expect(draftWarnings({ funder_named: false, funder_stake: null })).toEqual([]);
    expect(draftWarnings({ funder_named: false, funder_stake: "none" })).toEqual([]);
    expect(draftWarnings(null)).toEqual([]);
  });

  it("keeps the Grantmaker's warnings, with ids that follow what they say", () => {
    const parsed = parseGrantmakerWarnings([
      { about: "cost", text: "The quote may run over by half." },
      { about: "made-up", text: "Something else." },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.map((w) => w.about)).toEqual(["cost", "other"]);
    const again = parseGrantmakerWarnings([{ about: "cost", text: "The quote may run over by half." }]);
    expect(again.ok && again.warnings[0]!.id).toBe(parsed.warnings[0]!.id);
    const changed = parseGrantmakerWarnings([{ about: "cost", text: "The quote may run over by twice." }]);
    expect(changed.ok && changed.warnings[0]!.id).not.toBe(parsed.warnings[0]!.id);
    // Both kinds together, each once.
    const all = draftWarnings({ funder_named: false, funder_stake: "A stake.", warnings: parsed.warnings });
    expect(all.map((w) => w.raised_by)).toEqual(["platform", "grantmaker", "grantmaker"]);
  });

  it("refuses warnings it cannot show a funder", () => {
    expect(parseGrantmakerWarnings(undefined)).toEqual({ ok: true, warnings: [] });
    expect(parseGrantmakerWarnings("text").ok).toBe(false);
    expect(parseGrantmakerWarnings([{ about: "cost", text: "  " }]).ok).toBe(false);
    expect(parseGrantmakerWarnings([{ about: "cost", text: "x".repeat(WARNING_MAX_CHARS + 1) }]).ok).toBe(false);
    expect(
      parseGrantmakerWarnings(Array.from({ length: WARNINGS_MAX + 1 }, (_, i) => ({ about: "other", text: `w${i}` }))).ok
    ).toBe(false);
  });

  it("is acknowledged whole by true, or by naming every id", () => {
    const warnings = draftWarnings({ funder_named: false, funder_stake: "A stake." });
    expect(unacknowledged(warnings, undefined)).toHaveLength(1);
    expect(unacknowledged(warnings, false)).toHaveLength(1);
    expect(unacknowledged(warnings, ["w-other"])).toHaveLength(1);
    expect(unacknowledged(warnings, true)).toEqual([]);
    expect(unacknowledged(warnings, [warnings[0]!.id])).toEqual([]);
    expect(unacknowledged([], undefined)).toEqual([]);
  });

  it("is never acknowledged by the Assistant without the user's press", () => {
    expect(alwaysAsks("fund_grant", { budget_owls: 10, acknowledge_warnings: true })).toBe(true);
    expect(alwaysAsks("fund_grant", { budget_owls: 10, acknowledge_warnings: ["w-1"] })).toBe(true);
    expect(alwaysAsks("fund_grant", { budget_owls: 10 })).toBe(false);
    expect(alwaysAsks("fund_mandate", { owls: 10 })).toBe(false);
  });
});
