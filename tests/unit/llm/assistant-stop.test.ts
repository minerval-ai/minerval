/**
 * The stop button during a read that waits (src/llm/agents/assistant.ts,
 * stopSignal): get_grant_conversation can wait two minutes for the
 * Grantmaker, and a stop pressed during it ends the reply at once rather
 * than after the wait. A write is left to finish, so the reply records it.
 */
import { describe, it, expect, vi } from "vitest";
import { runAssistantTurn } from "../../../src/llm/agents/assistant.js";
import type { AccountTools } from "../../../src/llm/tools/assistant-tools.js";

// The loop is stood in for: one turn that calls the tool the test names.
let callTool = "get_grant_conversation";
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(
    async (options: {
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
      onText?: (delta: string, turn: number) => void;
    }) => {
      options.onText?.("Waiting on the Grantmaker.", 0);
      const out = await options.executeTool(callTool, { id: "g1" });
      return { content: `Read: ${out}` };
    }
  ),
}));
vi.mock("../../../src/services/trace-service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/trace-service.js")>()),
  startAgentRun: () => null,
}));

const def = (name: string) => ({ name, description: "", input_schema: { type: "object" as const, properties: {} } });

function account(finish: { resolve?: (v: { text: string; isError: boolean }) => void }): AccountTools {
  return {
    definitions: [def("get_grant_conversation"), def("send_grant_message")],
    readOnly: new Set(["get_grant_conversation"]),
    call: () => new Promise((resolve) => (finish.resolve = resolve)),
    close: async () => undefined,
  };
}

function turn(acct: AccountTools, stopSignal: AbortSignal) {
  return runAssistantTurn({
    transcript: [{ role: "user", content: "Draft the mandate." }],
    context: "Context.",
    sections: [],
    model: "test-model",
    account: acct,
    conversationMicroUsd: 0,
    charge: async () => ({ balanceMicroUsd: 1_000_000, stop: false }),
    hold: async () => null,
    stopSignal,
  });
}

describe("a stop pressed while a read waits", () => {
  it("ends the reply at once, keeping the text written so far", async () => {
    callTool = "get_grant_conversation";
    const stop = new AbortController();
    const finish: { resolve?: (v: { text: string; isError: boolean }) => void } = {};
    const running = turn(account(finish), stop.signal);
    await vi.waitFor(() => expect(finish.resolve).toBeDefined());
    stop.abort();
    const result = await running;
    expect(result.stopped).toBe("user");
    expect(result.reply).toBe("Waiting on the Grantmaker.");
    // The read ending later changes nothing.
    finish.resolve!({ text: "{}", isError: false });
  });

  it("lets a write finish, so the reply records it", async () => {
    callTool = "send_grant_message";
    const stop = new AbortController();
    const finish: { resolve?: (v: { text: string; isError: boolean }) => void } = {};
    const running = turn(account(finish), stop.signal);
    await vi.waitFor(() => expect(finish.resolve).toBeDefined());
    stop.abort();
    finish.resolve!({ text: "sent", isError: false });
    const result = await running;
    expect(result.stopped).toBeNull();
    expect(result.toolUses).toEqual([{ tool: "send_grant_message", ok: true }]);
  });
});
