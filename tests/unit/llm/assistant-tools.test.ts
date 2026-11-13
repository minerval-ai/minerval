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
  HELD_KINDS,
  HELD_TOOL_LABELS,
  HELD_TOOLS,
  openAccountTools,
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
      "fund_showing_work",
      "send_pages_outside",
      "take_up_public_request",
      "decline_public_request",
      "fund_public_mandate",
      "back_public_mandate",
      "fund_public_node",
      "ask_public_mandate_for_assessment",
      "send_report_to_maintainers",
      "send_failure_facts_to_maintainers",
      "fund_outward_work",
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
