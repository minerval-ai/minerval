import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The tagging drain (#272) is control flow over the claim-row queue: lease
 * the next untagged row, run the tagger, apply through the tag service,
 * stamp tagged_at; classify failures like the Steward drain. The SQL runs
 * live; here the DB and the agent are mocked and the statements checked.
 */

const CLAIM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TAG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const { state } = vi.hoisted(() => ({
  state: {
    queue: [] as Array<{
      id: string; text: string; claim_type: string; domains: string[]; tagging_attempts: number;
      sensitivity_label: string;
    }>,
    // The label the tagger's run and the write of its tags each worked at.
    taggedAt: [] as string[],
    appliedAt: [] as string[],
    queries: [] as Array<{ q: string; params: unknown[] }>,
    decision: null as null | Record<string, unknown>,
    throwWith: null as null | Error,
    applied: [] as Array<Record<string, unknown>>,
    existing: [] as Array<Record<string, unknown>>,
    // The lane's wait, as its platform_flags row holds it (tagging-lane.ts).
    flag: null as null | Record<string, unknown>,
    flagWrites: 0,
    // The process-wide breaker, spent or not.
    breaker: null as null | Error,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    state.queries.push({ q, params });
    if (q.includes("SET tagging_leased_at = now()")) {
      const next = state.queue.shift();
      return next ? [next] : [];
    }
    if (q.includes("platform_flags")) {
      if (q.startsWith("SELECT")) return state.flag ? [{ value: state.flag }] : [];
      if (q.startsWith("INSERT")) {
        state.flag = JSON.parse(String(params[1]));
        state.flagWrites++;
      }
      if (q.startsWith("DELETE")) state.flag = null;
    }
    return [];
  }),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(() => {
    if (state.breaker) throw state.breaker;
  }),
}));

vi.mock("../../../src/llm/agents/tagger.js", () => ({
  tagClaim: vi.fn(async () => {
    const { currentLabel } = await import("../../../src/llm/usage-context.js");
    state.taggedAt.push(currentLabel());
    if (state.throwWith) throw state.throwWith;
    return state.decision ?? { tags: [], reasoning: "", submitted: true };
  }),
}));

vi.mock("../../../src/services/tag-service.js", () => ({
  MAX_TAGGING_ATTEMPTS: 3,
  getTagsForSubject: vi.fn(async () => state.existing),
  resolveTagBySlug: vi.fn(async (slug: string) =>
    slug === "vaccine-safety" ? { id: TAG_A, slug, name: "Vaccine safety" } : null
  ),
  setSubjectTags: vi.fn(async (input: Record<string, unknown>) => {
    const { currentLabel } = await import("../../../src/llm/usage-context.js");
    state.appliedAt.push(currentLabel());
    state.applied.push(input);
    return {
      attached: (input.assignments as Array<Record<string, unknown>>).map((a, i) => ({
        id: a.tagId ?? `new-${i}`,
        slug: a.tagId ? "vaccine-safety" : String(a.name).toLowerCase().replace(/\s+/g, "-"),
        name: a.name ?? "Vaccine safety",
      })),
      resolutions: [],
      removed: 0,
    };
  }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ taggingBatchSize: 5, taggingIntervalSeconds: 30, taggerModel: "m" }),
}));

import {
  assignmentsFromDecision,
  processNextTaggingTask,
  tagOneClaim,
  taggingTick,
} from "../../../src/workers/tagging-pipeline.js";
import { MissingLabelError } from "../../../src/labels.js";
import { tagClaim } from "../../../src/llm/agents/tagger.js";
import { LlmBudgetExceededError } from "../../../src/llm/errors.js";
import { breakerResetsAt, currentTaggingLaneWait } from "../../../src/services/tagging-lane.js";

const row = (over: Partial<(typeof state.queue)[number]> = {}) => ({
  id: CLAIM,
  text: "mRNA vaccines cause myocarditis in young men above the background rate.",
  claim_type: "causal",
  domains: [],
  tagging_attempts: 0,
  sensitivity_label: "public",
  ...over,
});

beforeEach(() => {
  state.queue = [];
  state.queries = [];
  state.decision = null;
  state.throwWith = null;
  state.applied = [];
  state.existing = [];
  state.taggedAt = [];
  state.appliedAt = [];
  state.flag = null;
  state.flagWrites = 0;
  state.breaker = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("leasing", () => {
  it("takes the next untagged, embedded, active row by importance with SKIP LOCKED", async () => {
    const r = await processNextTaggingTask();
    expect(r).toEqual({ status: "empty" });
    const lease = state.queries[0]!.q;
    expect(lease).toContain("tagged_at IS NULL");
    expect(lease).toContain("embedding IS NOT NULL");
    expect(lease).toContain("state = 'active'");
    expect(lease).toContain("ORDER BY importance DESC");
    expect(lease).toContain("FOR UPDATE SKIP LOCKED");
    expect(lease).toContain("tagging_leased_at < now() - interval");
    expect(state.queries[0]!.params).toEqual([3]);
  });

  it("reads the claim's label with the row it leases", async () => {
    await processNextTaggingTask();
    expect(state.queries[0]!.q).toMatch(/RETURNING [^`]*sensitivity_label/);
  });
});

// The queue is the claim row, so the claim's label is the label of the work
// (src/labels.ts): the tagger's run and the write of its tags are inside it.
describe("the label a claim is tagged at", () => {
  it("is the claim's own, for the tagger's run and for the tags it writes", async () => {
    state.queue.push(row({ sensitivity_label: "internal" }), row({ id: "open" }));
    state.decision = { submitted: true, reasoning: "", tags: [{ slug: "vaccine-safety", confidence: 0.8 }] };
    await taggingTick({ batch: 2 });
    expect(state.taggedAt).toEqual(["internal", "public"]);
    expect(state.appliedAt).toEqual(["internal", "public"]);
  });

  it("is never public for a row handed in without its label: the row is refused", async () => {
    const { sensitivity_label: _none, ...unlabeled } = row();
    await expect(tagOneClaim(unlabeled as ReturnType<typeof row>)).rejects.toBeInstanceOf(MissingLabelError);
    expect(state.taggedAt).toEqual([]);
    expect(state.applied).toEqual([]);
  });
});

describe("a successful pass", () => {
  it("applies the decision under the tagger source and stamps tagged_at", async () => {
    state.queue.push(row());
    state.decision = {
      submitted: true,
      reasoning: "a safety question",
      tags: [
        { slug: "vaccine-safety", confidence: 0.9 },
        { name: "Myocarditis", description: "Heart muscle inflammation.", confidence: 0.7 },
      ],
    };
    const r = await processNextTaggingTask();
    expect(r).toMatchObject({ status: "processed", claimId: CLAIM, attached: ["vaccine-safety", "myocarditis"] });
    expect(state.applied[0]).toMatchObject({ kind: "claim", subjectId: CLAIM, source: "tagger" });
    const assignments = state.applied[0]!.assignments as Array<Record<string, unknown>>;
    expect(assignments[0]).toMatchObject({ tagId: TAG_A, confidence: 0.9, reasoning: "a safety question" });
    expect(assignments[1]).toMatchObject({ name: "Myocarditis", description: "Heart muscle inflammation." });
    const done = state.queries.find((c) => c.q.includes("SET tagged_at = now()"));
    expect(done?.q).toContain("tagging_leased_at = NULL");
    expect(done?.q).toContain("tagging_attempts = 0");
  });

  it("hands the tagger the tags other hands recorded, never its own previous ones", async () => {
    state.queue.push(row());
    state.existing = [
      { name: "Old tagger tag", source: "tagger" },
      { name: "Number theory", source: "steward" },
    ];
    state.decision = { submitted: true, reasoning: "", tags: [] };
    await processNextTaggingTask();
    const input = vi.mocked(tagClaim).mock.calls[0]![0];
    expect(input.existing).toEqual([{ name: "Number theory", source: "steward" }]);
  });

  it("an empty submitted decision still counts as tagged (a claim about nothing)", async () => {
    state.queue.push(row());
    state.decision = { submitted: true, reasoning: "noise", tags: [] };
    const r = await processNextTaggingTask();
    expect(r).toMatchObject({ status: "processed", attached: [] });
    expect(state.queries.some((c) => c.q.includes("SET tagged_at = now()"))).toBe(true);
  });
});

describe("failure handling", () => {
  it("a budget error releases the lease uncounted and stops the tick", async () => {
    state.queue.push(row(), row({ id: "second" }));
    state.throwWith = new LlmBudgetExceededError("budget");
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 0, budget: true, drained: false });
    const release = state.queries.find((c) => c.q.includes("SET tagging_leased_at = NULL"));
    expect(release?.q).not.toContain("tagging_attempts");
    // The second row was never leased.
    expect(state.queue).toHaveLength(1);
  });

  it("a transient API error releases the lease uncounted", async () => {
    state.queue.push(row());
    state.throwWith = Object.assign(new Error("overloaded"), { status: 529 });
    const r = await processNextTaggingTask();
    expect(r).toMatchObject({ status: "transient" });
    const release = state.queries.find((c) => c.q.includes("SET tagging_leased_at = NULL"));
    expect(release?.q).not.toContain("tagging_attempts");
  });

  it("a genuine error counts an attempt and parks at the cap", async () => {
    state.queue.push(row({ tagging_attempts: 2 }));
    state.throwWith = new Error("schema violation");
    const r = await processNextTaggingTask();
    expect(r).toMatchObject({ status: "failed", parked: true });
    const bump = state.queries.find((c) => c.q.includes("tagging_attempts = $2"));
    expect(bump?.params).toEqual([CLAIM, 3]);
    expect(bump?.q).not.toContain("tagged_at = now()");
  });

  it("an unsubmitted decision is a genuine failure, so nothing is written", async () => {
    state.queue.push(row());
    state.decision = { submitted: false, reasoning: "no submit", tags: [] };
    const r = await processNextTaggingTask();
    expect(r).toMatchObject({ status: "failed", parked: false });
    expect(state.applied).toHaveLength(0);
  });
});

describe("taggingTick", () => {
  it("drains up to the batch and reports when the queue runs dry", async () => {
    state.queue.push(row(), row({ id: "b" }), row({ id: "c" }));
    state.decision = { submitted: true, reasoning: "", tags: [{ slug: "vaccine-safety", confidence: 0.8 }] };
    const tick = await taggingTick({ batch: 2 });
    expect(tick).toMatchObject({ processed: 2, attached: 2, failed: 0, drained: false });
    const rest = await taggingTick({ batch: 5 });
    expect(rest).toMatchObject({ processed: 1, drained: true });
  });
});

describe("the lane's wait on the spend breaker", () => {
  // 2026-11-13: the tagger's calls are unattributed, so the process-wide
  // breaker is theirs to meet. Met inside a run it was an agent error on
  // the run log every 30 seconds.
  it("a spent breaker ends the tick before a claim is leased or a run opened, and the lane says what it waits on", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T14:20:00Z") });
    state.queue.push(row());
    state.breaker = new LlmBudgetExceededError("hourly_call_count", 167, 167);
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 0, failed: 0, budget: true, drained: false });
    expect(state.queue).toHaveLength(1);
    expect(tagClaim).not.toHaveBeenCalled();
    // Until the breaker's hour rolls over.
    expect(tick.waiting).toMatchObject({ reason: "spend_breaker", since: "2026-11-13T14:20:00.000Z", next_attempt_at: "2026-11-13T15:00:00.000Z", attempts: 0 });
    expect(tick.waiting!.reason_label).toContain("spend breaker");
    expect(state.flag).toMatchObject({ reason: "spend_breaker", next_attempt_at: "2026-11-13T15:00:00.000Z" });

    // The ticks that follow in the same window say the same and write nothing.
    vi.setSystemTime(new Date("2026-11-13T14:20:30Z"));
    expect((await taggingTick()).waiting).toMatchObject({ reason: "spend_breaker", since: "2026-11-13T14:20:00.000Z" });
    expect(state.flagWrites).toBe(1);
    expect(tagClaim).not.toHaveBeenCalled();
  });

  it("a daily limit waits until the next UTC day", () => {
    const at = Date.parse("2026-11-13T14:20:00Z");
    expect(new Date(breakerResetsAt("daily_token_count", at)).toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(new Date(breakerResetsAt("hourly_token_count", at)).toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });

  it("the wait is over when the lane tags a claim again", async () => {
    state.flag = { reason: "spend_breaker", since: "2026-11-13T14:20:00.000Z", next_attempt_at: "2026-11-13T15:00:00.000Z", attempts: 0 };
    state.queue.push(row());
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 1, budget: false });
    expect(tick.waiting).toBeUndefined();
    expect(state.flag).toBeNull();
  });

  it("a breaker that trips inside a run stops the tick and records the same wait", async () => {
    state.queue.push(row(), row({ id: "second" }));
    state.throwWith = new LlmBudgetExceededError("daily_call_count", 1667, 1667);
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 0, budget: true });
    expect(tick.waiting).toMatchObject({ reason: "spend_breaker" });
    expect(state.queue).toHaveLength(1);
  });
});

describe("the lane's wait on a platform fault", () => {
  const overloaded = () => Object.assign(new Error("overloaded"), { status: 529 });

  it("a transient failure ends the tick, counts nothing, and holds the lane 30 seconds", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T14:20:00Z") });
    state.queue.push(row(), row({ id: "second" }), row({ id: "third" }));
    state.throwWith = overloaded();
    const tick = await taggingTick();
    // It used to read as one processed and one failed, and go on to the next claim.
    expect(tick).toMatchObject({ processed: 0, failed: 0, budget: false, drained: false });
    expect(state.queue).toHaveLength(2);
    expect(tagClaim).toHaveBeenCalledTimes(1);
    expect(tick.waiting).toMatchObject({
      reason: "provider_unavailable",
      since: "2026-11-13T14:20:00.000Z",
      next_attempt_at: "2026-11-13T14:20:30.000Z",
      attempts: 1,
    });
    // The claim is back in the queue, uncounted.
    const release = state.queries.find((c) => c.q.includes("SET tagging_leased_at = NULL"));
    expect(release?.q).not.toContain("tagging_attempts");
  });

  it("no tick leases while the lane waits; one claim is tried when the wait ends, and a second failure doubles it", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T14:20:00Z") });
    state.queue.push(row(), row({ id: "second" }));
    state.throwWith = overloaded();
    await taggingTick();
    expect(state.queue).toHaveLength(1);

    // The scheduler's next tick, and any other task's: still waiting.
    vi.setSystemTime(new Date("2026-11-13T14:20:29Z"));
    const held = await taggingTick();
    expect(held).toMatchObject({ processed: 0, failed: 0, budget: false, drained: false });
    expect(held.waiting).toMatchObject({ reason: "provider_unavailable", attempts: 1 });
    expect(state.queue).toHaveLength(1);
    expect(tagClaim).toHaveBeenCalledTimes(1);

    // Due: one claim is tried, and the provider is still down.
    vi.setSystemTime(new Date("2026-11-13T14:20:31Z"));
    const again = await taggingTick();
    expect(tagClaim).toHaveBeenCalledTimes(2);
    expect(again.waiting).toMatchObject({
      reason: "provider_unavailable",
      since: "2026-11-13T14:20:00.000Z",
      next_attempt_at: "2026-11-13T14:21:31.000Z",
      attempts: 2,
    });
  });

  it("doubles to ten minutes and no further", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T14:20:00Z") });
    state.flag = { reason: "provider_unavailable", since: "2026-11-13T13:00:00.000Z", next_attempt_at: "2026-11-13T14:19:00.000Z", attempts: 9 };
    state.queue.push(row());
    state.throwWith = overloaded();
    const tick = await taggingTick();
    expect(tick.waiting).toMatchObject({ attempts: 10, since: "2026-11-13T13:00:00.000Z", next_attempt_at: "2026-11-13T14:30:00.000Z" });
  });

  it("names the class: an account out of credits is a deployment fault", async () => {
    state.queue.push(row());
    state.throwWith = Object.assign(new Error("402 This request's maximum cost exceeds your available credits."), { status: 402 });
    const tick = await taggingTick();
    expect(tick.waiting).toMatchObject({ reason: "credits_fault" });
    expect(tick.waiting!.reason_label).toContain("out of credits");
    // The provider's own words are not in what the lane publishes.
    expect(JSON.stringify(state.flag)).not.toContain("402");
  });

  it("ends when a claim is tagged, and the rest of the batch runs", async () => {
    state.flag = { reason: "provider_unavailable", since: "2026-11-13T13:00:00.000Z", next_attempt_at: "2026-11-13T13:10:00.000Z", attempts: 4 };
    state.queue.push(row(), row({ id: "second" }));
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 2, failed: 0 });
    expect(tick.waiting).toBeUndefined();
    expect(state.flag).toBeNull();
  });

  it("ends when nothing is left to tag", async () => {
    state.flag = { reason: "provider_unavailable", since: "2026-11-13T13:00:00.000Z", next_attempt_at: "2026-11-13T13:10:00.000Z", attempts: 4 };
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 0, drained: true });
    expect(state.flag).toBeNull();
  });

  it("a genuine failure is the claim's own: it is counted and the lane goes on", async () => {
    state.queue.push(row(), row({ id: "second" }));
    state.throwWith = new Error("schema violation");
    const tick = await taggingTick();
    expect(tick).toMatchObject({ processed: 2, failed: 2 });
    expect(tick.waiting).toBeUndefined();
    expect(state.flag).toBeNull();
  });

  it("is shown only while the next attempt is ahead", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T14:20:00Z") });
    state.flag = { reason: "credits_fault", since: "2026-11-13T14:00:00.000Z", next_attempt_at: "2026-11-13T14:25:00.000Z", attempts: 5 };
    expect(await currentTaggingLaneWait()).toMatchObject({ reason: "credits_fault", attempts: 5, next_attempt_at: "2026-11-13T14:25:00.000Z" });
    vi.setSystemTime(new Date("2026-11-13T14:25:00Z"));
    expect(await currentTaggingLaneWait()).toBeNull();
    // A row this module did not write is no wait.
    state.flag = { reason: "something_else", since: "x", next_attempt_at: "2099-01-01T00:00:00.000Z" };
    expect(await currentTaggingLaneWait()).toBeNull();
  });
});

describe("assignmentsFromDecision", () => {
  it("resolves known slugs to ids and turns an invented slug into a name", async () => {
    const out = await assignmentsFromDecision({
      submitted: true,
      reasoning: "r",
      tags: [
        { slug: "vaccine-safety", confidence: 0.9 },
        { slug: "made-up-topic", confidence: 0.5 },
        { name: "Cardiology", confidence: 0.6 },
      ],
    });
    expect(out).toEqual([
      { tagId: TAG_A, confidence: 0.9, reasoning: "r" },
      { name: "made up topic", description: undefined, confidence: 0.5, reasoning: "r" },
      { name: "Cardiology", description: undefined, confidence: 0.6, reasoning: "r" },
    ]);
  });
});
