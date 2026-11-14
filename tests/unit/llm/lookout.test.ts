import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Lookout run (llm/agents/lookout.ts): the briefing carries the brief,
 * the delegated bounds, the queued inputs, and the record of earlier
 * flags; the toolset is the watcher's (graph reads, scope sources, the
 * retraction record, page reads, the three ways to raise a candidate) with
 * web search on every model; propose_ingest carries the lookout's urgency
 * and ceiling, with no count per run (#695); the queued inputs are
 * consumed after the run; the note is the model's closing text. A lookout
 * that follows feeds also gets its inbox tools and a feeds section in its
 * briefing, and its triage carries the same ceiling. The tool loop and the
 * services are mocked.
 */

const LOOKOUT = "22222222-2222-4222-8222-222222222222";
const GRANT = "11111111-1111-4111-8111-111111111111";

const { state } = vi.hoisted(() => ({
  state: {
    lookout: null as null | Record<string, unknown>,
    events: [] as Array<{ id: string; kind: string; payload: Record<string, unknown>; created_at: Date }>,
    flags: [] as Array<Record<string, unknown>>,
    consumed: [] as string[][],
    loop: null as null | {
      tools: Array<{ name: string }>;
      system: unknown;
      model: string | undefined;
      briefing: string;
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
    },
    script: [] as Array<{ name: string; input: Record<string, unknown> }>,
    reassess: [] as Array<Record<string, unknown>>,
    ingests: [] as Array<Record<string, unknown>>,
    notes: [] as Array<Record<string, unknown>>,
    workspace: null as null | string,
    feeds: [] as Array<Record<string, unknown>>,
    triage: [] as Array<Record<string, unknown>>,
    maxIterations: 0,
    maxTokens: 0,
    pendingCount: 0,
    mandateToolOpts: null as null | Record<string, unknown>,
    retractionPage: { total: 0, offset: 0, next_offset: null, rows: [] } as unknown,
    scopeSourcesInput: null as null | Record<string, unknown>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    if (q.includes("FROM lookouts l JOIN grants g")) return state.lookout ? [state.lookout] : [];
    return [];
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ lookoutModel: "openai/gpt-6-luna" }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  runBudget: () => null,
  budgetRefusal: () => null,
  withAgent: (_a: string, fn: () => unknown) => fn(),
  withSkills: (_s: string[], fn: () => unknown) => fn(),
  getUsageContext: () => ({}),
  markCurrentRunPrivate: vi.fn(),
}));
vi.mock("../../../src/llm/prompts/lookout.js", () => ({
  getLookoutSystemPromptBlocks: () => ["SYSTEM"],
}));
vi.mock("../../../src/llm/tools/skill-load-tools.js", () => ({
  createSkillLoadTools: () => ({ definitions: [], execute: async () => null, pointed: [], pointerNote: "" }),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [{ name: "raise_issue" }],
    execute: async () => null,
    raisedCount: 0,
  }),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () => [
    { name: "search_claims" },
    { name: "get_claim" },
    { name: "get_decomposition" },
    { name: "get_dependents" },
  ],
  executeGraphReadTool: async (name: string) => (name === "get_claim" ? '{"claim":"x"}' : null),
}));
vi.mock("../../../src/llm/tools/mandate-tools.js", () => ({
  createMandateTools: vi.fn((opts: Record<string, unknown>) => {
    state.mandateToolOpts = opts;
    return {
      definitions: [{ name: "read_page" }],
      execute: async (name: string) => (name === "read_page" ? '{"ok":true,"text":"page"}' : null),
    };
  }),
}));
vi.mock("../../../src/services/lookout-service.js", () => ({
  LOOKOUT_BOUNDS: { workspaceChars: 50_000, noteChars: 2_000 },
  // The columns the run reads its lookout with, by name.
  LOOKOUT_COLUMNS: ["id", "grant_id", "title", "brief", "status", "model"],
  pendingLookoutEvents: vi.fn(async () => state.events),
  countPendingLookoutEvents: vi.fn(async () => state.pendingCount),
  listLookoutFlags: vi.fn(async () => state.flags),
  consumeLookoutEvents: vi.fn(async (_id: string, ids: string[]) => {
    state.consumed.push(ids);
  }),
  flagReassessment: vi.fn(async (input: Record<string, unknown>) => {
    state.reassess.push(input);
    return { ok: true, duplicate: false, flag_id: "f", action_id: "a", value_written: 5, note: "" };
  }),
  flagIngest: vi.fn(async (input: Record<string, unknown>) => {
    state.ingests.push(input);
    return { ok: true, duplicate: false, flag_id: "f", action_id: null, value_written: null, note: "" };
  }),
  flagNote: vi.fn(async (input: Record<string, unknown>) => {
    state.notes.push(input);
    return { ok: true, duplicate: false, flag_id: "f", action_id: null, value_written: null, note: "" };
  }),
  updateLookoutWorkspace: vi.fn(async (_id: string, content: string) => {
    state.workspace = content;
    return content.length;
  }),
  lookoutFeedSummaries: vi.fn(async () => state.feeds),
}));
vi.mock("../../../src/services/feed-service.js", () => ({
  LOOKOUT_SETTABLE_WAKE_RULES: ["batch", "each", "heartbeat", "paused"],
  READ_VIEWS: ["lead", "outline", "section", "full"],
  TRIAGE_DECISIONS: ["ingest", "skip", "defer"],
  feedInbox: vi.fn(async () => ({ total: 0, offset: 0, next_offset: null, rows: [] })),
  readItem: vi.fn(async () => ({ ok: true, chars_returned: 4000, text: "x" })),
  readListing: vi.fn(async () => ({ ok: true, rows: [] })),
  updateFeed: vi.fn(async () => ({ ok: true, feed_id: "f-1" })),
  triageItems: vi.fn(async (input: Record<string, unknown>) => {
    state.triage.push(input);
    return { outcomes: [], ingested: 2, skipped_in_bulk: 0 };
  }),
}));
vi.mock("../../../src/services/source-watch-service.js", () => ({
  checkDoi: vi.fn(async (doi: string) => ({ doi, found: true, updates: [] })),
  recentRetractionsPage: vi.fn(async () => state.retractionPage),
  scopeSources: vi.fn(async (input: Record<string, unknown>) => {
    state.scopeSourcesInput = input;
    return [];
  }),
  claimsRestingOnSources: vi.fn(async () => [{ source_id: "s-1", claim_id: "c-7", via: "draws_on" }]),
  readPage: vi.fn(async () => ({ ok: true, text: "page", chars: 4 })),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string }>;
    system: unknown;
    model?: string;
    maxIterations: number;
    maxTokens: number;
    initialMessages: Array<{ content: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    state.maxIterations = opts.maxIterations;
    state.maxTokens = opts.maxTokens;
    state.loop = {
      tools: opts.tools,
      system: opts.system,
      model: opts.model,
      briefing: opts.initialMessages[0]!.content,
      executeTool: opts.executeTool,
    };
    const outputs: string[] = [];
    for (const step of state.script) outputs.push(await opts.executeTool(step.name, step.input));
    return { content: "Checked the sources; nothing warranted work.", toolUses: [], stopReason: "end_turn", outputs };
  }),
}));

import { runLookout } from "../../../src/llm/agents/lookout.js";

const lookout = (over: Record<string, unknown> = {}) => ({
  id: LOOKOUT,
  grant_id: GRANT,
  title: "Retraction watch",
  brief: "Watch the retraction record behind the nutrition sources.",
  status: "active",
  heartbeat_hours: 24,
  triggers: ["retraction"],
  model: null,
  max_value: 6,
  workspace: null,
  grant_skills: [],
  grant_status: "active",
  mandate_title: "Nutrition literature",
  mandate_objective: null,
  scope_claim_id: null,
  scope_query: "nutrition",
  flags: 0,
  ...over,
});

beforeEach(() => {
  state.lookout = lookout();
  state.events = [];
  state.flags = [];
  state.consumed = [];
  state.loop = null;
  state.script = [];
  state.reassess = [];
  state.ingests = [];
  state.notes = [];
  state.workspace = null;
  state.feeds = [];
  state.triage = [];
  state.maxIterations = 0;
  state.maxTokens = 0;
  state.pendingCount = 0;
  state.mandateToolOpts = null;
  state.retractionPage = { total: 0, offset: 0, next_offset: null, rows: [] };
  state.scopeSourcesInput = null;
});

describe("runLookout", () => {
  it("briefs the watcher with its brief, bounds, queued inputs, and earlier flags, and consumes the inputs", async () => {
    state.events = [
      { id: "ev-1", kind: "retraction", payload: { doi: "10.1/x", note: "retracted" }, created_at: new Date("2026-09-10T08:00:00Z") },
    ];
    state.flags = [
      { kind: "reassess", claim_id: "c-9", claim_text: "Vitamin D prevents colds", url: null, action_status: "open", ran: false, moved: false, repeats: 2, created_at: new Date("2026-09-01T00:00:00Z") },
    ];
    const res = await runLookout({ lookoutId: LOOKOUT });
    const b = state.loop!.briefing;
    expect(b).toContain("Watch the retraction record behind the nutrition sources.");
    // What it raises goes to the officers unless its Grantmaker gave it a limit; no count of ingests (#695).
    expect(b).toContain("everything you raise goes to the mandate's program officers");
    // The stored bounds govern, whatever the brief says, and say why.
    expect(b).toContain("these govern");
    expect(b).toMatch(/Heartbeat: every \d+h \(a run opens within about 15 minutes of falling due\)|Heartbeat: none/);
    expect(b).not.toMatch(/ingests? this run/);
    expect(b).toContain("[retraction] 2026-09-10T08:00");
    expect(b).toContain("still waiting for its pass (repeated 2x)");
    expect(b).toContain("this is your first run");
    expect(state.consumed).toEqual([["ev-1"]]);
    expect(res).toMatchObject({ note: "Checked the sources; nothing warranted work.", flagsRaised: 0, eventsConsumed: 1 });
  });

  it("carries the watcher's toolset, with web search on every model", async () => {
    state.lookout = lookout({ model: "claude-sonnet-5-5" });
    await runLookout({ lookoutId: LOOKOUT });
    const names = state.loop!.tools.map((t) => t.name);
    expect(names).toEqual([
      "web_search",
      "raise_issue",
      "search_claims", "get_claim", "get_decomposition", "get_dependents",
      "query_sql",
      "submit_contribution",
      "read_page", "scope_sources", "check_doi", "recent_retractions",
      "read_listing",
      "flag_reassessment", "propose_ingest", "leave_note", "update_workspace",
    ]);
    expect(state.loop!.model).toBe("claude-sonnet-5-5");
    expect(state.loop!.briefing).toContain("Each tool result shows what you have spent");
    // The shared mandate tools, without the mandate's workspace (#691).
    expect(state.mandateToolOpts).toBeUndefined();
    expect(JSON.parse(await state.loop!.executeTool("read_page", { url: "https://x.test" }))).toMatchObject({ ok: true });
    // Room to rewrite a whole workspace in one call (#689).
    expect(state.maxTokens).toBe(16384);

    // No pin: the cheap-tier default, with the client-side tool of the same name.
    state.lookout = lookout({ model: null });
    await runLookout({ lookoutId: LOOKOUT });
    expect(state.loop!.tools[0]!.name).toBe("web_search");
    expect("input_schema" in state.loop!.tools[0]!).toBe(true);
    expect(state.loop!.model).toBe("openai/gpt-6-luna");
  });

  it("routes the candidate tools to the service with the delegated limit, and counts no ingests", async () => {
    state.script = [
      { name: "flag_reassessment", input: { claim_id: "c-1", rationale: "retracted primary source", budget_owls: 2 } },
      { name: "propose_ingest", input: { url: "https://example.org/a", rationale: "primary source missing", budget_owls: 0.5 } },
      { name: "propose_ingest", input: { url: "https://example.org/b", rationale: "another" } },
      { name: "leave_note", input: { text: "Two more sources look relevant; noting them for the review." } },
      { name: "update_workspace", input: { content: "checked: 10.1/x" } },
      { name: "get_claim", input: { claim_id: "c-1" } },
      { name: "nope", input: {} },
    ];
    const res = await runLookout({ lookoutId: LOOKOUT });
    expect(state.reassess[0]).toMatchObject({ lookoutId: LOOKOUT, grantId: GRANT, commissionLimitMicroUsd: 0, claimId: "c-1", budgetMicroUsd: 2_000_000 });
    // Both ingests reach the service, each with the limit and its budget
    // (no budget raises it to the officers).
    expect(state.ingests).toEqual([
      expect.objectContaining({ url: "https://example.org/a", commissionLimitMicroUsd: 0, budgetMicroUsd: 500_000 }),
      expect.objectContaining({ url: "https://example.org/b", commissionLimitMicroUsd: 0, budgetMicroUsd: 0 }),
    ]);
    expect(state.notes[0]).toMatchObject({ text: expect.stringContaining("noting them") });
    expect(state.workspace).toBe("checked: 10.1/x");
    expect(res).toMatchObject({ flagsRaised: 4, ingestsProposed: 2, notesLeft: 1 });
    const ingestTool = state.loop!.tools.find((t) => t.name === "propose_ingest") as unknown as {
      input_schema: { required: string[] };
    };
    expect(ingestTool.input_schema.required).not.toContain("budget_owls");
    expect(JSON.parse(await state.loop!.executeTool("nope", {}))).toEqual({ error: "unknown tool nope" });
  });

  it("gives a lookout that follows feeds its inbox and a feeds briefing, and triages within its ceiling", async () => {
    state.lookout = lookout({ commission_limit_micro_usd: 4_000_000 });
    state.feeds = [
      { feed_id: "f-1", title: "Some Substack", url: "https://x.substack.com/feed", status: "active", wake: "batch", waiting: 7, deferred: 2, oldest_waiting: "2026-09-09T10:00:00.000Z", last_polled_at: null, last_error: null },
    ];
    state.script = [
      { name: "triage_items", input: { decisions: [{ item_id: "i-1", decision: "ingest" }, { item_id: "i-2", decision: "ingest" }] } },
      { name: "propose_ingest", input: { url: "https://example.org/a", rationale: "the paper the post reports" } },
      { name: "propose_ingest", input: { url: "https://example.org/b", rationale: "and another" } },
    ];
    const res = await runLookout({ lookoutId: LOOKOUT });
    const names = state.loop!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["feed_inbox", "read_item", "triage_items", "set_feed_rule", "read_listing"]));
    expect(state.maxIterations).toBe(200);
    expect(state.loop!.briefing).toContain('f-1 "Some Substack"');
    expect(state.loop!.briefing).toContain("7 waiting, 2 deferred");
    expect(state.triage[0]).toMatchObject({ lookoutId: LOOKOUT, grantId: GRANT, commissionLimitMicroUsd: 4_000_000 });
    expect(state.triage[0]).not.toHaveProperty("ingestAllowance");
    expect(state.ingests).toHaveLength(2);
    expect(res).toMatchObject({ ingestsProposed: 4 });
    const read = JSON.parse(await state.loop!.executeTool("read_item", { item_id: "i-3", view: "full" }));
    expect(read.read_this_run).toEqual({ chars: 4000, approx_tokens: 1000 });
  });

  it("shows a retraction event in full, resting claims included, however many claims it names (#685)", async () => {
    const claimIds = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    state.events = [
      {
        id: "ev-1",
        kind: "retraction",
        payload: {
          doi: "10.1/paper", notice_doi: "10.1/notice", notice_type: "retraction", notice_title: "Retraction: X",
          source_id: "s-1", source_url: "https://doi.org/10.1/paper", source_title: "Paper X",
          claim_ids: claimIds,
          resting_claims: [{ claim_id: "c-rest", via: "draws_on", through_source_id: "s-2", through_source_title: "Review Y", relation_type: "cites" }],
          note: "Check whether any of them should be looked at again.",
        },
        created_at: new Date("2026-09-10T08:00:00Z"),
      },
    ];
    await runLookout({ lookoutId: LOOKOUT });
    const b = state.loop!.briefing;
    expect(b).toContain("claims asserting it (50)");
    expect(b).toContain(claimIds[49]);
    expect(b).toContain('c-rest via draws_on (cites) through source s-2 "Review Y"');
    // Everything fit, so no read_event tool.
    expect(state.loop!.tools.map((t) => t.name)).not.toContain("read_event");
  });

  it("lists inputs past the briefing's size one line each, reads them with read_event, and says how many wait", async () => {
    const big = "x".repeat(30_000);
    state.events = ["ev-1", "ev-2", "ev-3"].map((id) => ({
      id, kind: "manual", payload: { note: big, from: "grantmaker" }, created_at: new Date("2026-09-10T08:00:00Z"),
    }));
    state.events = [...state.events, ...Array.from({ length: 47 }, (_, i) => ({
      id: `ev-x${i}`, kind: "manual", payload: { note: "small" }, created_at: new Date("2026-09-10T09:00:00Z"),
    }))];
    state.pendingCount = 62;
    await runLookout({ lookoutId: LOOKOUT });
    const b = state.loop!.briefing;
    expect(b).toContain("(event ev-1) from grantmaker");
    expect(b).toContain("- [manual] 2026-09-10T08:00 (event ev-2): manual");
    expect(b).toContain("12 more inputs wait beyond these 50");
    expect(state.loop!.tools.map((t) => t.name)).toContain("read_event");
    expect(await state.loop!.executeTool("read_event", { event_id: "ev-2" })).toContain(big);
    expect(JSON.parse(await state.loop!.executeTool("read_event", { event_id: "nope" }))).toMatchObject({ ok: false });
  });

  it("looks sources up by id with their resting claims, pages recent_retractions, and says when Crossref failed", async () => {
    const res = JSON.parse(await (async () => {
      await runLookout({ lookoutId: LOOKOUT });
      return state.loop!.executeTool("scope_sources", { source_ids: ["s-1"] });
    })());
    expect(state.scopeSourcesInput).toMatchObject({ sourceIds: ["s-1"] });
    expect(res.resting_claims).toEqual([{ source_id: "s-1", claim_id: "c-7", via: "draws_on" }]);

    state.retractionPage = { total: 120, offset: 50, next_offset: 100, rows: [] };
    expect(JSON.parse(await state.loop!.executeTool("recent_retractions", { offset: 50 }))).toMatchObject({
      days: 30, total: 120, next_offset: 100,
    });
    state.retractionPage = null;
    expect(JSON.parse(await state.loop!.executeTool("recent_retractions", {}))).toMatchObject({ ok: false });
  });

  it("says how many flags the recent list leaves out, and gives the mandate's objective", async () => {
    state.lookout = lookout({ flags: 45, mandate_objective: "Map what is known about dietary fat." });
    state.flags = Array.from({ length: 20 }, () => ({
      kind: "note", claim_id: null, url: "https://x.org", repeats: 0, created_at: new Date("2026-09-01T00:00:00Z"),
    }));
    await runLookout({ lookoutId: LOOKOUT });
    const b = state.loop!.briefing;
    expect(b).toContain("The 20 most recent of the 45 you have raised");
    expect(b).toContain("Map what is known about dietary fat.");
  });

  it("reads its lookout by named columns, so a column the table gains (its label) is not handed to the run", async () => {
    const { rawQuery } = await import("../../../src/db/client.js");
    vi.mocked(rawQuery).mockClear();
    await runLookout({ lookoutId: LOOKOUT });
    const read = vi.mocked(rawQuery).mock.calls.map((c) => String(c[0])).find((q) => q.includes("FROM lookouts l JOIN grants g"))!;
    expect(read).toContain("SELECT l.id, l.grant_id, l.title, l.brief, l.status, l.model,");
    expect(read).not.toMatch(/\bl\.\*/);
    expect(read).not.toContain("sensitivity_label");
  });

  it("refuses to run a lookout that is paused or whose mandate is not active", async () => {
    state.lookout = lookout({ status: "paused" });
    await expect(runLookout({ lookoutId: LOOKOUT })).rejects.toThrow(/not active/);
    state.lookout = lookout({ grant_status: "completed" });
    await expect(runLookout({ lookoutId: LOOKOUT })).rejects.toThrow(/not active/);
  });
});
