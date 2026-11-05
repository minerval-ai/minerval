import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Correspondent run (llm/agents/correspondent.ts, #563): the briefing
 * carries the readers, the brief, the scope, the budget and the mandate's
 * room, and the window of changes since the last update (those an earlier
 * quiet run read marked as seen); the toolset is the graph reads plus the
 * same list_graph_changes MCP serves, and nothing an outside client lacks
 * beyond publishing and the workspace; publish_update checks its items
 * against the window, computes "not covered" itself, and takes one update a
 * run; queued inputs are consumed and the run returns where the cursor
 * moves. The tool loop and the services are mocked.
 */

const CORR = "22222222-2222-4222-8222-222222222222";
const GRANT = "11111111-1111-4111-8111-111111111111";
const CLAIM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const { state } = vi.hoisted(() => ({
  state: {
    correspondent: null as null | Record<string, unknown>,
    window: null as null | Record<string, unknown>,
    events: [] as Array<{ id: string; kind: string; payload: Record<string, unknown>; created_at: Date }>,
    consumed: [] as string[][],
    published: [] as Array<Record<string, unknown>>,
    script: [] as Array<{ name: string; input: Record<string, unknown> }>,
    outputs: [] as string[],
    loop: null as null | { tools: Array<{ name: string }>; briefing: string; system: unknown; model?: string },
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params?: unknown[]) => {
    if (q.includes("FROM correspondents c JOIN grants g")) return state.correspondent ? [state.correspondent] : [];
    if (q.includes("FROM claims WHERE id = ANY") && q.includes("state = 'active'")) {
      return ((params?.[0] as string[]) ?? []).filter((id) => id === CLAIM_A || id === CLAIM_B).map((id) => ({ id }));
    }
    if (q.includes("FROM claims WHERE id = ANY")) return [{ id: CLAIM_A, text: "Claim A" }];
    return [];
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ correspondentModel: "claude-sonnet-5-5", monitorMaterialCredenceDelta: 0.1, publicWebBaseUrl: "https://minerval.ai" }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  runBudget: () => null,
  budgetRefusal: () => null,
  withAgent: (_a: string, fn: () => unknown) => fn(),
  withSkills: (_s: string[], fn: () => unknown) => fn(),
  getUsageContext: () => ({}),
}));
vi.mock("../../../src/llm/tools/skill-load-tools.js", () => ({
  createSkillLoadTools: () => ({ definitions: [], execute: async () => null, pointed: [], pointerNote: "" }),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [{ name: "raise_issue" }], execute: async () => null, raisedCount: 0 }),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () => [
    { name: "search_claims" },
    { name: "get_claim" },
    { name: "get_decomposition" },
    { name: "get_dependents" },
  ],
  executeGraphReadTool: async () => null,
}));
vi.mock("../../../src/services/correspondent-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/services/correspondent-service.js")>();
  return {
    ...real,
    pendingCorrespondentEvents: vi.fn(async () => state.events),
    correspondentWindow: vi.fn(async () => state.window),
    mandateRoom: vi.fn(async () => ({ headroomMicroUsd: 12_000_000, dayRoomMicroUsd: 2_000_000 })),
    consumeCorrespondentEvents: vi.fn(async (_id: string, ids: string[]) => {
      state.consumed.push(ids);
    }),
    publishCorrespondentUpdate: vi.fn(async (input: Record<string, unknown>) => {
      state.published.push(input);
      return { updateId: "u-1" };
    }),
    updateCorrespondentWorkspace: vi.fn(async (_id: string, c: string) => c.length),
  };
});
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string }>;
    system: unknown;
    model?: string;
    initialMessages: Array<{ content: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    state.loop = { tools: opts.tools, briefing: opts.initialMessages[0]!.content, system: opts.system, model: opts.model };
    for (const step of state.script) state.outputs.push(await opts.executeTool(step.name, step.input));
    return { content: "Read 3 changes; published one update.", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runCorrespondent } from "../../../src/llm/agents/correspondent.js";

function change(id: string, claimId: string, status = "doubtful") {
  return {
    change_id: id,
    at: "2026-11-05T10:00:00.000000Z",
    claim_id: claimId,
    claim_text: `Claim ${claimId.slice(0, 1)}`,
    kind: "status_moved",
    status,
    prev_status: "supported",
    confidence: 0.7,
    credence: 0.3,
    prev_credence: 0.7,
    credence_delta: -0.4,
    status_steps: 2,
    trigger: "lookout_flag",
    page_url: "",
    cursor: `cur-${id}`,
  };
}

beforeEach(() => {
  state.correspondent = {
    id: CORR,
    grant_id: GRANT,
    title: "X weekly",
    brief: "Tell the readers following X what moved in its argument and why it matters.",
    audience: "evaluators reviewing X",
    scope_claim_ids: [CLAIM_A],
    scope_tag_ids: [],
    scope_tag_slugs: ["ai-safety"],
    status: "active",
    heartbeat_hours: 168,
    triggers: ["graph_change"],
    min_wake_hours: 24,
    model: null,
    changes_cursor: null,
    workspace: null,
    grant_skills: [],
    grant_status: "active",
    mandate_title: "Following X",
    created_at: new Date(),
  };
  const seen = [change("c1", CLAIM_A)];
  const fresh = [change("c2", CLAIM_A), change("c3", CLAIM_B)];
  state.window = { from: "from-cur", to: "to-cur", seen, fresh, changes: [...seen, ...fresh], more: false };
  state.events = [{ id: "e1", kind: "graph_change", payload: {}, created_at: new Date() }];
  state.consumed = [];
  state.published = [];
  state.script = [];
  state.outputs = [];
  state.loop = null;
});

describe("runCorrespondent", () => {
  it("briefs the readers, the brief, the scope, the bounds and the window, seen changes marked", async () => {
    await runCorrespondent({ correspondentId: CORR });
    const b = state.loop!.briefing;
    expect(b).toContain("evaluators reviewing X");
    expect(b).toContain("Tell the readers following X");
    expect(b).toContain(`claim ${CLAIM_A} "Claim A" and everything beneath it`);
    expect(b).toContain("- tag ai-safety");
    expect(b).toContain("$12.00 uncommitted in escrow and $2.00 left of today's rate");
    expect(b).toContain("at most once every 24h");
    expect(b).toContain("- (seen) change c1");
    expect(b).toContain("- change c3");
    expect(state.loop!.model).toBe("claude-sonnet-5-5");
  });

  it("reads with the graph reads and the change stream outside clients have, plus publishing", async () => {
    await runCorrespondent({ correspondentId: CORR });
    expect(state.loop!.tools.map((t) => t.name).sort()).toEqual(
      [
        "raise_issue",
        "search_claims",
        "get_claim",
        "get_decomposition",
        "get_dependents",
        "list_graph_changes",
        "publish_update",
        "update_workspace",
      ].sort()
    );
  });

  it("publishes one update with not-covered computed from the window, and returns the cursor to move to", async () => {
    state.script = [
      { name: "publish_update", input: { title: "X: A moved", body: "Claim A moved from supported to doubtful.", items: [{ claim_id: CLAIM_B, reason: "Not in the window", change_ids: ["c9"] }], unexamined: "" } },
      {
        name: "publish_update",
        input: {
          title: "X: A moved",
          body: "Claim A moved from supported to doubtful.",
          items: [{ claim_id: CLAIM_A, reason: "It moved from supported to doubtful.", change_ids: ["c2"] }],
          unexamined: "The arguments under B were not read.",
        },
      },
      { name: "publish_update", input: { title: "Again", body: "A second update in one run.", items: [], unexamined: "" } },
    ];
    const res = await runCorrespondent({ correspondentId: CORR });
    expect(JSON.parse(state.outputs[0]!)).toMatchObject({ ok: false });
    expect(JSON.parse(state.outputs[1]!)).toMatchObject({ ok: true, update_id: "u-1", not_covered: { changes_total: 1 } });
    expect(JSON.parse(state.outputs[2]!)).toMatchObject({ ok: false });
    expect(state.published).toHaveLength(1);
    const nc = state.published[0]!.notCovered as { changes: Array<{ change_id: string }>; unexamined: string };
    // c1 shares CLAIM_A with the item, so only c3 (on B) is uncovered.
    expect(nc.changes.map((c) => c.change_id)).toEqual(["c3"]);
    expect(nc.unexamined).toBe("The arguments under B were not read.");
    expect(state.published[0]).toMatchObject({ changesFrom: "from-cur", changesTo: "to-cur", grantId: GRANT });
    expect(res).toMatchObject({ published: true, updateId: "u-1", cursorTo: "to-cur", eventsConsumed: 1 });
    expect(state.consumed).toEqual([["e1"]]);
  });

  it("may publish nothing, and still consumes its inputs and moves its cursor", async () => {
    const res = await runCorrespondent({ correspondentId: CORR });
    expect(res).toMatchObject({ published: false, updateId: null, cursorTo: "to-cur" });
    expect(state.consumed).toEqual([["e1"]]);
  });
});
