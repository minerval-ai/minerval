/**
 * The pure prize-claim rules (docs/mathematics.md §8.4, §8.5): the
 * transition matrix, the window by tier, the pause cap, the cooldown
 * ladder, the static scan, tie groups and supersession, the sign-off rule,
 * the rate-limit rules over counts, and the one-time code.
 */
import { describe, it, expect } from "vitest";
import {
  PRIZE_CLAIM_TRANSITIONS,
  TERMINAL_PRIZE_CLAIM_STATUSES,
  QUEUE_HOLDING_STATUSES,
  canTransition,
  assertTransition,
  challengeWindowDays,
  windowEndsAt,
  effectiveWindowEnd,
  windowHasElapsed,
  cooldownMsForFailures,
  cooldownDecision,
  COOLDOWN_CAP_MS,
  scanLeanPolicy,
  stripLeanComments,
  leanExcerpt,
  tieGroupShare,
  claimsToSupersede,
  tieGroupSettled,
  signoffRequired,
  rateLimitDecision,
  declarationsProblem,
  issuePrizeClaimCode,
  verifyPrizeClaimCode,
  PRIZE_CODE_TTL_MS,
} from "../../../src/services/prize-claim-service.js";
import { PRIZE_RULES_VERSION } from "../../../src/services/bounty-service.js";
import type { PrizeClaimStatus } from "../../../src/services/claim-extras-types.js";

const ALL: PrizeClaimStatus[] = [
  "queued", "checking", "check_error", "checked", "in_review", "in_challenge_window",
  "payable", "defect_award_pending", "paid", "rejected", "voided", "withdrawn", "superseded", "forfeited",
];

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("the transition matrix", () => {
  it("names every status exactly once and terminals go nowhere", () => {
    expect(Object.keys(PRIZE_CLAIM_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const t of TERMINAL_PRIZE_CLAIM_STATUSES) expect(PRIZE_CLAIM_TRANSITIONS[t]).toEqual([]);
  });

  it("follows §8.4: queued → checking → checked | rejected | check_error; checked → in_review; in_review → window | rejected | defect; window → payable; payable → paid | forfeited", () => {
    expect(canTransition("queued", "checking")).toBe(true);
    expect(canTransition("checking", "checked")).toBe(true);
    expect(canTransition("checking", "rejected")).toBe(true);
    expect(canTransition("checking", "check_error")).toBe(true);
    expect(canTransition("checking", "queued")).toBe(true);
    expect(canTransition("check_error", "queued")).toBe(true);
    expect(canTransition("checked", "in_review")).toBe(true);
    expect(canTransition("in_review", "in_challenge_window")).toBe(true);
    expect(canTransition("in_review", "rejected")).toBe(true);
    expect(canTransition("in_review", "defect_award_pending")).toBe(true);
    expect(canTransition("in_challenge_window", "payable")).toBe(true);
    expect(canTransition("in_challenge_window", "voided")).toBe(true);
    // The audit's send-back returns the window to review for a fresh decision (§8.5).
    expect(canTransition("in_challenge_window", "in_review")).toBe(true);
    expect(canTransition("payable", "paid")).toBe(true);
    expect(canTransition("payable", "forfeited")).toBe(true);
    expect(canTransition("defect_award_pending", "paid")).toBe(true);
  });

  it("refuses the moves the design forbids", () => {
    expect(canTransition("queued", "checked")).toBe(false);
    expect(canTransition("queued", "paid")).toBe(false);
    expect(canTransition("checked", "in_challenge_window")).toBe(false);
    expect(canTransition("in_review", "payable")).toBe(false);
    expect(canTransition("in_challenge_window", "paid")).toBe(false);
    expect(canTransition("payable", "in_review")).toBe(false);
    expect(canTransition("in_challenge_window", "checked")).toBe(false);
    expect(canTransition("paid", "voided")).toBe(false);
    expect(canTransition("rejected", "queued")).toBe(false);
    expect(() => assertTransition("paid", "payable")).toThrow(/cannot move/);
  });

  it("every non-terminal status can be withdrawn, voided, or (outside the defect path) superseded", () => {
    for (const s of ALL) {
      if (TERMINAL_PRIZE_CLAIM_STATUSES.includes(s)) continue;
      expect(canTransition(s, "withdrawn")).toBe(true);
      expect(canTransition(s, "voided")).toBe(true);
      if (s !== "defect_award_pending") expect(canTransition(s, "superseded")).toBe(true);
    }
  });

  it("the queue-holding statuses are the five §8.4 names", () => {
    expect([...QUEUE_HOLDING_STATUSES]).toEqual(["checking", "check_error", "checked", "in_review", "in_challenge_window"]);
  });
});

describe("the challenge window", () => {
  const cfg = { prizeChallengeWindowDaysSmall: 14, prizeChallengeWindowDaysLarge: 30, prizeWindowTierOwls: 1000 };

  it("is 14 days below the tier and 30 at or above it", () => {
    expect(challengeWindowDays(999_990_000, cfg)).toBe(14);
    expect(challengeWindowDays(1_000_000_000, cfg)).toBe(30);
    expect(challengeWindowDays(2_500_000_000, cfg)).toBe(30);
  });

  it("is never below 14 days whatever the configuration says", () => {
    expect(challengeWindowDays(1, { ...cfg, prizeChallengeWindowDaysSmall: 3 })).toBe(14);
  });

  it("ends the window that many days after acceptance", () => {
    const at = new Date("2026-03-01T00:00:00Z");
    expect(windowEndsAt(at, 14).toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("pauses only while an admitted challenge is open, and caps the total pause at twice the window", () => {
    const ends = new Date("2026-03-15T00:00:00Z");
    const base = { windowEndsAt: ends, windowDays: 14, pausedMs: 0, openPauseStartedAt: null, now: ends };
    expect(windowHasElapsed(base)).toBe(true);
    // A pause of 3 days already closed pushes the end by 3 days.
    const paused = { ...base, pausedMs: 3 * DAY };
    expect(effectiveWindowEnd(paused).endsAt.getTime()).toBe(ends.getTime() + 3 * DAY);
    expect(windowHasElapsed(paused)).toBe(false);
    expect(windowHasElapsed({ ...paused, now: new Date(ends.getTime() + 3 * DAY) })).toBe(true);
    // An open challenge holds the window past its end.
    const open = { ...base, openPauseStartedAt: new Date(ends.getTime() - DAY), now: new Date(ends.getTime() + 5 * DAY) };
    expect(windowHasElapsed(open)).toBe(false);
    // Beyond twice the window (28 days of pause) only a human sign-off may hold payment.
    const capped = { ...base, pausedMs: 20 * DAY, openPauseStartedAt: new Date(ends.getTime()), now: new Date(ends.getTime() + 10 * DAY) };
    const eff = effectiveWindowEnd(capped);
    expect(eff.capped).toBe(true);
    expect(eff.pausedMs).toBe(28 * DAY);
    expect(windowHasElapsed({ ...capped, now: new Date(ends.getTime() + 28 * DAY) })).toBe(true);
    expect(windowHasElapsed({ ...capped, now: new Date(ends.getTime() + 27 * DAY) })).toBe(false);
  });
});

describe("the cooldown ladder", () => {
  it("doubles from 24 hours to a cap of seven days", () => {
    expect(cooldownMsForFailures(0)).toBe(0);
    expect(cooldownMsForFailures(1)).toBe(24 * HOUR);
    expect(cooldownMsForFailures(2)).toBe(48 * HOUR);
    expect(cooldownMsForFailures(3)).toBe(96 * HOUR);
    expect(cooldownMsForFailures(4)).toBe(COOLDOWN_CAP_MS);
    expect(cooldownMsForFailures(9)).toBe(COOLDOWN_CAP_MS);
  });

  it("waives one resubmission within 72 hours, then blocks until the ladder runs out", () => {
    const f1 = new Date("2026-03-01T00:00:00Z");
    // First failure, an hour later: waived (near-miss fix by its author).
    const first = cooldownDecision({ failures: [f1], submissions: [new Date(f1.getTime() - HOUR)], now: new Date(f1.getTime() + HOUR) });
    expect(first).toMatchObject({ blocked: false, waived: true });
    // The waiver was used (a filing landed inside the cooldown); the second failure blocks for 48h.
    const f2 = new Date(f1.getTime() + 2 * HOUR);
    const second = cooldownDecision({
      failures: [f1, f2],
      submissions: [new Date(f1.getTime() - HOUR), new Date(f1.getTime() + HOUR)],
      now: new Date(f2.getTime() + HOUR),
    });
    expect(second.blocked).toBe(true);
    expect(second.retryAt?.getTime()).toBe(f2.getTime() + 48 * HOUR);
    // After the ladder elapses, filing is open again.
    expect(cooldownDecision({ failures: [f1, f2], submissions: [], now: new Date(f2.getTime() + 49 * HOUR) }).blocked).toBe(false);
  });

  it("does not waive after 72 hours even when unused", () => {
    const f1 = new Date("2026-03-01T00:00:00Z");
    const later = cooldownDecision({ failures: [f1], submissions: [], now: new Date(f1.getTime() + 73 * HOUR) });
    // 73h is past the 24h cooldown anyway; make the ladder longer to see the waiver's edge.
    expect(later.blocked).toBe(false);
    const f2 = new Date(f1.getTime() + HOUR);
    const f3 = new Date(f2.getTime() + HOUR);
    const f4 = new Date(f3.getTime() + HOUR);
    const deep = cooldownDecision({ failures: [f1, f2, f3, f4], submissions: [], now: new Date(f4.getTime() + 73 * HOUR) });
    expect(deep.blocked).toBe(true);
    expect(deep.waived).toBe(false);
  });
});

describe("the static scan", () => {
  it("strips line and block comments, docstrings included", () => {
    expect(stripLeanComments("theorem x : True := by\n  -- sorry here\n  trivial")).not.toMatch(/sorry/);
    expect(stripLeanComments("/-- doc with axiom -/\ntheorem x : True := trivial")).not.toMatch(/axiom/);
    expect(stripLeanComments("/- outer /- nested import -/ still -/ theorem")).toBe(" theorem");
  });

  it("finds each forbidden token at a word boundary, and not inside identifiers", () => {
    for (const tok of ["sorry", "admit", "axiom", "native_decide", "import", "unsafe", "partial"]) {
      const hit = scanLeanPolicy(`theorem t : True := by\n  ${tok}`);
      expect(hit?.token).toBe(tok);
      expect(hit?.line).toBe(2);
    }
    expect(scanLeanPolicy("theorem sorry_free : True := trivial")).toBeNull();
    expect(scanLeanPolicy("theorem x : Nat.partialOrder = Nat.partialOrder := rfl")).toBeNull();
    expect(scanLeanPolicy("theorem y : True := by exact trivial -- import not here")).toBeNull();
  });

  it("bounds the excerpt to the requested length", () => {
    const long = "theorem t : True := trivial\n".repeat(400);
    const ex = leanExcerpt(long, 4000);
    expect(ex.length).toBeLessThan(4100);
    expect(ex).toMatch(/more characters/);
  });
});

describe("tie groups and supersession", () => {
  it("splits equally with no random selection", () => {
    expect(tieGroupShare(1_000_000_000, 1)).toBe(1_000_000_000);
    expect(tieGroupShare(1_000_000_000, 2)).toBe(500_000_000);
    expect(tieGroupShare(1_000_000_001, 2)).toBe(500_000_000);
  });

  it("supersedes non-terminal claims outside the paid claim's tie group, and only those", () => {
    const paid = { id: "a", status: "paid" as const, tie_group: "g1" };
    const all = [
      paid,
      { id: "b", status: "in_challenge_window" as const, tie_group: "g1" },
      { id: "c", status: "queued" as const, tie_group: null },
      { id: "d", status: "rejected" as const, tie_group: null },
      { id: "e", status: "checked" as const, tie_group: "g2" },
    ];
    expect(claimsToSupersede(all, paid)).toEqual(["c", "e"]);
    expect(tieGroupSettled(all, paid)).toBe(false);
    expect(tieGroupSettled(all.map((c) => (c.id === "b" ? { ...c, status: "paid" as const } : c)), paid)).toBe(true);
    expect(tieGroupSettled([{ id: "z", status: "paid", tie_group: null }], { id: "z", status: "paid", tie_group: null })).toBe(true);
  });
});

describe("the sign-off rule", () => {
  const cfg = { prizeHumanSignoffOwls: 1000, prizeHumanSignoffImportance: 0.6 };
  const base = { amountMicroUsd: 500_000_000, importance: 0.3, reviewStatus: "accepted", arbitrationHumanReview: false, secondOpinionDisagrees: false, fallbackRan: false, screeningResult: "clear" };

  it("is not required for a small prize on an ordinary claim with a clean record", () => {
    expect(signoffRequired(base, cfg).required).toBe(false);
  });

  it("is required for each of §8.5's conditions", () => {
    expect(signoffRequired({ ...base, amountMicroUsd: 1_000_000_000 }, cfg).required).toBe(true);
    expect(signoffRequired({ ...base, importance: 0.6 }, cfg).required).toBe(true);
    expect(signoffRequired({ ...base, reviewStatus: "human_review" }, cfg).required).toBe(true);
    expect(signoffRequired({ ...base, arbitrationHumanReview: true }, cfg).required).toBe(true);
    expect(signoffRequired({ ...base, secondOpinionDisagrees: true }, cfg).required).toBe(true);
    expect(signoffRequired({ ...base, fallbackRan: true }, cfg).reasons).toEqual(["the Steward's decision was served by a fallback model"]);
    expect(signoffRequired({ ...base, screeningResult: "unclear" }, cfg).required).toBe(true);
    expect(signoffRequired({ ...base, screeningResult: null }, cfg).required).toBe(false);
  });
});

describe("the rate-limit rules", () => {
  const cfg = { prizeClaimsPerStatementPer30Days: 3, prizeClaimsPerDayPlatform: 5 };
  const now = new Date("2026-03-10T12:00:00Z");
  const seasoned = { reputationScore: 60, createdAt: new Date("2025-01-01") };
  const empty = { perStatement30d: 0, platformToday: 0, claimantToday: 0, claimantFailures: [], claimantSubmissions: [] };

  it("passes an ordinary filer", () => {
    expect(rateLimitDecision(empty, seasoned, now, cfg).limited).toBe(false);
  });
  it("caps three per statement in 30 days", () => {
    expect(rateLimitDecision({ ...empty, perStatement30d: 3 }, seasoned, now, cfg)).toMatchObject({ limited: true, message: /per statement/ });
  });
  it("caps five per day platform-wide", () => {
    expect(rateLimitDecision({ ...empty, platformToday: 5 }, seasoned, now, cfg)).toMatchObject({ limited: true, message: /platform-wide/ });
  });
  it("caps sandboxed accounts (under 50 reputation or under 24 hours) at one per day", () => {
    expect(rateLimitDecision({ ...empty, claimantToday: 1 }, { reputationScore: 40, createdAt: seasoned.createdAt }, now, cfg).limited).toBe(true);
    expect(rateLimitDecision({ ...empty, claimantToday: 1 }, { reputationScore: 70, createdAt: new Date(now.getTime() - HOUR) }, now, cfg).limited).toBe(true);
    expect(rateLimitDecision({ ...empty, claimantToday: 1 }, seasoned, now, cfg).limited).toBe(false);
  });
  it("applies the cooldown ladder with a retry time", () => {
    const f = new Date(now.getTime() - 2 * HOUR);
    const r = rateLimitDecision({ ...empty, claimantFailures: [f], claimantSubmissions: [new Date(f.getTime() + HOUR)] }, seasoned, now, cfg);
    expect(r.limited).toBe(true);
    expect(r.retryAt?.getTime()).toBe(f.getTime() + 24 * HOUR);
  });
});

describe("the declarations", () => {
  const ok = { eligibility: true, understanding: true, cc0: true };
  const residency = { country: "GB", us_person: false };
  it("accepts a complete form under the rules version in force", () => {
    expect(declarationsProblem(ok, PRIZE_RULES_VERSION, "GPT-assisted lemma search", residency, "A. Turing")).toBeNull();
  });
  it("names the first missing declaration, a stale rules version, and missing disclosures", () => {
    expect(declarationsProblem({ ...ok, cc0: false }, PRIZE_RULES_VERSION, "x", residency, "n")).toMatch(/cc0/);
    expect(declarationsProblem(ok, "2020-01-01", "x", residency, "n")).toMatch(/rules version/);
    expect(declarationsProblem(ok, PRIZE_RULES_VERSION, "", residency, "n")).toMatch(/tools disclosure/);
    expect(declarationsProblem(ok, PRIZE_RULES_VERSION, "x", { country: "", us_person: false }, "n")).toMatch(/country/);
    expect(declarationsProblem(ok, PRIZE_RULES_VERSION, "x", { country: "GB", us_person: null }, "n")).toMatch(/U\.S\./);
    expect(declarationsProblem(ok, PRIZE_RULES_VERSION, "x", residency, " ")).toMatch(/credit name/);
  });
});

describe("the one-time code", () => {
  const cfg = { minervalOperatorKey: "op-secret", apiKeys: [] as string[] } as never;
  const now = new Date("2026-03-01T00:00:00Z");
  it("verifies only for the same claim, account, and purpose, and only until it expires", () => {
    const { code, expires_at } = issuePrizeClaimCode({ prizeClaimId: "pc1", userId: "u1", purpose: "payee" }, now, cfg);
    expect(new Date(expires_at).getTime()).toBe(now.getTime() + PRIZE_CODE_TTL_MS);
    expect(verifyPrizeClaimCode(code, { prizeClaimId: "pc1", userId: "u1", purpose: "payee" }, now, cfg)).toBe(true);
    expect(verifyPrizeClaimCode(code, { prizeClaimId: "pc2", userId: "u1", purpose: "payee" }, now, cfg)).toBe(false);
    expect(verifyPrizeClaimCode(code, { prizeClaimId: "pc1", userId: "u2", purpose: "payee" }, now, cfg)).toBe(false);
    expect(verifyPrizeClaimCode(code, { prizeClaimId: "pc1", userId: "u1", purpose: "withdraw" }, now, cfg)).toBe(false);
    expect(verifyPrizeClaimCode(code, { prizeClaimId: "pc1", userId: "u1", purpose: "payee" }, new Date(now.getTime() + PRIZE_CODE_TTL_MS + 1), cfg)).toBe(false);
    expect(verifyPrizeClaimCode(`${code}x`, { prizeClaimId: "pc1", userId: "u1", purpose: "payee" }, now, cfg)).toBe(false);
    expect(verifyPrizeClaimCode("", { prizeClaimId: "pc1", userId: "u1", purpose: "payee" }, now, cfg)).toBe(false);
  });
});
