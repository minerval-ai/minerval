import { describe, it, expect } from "vitest";

// F45: /signin?callbackUrl=/%5Cevil.example was an open redirect because the
// old check only looked at "/" vs "//". isSafeRelativePath is the shared
// same-site return-to check.
import { isSafeRelativePath } from "../../../web/lib/safe-redirect";
import {
  ORIGIN,
  OFF_SITE_BYPASSES,
  ALWAYS_REJECTED,
  SAME_SITE_CONTROL_CHAR_PATHS,
  HONEST_PATHS,
  viaSigninLink,
} from "./fixtures/callback-urls";

// Node's WHATWG URL parser is the one browsers implement; resolve the way a
// browser resolves a Location header received from /signin.
function resolvesSameSite(value: string): boolean {
  try {
    return new URL(value, `${ORIGIN}/signin`).origin === ORIGIN;
  } catch {
    return false;
  }
}

// The pre-F45 check, for comparison.
const oldCheckAccepts = (value: string) => value.startsWith("/") && !value.startsWith("//");

describe("isSafeRelativePath", () => {
  it.each(OFF_SITE_BYPASSES)("the browser really resolves %s off-site", (_label, value) => {
    expect(oldCheckAccepts(value)).toBe(true);
    expect(resolvesSameSite(value)).toBe(false);
  });

  it.each(OFF_SITE_BYPASSES)("rejects %s", (_label, value) => {
    expect(isSafeRelativePath(value)).toBe(false);
  });

  it.each(ALWAYS_REJECTED)("rejects %s", (_label, value) => {
    expect(isSafeRelativePath(value)).toBe(false);
  });

  it("rejects a missing value", () => {
    expect(isSafeRelativePath(undefined)).toBe(false);
  });

  it.each(SAME_SITE_CONTROL_CHAR_PATHS)("accepts %s, as the old check did", (_label, value) => {
    expect(resolvesSameSite(value)).toBe(true);
    expect(isSafeRelativePath(value)).toBe(true);
  });

  it.each(HONEST_PATHS)("accepts the %s callback after the signin-link round trip", (_src, path) => {
    const received = viaSigninLink(path);
    expect(received).toBe(path);
    expect(isSafeRelativePath(received)).toBe(true);
  });

  it("accepts same-site paths with percent escapes, query and fragment", () => {
    for (const p of ["/claims/caf%C3%A9", "/%5Cnot-a-host", "/claims?q=a%2Fb&x=1", "/claims#contribute"]) {
      expect(isSafeRelativePath(p)).toBe(true);
    }
  });

  it("accepts exactly what the old check accepted minus what leaves the site (exhaustive, length <= 4)", () => {
    const alphabet = ["/", "\\", "\t", "\n", "\r", "\u0000", "\u0001", "\u001f", "\u007f", " ", "a", ".", "@", ":", "%"];
    let level = [""];
    const all = [""];
    for (let len = 1; len <= 4; len++) {
      level = level.flatMap((prefix) => alphabet.map((c) => prefix + c));
      all.push(...level);
    }
    const mismatches = all.filter(
      (v) => isSafeRelativePath(v) !== (oldCheckAccepts(v) && resolvesSameSite(v))
    );
    expect(all.length).toBeGreaterThan(50_000);
    expect(mismatches.map((v) => JSON.stringify(v))).toEqual([]);
  });
});
