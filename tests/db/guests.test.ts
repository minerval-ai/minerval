/**
 * Guests on /ask (docs/accounts.md, "Guests"), against real Postgres and the
 * real app: a guest pass gives the guest owls and no signup grant; the
 * per-address and daily bounds refuse with what was met; a guest's session
 * reaches the Assistant's routes and nothing else; a guest's conversation is
 * on the standard model and its tools are reads and the guest acts; and
 * signing in carries the guest's conversations to the account.
 *
 * The Assistant's model loop is replaced by a script; its tools are real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const SERVICE_KEY = "guests-web-tier-key";

vi.hoisted(() => {
  process.env.API_KEYS = "guests-web-tier-key";
  process.env.LOG_LEVEL = "fatal";
  process.env.GUEST_ASK_OWLS = "5";
  process.env.GUEST_ASK_DAILY_OWLS = "12";
  process.env.GUEST_ASK_PER_ADDRESS_PER_DAY = "1";
});

const agent = vi.hoisted(() => ({
  inputs: [] as Array<{ sections?: string[]; model?: string; account: { definitions: Array<{ name: string }> } }>,
}));

vi.mock("../../src/llm/agents/assistant.js", () => ({
  runAssistantTurn: vi.fn(async (input: never) => {
    agent.inputs.push(input);
    return { reply: "A reply.", stopped: null, toolUses: [], runId: null };
  }),
}));
vi.mock("../../src/llm/client.js", async (original) => ({
  ...(await original<typeof import("../../src/llm/client.js")>()),
  complete: vi.fn(async () => ({ content: "A title", model: "test", usage: {}, stopReason: "end_turn" })),
}));

import { rawQuery } from "../../src/db/client.js";
import { settleAssistantTurns } from "../../src/services/assistant-service.js";
import { getEntitlement } from "../../src/services/billing-service.js";
import { loadConfig } from "../../src/config.js";
import { OWL } from "./helpers.js";

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await settleAssistantTurns();
  await app?.close();
});

beforeEach(async () => {
  agent.inputs = [];
  // Each test starts the day's giving from nothing.
  await rawQuery(`DELETE FROM guest_passes`);
});

async function makeGuest(address: string) {
  return app.inject({
    method: "POST",
    url: "/users/guest",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { address },
  });
}

function asGuest(externalId: string, req: { method: "GET" | "POST" | "PUT" | "PATCH"; url: string; payload?: unknown }) {
  return app.inject({
    ...req,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": externalId },
  } as never);
}

describe("guest passes", () => {
  it("gives a guest its owls and no signup grant, and states the terms", async () => {
    const terms = await app.inject({ method: "GET", url: "/users/guest", headers: { "x-api-key": SERVICE_KEY } });
    expect(terms.json()).toMatchObject({
      offered: true,
      terms: { owls: 5, daily_owls: 12, per_address_per_day: 1 },
      models: [{ id: loadConfig().assistantStandardModel }],
    });

    const res = await makeGuest("203.0.113.1");
    expect(res.statusCode).toBe(201);
    const guest = res.json().guest as { id: string; external_id: string; granted_owls: number };
    expect(guest.external_id).toMatch(/^guest:/);
    expect(guest.granted_owls).toBe(5);
    // Reading the entitlement mints a person's free grants; a guest's is only its pass.
    expect((await getEntitlement(guest.id)).owlBalanceMicroUsd).toBe(5 * OWL);
    const reasons = await rawQuery<{ reason: string }>(`SELECT reason FROM owl_ledger WHERE user_id = $1`, [guest.id]);
    expect(reasons.map((r) => r.reason)).toEqual(["guest_grant"]);
    // The address itself is not kept.
    const [pass] = await rawQuery<{ address_hash: string }>(`SELECT address_hash FROM guest_passes WHERE account_id = $1`, [guest.id]);
    expect(pass!.address_hash).not.toContain("203.0.113.1");
  });

  it("refuses a second guest from one address in a day, and past the day's owls", async () => {
    expect((await makeGuest("198.51.100.7")).statusCode).toBe(201);
    const again = await makeGuest("198.51.100.7");
    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe("GUEST_ADDRESS_LIMIT");
    expect(again.json().error).toMatch(/Make an account/);

    // 12 a day at 5 each: a second address fits, a third does not.
    expect((await makeGuest("198.51.100.8")).statusCode).toBe(201);
    const third = await makeGuest("198.51.100.9");
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe("GUEST_DAILY_LIMIT");
  });

  it("is refused to anyone but the web tier", async () => {
    const res = await app.inject({ method: "POST", url: "/users/guest", payload: { address: "192.0.2.1" } });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
  });

  it("is not a sign-in identity", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users/provision",
      headers: { "x-api-key": SERVICE_KEY },
      payload: { external_id: "guest:made-up", display_name: "x" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("a guest's session", () => {
  it("reaches the Assistant, on the standard model with reads and the guest acts, and nothing else", async () => {
    const guest = (await makeGuest("203.0.113.20")).json().guest as { id: string; external_id: string };

    const refused = await asGuest(guest.external_id, { method: "GET", url: "/api-keys" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("GUEST_NOT_ALLOWED");

    const home = await asGuest(guest.external_id, { method: "GET", url: "/assistant/conversations" });
    expect(home.statusCode).toBe(200);
    expect(home.json().guest).toMatchObject({ granted_owls: 5, owls: 5 });
    expect(home.json().models.map((m: { id: string }) => m.id)).toEqual([loadConfig().assistantStandardModel]);

    const frontier = await asGuest(guest.external_id, {
      method: "POST",
      url: "/assistant/conversations",
      payload: { message: "Is coffee bad for you?", model: loadConfig().assistantModel },
    });
    if (loadConfig().assistantModel !== loadConfig().assistantStandardModel) {
      expect(frontier.statusCode).toBe(400);
    }

    const started = await asGuest(guest.external_id, {
      method: "POST",
      url: "/assistant/conversations",
      payload: { message: "Is coffee bad for you?" },
    });
    expect(started.statusCode).toBe(201);
    const convo = started.json().conversation;
    expect(convo.model).toBe(loadConfig().assistantStandardModel);
    expect(convo.guest).toMatchObject({ granted_owls: 5 });
    await settleAssistantTurns();

    const input = agent.inputs.at(-1)!;
    expect(input.sections?.join("\n")).toMatch(/Your user is a guest/);
    const tools = input.account.definitions.map((d) => d.name);
    expect(tools).toContain("propose_claim");
    expect(tools).toContain("get_claim");
    expect(tools).not.toContain("fund_grant");
    expect(tools).not.toContain("save_page");
  });

  it("goes with the person when they sign in", async () => {
    const guest = (await makeGuest("203.0.113.30")).json().guest as { id: string; external_id: string };
    const started = await asGuest(guest.external_id, {
      method: "POST",
      url: "/assistant/conversations",
      payload: { message: "What is known about sleep and memory?" },
    });
    expect(started.statusCode).toBe(201);
    await settleAssistantTurns();

    const signedIn = await app.inject({
      method: "POST",
      url: "/users/provision",
      headers: { "x-api-key": SERVICE_KEY },
      payload: { external_id: "github:guest-carried", display_name: "Carried", guest_external_id: guest.external_id },
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().carried_conversations).toBe(1);
    const person = signedIn.json().user as { id: string };
    const [row] = await rawQuery<{ user_id: string }>(`SELECT user_id FROM assistant_conversations WHERE id = $1`, [
      started.json().conversation.id,
    ]);
    expect(row!.user_id).toBe(person.id);

    // Once: a second sign-in naming the same guest moves nothing.
    const again = await app.inject({
      method: "POST",
      url: "/users/provision",
      headers: { "x-api-key": SERVICE_KEY },
      payload: { external_id: "github:guest-carried", display_name: "Carried", guest_external_id: guest.external_id },
    });
    expect(again.json().carried_conversations).toBeUndefined();
  });
});
