import { describe, it, expect } from "vitest";

/**
 * Today's date at the LLM seam (llm/run-date.ts, #771): every call with a
 * system prompt is told the date, after its last block so the cached prefix
 * is untouched, once, however many seam functions the call passes through.
 */

import { runDateLine, withRunDate } from "../../../src/llm/run-date.js";

const NOW = new Date("2026-11-03T23:59:00Z");

describe("withRunDate", () => {
  it("says the UTC date and why it matters", () => {
    expect(runDateLine(NOW)).toMatch(/^Today's date is 2026-11-03 \(UTC\)\. Read every source/);
  });

  it("appends the date to a string prompt, and to the last non-empty block of a block prompt", () => {
    expect(withRunDate("role", NOW)).toBe(`role\n\n${runDateLine(NOW)}`);
    expect(withRunDate(["constitution and role", "skill", ""], NOW)).toEqual([
      "constitution and role",
      `skill\n\n${runDateLine(NOW)}`,
      "",
    ]);
  });

  it("dates once: a loop's dated prompt passed on to completeWithTools is not dated again", () => {
    const once = withRunDate(["role", "skill"], NOW);
    expect(withRunDate(once, new Date("2026-11-04T00:01:00Z"))).toBe(once);
  });

  it("leaves a call with no system prompt, or only empty blocks, alone", () => {
    expect(withRunDate(undefined, NOW)).toBeUndefined();
    expect(withRunDate(["", ""], NOW)).toEqual(["", ""]);
  });

  it("does not mistake a role prompt that mentions today's date for a dated one", () => {
    const role = "And today's date is in the task message: read every source against it.";
    expect(withRunDate(role, NOW)).toBe(`${role}\n\n${runDateLine(NOW)}`);
  });
});
