import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { MODELS, isAnthropicModelId, DEFAULT_MODEL } from "../../src/llm/models.js";

describe("model IDs", () => {
  it("DEFAULT_MODEL is the shared Sonnet ID", () => {
    expect(DEFAULT_MODEL).toBe(MODELS.sonnet);
  });

  it("accepts Anthropic API IDs", () => {
    expect(isAnthropicModelId("claude-sonnet-5")).toBe(true);
    expect(isAnthropicModelId("claude-fable-5-1")).toBe(true);
    expect(isAnthropicModelId("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("rejects Bedrock-style IDs", () => {
    expect(isAnthropicModelId("us.anthropic.claude-sonnet-4-20250514")).toBe(false);
    expect(isAnthropicModelId("anthropic.claude-3-haiku")).toBe(false);
  });
});

describe("loadConfig model defaults", () => {
  const MODEL_ENV = ["GOVERNANCE_MODEL", "ARBITRATION_MODEL", "AUDIT_MODEL", "CURATOR_MODEL"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of MODEL_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of MODEL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to Anthropic API model IDs", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.governanceModel).toBe(MODELS.sonnet);
    expect(config.arbitrationModel).toBe(MODELS.sonnet);
    expect(config.auditModel).toBe(MODELS.sonnet);
    expect(config.curatorModel).toBe(MODELS.sonnet);
  });

  it("rejects a Bedrock-style override", async () => {
    process.env.GOVERNANCE_MODEL = "us.anthropic.claude-sonnet-4-20250514";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/Bedrock/);
  });

  it("accepts an OpenAI model override", async () => {
    process.env.GOVERNANCE_MODEL = "gpt-5-nano";
    const { loadConfig } = await import("../../src/config.js");
    expect(loadConfig().governanceModel).toBe("gpt-5-nano");
  });

  it("accepts an OpenRouter vendor/model override", async () => {
    process.env.GOVERNANCE_MODEL = "qwen/qwen3-235b-a22b";
    const { loadConfig } = await import("../../src/config.js");
    expect(loadConfig().governanceModel).toBe("qwen/qwen3-235b-a22b");
  });

  it("rejects an ID that resolves to no provider", async () => {
    process.env.GOVERNANCE_MODEL = "llama-3-70b";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/does not resolve to a known provider/);
  });
});

describe("loadConfig load-bearing model env guard (#100)", () => {
  // EXTRACTOR_MODEL is load-bearing too: it authors the graph's canonical
  // language, and its absence from this list is what let it run the cheap
  // default through the first live epoch unnoticed.
  // SOLVER_MODEL joins the guard (docs/mathematics.md §7.8): a multi-hour
  // attempt on a model nobody chose is a different product than the
  // mandate funded, so production names it even while the solver is off.
  // STEWARD_STRONG_MODEL joins it too (docs/mathematics.md §6.4): the
  // Steward's six money triggers run on it and nowhere else, and the direct
  // invocation refuses production without it, so the boot must refuse first.
  const MODEL_ENV = [
    "STEWARD_MODEL",
    "CURATOR_MODEL",
    "AUDIT_MODEL",
    "ARBITRATION_MODEL",
    "EXTRACTOR_MODEL",
    "SOLVER_MODEL",
    "STEWARD_STRONG_MODEL",
  ];
  const saved: Record<string, string | undefined> = {};
  let savedEnvironment: string | undefined;

  beforeEach(() => {
    for (const k of MODEL_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    savedEnvironment = process.env.ENVIRONMENT;
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of MODEL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
    vi.restoreAllMocks();
  });

  it("throws in production when a load-bearing model env is unset", async () => {
    process.env.ENVIRONMENT = "production";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/STEWARD_MODEL/);
  });

  it("names only the missing envs", async () => {
    process.env.ENVIRONMENT = "production";
    process.env.STEWARD_MODEL = "claude-fable-5-1";
    process.env.CURATOR_MODEL = "claude-fable-5-1";
    process.env.AUDIT_MODEL = "claude-fable-5-1";
    const { loadConfig } = await import("../../src/config.js");
    let message = "";
    try {
      loadConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("ARBITRATION_MODEL");
    // The Extractor is named too: it went a whole live epoch on the cheap
    // default because this guard did not cover it.
    expect(message).toContain("EXTRACTOR_MODEL");
    expect(message).toContain("SOLVER_MODEL");
    expect(message).toContain("STEWARD_STRONG_MODEL");
    expect(message).not.toContain("STEWARD_MODEL");
  });

  it("loads in production when all load-bearing model envs are set", async () => {
    process.env.ENVIRONMENT = "production";
    for (const k of MODEL_ENV) process.env[k] = "claude-fable-5-1";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.stewardModel).toBe("claude-fable-5-1");
  });

  it("only warns outside production (and stays quiet under vitest)", async () => {
    process.env.ENVIRONMENT = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).not.toThrow();
    // VITEST is set in this process, so the dev warning is suppressed too.
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns in a non-vitest dev process running on the cheap defaults", async () => {
    process.env.ENVIRONMENT = "development";
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { loadConfig } = await import("../../src/config.js");
      loadConfig();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain("STEWARD_MODEL");
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
    }
  });
});

describe("loadConfig mathematics keys (docs/mathematics.md Appendix E)", () => {
  const KEYS = [
    "LEAN_CHECKER_URL",
    "LEAN_CHECKER_TOKEN",
    "LEAN_CPU_HOUR_COST_MICRO_USD",
    "LEAN_CHECK_OVERHEAD_MICRO_USD",
    "FORMALIZATION_REVIEW_PERIOD_DAYS",
    "FORMALIZATION_REVIEW_AWARD_USD",
    "SOLVER_MODEL",
    "SOLVER_ENABLED",
    "SOLVER_DAILY_CAP_OWLS",
    "SOLVER_CALIBRATION_DAILY_CAP_OWLS",
    "SOLVER_LEAN_MAX_CHECKS",
    "SOLVER_LEAN_MAX_ELABORATIONS",
    "ATTEMPT_OVERAGE_FRACTION",
    "ATTEMPT_MAX_WALL_HOURS",
    "ATTEMPT_MAX_ITERATIONS",
    "TRACE_ALWAYS_AGENTS",
    "MAX_BOUNTY_PER_CLAIM_USD",
    "MIN_BOUNTY_PER_CLAIM_USD",
    "BOUNTY_POOL_FRACTION_PER_PASS",
    "BOUNTY_POOL_FRACTION_PER_DAY",
    "BOUNTY_AUTONOMY_THRESHOLD_USD",
    "BOUNTY_NOTICE_DAYS",
    "BOUNTY_DEFAULT_EXPIRY_DAYS",
    "PRIZE_HUMAN_SIGNOFF_USD",
    "PRIZE_HUMAN_SIGNOFF_IMPORTANCE",
    "PRIZE_CHALLENGE_WINDOW_DAYS_SMALL",
    "PRIZE_CHALLENGE_WINDOW_DAYS_LARGE",
    "PRIZE_WINDOW_TIER_USD",
    "PRIZE_PAYEE_STEPS_DAYS",
    "PRIZE_REVIEW_RESERVE_FRACTION",
    "PRIZE_DEFECT_AWARD_FRACTION",
    "PRIZE_DEFECT_AWARD_CAP_USD",
    "PRIZE_OWL_TRANCHE_USD",
    "PRIZE_CHECK_MAX_CONCURRENT",
    "PRIZE_CHECKS_PER_DAY",
    "PRIZE_CHECK_RECLAIM_MINUTES",
    "PRIZE_CHECK_MAX_ATTEMPTS",
    "PRIZE_CLAIMS_PER_STATEMENT_PER_30_DAYS",
    "PRIZE_CLAIMS_PER_DAY_PLATFORM",
    "MINERVAL_OPERATOR_KEY",
    "MATH_MANDATE_ESCROW_OWLS",
    "MATH_MANDATE_DAILY_OWLS",
    "MATH_PRIZE_POOL_USD",
    "ENVIRONMENT",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("ships the design's defaults", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const c = loadConfig();
    // §5: the checker, off until a URL is set.
    expect(c.leanCheckerUrl).toBe("");
    expect(c.leanCheckerToken).toBe("");
    expect(c.leanCpuHourCostMicroUsd).toBe(200_000);
    expect(c.leanCheckOverheadMicroUsd).toBe(20_000);
    expect(c.formalizationReviewPeriodDays).toBe(14);
    expect(c.formalizationReviewAwardUsd).toBe(100);
    // §7: the solver, on the strong tier, off by default.
    expect(c.solverModel).toBe(MODELS.fable);
    expect(c.solverEnabled).toBe(false);
    expect(c.solverDailyCapOwls).toBe(400);
    expect(c.solverCalibrationDailyCapOwls).toBe(100);
    expect(c.solverLeanMaxChecks).toBe(60);
    expect(c.solverLeanMaxElaborations).toBe(200);
    expect(c.attemptOverageFraction).toBe(0.25);
    expect(c.attemptMaxWallHours).toBe(6);
    expect(c.attemptMaxIterations).toBe(500);
    expect(c.traceAlwaysAgents).toEqual(["math_solver"]);
    // §8.1: bounties.
    expect(c.maxBountyPerClaimUsd).toBe(5000);
    expect(c.minBountyPerClaimUsd).toBe(250);
    expect(c.bountyPoolFractionPerPass).toBe(0.1);
    expect(c.bountyPoolFractionPerDay).toBe(0.25);
    expect(c.bountyAutonomyThresholdUsd).toBe(1000);
    expect(c.bountyNoticeDays).toBe(30);
    expect(c.bountyDefaultExpiryDays).toBe(365);
    // §8.4–§8.7: prize claims.
    expect(c.prizeHumanSignoffUsd).toBe(1000);
    expect(c.prizeHumanSignoffImportance).toBe(0.6);
    expect(c.prizeChallengeWindowDaysSmall).toBe(14);
    expect(c.prizeChallengeWindowDaysLarge).toBe(30);
    expect(c.prizeWindowTierUsd).toBe(1000);
    expect(c.prizePayeeStepsDays).toBe(90);
    expect(c.prizeReviewReserveFraction).toBe(0.1);
    expect(c.prizeDefectAwardFraction).toBe(0.1);
    expect(c.prizeDefectAwardCapUsd).toBe(500);
    expect(c.prizeOwlTrancheUsd).toBe(2000);
    expect(c.prizeCheckMaxConcurrent).toBe(2);
    expect(c.prizeChecksPerDay).toBe(50);
    expect(c.prizeCheckReclaimMinutes).toBe(30);
    expect(c.prizeCheckMaxAttempts).toBe(3);
    expect(c.prizeClaimsPerStatementPer30Days).toBe(3);
    expect(c.prizeClaimsPerDayPlatform).toBe(5);
    // §8.11 and §10.7.
    expect(c.minervalOperatorKey).toBe("");
    expect(c.mathMandateEscrowOwls).toBe(2500);
    expect(c.mathMandateDailyOwls).toBe(200);
    expect(c.mathPrizePoolUsd).toBe(2500);
  });

  it("reads overrides with the right coercions", async () => {
    process.env.SOLVER_ENABLED = "true";
    process.env.TRACE_ALWAYS_AGENTS = " math_solver, claim_steward ,";
    process.env.SOLVER_DAILY_CAP_OWLS = "150";
    process.env.PRIZE_REVIEW_RESERVE_FRACTION = "0.2";
    process.env.MINERVAL_OPERATOR_KEY = "op-secret";
    process.env.MATH_PRIZE_POOL_USD = "1000";
    const { loadConfig } = await import("../../src/config.js");
    const c = loadConfig();
    expect(c.solverEnabled).toBe(true);
    expect(c.traceAlwaysAgents).toEqual(["math_solver", "claim_steward"]);
    expect(c.solverDailyCapOwls).toBe(150);
    expect(c.prizeReviewReserveFraction).toBe(0.2);
    expect(c.minervalOperatorKey).toBe("op-secret");
    expect(c.mathPrizePoolUsd).toBe(1000);
  });

  it("SOLVER_ENABLED is on only for the literal string 'true'", async () => {
    process.env.SOLVER_ENABLED = "false";
    const { loadConfig } = await import("../../src/config.js");
    expect(loadConfig().solverEnabled).toBe(false);
  });

  it("refuses a SOLVER_MODEL outside the strong-tier families (§7.8)", async () => {
    process.env.SOLVER_MODEL = MODELS.sonnet;
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/SOLVER_MODEL .* strong-tier/);
  });

  it("refuses a SOLVER_MODEL that resolves to no provider", async () => {
    process.env.SOLVER_MODEL = "llama-3-70b";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/does not resolve to a known provider/);
  });

  it("never lets a challenge window drop below 14 days (§8.5)", async () => {
    process.env.PRIZE_CHALLENGE_WINDOW_DAYS_SMALL = "7";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow();
  });

  it("keeps the fund fractions inside [0, 1]", async () => {
    process.env.BOUNTY_POOL_FRACTION_PER_DAY = "1.5";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow();
  });
});

describe("loadConfig API key contributor bindings (issue #10)", () => {
  let savedApiKeys: string | undefined;

  beforeEach(() => {
    savedApiKeys = process.env.API_KEYS;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = savedApiKeys;
  });

  it("parses bound and unbound keys", async () => {
    process.env.API_KEYS = "k1:alice, k2";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.apiKeys).toEqual(["k1", "k2"]);
    expect(config.apiKeyContributors).toEqual({ k1: "alice" });
  });

  it("defaults to no keys and no bindings", async () => {
    delete process.env.API_KEYS;
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.apiKeys).toEqual([""]);
    expect(config.apiKeyContributors).toEqual({});
  });
});
