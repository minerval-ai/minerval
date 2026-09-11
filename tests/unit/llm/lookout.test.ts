import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Lookout run (llm/agents/lookout.ts): the briefing carries the brief,
 * the delegated bounds, the queued inputs, and the record of earlier
 * flags; the toolset is the watcher's (graph reads, scope sources, the
 * retraction record, page reads, the three ways to raise a candidate) and
 * web search only on an Anthropic model; propose_ingest stops at the
 * per-run limit; the queued inputs are consumed after the run; the note is
 * the model's closing text. The tool loop and the services are mocked.
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
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    if (q.includes("FROM lookouts l JOIN grants g")) return state.lookout ? [state.lookout] : [];
    return [];
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ lookoutModel: "claude-haiku-4-5-20251001" }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  withAgent: (_a: string, fn: () => unknown) => fn(),
  withSkills: (_s: string[], fn: () => unknown) => fn(),
  getUsageContext: () => ({}),
}));
vi.mock("../../../src/llm/prompts/lookout.js", () => ({
  getLookoutSystemPromptBlocks: () => ["SYSTEM"],
}));
vi.mock("../../../src/llm/prompts/skills.js", () => ({
  skillsByName: () => [],
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
vi.mock("../../../src/llm/agents/grantor.js", () => ({
  surveyScope: vi.fn(async () => [{ id: "c1" }]),
}));
vi.mock("../../../src/services/lookout-service.js", () => ({
  LOOKOUT_BOUNDS: { workspaceChars: 50_000, noteChars: 2_000 },
  pendingLookoutEvents: vi.fn(async () => state.events),
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
}));
vi.mock("../../../src/services/source-watch-service.js", () => ({
  checkDoi: vi.fn(async (doi: string) => ({ doi, found: true, updates: [] })),
  recentRetractions: vi.fn(async () => []),
  scopeSources: vi.fn(async () => []),
  readPage: vi.fn(async () => ({ ok: true, text: "page", chars: 4 })),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string }>;
    system: unknown;
    model?: string;
    initialMessages: Array<{ content: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
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
  max_ingests_per_run: 1,
  workspace: null,
  grant_skills: [],
  grant_status: "active",
  mandate_title: "Nutrition literature",
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
    expect(b).toContain("clamped to 6/10");
    expect(b).toContain("at most 1 ingest this run");
    expect(b).toContain("[retraction] 2026-09-10T08:00");
    expect(b).toContain("still waiting for its pass (repeated 2x)");
    expect(b).toContain("this is your first run");
    expect(state.consumed).toEqual([["ev-1"]]);
    expect(res).toMatchObject({ note: "Checked the sources; nothing warranted work.", flagsRaised: 0, eventsConsumed: 1 });
  });

  it("carries the watcher's toolset, with web search only on an Anthropic model", async () => {
    await runLookout({ lookoutId: LOOKOUT });
    const names = state.loop!.tools.map((t) => t.name);
    expect(names).toEqual([
      "web_search",
      "raise_issue",
      "search_claims", "get_claim", "get_decomposition", "get_dependents",
      "survey_scope", "scope_sources", "check_doi", "recent_retractions", "read_page",
      "flag_reassessment", "propose_ingest", "leave_note", "update_workspace",
    ]);
    expect(state.loop!.model).toBe("claude-haiku-4-5-20251001");

    state.lookout = lookout({ model: "z-ai/glm-5.3-flash" });
    await runLookout({ lookoutId: LOOKOUT });
    expect(state.loop!.tools.map((t) => t.name)).not.toContain("web_search");
    expect(state.loop!.model).toBe("z-ai/glm-5.3-flash");
    expect(state.loop!.briefing).toContain("no web search on this model");
  });

  it("routes the candidate tools to the service with the delegated bounds, and stops ingests at the per-run limit", async () => {
    state.script = [
      { name: "flag_reassessment", input: { claim_id: "c-1", rationale: "retracted primary source", urgency: 9 } },
      { name: "propose_ingest", input: { url: "https://example.org/a", rationale: "primary source missing" } },
      { name: "propose_ingest", input: { url: "https://example.org/b", rationale: "another" } },
      { name: "leave_note", input: { text: "Two more sources look relevant but the limit is reached." } },
      { name: "update_workspace", input: { content: "checked: 10.1/x" } },
      { name: "get_claim", input: { claim_id: "c-1" } },
      { name: "nope", input: {} },
    ];
    const res = await runLookout({ lookoutId: LOOKOUT });
    expect(state.reassess[0]).toMatchObject({ lookoutId: LOOKOUT, grantId: GRANT, maxValue: 6, claimId: "c-1", urgency: 9 });
    expect(state.ingests).toHaveLength(1);
    expect(state.notes[0]).toMatchObject({ text: expect.stringContaining("limit is reached") });
    expect(state.workspace).toBe("checked: 10.1/x");
    expect(res).toMatchObject({ flagsRaised: 3, ingestsProposed: 1, notesLeft: 1 });
    // The second ingest was refused by the run limit, in the tool result.
    const second = await state.loop!.executeTool("propose_ingest", { url: "https://example.org/c", rationale: "x" });
    expect(JSON.parse(second)).toMatchObject({ ok: false, code: "RUN_LIMIT" });
    expect(JSON.parse(await state.loop!.executeTool("nope", {}))).toEqual({ error: "unknown tool nope" });
  });

  it("refuses to run a lookout that is paused or whose mandate is not active", async () => {
    state.lookout = lookout({ status: "paused" });
    await expect(runLookout({ lookoutId: LOOKOUT })).rejects.toThrow(/not active/);
    state.lookout = lookout({ grant_status: "completed" });
    await expect(runLookout({ lookoutId: LOOKOUT })).rejects.toThrow(/not active/);
  });
});
