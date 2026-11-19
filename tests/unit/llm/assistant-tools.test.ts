/**
 * The Assistant's gate (src/llm/tools/assistant-tools.ts): every account
 * tool that is not a read is either held for the user or listed, with its
 * reason, as one that runs without asking. A failure here means a tool that
 * writes was added to the MCP surface without deciding which: add it to
 * HELD_TOOLS if it spends owls on the graph or publishes under the user's
 * name, otherwise to RUNS_WITHOUT_ASKING with the reason.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  assistantAuth,
  createAssistantTools,
  currentToolInput,
  currentToolName,
  HELD_KINDS,
  HELD_TOOL_LABELS,
  HELD_TOOLS,
  openAccountTools,
  RENAMED_HELD_TOOLS,
  RUNS_WITHOUT_ASKING,
  type AccountTools,
} from "../../../src/llm/tools/assistant-tools.js";
import { MCP_EXCLUDED_ROUTES, ROUTE_TOOLS } from "../../../src/mcp/route-tools.js";

let app: FastifyInstance;
let account: AccountTools;

beforeAll(async () => {
  process.env.ENVIRONMENT = "staging";
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  account = await openAccountTools(
    app,
    assistantAuth({ id: "00000000-0000-4000-8000-000000000001", externalId: null }),
    "test"
  );
});

afterAll(async () => {
  await account?.close();
  await app?.close();
});

describe("the Assistant's tools", () => {
  it("are the account's MCP tools", () => {
    const names = account.definitions.map((d) => d.name);
    expect(names.length).toBeGreaterThan(80);
    expect(names).toContain("search_claims");
    expect(names).toContain("propose_claim");
  });

  it("classify every tool that is not a read", () => {
    const unclassified = account.definitions
      .map((d) => d.name)
      .filter((name) => !account.readOnly.has(name))
      .filter((name) => !(name in HELD_TOOLS) && !(name in RUNS_WITHOUT_ASKING));
    expect(unclassified).toEqual([]);
  });

  it("classify only tools that exist, each once", () => {
    const names = new Set(account.definitions.map((d) => d.name));
    // A tool whose route only a members-only deployment mounts is not among
    // this app's tools, and is classified all the same.
    const membersOnly = new Set([
      "fund_release_work",
      "set_gate",
      "set_gate_mode",
      "end_gate_setting",
      "decide_at_gate",
      "offer_to_gate",
      "set_page_flow",
      "end_page_flow",
      "hold_gate_item",
      "save_redaction_policy",
      "try_the_redactor",
      "send_pages_outside",
      "take_up_public_request",
      "decline_public_request",
      "fund_public_mandate",
      "back_public_mandate",
      "fund_public_node",
      "ask_public_mandate_for_assessment",
    ]);
    for (const name of membersOnly) expect(Object.values(ROUTE_TOOLS).map((t) => t.name)).toContain(name);
    const stale = [...Object.keys(HELD_TOOLS), ...Object.keys(RUNS_WITHOUT_ASKING)].filter(
      (name) => !names.has(name) && !membersOnly.has(name)
    );
    expect(stale).toEqual([]);
    expect(Object.keys(HELD_TOOLS).filter((name) => name in RUNS_WITHOUT_ASKING)).toEqual([]);
    expect(Object.keys(HELD_TOOL_LABELS).sort()).toEqual(Object.keys(HELD_TOOLS).sort());
    for (const kind of Object.values(HELD_TOOLS)) expect(kind in HELD_KINDS).toBe(true);
    for (const reason of Object.values(RUNS_WITHOUT_ASKING)) expect(reason.length).toBeGreaterThan(20);
  });

  it("cannot press its own cards or change what is allowed", () => {
    // Releasing a held action and changing the allowance are the user's own
    // acts: no tool reaches either route.
    const gate = ["POST /assistant/conversations/:id/held/:action_id", "PUT /assistant/allowance"];
    for (const key of gate) {
      expect(key in MCP_EXCLUDED_ROUTES).toBe(true);
      expect(key in ROUTE_TOOLS).toBe(false);
    }
    const names = account.definitions.map((d) => d.name);
    expect(names.filter((n) => /held|allowance/.test(n))).toEqual(["get_assistant_allowance"]);
  });

  it("holds a held tool without calling it, and runs it when its kind is allowed", async () => {
    const calls: string[] = [];
    const fake: AccountTools = {
      definitions: account.definitions,
      readOnly: account.readOnly,
      call: async (name) => {
        calls.push(name);
        return { text: JSON.stringify({ claim: { id: "x" } }), isError: false };
      },
      close: async () => undefined,
    };
    const used: string[] = [];
    let allow = false;
    const tools = createAssistantTools(fake, {
      hold: async (tool, _kind, input) => (allow ? fake.call(tool, input) : null),
      note: () => undefined,
      used: (tool) => used.push(tool),
    });

    const held = JSON.parse(await tools.execute("propose_claim", { text: "Eggs are fine." }));
    expect(held.held).toBe(true);
    expect(calls).toEqual([]);
    expect(used).toEqual([]);

    allow = true;
    const ran = JSON.parse(await tools.execute("propose_claim", { text: "Eggs are fine." }));
    expect(ran).toMatchObject({ held: false, ran_without_asking: true, ok: true });
    expect(calls).toEqual(["propose_claim"]);
    expect(used).toEqual(["propose_claim"]);

    // A read goes straight through.
    await tools.execute("search_claims", { query: "eggs" });
    expect(calls).toEqual(["propose_claim", "search_claims"]);
  });

  it("gives a delegated copy no delegate tool", () => {
    const hooks = { hold: async () => null, note: () => undefined, used: () => undefined };
    const top = createAssistantTools(account, { ...hooks, delegate: async () => "report" });
    const copy = createAssistantTools(account, hooks);
    expect(top.definitions.map((d) => d.name)).toContain("delegate");
    expect(copy.definitions.map((d) => d.name)).not.toContain("delegate");
  });
});

describe("a held tool that was renamed", () => {
  // An action held under the old name before a rename still waits for its
  // user's press: it must run, and read, as the tool it now is.
  it("resolves each old name to a held tool that exists, with its card's words", () => {
    const routeTools = new Set(Object.values(ROUTE_TOOLS).map((t) => t.name));
    for (const [old, now] of Object.entries(RENAMED_HELD_TOOLS)) {
      expect(currentToolName(old)).toBe(now);
      expect(HELD_TOOLS[now], now).toBeDefined();
      expect(HELD_TOOL_LABELS[now], now).toBeDefined();
      expect(routeTools.has(now), now).toBe(true);
      // The old name is gone, so nothing could reach it but the alias.
      expect(HELD_TOOLS[old], old).toBeUndefined();
      expect(routeTools.has(old), old).toBe(false);
    }
    expect(currentToolName("fund_showing_work")).toBe("fund_release_work");
    expect(currentToolName("cancel_order")).toBe("cancel_order");
  });

  it("reads a held action's input in the names its tool now takes", () => {
    // Held before the routes were renamed: the release was `showing_id`, and consent was the decision `release`.
    expect(currentToolInput("fund_showing_work", { showing_id: "s", page_id: "p", owls: 1 })).toEqual({ release_id: "s", page_id: "p", owls: 1 });
    expect(
      currentToolInput("decide_at_gate", { decision: "release", items: [{ item_id: "i", decision: "release" }, { item_id: "j", decision: "hold" }] })
    ).toEqual({ decision: "consent", items: [{ item_id: "i", decision: "consent" }, { item_id: "j", decision: "hold" }] });
    // A decision of another tool, and an input already in the new names, are left as they are.
    expect(currentToolInput("cancel_order", { decision: "release" })).toEqual({ decision: "release" });
    expect(currentToolInput("end_page_flow", { release_id: "r", reason: "replaced" })).toEqual({ release_id: "r", reason: "replaced" });
  });
});
