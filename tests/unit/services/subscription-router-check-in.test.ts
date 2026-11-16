/**
 * The text of a check-in that has come due: on time it names the time that
 * was set; late, it also says what time it is now and how late it is, so the
 * agent knows the world may have moved since (#1028).
 */
import { describe, it, expect } from "vitest";
import { checkInText, LATE_CHECK_IN_NOTICE_SECONDS } from "../../../src/services/subscription-router.js";

describe("checkInText", () => {
  it("names only the time set when the check-in arrives on time", () => {
    expect(checkInText("2026-11-13 04:06:00+00", "2026-11-13 04:07", 60)).toBe("The time you set has come (2026-11-13 04:06 UTC).");
    expect(checkInText("2026-11-13 04:06:00+00", "2026-11-13 04:11", LATE_CHECK_IN_NOTICE_SECONDS)).toBe(
      "The time you set has come (2026-11-13 04:06 UTC)."
    );
  });

  it("says the time now and how late it is when it arrives late", () => {
    const text = checkInText("2026-11-13 04:06:00+00", "2026-11-13 21:30", (17 * 60 + 24) * 60 + 30);
    expect(text).toContain("The time you set has come (2026-11-13 04:06 UTC)");
    expect(text).toContain("it is now 21:30 UTC, 17 h 24 min late");
  });

  it("names the date when the day has changed, and counts days", () => {
    const text = checkInText("2026-11-13 04:06:00+00", "2026-11-15 05:10", (2 * 24 * 60 + 64) * 60);
    expect(text).toContain("it is now 2026-11-15 05:10 UTC, 2 d 1 h 4 min late");
  });

  it("counts minutes alone when late by less than an hour", () => {
    expect(checkInText("2026-11-13T04:06:00Z", "2026-11-13 04:18", 12 * 60)).toContain("it is now 04:18 UTC, 12 min late");
  });
});
