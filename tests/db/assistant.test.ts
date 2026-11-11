/**
 * Assistant conversations against real Postgres and the real app: a message
 * claims the turn and the reply lands in the background; the run is charged
 * as it goes and ends when the balance does or the user stops it; a held
 * action waits for the user, runs once when pressed, and runs at once when
 * its kind is allowed; and what the Assistant writes to a granting
 * conversation is marked as its own.
 *
 * The Assistant's model loop is replaced by a script each test sets; its
 * tools are the real ones, reached through the in-process MCP server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

type TurnInput = {
  transcript: Array<{ role: string; content: string }>;
  context: string;
  account: { call: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> };
  charge: (replyMicroUsd: number) => Promise<{ balanceMicroUsd: number; stop: boolean }>;
  hold: (tool: string, kind: string, input: Record<string, unknown>) => Promise<unknown>;
  onText?: (delta: string, turn: number) => void;
  onNote?: (text: string) => void;
};
type TurnResult = { reply: string; stopped: "user" | "balance" | null; toolUses: unknown[]; runId: string | null };

const agent = vi.hoisted(() => ({
  script: null as null | ((input: never) => Promise<unknown>),
  inputs: [] as unknown[],
}));

vi.mock("../../src/llm/agents/assistant.js", () => ({
  runAssistantTurn: vi.fn(async (input: never) => {
    agent.inputs.push(input);
    if (agent.script) return agent.script(input);
    return { reply: "A reply.", stopped: null, toolUses: [], runId: null };
  }),
}));

vi.mock("../../src/llm/agents/grantmaker.js", () => ({
  runGrantmakerTurn: vi.fn(async () => ({ reply: "What is the question you want worked?" })),
}));

import { rawQuery } from "../../src/db/client.js";
import {
  addAssistantMessage,
  decideHeldAction,
  deleteAssistantConversation,
  getAllowance,
  getAssistantConversation,
  serializeAssistantConversation,
  setAllowance,
  settleAssistantTurns,
  startAssistantConversation,
  stopAssistantTurn,
} from "../../src/services/assistant-service.js";
import { chargeMetered } from "../../src/services/owl-ledger-service.js";
import { getEntitlement } from "../../src/services/billing-service.js";
import {
  resetGrantConversationRateLimiter,
  settleGrantConversationTurns,
} from "../../src/services/grant-conversation-service.js";
import { seedUser, creditOwls, owlBalance, OWL } from "./helpers.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await settleAssistantTurns();
  await settleGrantConversationTurns();
  await app?.close();
});

beforeEach(() => {
  agent.script = null;
  agent.inputs = [];
  resetGrantConversationRateLimiter();
});

function script(fn: (input: TurnInput) => Promise<TurnResult>) {
  agent.script = fn as never;
}

/** A user whose balance is exactly `microUsd`, free grants included. */
async function userWith(label: string, microUsd: number) {
  const id = await seedUser(label);
  // Reading the entitlement mints the signup and monthly grants; level the
  // balance afterwards so each test starts from a known figure.
  const granted = (await getEntitlement(id)).owlBalanceMicroUsd;
  if (microUsd > granted) await creditOwls(id, microUsd - granted);
  if (microUsd < granted) await chargeMetered({ userId: id, microUsd: granted - microUsd, op: "test" });
  return { id, externalId: null };
}

const user = (label: string, owls = 10) => userWith(label, owls * OWL);

async function start(u: { id: string; externalId: null }, message = "Where does the egg question stand?") {
  const started = await startAssistantConversation({ app, user: u, message });
  if (!started.ok) throw new Error(started.message);
  return started.conversation;
}

type Wire = Awaited<ReturnType<typeof serializeAssistantConversation>>;
async function read(id: string, userId: string): Promise<Wire> {
  return serializeAssistantConversation((await getAssistantConversation(id, userId))!);
}

describe("chargeMetered", () => {
  it("debits what the work cost, and no more than the balance holds", async () => {
    const u = await user("metered", 1);
    const first = await chargeMetered({ userId: u.id, microUsd: 400_000, op: "assistant" });
    expect(first).toEqual({ chargedMicroUsd: 400_000, balanceMicroUsd: 600_000 });
    // The platform absorbs what a turn cost past the balance.
    const second = await chargeMetered({ userId: u.id, microUsd: 900_000, op: "assistant" });
    expect(second).toEqual({ chargedMicroUsd: 600_000, balanceMicroUsd: 0 });
    const third = await chargeMetered({ userId: u.id, microUsd: 50_000, op: "assistant" });
    expect(third).toEqual({ chargedMicroUsd: 0, balanceMicroUsd: 0 });
    expect(await owlBalance(u.id)).toBe(0);
  });
});

describe("assistant conversations", () => {
  it("saves the message at once, then records the reply with its cost", async () => {
    const u = await user("basic");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script(async (input) => {
      input.onNote?.("Reading the decomposition");
      await input.charge(250_000);
      await gate;
      await input.charge(400_000);
      return { reply: "It is inconclusive.", stopped: null, toolUses: [{ tool: "get_claim", ok: true }], runId: null };
    });
    const convo = await start(u);
    expect((convo.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);

    await new Promise((r) => setTimeout(r, 1_300));
    const mid = await read(convo.id, u.id);
    expect(mid.turn).toMatchObject({ state: "replying", note: "Reading the decomposition", cost_micro_usd: 250_000 });

    release();
    await settleAssistantTurns();
    const done = await read(convo.id, u.id);
    expect(done.turn.state).toBe("idle");
    expect(done.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(done.messages[1]).toMatchObject({
      content: "It is inconclusive.",
      cost_micro_usd: 400_000,
      worked: [{ tool: "get_claim", count: 1 }],
    });
    expect(done.spent_micro_usd).toBe(400_000);
    expect(done.balance_micro_usd).toBe(10 * OWL - 400_000);
    expect(await owlBalance(u.id)).toBe(10 * OWL - 400_000);
  });

  it("tells the Assistant the balance, the bill, and that nothing else limits it", async () => {
    const u = await user("context", 3);
    await start(u);
    await settleAssistantTurns();
    const input = agent.inputs[0] as TurnInput;
    expect(input.context).toContain("balance $3.00");
    expect(input.context).toContain("This conversation has cost so far: $0.00");
    expect(input.context).toContain("there is no ceiling on this reply");
    expect(input.context).toContain("Allowed without asking: nothing");
  });

  it("refuses a message only when the balance is zero", async () => {
    const broke = await user("broke", 0);
    const refused = await startAssistantConversation({ app, user: broke, message: "Hello" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("INSUFFICIENT_OWLS");

    // A cent is enough to start: there is no minimum and no reserve.
    const nearly = await userWith("nearly", 10_000);
    const ok = await startAssistantConversation({ app, user: nearly, message: "Hello" });
    expect(ok.ok).toBe(true);
    await settleAssistantTurns();
  });

  it("reports the balance running out to the run, and charges no more than there was", async () => {
    const u = await user("runs-out", 1);
    const seen: number[] = [];
    script(async (input) => {
      seen.push((await input.charge(700_000)).balanceMicroUsd);
      seen.push((await input.charge(1_600_000)).balanceMicroUsd);
      return { reply: "As far as I got.", stopped: "balance", toolUses: [], runId: null };
    });
    const convo = await start(u);
    await settleAssistantTurns();
    expect(seen.slice(0, 2)).toEqual([300_000, 0]);
    const done = await read(convo.id, u.id);
    expect(done.messages[1]).toMatchObject({ stopped: "balance", cost_micro_usd: OWL });
    expect(done.spent_micro_usd).toBe(OWL);
    expect(await owlBalance(u.id)).toBe(0);

    // The next reply's transcript says why the last one ended.
    await creditOwls(u.id, OWL);
    await addAssistantMessage({ app, user: u, conversationId: convo.id, message: "Go on." });
    await settleAssistantTurns();
    const next = agent.inputs.at(-1) as TurnInput;
    expect(next.transcript[1]!.content).toContain("ended early: the balance ran out");
  });

  it("passes the user's stop to the running turn", async () => {
    const u = await user("stop");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stop = false;
    script(async (input) => {
      await input.charge(100_000);
      await gate;
      stop = (await input.charge(200_000)).stop;
      return { reply: "Partial.", stopped: stop ? "user" : null, toolUses: [], runId: null };
    });
    const convo = await start(u);
    expect(await stopAssistantTurn(convo.id, u.id)).toBe(true);
    expect((await read(convo.id, u.id)).turn.stopping).toBe(true);
    release();
    await settleAssistantTurns();
    expect(stop).toBe(true);
    const done = await read(convo.id, u.id);
    expect(done.messages[1]).toMatchObject({ stopped: "user", content: "Partial." });
    expect(done.turn).toMatchObject({ state: "idle", stopping: false });
    // Nothing is running now, so there is nothing to stop.
    expect(await stopAssistantTurn(convo.id, u.id)).toBe(false);
  });

  it("refuses a second message while a turn runs", async () => {
    const u = await user("busy");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script(async () => {
      await gate;
      return { reply: "Done.", stopped: null, toolUses: [], runId: null };
    });
    const convo = await start(u);
    const second = await addAssistantMessage({ app, user: u, conversationId: convo.id, message: "And?" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("TURN_IN_PROGRESS");
    release();
    await settleAssistantTurns();
    expect((await read(convo.id, u.id)).messages).toHaveLength(2);
  });

  it("keeps the message and records why when a turn fails, still charged for what ran", async () => {
    const u = await user("fails");
    script(async (input) => {
      await input.charge(120_000);
      throw new Error("model unavailable");
    });
    const convo = await start(u);
    await settleAssistantTurns();
    const done = await read(convo.id, u.id);
    expect(done.turn).toMatchObject({ state: "failed", error: "model unavailable" });
    expect(done.messages.map((m) => m.role)).toEqual(["user"]);
    expect(done.spent_micro_usd).toBe(120_000);
  });

  it("is another user's 404", async () => {
    const u = await user("owner");
    const other = await user("other");
    const convo = await start(u);
    await settleAssistantTurns();
    expect(await getAssistantConversation(convo.id, other.id)).toBeNull();
    expect(await deleteAssistantConversation(convo.id, other.id)).toBe(false);
    expect(await deleteAssistantConversation(convo.id, u.id)).toBe(true);
    expect(await getAssistantConversation(convo.id, u.id)).toBeNull();
  });
});

describe("held actions", () => {
  const order = { claim_id: "00000000-0000-4000-8000-00000000dead" };

  it("waits for the user, and tells the Assistant what they decided", async () => {
    const u = await user("held");
    let ran: unknown = "unset";
    script(async (input) => {
      ran = await input.hold("cancel_order", "cancel", { id: order.claim_id });
      return { reply: "I have asked to cancel it.", stopped: null, toolUses: [], runId: null };
    });
    const convo = await start(u);
    await settleAssistantTurns();
    expect(ran).toBeNull();

    const waiting = await read(convo.id, u.id);
    expect(waiting.held_actions).toHaveLength(1);
    const card = waiting.held_actions[0]!;
    expect(card).toMatchObject({ tool: "cancel_order", kind: "cancel", status: "held", ran_without_asking: false });
    expect(waiting.messages[1]!.cards).toEqual([{ type: "held", id: card.id }]);

    const declined = await decideHeldAction({
      app,
      user: u,
      conversationId: convo.id,
      actionId: card.id,
      decision: "decline",
    });
    expect(declined.ok && declined.action.status).toBe("declined");
    // Decided once: a second press does nothing.
    const again = await decideHeldAction({
      app,
      user: u,
      conversationId: convo.id,
      actionId: card.id,
      decision: "run",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("ALREADY_DECIDED");

    script(async () => ({ reply: "Understood.", stopped: null, toolUses: [], runId: null }));
    await addAssistantMessage({ app, user: u, conversationId: convo.id, message: "No, leave it." });
    await settleAssistantTurns();
    const next = agent.inputs.at(-1) as TurnInput;
    expect(next.context).toMatch(/Their decisions since your last reply: cancel_order .*\(declined\)/);
  });

  it("runs the Assistant's own call as the user when pressed", async () => {
    const u = await user("pressed");
    script(async (input) => {
      await input.hold("cancel_order", "cancel", { id: order.claim_id });
      return { reply: "Held.", stopped: null, toolUses: [], runId: null };
    });
    const convo = await start(u);
    await settleAssistantTurns();
    const card = (await read(convo.id, u.id)).held_actions[0]!;
    const pressed = await decideHeldAction({
      app,
      user: u,
      conversationId: convo.id,
      actionId: card.id,
      decision: "run",
    });
    // The order does not exist, so the real route answers and says so: the
    // call went through the account's tools and its answer was recorded.
    expect(pressed.ok).toBe(true);
    if (pressed.ok) {
      expect(pressed.action.status).toBe("failed");
      expect(JSON.stringify(pressed.action.result)).toMatch(/not found/i);
    }
    // Another user cannot press it.
    const other = await user("presser");
    const denied = await decideHeldAction({
      app,
      user: other,
      conversationId: convo.id,
      actionId: card.id,
      decision: "run",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("NOT_FOUND");
  });

  it("runs an allowed kind at once and leaves a receipt", async () => {
    const u = await user("allowed");
    script(async (input) => {
      await input.hold("cancel_order", "cancel", { id: order.claim_id });
      return { reply: "Held.", stopped: null, toolUses: [], runId: null };
    });
    const convo = await start(u);
    await settleAssistantTurns();
    const card = (await read(convo.id, u.id)).held_actions[0]!;
    await decideHeldAction({
      app,
      user: u,
      conversationId: convo.id,
      actionId: card.id,
      decision: "run",
      allow: { scope: "conversation" },
    });
    expect((await read(convo.id, u.id)).allowed_kinds.conversation).toEqual(["cancel"]);
    expect(await getAllowance(u.id)).toEqual([]);

    let ran: unknown = null;
    script(async (input) => {
      ran = await input.hold("cancel_order", "cancel", { id: order.claim_id });
      return { reply: "Tried.", stopped: null, toolUses: [], runId: null };
    });
    await addAssistantMessage({ app, user: u, conversationId: convo.id, message: "Again." });
    await settleAssistantTurns();
    expect(ran).toMatchObject({ isError: true });
    const after = await read(convo.id, u.id);
    expect(after.held_actions).toHaveLength(2);
    expect(after.held_actions[1]).toMatchObject({ ran_without_asking: true, status: "failed" });
    expect((agent.inputs.at(-1) as TurnInput).context).toContain("Allowed without asking: Cancel orders");

    // Another kind in the same conversation is still held.
    script(async (input) => {
      ran = await input.hold("propose_claim", "propose", { text: "Eggs are fine." });
      return { reply: "Held.", stopped: null, toolUses: [], runId: null };
    });
    await addAssistantMessage({ app, user: u, conversationId: convo.id, message: "Propose it." });
    await settleAssistantTurns();
    expect(ran).toBeNull();
  });

  it("keeps an account-wide allowance across conversations, and only known kinds", async () => {
    const u = await user("always");
    expect(await setAllowance(u.id, ["cancel", "everything", "cancel"])).toEqual(["cancel"]);
    let ran: unknown = null;
    script(async (input) => {
      ran = await input.hold("cancel_order", "cancel", { id: order.claim_id });
      return { reply: "Tried.", stopped: null, toolUses: [], runId: null };
    });
    const convo = await start(u);
    await settleAssistantTurns();
    expect(ran).not.toBeNull();
    expect((await read(convo.id, u.id)).allowed_kinds.always).toEqual(["cancel"]);
  });
});

describe("the Assistant opened from the browser extension", () => {
  const page = {
    url: "https://example.com/eggs",
    title: "Eggs are fine, says study",
    claims: [
      {
        verbatim_text: "eggs do not raise heart risk",
        verdict: "contradicts",
        claim_id: null,
        canonical_form: "Regular egg consumption increases cardiovascular disease risk",
        status: "inconclusive",
      },
    ],
  };

  it("is told the page and what the extension found", async () => {
    const u = await user("extension");
    const started = await startAssistantConversation({
      app,
      user: u,
      message: "Is this article right?",
      page,
    });
    if (!started.ok) throw new Error(started.message);
    expect(started.conversation.surface).toBe("extension");
    await settleAssistantTurns();
    const input = agent.inputs.at(-1) as TurnInput & { sections: string[] };
    expect(input.context).toContain("Opened from: the browser extension.");
    expect(input.context).toContain("URL: https://example.com/eggs");
    expect(input.context).toContain("eggs do not raise heart risk");
    expect(input.sections.join("")).toContain("In the Minerval browser extension");
    expect(input.sections.join("")).not.toContain("On minerval.ai");
  });

  it("refuses a page with more findings than the route takes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/assistant/conversations",
      payload: {
        message: "x",
        page: { ...page, claims: Array.from({ length: 201 }, () => page.claims[0]) },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the Assistant saving a page", () => {
  it("saves through its own tools without asking, and the reply carries the page", async () => {
    const u = await user("pages");
    let pageId = "";
    script(async (input) => {
      const saved = await input.account.call("save_page", { title: "A brief", body: "What the graph holds." });
      if (saved.isError) throw new Error(saved.text);
      pageId = (JSON.parse(saved.text) as { page: { id: string } }).page.id;
      // Deleting is the user's own act: no tool reaches it.
      const gone = await input.account.call("delete_page", { id: pageId }).catch(() => ({ isError: true }));
      expect(gone.isError).toBe(true);
      return {
        reply: "Saved.",
        stopped: null,
        toolUses: [{ tool: "save_page", ok: true, pageId }],
        runId: null,
      };
    });
    const convo = await start(u, "Write me a brief.");
    await settleAssistantTurns();
    const done = await read(convo.id, u.id);
    expect(done.messages[1]!.cards).toEqual([{ type: "page", id: pageId }]);
    const rows = await rawQuery<{ user_id: string; title: string }>(
      `SELECT user_id, title FROM assistant_pages WHERE id = $1`,
      [pageId]
    );
    expect(rows).toEqual([{ user_id: u.id, title: "A brief" }]);
  });
});

describe("the Assistant in a granting conversation", () => {
  it("marks what it writes as its own, and the user's messages stay unmarked", async () => {
    const u = await user("grant");
    let grantId = "";
    script(async (input) => {
      const opened = await input.account.call("start_grant_conversation", {
        message: "My user wants the egg question worked down.",
      });
      if (opened.isError) throw new Error(opened.text);
      grantId = (JSON.parse(opened.text) as { conversation: { id: string } }).conversation.id;
      return {
        reply: "I have opened a conversation with the Grantmaker.",
        stopped: null,
        toolUses: [{ tool: "start_grant_conversation", ok: true, grantConversationId: grantId }],
        runId: null,
      };
    });
    const convo = await start(u, "Get the egg question funded.");
    await settleAssistantTurns();
    await settleGrantConversationTurns();

    const rows = await rawQuery<{ messages: Array<{ role: string; via?: string }>; user_id: string }>(
      `SELECT messages, user_id FROM grant_conversations WHERE id = $1`,
      [grantId]
    );
    expect(rows[0]!.user_id).toBe(u.id);
    expect(rows[0]!.messages[0]).toMatchObject({ role: "user", via: "assistant" });

    const done = await read(convo.id, u.id);
    expect(done.messages[1]!.cards).toEqual([{ type: "grant_conversation", id: grantId }]);

    // The user writing in the same conversation themselves is not marked.
    const { addMessage } = await import("../../src/services/grant-conversation-service.js");
    const own = await addMessage({ conversationId: grantId, userId: u.id, message: "I fund it myself." });
    expect(own.ok).toBe(true);
    await settleGrantConversationTurns();
    const after = await rawQuery<{ messages: Array<{ role: string; via?: string }> }>(
      `SELECT messages FROM grant_conversations WHERE id = $1`,
      [grantId]
    );
    const mine = after[0]!.messages.filter((m) => m.role === "user");
    expect(mine.map((m) => m.via ?? null)).toEqual(["assistant", null]);
  });
});
