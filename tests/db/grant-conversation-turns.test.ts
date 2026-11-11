/**
 * Granting-conversation turns in the background, against real Postgres:
 * a message is saved and the turn claimed in one conditional write, the
 * caller gets the conversation back before the Grantmaker replies, a second
 * message while a turn runs claims nothing, a failed turn keeps the message
 * and records why, a turn whose process died can be taken over, and the
 * draft cannot be funded while a turn may still revise it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const agent = vi.hoisted(() => ({
  // Each turn waits on its own gate, so a test can hold a turn open.
  gates: [] as Array<{ release: () => void; promise: Promise<void> }>,
  fail: null as Error | null,
  mandate: null as Record<string, unknown> | null,
  transcripts: [] as unknown[],
}));

vi.mock("../../src/llm/agents/grantmaker.js", () => ({
  runGrantmakerTurn: vi.fn(async (input: {
    transcript: unknown[];
    onText?: (delta: string, turn: number) => void;
  }) => {
    agent.transcripts.push(input.transcript);
    input.onText?.("Here is ", 0);
    input.onText?.("my rep", 0);
    const gate = agent.gates.shift();
    if (gate) await gate.promise;
    if (agent.fail) throw agent.fail;
    return {
      reply: "Here is my reply.",
      ...(agent.mandate ? { mandate: agent.mandate } : {}),
    };
  }),
}));

import Fastify from "fastify";
import { rawQuery } from "../../src/db/client.js";
import { grantConversationRoutes } from "../../src/routes/grant-conversations.js";
import { mandateDraftHash } from "../../src/services/mandate-draft-hash.js";
import {
  addMessage,
  fundConversationMandate,
  getConversation,
  resetGrantConversationRateLimiter,
  serializeTurn,
  settleGrantConversationTurns,
  startConversation,
} from "../../src/services/grant-conversation-service.js";
import { seedUser, creditOwls, OWL } from "./helpers.js";

function hold(): () => void {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  agent.gates.push({ release, promise });
  return release;
}

const draft = {
  title: "Education research",
  objective: "Assess the load-bearing claims.",
  plan: { strategy: "Breadth first.", items: [{ action: "assess", rationale: "the root" }] },
  expected_cost_owls: 10,
};

beforeEach(() => {
  resetGrantConversationRateLimiter();
  agent.gates = [];
  agent.fail = null;
  agent.mandate = null;
  agent.transcripts = [];
});

describe("granting-conversation turns", () => {
  it("returns the saved message at once, then records the reply", async () => {
    const userId = await seedUser("turn-basic");
    const release = hold();
    const started = await startConversation({ userId, message: "Fund education research." });
    if (!started.ok) throw new Error(started.message);

    // Back before the Grantmaker replied: the message is saved, the turn runs.
    const convo = started.conversation;
    expect((convo.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
    expect(serializeTurn(convo).state).toBe("replying");

    release();
    await settleGrantConversationTurns();
    const done = (await getConversation(convo.id, userId))!;
    expect((done.messages as Array<{ role: string; content: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(serializeTurn(done).state).toBe("idle");
    expect(done.turnStartedAt).toBeNull();
  });

  it("shows the reply as it forms, and clears it when the turn ends", async () => {
    const userId = await seedUser("turn-partial");
    const release = hold();
    const started = await startConversation({ userId, message: "Draft it." });
    if (!started.ok) throw new Error(started.message);
    const id = started.conversation.id;

    // The partial reply is saved about once a second while it changes.
    await new Promise((r) => setTimeout(r, 1_400));
    const mid = (await getConversation(id, userId))!;
    expect(serializeTurn(mid)).toMatchObject({ state: "replying", partial: "Here is my rep" });

    release();
    await settleGrantConversationTurns();
    const done = (await getConversation(id, userId))!;
    expect(done.turnPartial).toBeNull();
    expect(serializeTurn(done).partial).toBeNull();
  });

  it("refuses a second message while a turn runs, without saving it", async () => {
    const userId = await seedUser("turn-busy");
    const release = hold();
    const started = await startConversation({ userId, message: "First." });
    if (!started.ok) throw new Error(started.message);

    const second = await addMessage({
      conversationId: started.conversation.id,
      userId,
      message: "Second, too soon.",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("TURN_IN_PROGRESS");

    release();
    await settleGrantConversationTurns();
    const done = (await getConversation(started.conversation.id, userId))!;
    const contents = (done.messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toEqual(["First.", "Here is my reply."]);
  });

  it("keeps the message and records why when the turn fails", async () => {
    const userId = await seedUser("turn-fail");
    agent.fail = new Error("400 tool_use ids were found without tool_result blocks");
    const started = await startConversation({ userId, message: "Please draft." });
    if (!started.ok) throw new Error(started.message);
    await settleGrantConversationTurns();

    const failed = (await getConversation(started.conversation.id, userId))!;
    expect((failed.messages as Array<{ content: string }>).map((m) => m.content)).toEqual([
      "Please draft.",
    ]);
    const turn = serializeTurn(failed);
    expect(turn.state).toBe("failed");
    expect(turn.error).toMatch(/tool_result/);

    // A follow-up starts a fresh turn, which clears the failure.
    agent.fail = null;
    const again = await addMessage({
      conversationId: failed.id,
      userId,
      message: "Please reply to my last message.",
    });
    expect(again.ok).toBe(true);
    await settleGrantConversationTurns();
    const recovered = (await getConversation(failed.id, userId))!;
    expect(serializeTurn(recovered).state).toBe("idle");
    expect(recovered.turnError).toBeNull();
    // The agent saw both of the funder's messages.
    expect(agent.transcripts.at(-1)).toHaveLength(2);
  });

  it("reads a turn whose process died as failed, and lets a new message take it over", async () => {
    const userId = await seedUser("turn-lost");
    const started = await startConversation({ userId, message: "Hello." });
    if (!started.ok) throw new Error(started.message);
    await settleGrantConversationTurns();
    const id = started.conversation.id;

    // A turn that claimed the conversation and then stopped beating.
    await rawQuery(
      `UPDATE grant_conversations
          SET turn_started_at = now() - interval '10 minutes',
              turn_heartbeat_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [id]
    );
    const lost = (await getConversation(id, userId))!;
    expect(serializeTurn(lost)).toMatchObject({ state: "failed", error: expect.stringMatching(/interrupted/) });

    const next = await addMessage({ conversationId: id, userId, message: "Are you there?" });
    expect(next.ok).toBe(true);
    await settleGrantConversationTurns();
    expect(serializeTurn((await getConversation(id, userId))!).state).toBe("idle");
  });

  it("refuses to fund the draft while a turn may still revise it", async () => {
    const userId = await seedUser("turn-fund");
    await creditOwls(userId, 100 * OWL);
    agent.mandate = draft;
    const started = await startConversation({ userId, message: "Draft it." });
    if (!started.ok) throw new Error(started.message);
    await settleGrantConversationTurns();
    const id = started.conversation.id;
    expect((await getConversation(id, userId))!.status).toBe("proposed");

    const release = hold();
    const talking = await addMessage({ conversationId: id, userId, message: "One change." });
    expect(talking.ok).toBe(true);

    const refused = await fundConversationMandate({ conversationId: id, userId, budgetOwls: 10 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("TURN_IN_PROGRESS");

    release();
    await settleGrantConversationTurns();
    const funded = await fundConversationMandate({ conversationId: id, userId, budgetOwls: 10 });
    expect(funded.ok).toBe(true);
  });

  it("reads only what the caller lacks, and waits for the turn to end (#905)", async () => {
    const userId = await seedUser("turn-delta");
    const app = Fastify();
    app.decorate("authenticate", async (request: { auth?: unknown }) => {
      request.auth = { userId };
    });
    app.decorate("requireUser", async () => {});
    await app.register(grantConversationRoutes, { prefix: "/grant-conversations" });
    await app.ready();
    try {
      // A send answers with the message's place and the turn, no transcript.
      agent.mandate = draft;
      const release = hold();
      const startRes = await app.inject({
        method: "POST",
        url: "/grant-conversations",
        payload: { message: "Fund education research." },
      });
      expect(startRes.statusCode).toBe(201);
      const sent = startRes.json().conversation;
      expect(sent).toMatchObject({
        message: { index: 0, role: "user" },
        message_count: 1,
        mandate_sha256: null,
        turn: { state: "replying" },
      });
      expect(sent).not.toHaveProperty("messages");
      expect(sent).not.toHaveProperty("mandate");
      const id = sent.id as string;

      // A read that waits returns once the turn ends, with the reply alone.
      const reading = app.inject({
        method: "GET",
        url: `/grant-conversations/${id}?after=1&wait=10`,
      });
      await new Promise((r) => setTimeout(r, 300));
      release();
      const read = (await reading).json().conversation;
      expect(read.turn.state).toBe("idle");
      expect(read.message_count).toBe(2);
      expect(read.messages_after).toBe(1);
      expect(read.messages.map((m: { role: string }) => m.role)).toEqual(["assistant"]);
      expect(read.mandate.title).toBe(draft.title);
      const stored = (await getConversation(id, userId))!;
      expect(read.mandate_sha256).toBe(mandateDraftHash(stored.mandate));

      // With the hash it holds, the caller is not sent the draft again.
      const again = (
        await app.inject({
          method: "GET",
          url: `/grant-conversations/${id}?after=2&mandate_sha256=${read.mandate_sha256}`,
        })
      ).json().conversation;
      expect(again.messages).toEqual([]);
      expect(again.mandate_unchanged).toBe(true);
      expect(again).not.toHaveProperty("mandate");

      // With no parameters, the whole conversation, as before.
      const whole = (await app.inject({ method: "GET", url: `/grant-conversations/${id}` })).json()
        .conversation;
      expect(whole.messages).toHaveLength(2);
      expect(whole.mandate.title).toBe(draft.title);

      // A wait with no turn running answers at once.
      const t0 = Date.now();
      await app.inject({ method: "GET", url: `/grant-conversations/${id}?wait=25` });
      expect(Date.now() - t0).toBeLessThan(2_000);

      // A wait is capped.
      const tooLong = await app.inject({ method: "GET", url: `/grant-conversations/${id}?wait=60` });
      expect(tooLong.statusCode).toBe(400);

      // The list carries summaries, not transcripts.
      const list = (await app.inject({ method: "GET", url: "/grant-conversations" })).json();
      expect(list.conversations[0]).toMatchObject({ id, title: draft.title, message_count: 2 });
      expect(list.conversations[0]).not.toHaveProperty("messages");

      // A follow-up send, then funding, answer without the conversation.
      await creditOwls(userId, 100 * OWL);
      const follow = await app.inject({
        method: "POST",
        url: `/grant-conversations/${id}/messages`,
        payload: { message: "Looks good." },
      });
      expect(follow.statusCode).toBe(202);
      expect(follow.json().conversation).toMatchObject({ message: { index: 2 }, message_count: 3 });
      await settleGrantConversationTurns();
      const fund = await app.inject({
        method: "POST",
        url: `/grant-conversations/${id}/fund`,
        payload: { budget_owls: 10 },
      });
      expect(fund.statusCode).toBe(200);
      expect(fund.json()).toEqual({
        grant_id: expect.any(String),
        conversation: { id, status: "funded" },
      });
    } finally {
      await app.close();
    }
  });
});
