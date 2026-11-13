/**
 * What the Assistant is told when its user lacks a permission
 * (src/llm/permissions-note.ts): the passage's wording, and that there is
 * none when nothing is withheld, which is always the case on the public
 * graph. Which tools are withheld from whom is in
 * tests/unit/mcp/parity.test.ts and tests/db/members-only.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { permissionsNote } from "../../../src/llm/permissions-note.js";
import { runAssistantTurn } from "../../../src/llm/agents/assistant.js";
import type { AccountTools } from "../../../src/llm/tools/assistant-tools.js";

const NOTE =
  "In this deployment its administrators grant each person separate permissions, and your " +
  "user does not hold all of them. The tools that need a permission your user lacks are not " +
  "offered to you in this conversation, so what your instructions and skills say about " +
  "using them does not apply here.\n" +
  "Without the permission to direct the graph: start_grant_conversation, submit_source.\n" +
  "Without the permission to fund work: fund_mandate.\n" +
  "An administrator of the deployment grants a permission. You cannot, and your user " +
  "cannot grant one to themselves. The rest of your instructions hold as written.";

describe("the permissions note", () => {
  it("is empty when nothing is withheld", () => {
    expect(permissionsNote([])).toBe("");
  });

  it("names each tool under the permission it needs, in the permissions' order", () => {
    expect(
      permissionsNote([
        { tool: "fund_mandate", permission: "fund" },
        { tool: "start_grant_conversation", permission: "direct" },
        { tool: "submit_source", permission: "direct" },
      ])
    ).toBe(NOTE);
  });
});

// The loop is stood in for: what matters here is the first message each run is sent.
const sent: Array<{ first: string; tools: string[] }> = [];
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (options: {
    initialMessages: Array<{ role: string; content: string }>;
    tools: Array<{ name: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    const last = options.initialMessages.at(-1)!;
    sent.push({ first: last.content, tools: options.tools.map((t) => t.name) });
    // The reply's own run delegates once, so the copy's first message is seen too.
    if (options.tools.some((t) => t.name === "delegate")) {
      await options.executeTool("delegate", { task: "Read the node and report." });
    }
    return { content: "Done." };
  }),
}));
vi.mock("../../../src/services/trace-service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/trace-service.js")>()),
  startAgentRun: () => null,
}));

function account(withheld: AccountTools["withheld"]): AccountTools {
  return {
    definitions: [{ name: "search_claims", description: "", input_schema: { type: "object" as const, properties: {} } }],
    readOnly: new Set(["search_claims"]),
    withheld,
    call: async () => ({ text: "{}", isError: false }),
    close: async () => undefined,
  };
}

async function turn(withheld: AccountTools["withheld"]) {
  sent.length = 0;
  await runAssistantTurn({
    transcript: [{ role: "user", content: "What does the graph say about eggs?" }],
    context: "Context for this reply (from the system, not from your user).",
    sections: [],
    model: "test-model",
    account: account(withheld),
    conversationMicroUsd: 0,
    charge: async () => ({ balanceMicroUsd: 1_000_000, stop: false }),
    hold: async () => null,
  });
  return sent;
}

describe("the Assistant's brief", () => {
  it("carries the note after the context, and at the head of a delegated copy's task", async () => {
    const [reply, copy] = await turn([
      { tool: "fund_mandate", permission: "fund" },
      { tool: "start_grant_conversation", permission: "direct" },
      { tool: "submit_source", permission: "direct" },
    ]);
    expect(reply!.first).toBe(
      `Context for this reply (from the system, not from your user).\n\n${NOTE}\n\n---\n\nWhat does the graph say about eggs?`
    );
    expect(copy!.first).toBe(`${NOTE}\n\n---\n\nRead the node and report.`);
    expect(copy!.tools).not.toContain("delegate");
  });

  it("is sent exactly as before when nothing is withheld", async () => {
    for (const withheld of [undefined, []]) {
      const [reply, copy] = await turn(withheld);
      expect(reply!.first).toBe(
        "Context for this reply (from the system, not from your user).\n\n---\n\nWhat does the graph say about eggs?"
      );
      expect(copy!.first).toBe("Read the node and report.");
    }
  });
});
