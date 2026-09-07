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
    queue: [] as Array<{ id: string; text: string; claim_type: string; domains: string[]; tagging_attempts: number }>,
    queries: [] as Array<{ q: string; params: unknown[] }>,
    decision: null as null | Record<string, unknown>,
    throwWith: null as null | Error,
    applied: [] as Array<Record<string, unknown>>,
    existing: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    state.queries.push({ q, params });
    if (q.includes("SET tagging_leased_at = now()")) {
      const next = state.queue.shift();
      return next ? [next] : [];
    }
    return [];
  }),
}));

vi.mock("../../../src/llm/agents/tagger.js", () => ({
  tagClaim: vi.fn(async () => {
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
  taggingTick,
} from "../../../src/workers/tagging-pipeline.js";
import { tagClaim } from "../../../src/llm/agents/tagger.js";
import { LlmBudgetExceededError } from "../../../src/llm/errors.js";

const row = (over: Partial<(typeof state.queue)[number]> = {}) => ({
  id: CLAIM,
  text: "mRNA vaccines cause myocarditis in young men above the background rate.",
  claim_type: "causal",
  domains: [],
  tagging_attempts: 0,
  ...over,
});

beforeEach(() => {
  state.queue = [];
  state.queries = [];
  state.decision = null;
  state.throwWith = null;
  state.applied = [];
  state.existing = [];
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
