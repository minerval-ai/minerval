/**
 * The Steward's decisions (docs/mathematics.md §8.4, §8.5) over a scripted
 * database: accept opens the window by tier, makes the sources public,
 * applies the deferred contribution award, and requests an audit whose
 * dedupe key carries the decision id — so a re-acceptance is audited
 * again; a fallback-served decision is recorded and flagged; reject at
 * stage steward; statement_defect records the capped award and retires the
 * statement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  claim: null as null | Record<string, unknown>,
  bounty: { id: "b-1", claim_id: "claim-1", pool_id: "pool-1", formalization_id: "f-1", amount_micro_usd: 2_500_000_000, status: "claim_pending", resolution: "either", rules_version: "v", posted_by_grant_id: null, resolution_note: null, opened_at: new Date() },
  updates: [] as Array<{ sql: string; params: unknown[] }>,
  audits: [] as Array<Record<string, unknown>>,
  awards: [] as Array<Record<string, unknown>>,
  retired: [] as Array<Record<string, unknown>>,
  importance: 0.4,
}));

vi.mock("../../../src/db/client.js", () => {
  const query = async (sql: string, params: unknown[] = []) => {
    state.updates.push({ sql, params });
    if (sql.includes("FROM prize_claims WHERE id = $1")) return state.claim ? [state.claim] : [];
    if (sql.includes("FROM bounties WHERE id = $1")) return [state.bounty];
    const applySets = () => {
      const sets = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).split(",").map((s) => s.trim());
      for (const s of sets) {
        const m = /^(\w+) = \$(\d+)/.exec(s);
        if (!m || !state.claim) continue;
        const col = m[1]!;
        const val = params[Number(m[2]) - 1];
        if (col === "steward_decision") state.claim.steward_decision = typeof val === "string" ? JSON.parse(val) : val;
        else if (col === "window_ends_at") state.claim.window_ends_at = val;
        else if (col === "window_paused_ms") state.claim.window_paused_ms = val;
        else if (col === "audit_outcome") state.claim.audit_outcome = val;
        else if (col === "defect_award_micro_usd") state.claim.defect_award_micro_usd = val;
        else if (col === "result_category") state.claim.result_category = val;
        else if (col === "rejected_stage") state.claim.rejected_stage = val;
      }
    };
    if (sql.includes("UPDATE prize_claims SET status")) {
      const to = params[1] as string;
      const froms = params[2] as string[];
      if (!state.claim || !froms.includes(state.claim.status as string)) return [];
      state.claim = { ...state.claim, status: to };
      applySets();
      return [state.claim];
    }
    // A field update without a status change (the audit outcome, the payee steps).
    if (sql.includes("UPDATE prize_claims SET updated_at = now()")) {
      if (!state.claim) return [];
      state.claim = { ...state.claim };
      applySets();
      return [state.claim];
    }
    if (sql.includes("SELECT importance FROM claims")) return [{ importance: state.importance }];
    if (sql.includes("COUNT(*)::int AS n FROM prize_claims")) return [{ n: 0 }];
    if (sql.includes("UPDATE bounties SET status = $2")) return [{ id: "b-1", claim_id: "claim-1" }];
    return [];
  };
  return {
    rawQuery: vi.fn(query),
    withTransaction: vi.fn(async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query })),
  };
});
vi.mock("../../../src/services/queue-service.js", () => ({
  requestAudit: vi.fn(async (input: Record<string, unknown>) => {
    state.audits.push(input);
    return "run-1";
  }),
}));
vi.mock("../../../src/services/contribution-award-service.js", () => ({
  owlsForImportance: (i: number) => 1 + Math.round(i * 4),
  awardContributionOwls: vi.fn(async (input: Record<string, unknown>) => {
    state.awards.push(input);
    return input.owls as number;
  }),
}));
vi.mock("../../../src/services/claim-events-service.js", () => ({ emitClaimEvent: vi.fn(async () => {}) }));
vi.mock("../../../src/services/formalization-service.js", () => ({
  retireFormalization: vi.fn(async (id: string, opts: Record<string, unknown>) => {
    state.retired.push({ id, ...opts });
    return { retired: { id }, bounties: ["b-1"] };
  }),
}));
vi.mock("../../../src/services/contributor-service.js", () => ({ getOrCreateContributor: vi.fn(async () => ({ id: "platform" })) }));

import { acceptPrizeClaim, rejectPrizeClaimBySteward, recordPrizeAuditOutcome } from "../../../src/services/prize-claim-service.js";
import { loadConfig } from "../../../src/config.js";

function inReview() {
  return {
    id: "pc-1", contribution_id: "co-1", bounty_id: "b-1", claim_id: "claim-1", formalization_id: "f-1", claimant_id: "u-1",
    direction: "proof", status: "in_review", rejected_stage: null, lean_check_id: "lc-1", check_attempts: 1, tie_group: null,
    steward_decision: null, result_category: null, defect_award_micro_usd: null, window_ends_at: null, window_paused_ms: 0,
    audit_outcome: null, signed_off_at: null, signed_off_by: null, payee: null, credit_name: "Ada", tools_disclosure: "x",
    declarations: {}, rules_version: "v", submitted_at: new Date(), updated_at: new Date(), created_at: new Date(),
  };
}

const run = { runId: "run-9", requestedModel: "claude-strong", servedModel: "claude-strong", fallbackRan: false };

beforeEach(() => {
  state.claim = inReview();
  state.updates = [];
  state.audits = [];
  state.awards = [];
  state.retired = [];
  state.importance = 0.4;
});

describe("accept", () => {
  it("opens the window by tier, makes the sources public, awards the deferred contribution owls, and audits under a key carrying the decision id", async () => {
    const config = loadConfig();
    const r = await acceptPrizeClaim({ prizeClaimId: "pc-1", reason: "faithful", resultCategory: "new_result", actor: "claim_steward", run });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("in_challenge_window");
    const ends = new Date(r.window_ends_at!).getTime();
    expect(ends - Date.now()).toBeGreaterThan((config.prizeChallengeWindowDaysLarge - 0.01) * 86_400_000);
    expect(state.updates.some((u) => u.sql.includes("UPDATE attachments SET visibility") && u.params[1] === "public")).toBe(true);
    expect(state.awards[0]).toMatchObject({ contributorId: "u-1", contributionId: "co-1", owls: 3, awardKey: "prize-claim-accept:pc-1" });
    expect(state.audits[0]).toMatchObject({ auditType: "decision_audit", triggeredBy: "prize_acceptance", dedupeKey: `prize_claim:pc-1:${r.decision_id}` });
    expect((state.claim!.steward_decision as Record<string, unknown>)).toMatchObject({ decision: "accept", served_model: "claude-strong", fallback_ran: false, decision_id: r.decision_id });
  });

  it("changes the audit dedupe key on every decision, so a re-acceptance after a send-back is audited again", async () => {
    const first = await acceptPrizeClaim({ prizeClaimId: "pc-1", reason: "a", resultCategory: "new_result", actor: "s", run });
    state.claim = inReview();
    const second = await acceptPrizeClaim({ prizeClaimId: "pc-1", reason: "b", resultCategory: "formalization_of_known_proof", actor: "s", run });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.decision_id).not.toBe(second.decision_id);
    expect(state.audits.map((a) => a.dedupeKey)).toEqual([`prize_claim:pc-1:${first.decision_id}`, `prize_claim:pc-1:${second.decision_id}`]);
  });

  it("records a fallback-served decision and says so to the audit", async () => {
    const r = await acceptPrizeClaim({ prizeClaimId: "pc-1", reason: "a", resultCategory: "new_result", actor: "s", run: { ...run, servedModel: "claude-standard", fallbackRan: true } });
    expect(r.ok).toBe(true);
    expect((state.claim!.steward_decision as Record<string, unknown>).fallback_ran).toBe(true);
    expect(String(state.audits[0]!.context)).toMatch(/fallback model/);
  });

  it("refuses outside in_review and refuses the no-prize categories", async () => {
    expect(await acceptPrizeClaim({ prizeClaimId: "pc-1", reason: "a", resultCategory: "reference_to_prior_work", actor: "s", run })).toMatchObject({ ok: false, message: /pays no prize/ });
    state.claim = { ...inReview(), status: "checked" };
    expect(await acceptPrizeClaim({ prizeClaimId: "pc-1", reason: "a", resultCategory: "new_result", actor: "s", run })).toMatchObject({ ok: false, message: /checked/ });
    expect(state.audits).toHaveLength(0);
  });
});

describe("reject", () => {
  it("records the rejection at stage steward and reopens the bounty", async () => {
    const r = await rejectPrizeClaimBySteward({ prizeClaimId: "pc-1", reason: "proves less than the claim", resultCategory: "reference_to_prior_work", actor: "s", run });
    expect(r).toMatchObject({ ok: true, status: "rejected" });
    expect(state.claim!.rejected_stage).toBe("steward");
    expect(state.updates.some((u) => u.sql.includes("UPDATE contributions SET review_status = 'rejected'"))).toBe(true);
    expect(state.updates.some((u) => u.sql.includes("UPDATE bounties SET status = $2") && u.params[1] === "open")).toBe(true);
    expect(state.audits).toHaveLength(0);
  });

  it("statement_defect records the capped defect award, retires the statement, moves the bounty to rebinding, and audits like an acceptance", async () => {
    const config = loadConfig();
    const r = await rejectPrizeClaimBySteward({ prizeClaimId: "pc-1", reason: "vacuous hypothesis", resultCategory: "statement_defect", statementDefect: "the hypothesis is unsatisfiable", actor: "s", run });
    expect(r).toMatchObject({ ok: true, status: "defect_award_pending" });
    if (!r.ok) return;
    expect(r.defect_award_micro_usd).toBe(Math.min(Math.floor(2_500_000_000 * config.prizeDefectAwardFraction), config.prizeDefectAwardCapUsd * 1_000_000));
    expect(state.retired[0]).toMatchObject({ id: "f-1", reason: /defect exposed by prize claim pc-1/ });
    expect(state.updates.some((u) => u.sql.includes("SET status = 'rebinding'"))).toBe(true);
    expect(state.audits[0]).toMatchObject({ triggeredBy: "prize_acceptance", dedupeKey: `prize_claim:pc-1:${r.decision_id}` });
  });

  it("statement_defect needs the defect stated", async () => {
    expect(await rejectPrizeClaimBySteward({ prizeClaimId: "pc-1", reason: "x", resultCategory: "statement_defect", actor: "s", run })).toMatchObject({ ok: false, message: /statement_defect must say/ });
  });
});

describe("the audit's send-back", () => {
  function inWindow() {
    return {
      ...inReview(),
      status: "in_challenge_window",
      steward_decision: { decision: "accept", reason: "faithful", result_category: "new_result", statement_defect: null, run_id: "run-1", decision_id: "dec-1", served_model: "claude-standard", fallback_ran: true, at: new Date().toISOString() },
      window_ends_at: new Date(Date.now() + 14 * 86_400_000),
      window_paused_ms: 3_600_000,
      audit_outcome: null,
    };
  }

  it("returns the claim to in_review with the window cleared and the acceptance withdrawn, leaving the note in the trail", async () => {
    state.claim = inWindow();
    const r = await recordPrizeAuditOutcome({ prizeClaimId: "pc-1", outcome: "send_back", note: "served by a fallback model", actor: "audit_agent:run-2" });
    expect(r).toEqual({ ok: true, status: "in_review" });
    expect(state.claim!.status).toBe("in_review");
    expect(state.claim!.steward_decision).toBeNull();
    expect(state.claim!.window_ends_at).toBeNull();
    const transition = state.updates.find((u) => u.sql.includes("UPDATE prize_claims SET status") && u.params[1] === "in_review")!;
    expect(transition.params[2]).toEqual(["in_challenge_window"]);
    expect(transition.sql).toContain("window_paused_ms = $");
    // The send-back note itself, and the transition naming the withdrawn decision, both reach audit_log.
    const audit = state.updates.filter((u) => u.sql.includes("INSERT INTO audit_log"));
    expect(audit.some((u) => u.params[1] === "prize_claim:audit_send_back" && String(u.params[2]).includes("served by a fallback model"))).toBe(true);
    expect(audit.some((u) => u.params[1] === "prize_claim:in_review" && String(u.params[2]).includes("dec-1"))).toBe(true);
  });

  it("only records the outcome on a claim outside the window, and refuses before acceptance", async () => {
    state.claim = { ...inWindow(), status: "payable" };
    expect(await recordPrizeAuditOutcome({ prizeClaimId: "pc-1", outcome: "send_back", note: "n", actor: "a" })).toEqual({ ok: true, status: "payable" });
    expect(state.updates.some((u) => u.sql.includes("UPDATE prize_claims SET status"))).toBe(false);
    state.claim = inWindow();
    expect(await recordPrizeAuditOutcome({ prizeClaimId: "pc-1", outcome: "clear", note: "holds", actor: "a" })).toEqual({ ok: true, status: "in_challenge_window" });
    expect(state.claim!.status).toBe("in_challenge_window");
    state.claim = inReview();
    expect(await recordPrizeAuditOutcome({ prizeClaimId: "pc-1", outcome: "send_back", note: "n", actor: "a" })).toMatchObject({ ok: false, message: /in_review/ });
  });
});
