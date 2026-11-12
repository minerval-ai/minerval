/**
 * A person's request works at a label (src/server/request-labels.ts), on a
 * members-only deployment with more than one, against the real app and the
 * real policies.
 *
 * The deployment here has `rl-a` and `rl-b`, which read `public` and not
 * each other, and `rl-top`, which reads `rl-a`. One person is cleared for
 * both `rl-a` and `rl-b`: the hard case, since no one label covers what
 * they read. The tests try each way a request gets a label (from the row it
 * is about, from the person, from the key it came with) and each way it
 * could land in the wrong place.
 *
 * The agents are scripts: no model is called. Each script records the label
 * its run was opened at, read from the same context the database client
 * reads.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "request-labels-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-request-labels-administrator";

vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "request-labels-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-request-labels-administrator";
  process.env.LOG_LEVEL = "fatal";
  // The last test reads a run's log, which is recorded only when tracing is on.
  process.env.TRACE_LEVEL = "full";
});

type AssistantInput = {
  account: { call: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> };
  hold: (tool: string, kind: string, input: Record<string, unknown>) => Promise<unknown>;
};

const agents = vi.hoisted(() => ({
  /** Every run a script opened: which agent, at which label, reading which labels. */
  runs: [] as Array<{ agent: string; label: string | undefined; reads: string[] | null }>,
  assistant: null as null | ((input: never) => Promise<void>),
  /** What the Grantmaker's next turn returns besides its reply. */
  mandate: null as null | Record<string, unknown>,
}));

vi.mock("../../src/llm/agents/assistant.js", async () => {
  const { withAgent, getUsageContext } = await import("../../src/llm/usage-context.js");
  const { currentReadClearance } = await import("../../src/db/client.js");
  return {
    runAssistantTurn: (input: never) =>
      withAgent("assistant", async () => {
        agents.runs.push({ agent: "assistant", label: getUsageContext().label, reads: await currentReadClearance() });
        if (agents.assistant) await agents.assistant(input);
        return { reply: "A reply.", stopped: null, toolUses: [], runId: null };
      }),
  };
});

vi.mock("../../src/llm/agents/grantmaker.js", async () => {
  const { withAgent, getUsageContext } = await import("../../src/llm/usage-context.js");
  const { currentReadClearance } = await import("../../src/db/client.js");
  return {
    runGrantmakerTurn: () =>
      withAgent("grantmaker", async () => {
        agents.runs.push({ agent: "grantmaker", label: getUsageContext().label, reads: await currentReadClearance() });
        return { reply: "Here is a draft.", ...(agents.mandate ? { mandate: agents.mandate } : {}) };
      }),
  };
});

// The small model that names an Assistant conversation.
vi.mock("../../src/llm/client.js", async (original) => ({
  ...(await original<typeof import("../../src/llm/client.js")>()),
  complete: vi.fn(async () => ({ content: "A name", model: "test", usage: {}, stopReason: "end_turn" })),
}));

import { rawQuery } from "../../src/db/client.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { REQUEST_LABELS } from "../../src/server/request-labels.js";
import { LABEL_MESSAGES } from "../../src/server/plugins/request-label.js";
import { KEY_LABEL_NOTE } from "../../src/routes/api-keys.js";
import { settleAssistantTurns } from "../../src/services/assistant-service.js";
import {
  resetGrantConversationRateLimiter,
  settleGrantConversationTurns,
} from "../../src/services/grant-conversation-service.js";
import { resetContributionRateLimiter } from "../../src/services/reputation-service.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient,
} from "../../src/services/oauth-service.js";
import { connectionLabelNote } from "../../src/mcp/server.js";
import { withheldRunSourceText, withheldSourceText } from "../../src/raw-sources.js";
import { getUsageContext, runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { recordAgentStep } from "../../src/services/trace-service.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import crypto from "node:crypto";
import { creditOwls, OWL } from "./helpers.js";

const A = "rl-a";
const B = "rl-b";
const TOP = "rl-top";
const MINE = [A, B, TOP];

let app: FastifyInstance;
let baseUrl: string;

interface Person {
  id: string;
  externalId: string;
}

async function signIn(name: string, externalId = `oidc:${name}-${randomUUID()}`): Promise<Person> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id, externalId };
}

type Call = { method?: string; url: string; payload?: unknown };

/** The web tier acting for a signed-in person: a session. */
function as(person: Person, request: Call) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": person.externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

/** A request made with an API key. */
function withKey(key: string, request: Call) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": key },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

async function grant(body: Record<string, unknown>): Promise<string> {
  const res = await as(admin, { method: "POST", url: "/permissions/grants", payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().grant.id as string;
}

/** A member who reads at `labels`, may direct and fund, and has owls to spend. */
async function member(name: string, labels: string[]): Promise<Person> {
  const person = await signIn(name);
  for (const label of labels) await grant({ permission: "read", account_id: person.id, label });
  await grant({ permission: "direct", account_id: person.id });
  await grant({ permission: "fund", account_id: person.id });
  await creditOwls(person.id, 500 * OWL);
  return person;
}

async function mintKey(person: Person, label?: string): Promise<{ key: string; id: string }> {
  const res = await as(person, {
    method: "POST",
    url: "/api-keys",
    payload: { name: `key ${label ?? ""}`, ...(label ? { label } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { key: res.json().key, id: res.json().id };
}

async function seedClaimAt(label: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claims (text, steward_state, tagged_at, sensitivity_label)
     VALUES ($1, 'done', now(), $2) RETURNING id`,
    [`A request-labels claim at ${label} ${randomUUID()}`, label]
  );
  return row!.id;
}

const labelOf = async (table: string, id: string): Promise<string | undefined> =>
  (await rawQuery<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM ${table} WHERE id = $1`, [id]))[0]
    ?.sensitivity_label;

let admin: Person;
/** Reads `rl-a` and `rl-b`, which do not read each other. */
let both: Person;
/** Reads `rl-a` only. */
let onlyA: Person;
/** Reads `rl-top`, and so `rl-a`. */
let top: Person;
const claimAt: Record<string, string> = {};

beforeAll(async () => {
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(
    `INSERT INTO labels (name, description)
     VALUES ($1, 'One partner''s material.'), ($2, 'Another partner''s material.'), ($3, 'Reads the first partner''s.')
     ON CONFLICT (name) DO NOTHING`,
    MINE
  );
  await rawQuery(
    `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public'), ($3, $1), ($3, 'public')
     ON CONFLICT DO NOTHING`,
    MINE
  );
  await ensureEnforcement();

  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  admin = await signIn("request-labels-admin", FIRST_ADMINISTRATOR);
  both = await member("both", [A, B]);
  onlyA = await member("only-a", [A]);
  top = await member("top", [TOP]);
  for (const label of ["public", ...MINE]) claimAt[label] = await seedClaimAt(label);
});

afterAll(async () => {
  await settleAssistantTurns();
  await settleGrantConversationTurns();
  await app?.close();
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [MINE]);
});

beforeEach(() => {
  agents.runs = [];
  agents.assistant = null;
  agents.mandate = null;
  resetGrantConversationRateLimiter();
  resetContributionRateLimiter();
});

/** An MCP client over HTTP, as an outside agent connects. */
async function connect(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "request-labels-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function toolJson(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

// ---------------------------------------------------------------------------

describe("starting something new, from a signed-in session", () => {
  it("is refused until a label is named, and says which may be named", async () => {
    const res = await as(both, { method: "POST", url: "/grant-conversations", payload: { message: "Look into this." } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: "LABEL_REQUIRED",
      error: LABEL_MESSAGES.required(["public", A, B]),
      labels: ["public", A, B],
    });
    // Nothing was started.
    expect(agents.runs).toEqual([]);
    expect((await as(both, { url: "/grant-conversations" })).json().conversations).toEqual([]);
  });

  it("is refused at a label the person may not read, in words that do not say whether it exists", async () => {
    const unreadable = await as(onlyA, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Look into this.", label: B },
    });
    const undefinedLabel = await as(onlyA, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Look into this.", label: "no-such-label" },
    });
    expect(unreadable.statusCode).toBe(403);
    expect(unreadable.json().code).toBe("LABEL_NOT_READABLE");
    expect(unreadable.json().error).toBe(LABEL_MESSAGES.notReadable(B, ["public", A]));
    expect(undefinedLabel.statusCode).toBe(403);
    expect(undefinedLabel.json().error).toBe(LABEL_MESSAGES.notReadable("no-such-label", ["public", A]));
  });

  it("opens a granting conversation at the label named, and its Grantmaker runs there and reads no further", async () => {
    const res = await as(both, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Look into the second partner's figures.", label: B },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().conversation.id as string;
    await settleGrantConversationTurns();
    expect(await labelOf("grant_conversations", id)).toBe(B);
    // The person reads rl-a as well. The run does not: it reads what its label reads.
    expect(agents.runs).toEqual([{ agent: "grantmaker", label: B, reads: [B, "public"].sort() }]);
  });

  it("files a submitted source, and the proposal that carries it, at the label named", async () => {
    const url = `https://example.org/request-labels/${randomUUID()}`;
    const res = await as(both, {
      method: "POST",
      url: "/sources",
      payload: { url, title: "A partner's memo", content: "The memo's text.", label: A },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await labelOf("sources", res.json().source_id)).toBe(A);
    expect(await labelOf("contributions", res.json().contribution_id)).toBe(A);
    // And nobody who reads rl-b alone can see it was filed.
    const b = await member("only-b", [B]);
    expect((await as(b, { url: `/sources/${res.json().source_id}` })).statusCode).toBe(404);
  });

  it("files a proposed node at the label named", async () => {
    const res = await as(both, {
      method: "POST",
      url: "/claims/propose",
      payload: { claim: `The second partner shipped on time ${randomUUID()}`, label: B },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await labelOf("contributions", res.json().contribution.id)).toBe(B);
  });
});

describe("a request about something that is already there", () => {
  it("carries that row's label, whichever of the person's labels it is", async () => {
    for (const label of [A, B, "public"]) {
      const res = await as(both, {
        method: "POST",
        url: "/contributions",
        payload: { claim_id: claimAt[label], contribution_type: "challenge", content: `A challenge at ${label}.` },
      });
      expect(res.statusCode, `${label}: ${res.body}`).toBe(201);
      expect(await labelOf("contributions", res.json().contribution.id), label).toBe(label);
    }
  });

  it("is told the row does not exist when the person may not read it", async () => {
    const res = await as(onlyA, {
      method: "POST",
      url: "/contributions",
      payload: { claim_id: claimAt[B], contribution_type: "challenge", content: "A challenge." },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "NOT_FOUND", error: "Node not found" });
    // The same answer as for an id that names nothing.
    const none = await as(onlyA, {
      method: "POST",
      url: "/contributions",
      payload: { claim_id: randomUUID(), contribution_type: "challenge", content: "A challenge." },
    });
    expect(none.json()).toEqual(res.json());
  });

  it("refuses a label named beside the row that disagrees with it", async () => {
    const res = await as(both, {
      method: "POST",
      url: "/contributions",
      payload: { claim_id: claimAt[A], contribution_type: "challenge", content: "A challenge.", label: B },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("LABEL_FOLLOWS_ROW");
  });

  it("asks for a label when a contribution names no node, because then it is new", async () => {
    const payload = { contribution_type: "propose_request", content: "Someone should measure this." };
    const unnamed = await as(both, { method: "POST", url: "/contributions", payload });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().code).toBe("LABEL_REQUIRED");
    const named = await as(both, { method: "POST", url: "/contributions", payload: { ...payload, label: A } });
    expect(named.statusCode, named.body).toBe(201);
    expect(await labelOf("contributions", named.json().contribution.id)).toBe(A);
  });

  it("orders an assessment at the node's label", async () => {
    const res = await as(both, { method: "POST", url: `/claims/${claimAt[B]}/order` });
    expect(res.statusCode, res.body).toBe(201);
    expect(await labelOf("assessment_orders", res.json().order.id)).toBe(B);
  });
});

describe("a granting conversation and its mandate", () => {
  it("answers each later message at the conversation's label, and funds the mandate there", async () => {
    const started = await as(both, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Draft a mandate.", label: A },
    });
    const id = started.json().conversation.id as string;
    await settleGrantConversationTurns();

    agents.mandate = {
      title: "The first partner's delivery record",
      objective: "Assess what the first partner delivered.",
      expected_cost_owls: 5,
      plan: { items: [] },
    };
    const sent = await as(both, {
      method: "POST",
      url: `/grant-conversations/${id}/messages`,
      payload: { message: "Go ahead and draft it." },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await settleGrantConversationTurns();
    expect(agents.runs.map((r) => r.label)).toEqual([A, A]);

    const funded = await as(both, { method: "POST", url: `/grant-conversations/${id}/fund`, payload: { budget_owls: 5 } });
    expect(funded.statusCode, funded.body).toBe(200);
    expect(await labelOf("grants", funded.json().grant_id)).toBe(A);
    const [job] = await rawQuery<{ sensitivity_label: string }>(
      `SELECT j.sensitivity_label FROM budget_jobs j JOIN grants g ON g.budget_job_id = j.id WHERE g.id = $1`,
      [funded.json().grant_id]
    );
    expect(job!.sensitivity_label).toBe(A);
  });

  it("is not there for a person who may not read its label", async () => {
    const started = await as(both, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Draft a mandate.", label: B },
    });
    const id = started.json().conversation.id as string;
    await settleGrantConversationTurns();
    agents.runs = [];
    const res = await as(onlyA, {
      method: "POST",
      url: `/grant-conversations/${id}/messages`,
      payload: { message: "Let me in." },
    });
    expect(res.statusCode).toBe(404);
    expect(agents.runs).toEqual([]);
  });
});

describe("an API key", () => {
  it("is minted at a label the person names, and not without one", async () => {
    const unnamed = await as(both, { method: "POST", url: "/api-keys", payload: { name: "no label" } });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().code).toBe("LABEL_REQUIRED");
    const unreadable = await as(onlyA, { method: "POST", url: "/api-keys", payload: { name: "b", label: B } });
    expect(unreadable.statusCode).toBe(403);

    const minted = await as(both, { method: "POST", url: "/api-keys", payload: { name: "for a", label: A } });
    expect(minted.statusCode, minted.body).toBe(201);
    expect(minted.json()).toMatchObject({ label: A, note: KEY_LABEL_NOTE });
    const listed = (await as(both, { url: "/api-keys" })).json();
    expect(listed.note).toBe(KEY_LABEL_NOTE);
    expect(listed.keys.find((k: { id: string }) => k.id === minted.json().id).label).toBe(A);
  });

  it("reads what its label reads and nothing else its holder may read", async () => {
    const { key } = await mintKey(both, A);
    expect((await withKey(key, { url: `/claims/${claimAt[A]}` })).statusCode).toBe(200);
    expect((await withKey(key, { url: `/claims/${claimAt.public}` })).statusCode).toBe(200);
    // The person reads rl-b. The key does not.
    expect((await as(both, { url: `/claims/${claimAt[B]}` })).statusCode).toBe(200);
    expect((await withKey(key, { url: `/claims/${claimAt[B]}` })).statusCode).toBe(404);
  });

  it("starts new things at its own label, with no parameter, and refuses a request that names another", async () => {
    const { key } = await mintKey(both, A);
    const started = await withKey(key, { method: "POST", url: "/grant-conversations", payload: { message: "Draft." } });
    expect(started.statusCode, started.body).toBe(201);
    await settleGrantConversationTurns();
    expect(await labelOf("grant_conversations", started.json().conversation.id)).toBe(A);
    expect(agents.runs).toEqual([{ agent: "grantmaker", label: A, reads: [A, "public"].sort() }]);

    const other = await withKey(key, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Draft.", label: B },
    });
    expect(other.statusCode).toBe(400);
    expect(other.json()).toMatchObject({ code: "LABEL_FIXED", label: A });
    expect(other.json().error).toBe(LABEL_MESSAGES.fixed({ label: A, of: "API key" }, B));
  });

  it("acts only on what carries its own label: a row it reads at another label is refused, with the reason", async () => {
    const { key } = await mintKey(top, TOP);
    // rl-top reads rl-a, so the key can read the node. It may not write beside it.
    expect((await withKey(key, { url: `/claims/${claimAt[A]}` })).statusCode).toBe(200);
    const res = await withKey(key, {
      method: "POST",
      url: "/contributions",
      payload: { claim_id: claimAt[A], contribution_type: "challenge", content: "Text read at rl-top." },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LABEL_MISMATCH", label: TOP });
    expect(res.json().error).toBe(LABEL_MESSAGES.mismatch({ label: TOP, of: "API key" }, "node", A));
    // On a node at its own label it goes through, at that label.
    const own = await withKey(key, {
      method: "POST",
      url: "/contributions",
      payload: { claim_id: claimAt[TOP], contribution_type: "challenge", content: "A challenge." },
    });
    expect(own.statusCode, own.body).toBe(201);
    expect(await labelOf("contributions", own.json().contribution.id)).toBe(TOP);
  });

  it("minted before the deployment had a second label works at public", async () => {
    // The column's default is what such a key carries.
    const { createApiKey } = await import("../../src/services/api-key-service.js");
    const old = await createApiKey({ userId: both.id, name: "from before" });
    expect(old.key.workLabel).toBe("public");
    expect((await withKey(old.plaintext, { url: `/claims/${claimAt.public}` })).statusCode).toBe(200);
    expect((await withKey(old.plaintext, { url: `/claims/${claimAt[A]}` })).statusCode).toBe(404);
    const started = await withKey(old.plaintext, {
      method: "POST",
      url: "/grant-conversations",
      payload: { message: "Draft." },
    });
    expect(started.statusCode, started.body).toBe(201);
    expect(await labelOf("grant_conversations", started.json().conversation.id)).toBe("public");
  });

  it("is refused once its holder may no longer read its label", async () => {
    const person = await signIn("loses-a");
    const grantId = await grant({ permission: "read", account_id: person.id, label: A });
    await grant({ permission: "read", account_id: person.id, label: B });
    const { key } = await mintKey(person, A);
    expect((await withKey(key, { url: `/claims/${claimAt[A]}` })).statusCode).toBe(200);
    const removed = await as(admin, { method: "DELETE", url: `/permissions/grants/${grantId}` });
    expect(removed.statusCode, removed.body).toBe(200);
    const res = await withKey(key, { url: `/claims/${claimAt.public}` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "CREDENTIAL_LABEL_NOT_READABLE",
      error: LABEL_MESSAGES.credentialNotReadable({ label: A, of: "API key" }),
    });
  });
});

describe("an access token", () => {
  const REDIRECT = "https://client.example/callback";

  /** The authorize step an MCP client makes, up to the consent page. */
  async function pendingConsent() {
    const { client } = await registerClient({
      name: `request-labels ${randomUUID()}`,
      redirectUris: [REDIRECT],
      tokenEndpointAuthMethod: "none",
    });
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    const request = await createAuthorizationRequest({
      client,
      redirectUri: REDIRECT,
      scope: "mcp",
      state: null,
      codeChallenge: challenge,
      resource: null,
    });
    return { client, verifier, requestId: request.id };
  }

  it("works at the label the person named when they approved the client, through every refresh", async () => {
    const consent = await pendingConsent();
    const unnamed = await as(both, { method: "POST", url: `/oauth/requests/${consent.requestId}/approve`, payload: {} });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().code).toBe("LABEL_REQUIRED");
    const unreadable = await as(onlyA, {
      method: "POST",
      url: `/oauth/requests/${consent.requestId}/approve`,
      payload: { label: B },
    });
    expect(unreadable.statusCode).toBe(403);

    const approved = await as(both, {
      method: "POST",
      url: `/oauth/requests/${consent.requestId}/approve`,
      payload: { label: B },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const code = new URL(approved.json().redirect_to).searchParams.get("code")!;
    const first = await exchangeAuthorizationCode({
      code,
      client: consent.client,
      redirectUri: REDIRECT,
      codeVerifier: consent.verifier,
    });
    const second = await refreshAccessToken({ refreshToken: first.refreshToken, client: consent.client });
    const labels = await rawQuery<{ work_label: string }>(
      `SELECT work_label FROM oauth_tokens WHERE user_id = $1 AND client_id = $2`,
      [both.id, consent.client.id]
    );
    expect(labels.map((l) => l.work_label)).toEqual([B, B, B, B]);

    // The client is told its label up front, and its calls are held to it.
    const client = await connect({ Authorization: `Bearer ${second.accessToken}` });
    expect(client.getInstructions()).toContain(connectionLabelNote(B));
    const tools = (await client.listTools()).tools;
    // No tool that starts something new offers a label to choose.
    for (const name of ["start_grant_conversation", "propose_claim", "submit_source", "submit_contribution", "save_page"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(Object.keys((tool!.inputSchema as { properties?: object }).properties ?? {}), name).not.toContain("label");
    }
    const mine = toolJson(await client.callTool({ name: "get_my_labels", arguments: {} }));
    expect(mine).toMatchObject({ must_choose: false, works_at: B });
    expect((mine.labels as Array<{ name: string }>).map((l) => l.name)).toEqual(["public", B]);

    const started = toolJson(await client.callTool({ name: "start_grant_conversation", arguments: { message: "Draft." } }));
    await settleGrantConversationTurns();
    expect(await labelOf("grant_conversations", (started.conversation as { id: string }).id)).toBe(B);

    // The hand-written contribution tool follows the same rule as the route.
    const unreadableNode = await client.callTool({
      name: "submit_contribution",
      arguments: { claim_id: claimAt[A], contribution_type: "challenge", content: "A challenge." },
    });
    expect(unreadableNode.isError).toBe(true);
    expect(JSON.stringify(unreadableNode.content)).toContain("NOT_FOUND");
    const elsewhere = await client.callTool({
      name: "submit_contribution",
      arguments: { claim_id: claimAt.public, contribution_type: "challenge", content: "Text read at rl-b." },
    });
    expect(elsewhere.isError).toBe(true);
    expect(JSON.stringify(elsewhere.content)).toContain("LABEL_MISMATCH");
    const own = toolJson(
      await client.callTool({
        name: "submit_contribution",
        arguments: { claim_id: claimAt[B], contribution_type: "challenge", content: "A challenge." },
      })
    );
    expect(await labelOf("contributions", (own.contribution as { id: string }).id)).toBe(B);
    await client.close();
  });

  it("is not what a signed-in session uses: the MCP endpoint refuses a request with no label of its own", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "x-api-key": SERVICE_KEY,
        "x-acting-user": both.externalId,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", method: "ping", id: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: "CREDENTIAL_LABEL_REQUIRED", error: LABEL_MESSAGES.credentialRequired });
  });
});

describe("the Assistant", () => {
  const results: Array<{ tool: string; text: string; isError: boolean }> = [];
  const call = async (input: AssistantInput, tool: string, args: Record<string, unknown>) => {
    const result = await input.account.call(tool, args);
    results.push({ tool, ...result });
    return result;
  };

  it("works at the label its conversation was started at: its run, its tools and its cards", async () => {
    results.length = 0;
    agents.assistant = (async (input: AssistantInput) => {
      await call(input, "get_my_labels", {});
      await call(input, "start_grant_conversation", { message: "Draft a mandate for the first partner." });
      // A node at a label the conversation does not read is not there.
      await call(input, "get_claim", { claim_id: claimAt[B] });
      // One it reads at another label can be read and not written beside.
      await call(input, "submit_contribution", {
        claim_id: claimAt.public,
        contribution_type: "challenge",
        content: "Text read at rl-a.",
      });
      await input.hold("order_assessment", "assess", { claim_id: claimAt[A] });
    }) as never;

    const unnamed = await as(both, { method: "POST", url: "/assistant/conversations", payload: { message: "Hello." } });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().code).toBe("LABEL_REQUIRED");

    const started = await as(both, {
      method: "POST",
      url: "/assistant/conversations",
      payload: { message: "Where does the first partner stand?", label: A },
    });
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().conversation.id as string;
    await settleAssistantTurns();
    await settleGrantConversationTurns();

    expect(await labelOf("assistant_conversations", id)).toBe(A);
    // The person reads rl-b too. Neither the Assistant's run nor the
    // Grantmaker it started does.
    expect(agents.runs).toEqual([
      { agent: "assistant", label: A, reads: [A, "public"].sort() },
      { agent: "grantmaker", label: A, reads: [A, "public"].sort() },
    ]);

    const by = (tool: string) => results.find((r) => r.tool === tool)!;
    expect(JSON.parse(by("get_my_labels").text)).toMatchObject({ must_choose: false, works_at: A });
    const convo = JSON.parse(by("start_grant_conversation").text).conversation as { id: string };
    expect(await labelOf("grant_conversations", convo.id)).toBe(A);
    expect(by("get_claim").isError).toBe(true);
    expect(by("submit_contribution").isError).toBe(true);
    expect(JSON.parse(by("submit_contribution").text).error).toEqual({
      code: "LABEL_MISMATCH",
      message: LABEL_MESSAGES.mismatch({ label: A, of: "Assistant conversation" }, "node", "public"),
    });

    // The card says where it will write, and pressing it writes there.
    const read = (await as(both, { url: `/assistant/conversations/${id}` })).json().conversation;
    expect(read.label).toBe(A);
    expect(read.held_actions).toHaveLength(1);
    expect(read.held_actions[0]).toMatchObject({ tool: "order_assessment", status: "held", writes_at: A });
    const pressed = await as(both, {
      method: "POST",
      url: `/assistant/conversations/${id}/held/${read.held_actions[0].id}`,
      payload: { decision: "run" },
    });
    expect(pressed.statusCode, pressed.body).toBe(200);
    const done = pressed.json().conversation.held_actions[0];
    expect(done.status, JSON.stringify(done.result)).toBe("done");
    const [order] = await rawQuery<{ sensitivity_label: string }>(
      `SELECT sensitivity_label FROM assessment_orders WHERE user_id = $1 AND claim_id = $2`,
      [both.id, claimAt[A]]
    );
    expect(order!.sensitivity_label).toBe(A);

    // The next message is answered at the conversation's label, not asked for one.
    agents.runs = [];
    agents.assistant = null;
    const next = await as(both, {
      method: "POST",
      url: `/assistant/conversations/${id}/messages`,
      payload: { message: "And now?" },
    });
    expect(next.statusCode, next.body).toBe(202);
    await settleAssistantTurns();
    expect(agents.runs).toEqual([{ agent: "assistant", label: A, reads: [A, "public"].sort() }]);
  });

  it("is refused a conversation whose label its person may no longer read", async () => {
    const person = await signIn("loses-b");
    await creditOwls(person.id, 50 * OWL);
    await grant({ permission: "read", account_id: person.id, label: A });
    const readB = await grant({ permission: "read", account_id: person.id, label: B });
    const started = await as(person, {
      method: "POST",
      url: "/assistant/conversations",
      payload: { message: "About the second partner.", label: B },
    });
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().conversation.id as string;
    await settleAssistantTurns();

    expect((await as(admin, { method: "DELETE", url: `/permissions/grants/${readB}` })).statusCode).toBe(200);
    agents.runs = [];
    const res = await as(person, {
      method: "POST",
      url: `/assistant/conversations/${id}/messages`,
      payload: { message: "Carry on." },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "NOT_FOUND", error: "Conversation not found" });
    await settleAssistantTurns();
    // No run was opened for them at a label they cannot read.
    expect(agents.runs).toEqual([]);
    expect((await as(person, { url: `/assistant/conversations/${id}` })).statusCode).toBe(404);
  });
});

describe("the labels a person may choose", () => {
  it("are the ones they read, each with who reads it, and other labels are counted and not named", async () => {
    const mine = (await as(onlyA, { url: "/labels/mine" })).json();
    expect(mine.must_choose).toBe(true);
    expect(mine.works_at).toBeNull();
    expect(mine.labels.map((l: { name: string }) => l.name)).toEqual(["public", A]);
    const a = mine.labels[1];
    expect(a).toMatchObject({
      name: A,
      description: "One partner's material.",
      reads: ["public"],
      read_by_everyone: false,
      // rl-top reads rl-a, and this person does not read rl-top.
      also_read_from: [],
      also_read_from_others: 1,
    });
    expect(a.who_reads).toBe(
      `People granted the permission to read at "${A}" can read it, and so can people granted it at 1 label ` +
        `you are not cleared to read, which reads "${A}". A source filed here can be opened in full only by ` +
        `people who also hold the permission to open raw sources at "${A}". The others read what the agents ` +
        `wrote from it.`
    );
    expect(mine.labels[0]).toMatchObject({ name: "public", read_by_everyone: true, also_read_from: [], also_read_from_others: 0 });
    expect(JSON.stringify(mine)).not.toContain(TOP);
    expect(JSON.stringify(mine)).not.toContain(B);

    const upper = (await as(top, { url: "/labels/mine" })).json();
    expect(upper.labels.map((l: { name: string }) => l.name)).toEqual(["public", A, TOP]);
    expect(upper.labels[1]).toMatchObject({ name: A, also_read_from: [TOP], also_read_from_others: 0 });
  });
});

describe("opening raw sources", () => {
  let sourceId: string;
  let instanceId: string;
  /** Reads at rl-a, and holds no permission to open its sources. */
  let reader: Person;
  /** Reads at rl-a and may open its raw sources. */
  let opener: Person;
  /** Reads at rl-top (and so rl-a), and may open raw sources at rl-top alone. */
  let topOpener: Person;
  const TEXT = "Shipments rose in the first quarter.\n\nThe partner's own count was 4,112 units.";

  beforeAll(async () => {
    reader = await member("raw-reader", [A]);
    opener = await member("raw-opener", [A]);
    await grant({ permission: "read_sources", account_id: opener.id, label: A });
    topOpener = await member("raw-top-opener", [TOP]);
    await grant({ permission: "read_sources", account_id: topOpener.id, label: TOP });

    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, raw_content, sensitivity_label)
       VALUES ($1, 'A partner''s quarterly memo', $2, $3) RETURNING id`,
      [`https://example.org/request-labels/raw/${randomUUID()}`, TEXT, A]
    );
    sourceId = source!.id;
    const { segmentSource } = await import("../../src/services/source-segment-service.js");
    await runAtLabel(A, "a test", () => segmentSource(sourceId));
    const [instance] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, sensitivity_label)
       VALUES ($1, $2, 'The partner''s own count was 4,112 units.', 'affirms', $3) RETURNING id`,
      [claimAt[A], sourceId, A]
    );
    instanceId = instance!.id;
  });

  it("withholds the document's text from a reader without the permission, and says so", async () => {
    const res = await as(reader, { url: `/sources/${sourceId}/document` });
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json();
    expect(doc.text_withheld).toEqual(withheldSourceText(A));
    expect(doc.segments.length).toBeGreaterThan(0);
    for (const segment of doc.segments) {
      expect(segment.text).toBeNull();
      expect(segment.label).toBeNull();
    }
    // The document is not shown as empty, and what the agents quoted from it stays.
    expect(doc.total_chars).toBeGreaterThan(40);
    const quoted = [...doc.segments.flatMap((s: { instances: unknown[] }) => s.instances), ...doc.unanchored];
    expect(quoted).toEqual([expect.objectContaining({ instance_id: instanceId, verbatim_text: "The partner's own count was 4,112 units." })]);
    expect(res.body).not.toContain("Shipments rose");
  });

  it("opens it to a reader who holds the permission at the source's label", async () => {
    const doc = (await as(opener, { url: `/sources/${sourceId}/document` })).json();
    expect(doc.text_withheld).toBeUndefined();
    expect(doc.segments.map((s: { text: string | null }) => s.text).join(" ")).toContain("Shipments rose in the first quarter.");
  });

  it("does not follow what a label reads: the permission at rl-top does not open an rl-a source", async () => {
    const doc = (await as(topOpener, { url: `/sources/${sourceId}/document` })).json();
    expect(doc.text_withheld).toEqual(withheldSourceText(A));
  });

  it("holds an agent acting for the person to the same permission, over MCP", async () => {
    const { key } = await mintKey(reader, A);
    const client = await connect({ "x-api-key": key });
    const doc = toolJson(await client.callTool({ name: "get_source_document", arguments: { source_id: sourceId } }));
    expect(doc.text_withheld).toEqual(withheldSourceText(A));
    expect(JSON.stringify(doc)).not.toContain("Shipments rose");
    await client.close();
  });

  it("leaves a public source open to every member", async () => {
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, raw_content, sensitivity_label)
       VALUES ($1, 'A public page', 'Anyone may read this page.', 'public') RETURNING id`,
      [`https://example.org/request-labels/raw/${randomUUID()}`]
    );
    await runAtLabel("public", "a test", async () => {
      const { segmentSource } = await import("../../src/services/source-segment-service.js");
      await segmentSource(source!.id);
    });
    const doc = (await as(reader, { url: `/sources/${source!.id}/document` })).json();
    expect(doc.text_withheld).toBeUndefined();
    expect(JSON.stringify(doc)).toContain("Anyone may read this page.");
  });

  it("withholds the parts of a run's log that hold source text, and shows the rest", async () => {
    let runId = "";
    await runAtLabel(A, "a test", () =>
      withAgent("steward", async () => {
        const trace = getUsageContext().trace!;
        runId = trace.runId;
        recordAgentStep(trace, "assistant", { content: [{ type: "text", text: "I will open the memo." }], stopReason: "tool_use" });
        recordAgentStep(trace, "tool_results", [
          { name: "provenance_read_source", input: { source_id: sourceId }, output: JSON.stringify({ text: TEXT }) },
          { name: "get_claim", input: { claim_id: claimAt[A] }, output: JSON.stringify({ claim: "kept" }) },
        ]);
        await trace.tail;
      })
    );
    expect(runId).not.toBe("");
    const steps = await rawQuery<{ seq: number; kind: string }>(
      `SELECT seq, kind FROM agent_steps WHERE run_id = $1 ORDER BY seq`,
      [runId]
    );
    const toolStep = steps.find((s) => s.kind === "tool_results")!.seq;
    const sayStep = steps.find((s) => s.kind === "assistant")!.seq;

    const withheld = (await as(reader, { url: `/runs/${runId}/steps/${toolStep}` })).json();
    expect(withheld.content[0]).toEqual({
      name: "provenance_read_source",
      input: { source_id: sourceId },
      output: withheldRunSourceText(A, [A]),
    });
    expect(withheld.content[1].output).toBe(JSON.stringify({ claim: "kept" }));
    expect(withheld.hash).toBeTruthy();
    const said = (await as(reader, { url: `/runs/${runId}/steps/${sayStep}` })).json();
    expect(said.content.content[0].text).toBe("I will open the memo.");
    const listed = (await as(reader, { url: `/runs/${runId}/steps` })).json();
    expect(JSON.stringify(listed)).not.toContain("Shipments rose");
    expect(JSON.stringify(listed)).toContain("(withheld: text from a source)");

    const open = (await as(opener, { url: `/runs/${runId}/steps/${toolStep}` })).json();
    expect(open.content[0].output).toBe(JSON.stringify({ text: TEXT }));
  });
});

describe("the table", () => {
  it("names a carrier table that exists and carries a label, for every rule that reads one", async () => {
    const tables = new Set(
      (
        await rawQuery<{ table_name: string }>(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'sensitivity_label'`
        )
      ).map((r) => r.table_name)
    );
    const { CARRIERS } = await import("../../src/server/request-labels.js");
    for (const [name, carrier] of Object.entries(CARRIERS)) expect(tables.has(carrier.table), name).toBe(true);
    expect(Object.keys(REQUEST_LABELS).length).toBeGreaterThan(60);
  });
});
