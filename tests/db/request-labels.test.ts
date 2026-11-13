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
import { creditOwls, OWL, readViewsAs } from "./helpers.js";

/** The party this file adds as the organization itself, where the database has none, and removes at the end. */
const OWN_ORGANIZATION = "The organization (request-labels test)";
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
  // The organization's own party, made when this file's first administrator signed in.
  await rawQuery(`DELETE FROM parties WHERE name = $1 OR (is_own_organization AND created_by IS NULL)`, [OWN_ORGANIZATION]).catch(() => undefined);
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
      // Through the Assistant's own executor, as the model's calls go: a
      // held tool aimed at a node at another label is refused there and
      // then, and no card is made for it. One at its own label is held.
      const { createAssistantTools } = await import("../../src/llm/tools/assistant-tools.js");
      const tools = createAssistantTools(input.account as never, {
        hold: input.hold as never,
        note: () => undefined,
        used: () => undefined,
      });
      results.push({
        tool: "order_assessment elsewhere",
        text: await tools.execute("order_assessment", { claim_id: claimAt.public }),
        isError: true,
      });
      results.push({
        tool: "order_assessment",
        text: await tools.execute("order_assessment", { claim_id: claimAt[A] }),
        isError: false,
      });
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

    // Starting work on a node is not a change to the node: a conversation
    // at A may order an assessment at A of a public node, which A reads.
    // Like any order it is a card first, and it will write at A.
    expect(JSON.parse(by("order_assessment elsewhere").text)).toMatchObject({ held: true });
    expect(JSON.parse(by("order_assessment").text)).toMatchObject({ held: true });

    // One card, for the call that can run. It says where it will write, and pressing it writes there.
    const read = (await as(both, { url: `/assistant/conversations/${id}` })).json().conversation;
    expect(read.label).toBe(A);
    expect(read.held_actions).toHaveLength(2);
    for (const card of read.held_actions) expect(card).toMatchObject({ tool: "order_assessment", status: "held", writes_at: A });
    for (const card of read.held_actions as Array<{ id: string }>) {
      const pressed = await as(both, {
        method: "POST",
        url: `/assistant/conversations/${id}/held/${card.id}`,
        payload: { decision: "run" },
      });
      expect(pressed.statusCode, pressed.body).toBe(200);
      const done = (pressed.json().conversation.held_actions as Array<{ id: string; status: string; result: unknown }>).find(
        (h) => h.id === card.id
      )!;
      expect(done.status, JSON.stringify(done.result)).toBe("done");
    }
    // Both orders are at the conversation's label: the one on the node at A,
    // and the one on the public node, which is an assessment at A of a
    // public claim and leaves public work on it alone.
    for (const claim of [claimAt[A], claimAt.public]) {
      const orders = await rawQuery<{ sensitivity_label: string }>(
        `SELECT sensitivity_label FROM assessment_orders WHERE user_id = $1 AND claim_id = $2`,
        [both.id, claim]
      );
      expect(orders).toEqual([{ sensitivity_label: A }]);
    }

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

  it("withholds a finding's segment heading in the examinations read as the document read does (review 3, finding 7)", async () => {
    const HEADING = "SECRETHEAD Quarterly shipments";
    const [segment] = await rawQuery<{ id: string }>(
      `UPDATE source_segments SET label = $2
        WHERE id = (SELECT id FROM source_segments WHERE source_id = $1 ORDER BY ordinal LIMIT 1) RETURNING id`,
      [sourceId, HEADING]
    );
    const [exam] = await rawQuery<{ id: string }>(
      `INSERT INTO examinations (scope, trigger, source_id, brief, facets, requested_by, sensitivity_label)
       VALUES ('document', 'mechanical', $1, 'Check the count.', ARRAY['numbers'], 'curator', $2) RETURNING id`,
      [sourceId, A]
    );
    await rawQuery(
      `INSERT INTO examination_findings (examination_id, segment_id, facet, statement, evidence, sensitivity_label)
       VALUES ($1, $2, 'numbers', 'The count is the partner''s own.', 'Stated in the memo.', $3)`,
      [exam!.id, segment!.id, A]
    );
    const read = async (who: Person) => {
      const res = await as(who, { url: `/sources/${sourceId}/examinations` });
      expect(res.statusCode, res.body).toBe(200);
      return { body: res.body, exam: res.json().examinations[0] };
    };
    // Without the permission: the finding as the agent wrote it, no heading, and a notice that says why.
    for (const who of [reader, topOpener]) {
      const { body, exam: seen } = await read(who);
      expect(seen.findings).toEqual([expect.objectContaining({ statement: "The count is the partner's own.", segment_id: segment!.id, segment_label: null })]);
      expect(seen.headings_withheld).toEqual(withheldSourceText(A));
      expect(body).not.toContain("SECRETHEAD");
    }
    // With it: the heading.
    const open = await read(opener);
    expect(open.exam.findings[0].segment_label).toBe(HEADING);
    expect(open.exam.headings_withheld).toBeUndefined();
    // The same over MCP, for an agent acting for the person.
    const { key } = await mintKey(reader, A);
    const client = await connect({ "x-api-key": key });
    const overMcp = toolJson(await client.callTool({ name: "get_source_examinations", arguments: { source_id: sourceId } }));
    expect(JSON.stringify(overMcp)).not.toContain("SECRETHEAD");
    expect(overMcp.examinations[0].headings_withheld).toEqual(withheldSourceText(A));
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

// ---------------------------------------------------------------------------
// Nothing a request writes lands anywhere but at its label.
//
// A request reaches many rows through services several calls down from its
// route: a ledger row, an allocation, a message to a node's Steward, an
// event. Before a request had a label every one of them was stamped
// `public`, and a ledger row's display text is the first words of the node
// it is for, so funding a private node told the public ledger what the
// node says. So the check is on the database, not on the route: count the
// rows of every labelled table at every label, make the request, count
// again, and nothing may have changed at any label but the one the request
// was for.

let labelledTables: string[] | null = null;

/** Rows per table per label, as the owner sees them. */
async function census(): Promise<Map<string, number>> {
  labelledTables ??= (
    await rawQuery<{ t: string }>(
      `SELECT c.relname::text AS t
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'sensitivity_label' AND NOT a.attisdropped`
    )
  ).map((r) => r.t).sort();
  const rows = await rawQuery<{ t: string; l: string; n: number }>(
    labelledTables
      .map((t) => `SELECT '${t}' AS t, sensitivity_label AS l, count(*)::int AS n FROM "${t}" GROUP BY sensitivity_label`)
      .join(" UNION ALL ")
  );
  return new Map(rows.map((r) => [`${r.t} at ${r.l}`, r.n]));
}

/**
 * Make a request, and check that the only label any row count moved at is
 * `label`. Returns the response and the tables that changed there.
 */
async function writesOnlyAt<T>(label: string, what: string, act: () => Promise<T>): Promise<{ res: T; wrote: string[] }> {
  const before = await census();
  const res = await act();
  await settleAssistantTurns();
  await settleGrantConversationTurns();
  // What a request writes without waiting for it (an enqueue event) lands a moment later.
  await new Promise((r) => setTimeout(r, 80));
  const after = await census();
  const elsewhere: string[] = [];
  const wrote: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (delta === 0) continue;
    if (key.endsWith(` at ${label}`)) wrote.push(key.slice(0, -` at ${label}`.length));
    else elsewhere.push(`${key}: ${delta > 0 ? "+" : ""}${delta}`);
  }
  expect(elsewhere, `${what}: rows changed at a label other than ${label}`).toEqual([]);
  return { res, wrote: wrote.sort() };
}

/** A mandate at `label`, funded by `funder`, with its budget job and escrow. */
async function mandateAt(label: string, funder: Person): Promise<{ grantId: string; jobId: string }> {
  const [job] = await rawQuery<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status, sensitivity_label)
     VALUES ($1, 'grant', $2, 'running', $3) RETURNING id`,
    [funder.id, 20 * OWL, label]
  );
  await rawQuery(`INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id) VALUES ($1, $2, 'escrow_hold', $3)`, [
    funder.id,
    -20 * OWL,
    job!.id,
  ]);
  const [g] = await rawQuery<{ id: string }>(
    `INSERT INTO grants (funder_user_id, budget_job_id, name, policy, status, daily_budget_micro_usd, sensitivity_label)
     VALUES ($1, $2, $3, 'agent', 'active', 0, $4) RETURNING id`,
    [funder.id, job!.id, `A request-labels mandate ${randomUUID().slice(0, 8)}`, label]
  );
  return { grantId: g!.id, jobId: job!.id };
}

describe("the leak a request without a label made", () => {
  const visibleLedger = (labels: string[], claimId: string) =>
    readViewsAs(labels, `SELECT status, label FROM ledger WHERE target_node_id = $1`, [claimId]);

  it("is closed: funding a private node writes its ledger row, allocation, message and event at the node's label", async () => {
    const secret = `A-ONLY ${randomUUID()}: the first partner will miss its covenant`;
    const [claim] = await rawQuery<{ id: string }>(
      `INSERT INTO claims (text, steward_state, tagged_at, sensitivity_label) VALUES ($1, 'done', now(), $2) RETURNING id`,
      [secret, A]
    );
    const publicOnly = await member("reads-public", []);
    expect((await as(publicOnly, { url: `/claims/${claim!.id}` })).statusCode).toBe(404);

    const { res, wrote } = await writesOnlyAt(A, "funding a node at rl-a", () =>
      as(onlyA, { method: "POST", url: `/claims/${claim!.id}/contribute`, payload: { owls: 3 } })
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(wrote).toEqual(expect.arrayContaining(["action_allocations", "actions"]));

    for (const [table, column] of [
      ["actions", "claim_id"],
      ["action_allocations", "claim_id"],
      ["node_messages", "node_id"],
      ["enqueue_events", "claim_id"],
    ] as const) {
      const labels = await rawQuery<{ sensitivity_label: string }>(
        `SELECT DISTINCT sensitivity_label FROM ${table} WHERE ${column} = $1`,
        [claim!.id]
      );
      expect(labels.map((l) => l.sensitivity_label), table).toEqual(labels.length > 0 ? [A] : []);
    }
    // The ledger row's display text is the node's own words. A reader of
    // public alone is shown no such row; a reader of rl-a is.
    expect(await visibleLedger(["public"], claim!.id)).toEqual([]);
    expect(JSON.stringify(await readViewsAs(["public"], `SELECT label FROM ledger`))).not.toContain("A-ONLY");
    expect((await visibleLedger([A, "public"], claim!.id)).map((r) => r.label)).toEqual([secret.slice(0, 300)]);
  });

  it("leaves a finished ledger row for the node at the node's label when it is opened again", async () => {
    const claimId = await seedClaimAt(A);
    const [action] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd, status, sensitivity_label)
       VALUES ('assess', $1, 'standard', $2, 'A finished pass', 1000000, 'done', $3) RETURNING id`,
      [`assess:${claimId}`, claimId, A]
    );
    const { res } = await writesOnlyAt(A, "funding a node whose last pass is finished", () =>
      as(onlyA, { method: "POST", url: `/claims/${claimId}/contribute`, payload: { owls: 3 } })
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await labelOf("actions", action!.id)).toBe(A);
    expect(await visibleLedger(["public"], claimId)).toEqual([]);
  });

  it("stays closed whichever of two unrelated labels the person funds at", async () => {
    for (const label of [A, B]) {
      const claimId = await seedClaimAt(label);
      const { res } = await writesOnlyAt(label, `funding a node at ${label}`, () =>
        as(both, { method: "POST", url: `/claims/${claimId}/contribute`, payload: { owls: 2 } })
      );
      expect(res.statusCode, res.body).toBe(200);
    }
  });
});

describe("every route that writes, driven against a private target", () => {
  type Drive = () => Promise<{ statusCode: number; body: string; json: () => any }>;

  /** A rejected contribution at rl-a by `both`, with its review, to appeal. */
  async function rejectedContribution(): Promise<string> {
    const [c] = await rawQuery<{ id: string }>(
      `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content, review_status, sensitivity_label)
       VALUES ($1, $2, 'challenge', 'A challenge that was rejected.', 'rejected', $3) RETURNING id`,
      [claimAt[A], both.id, A]
    );
    await rawQuery(
      `INSERT INTO contribution_reviews (contribution_id, decision, reasoning, confidence, sensitivity_label)
       VALUES ($1, 'reject', 'Not sound.', 0.9, $2)`,
      [c!.id, A]
    );
    return c!.id;
  }

  async function grantConversationAt(label: string, drafted: boolean): Promise<string> {
    agents.mandate = drafted
      ? { title: "A drafted mandate", objective: "Assess it.", expected_cost_owls: 5, plan: { items: [] } }
      : null;
    const res = await as(both, { method: "POST", url: "/grant-conversations", payload: { message: "Draft.", label } });
    expect(res.statusCode, res.body).toBe(201);
    await settleGrantConversationTurns();
    agents.mandate = null;
    return res.json().conversation.id;
  }

  async function assistantConversationAt(label: string, script?: (input: AssistantInput) => Promise<void>): Promise<string> {
    agents.assistant = (script ?? null) as never;
    const res = await as(both, { method: "POST", url: "/assistant/conversations", payload: { message: "Hello.", label } });
    expect(res.statusCode, res.body).toBe(201);
    await settleAssistantTurns();
    agents.assistant = null;
    return res.json().conversation.id;
  }

  async function pageAt(label: string): Promise<string> {
    const res = await as(both, { method: "POST", url: "/pages", payload: { title: "A page", body: "Some text.", label } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().page.id;
  }

  /** A claim at rl-a with a published formal statement, an open bounty, and a prize claim by `both`. */
  async function prizeClaimAtA(): Promise<{ claimId: string; prizeClaimId: string; attemptId: string }> {
    const claimId = await seedClaimAt(A);
    const [f] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_formalizations
         (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest, namespace, statement_source,
          source_hash, expr_hash, pp_type, constants, definitions_axioms, witness_present, status, authored_by, sensitivity_label)
       VALUES ($1, 1, 'mathlib-v4.33.1', 'leanprover/lean4:v4.33.1', $2, 'sha256:img', $3, 'def Statement : Prop := True',
               $4, $5, 'True', '[]', '[]', false, 'published', 'claim_steward', $6) RETURNING id`,
      [claimId, randomUUID().replace(/-/g, ""), `Minerval.S${randomUUID().slice(0, 8)}_v1`, `src-${randomUUID()}`, `expr-${randomUUID()}`, A]
    );
    const mandate = await mandateAt(A, both);
    const [bounty] = await rawQuery<{ id: string }>(
      `INSERT INTO bounties (claim_id, formalization_id, posted_by_grant_id, amount_micro_usd, status, rules_version, rationale, sensitivity_label)
       VALUES ($1, $2, $3, 250000000, 'open', 'rules-v1', 'A test bounty', $4) RETURNING id`,
      [claimId, f!.id, mandate.grantId, A]
    );
    const [contribution] = await rawQuery<{ id: string }>(
      `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content, review_status, sensitivity_label)
       VALUES ($1, $2, 'claim_prize', 'A prize claim.', 'checking', $3) RETURNING id`,
      [claimId, both.id, A]
    );
    const [prizeClaim] = await rawQuery<{ id: string }>(
      `INSERT INTO prize_claims
         (contribution_id, bounty_id, claim_id, formalization_id, claimant_id, direction, status, rules_version, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, 'proof', 'accepted', 'rules-v1', $6) RETURNING id`,
      [contribution!.id, bounty!.id, claimId, f!.id, both.id, A]
    );
    const [attempt] = await rawQuery<{ id: string }>(
      `INSERT INTO proof_attempts (claim_id, formalization_id, model, variant, effort, status, ceiling_micro_usd, spent_micro_usd, sensitivity_label)
       VALUES ($1, $2, 'solver', 'max', 'max', 'running', 100000000, 0, $3) RETURNING id`,
      [claimId, f!.id, A]
    );
    return { claimId, prizeClaimId: prizeClaim!.id, attemptId: attempt!.id };
  }

  const post = (person: Person, url: string, payload?: unknown) => as(person, { method: "POST", url, payload: payload ?? {} });

  /**
   * One request for each route whose label comes from a row, against a row
   * at rl-a, made by the person who also reads rl-b. Each entry builds what
   * the route needs first (not counted) and returns the request to count.
   */
  const FROM_A_ROW: Record<string, () => Promise<Drive>> = {
    "POST /claims/:claim_id/order": async () => {
      const id = await seedClaimAt(A);
      return () => post(both, `/claims/${id}/order`);
    },
    "POST /claims/:claim_id/contribute": async () => {
      const id = await seedClaimAt(A);
      return () => post(both, `/claims/${id}/contribute`, { owls: 2 });
    },
    "POST /claims/:claim_id/decompose": async () => {
      const id = await seedClaimAt(A);
      return () => post(both, `/claims/${id}/decompose`, { budget_owls: 6 });
    },
    "PATCH /claims/:claim_id": async () => {
      // Open to a direct service caller alone: a service key of the person's, minted for rl-a.
      const { createApiKey } = await import("../../src/services/api-key-service.js");
      const key = await createApiKey({ userId: both.id, name: "seeding at a", scope: "service", workLabel: A });
      const id = await seedClaimAt(A);
      return () =>
        withKey(key.plaintext, {
          method: "PATCH",
          url: `/claims/${id}`,
          payload: { argument: { stance: "for", content: "An argument written straight onto the node." } },
        });
    },
    "POST /claims/:claim_id/prize-claims": async () => {
      const { claimId } = await prizeClaimAtA();
      return () => post(both, `/claims/${claimId}/prize-claims`, {});
    },
    "POST /contributions": async () => {
      const id = await seedClaimAt(A);
      return () => post(both, "/contributions", { claim_id: id, contribution_type: "challenge", content: "A challenge." });
    },
    "POST /appeals": async () => {
      const id = await rejectedContribution();
      return () => post(both, "/appeals", { contribution_id: id, appeal_reasoning: "The review missed the second table." });
    },
    "DELETE /orders/:id": async () => {
      const made = await post(both, `/claims/${await seedClaimAt(A)}/order`);
      expect(made.statusCode, made.body).toBe(201);
      return () => as(both, { method: "DELETE", url: `/orders/${made.json().order.id}` });
    },
    "POST /budget-jobs/:id/topup": async () => {
      const { jobId } = await mandateAt(A, both);
      return () => post(both, `/budget-jobs/${jobId}/topup`, { owls: 2 });
    },
    "POST /budget-jobs/:id/cancel": async () => {
      const { jobId } = await mandateAt(A, both);
      return () => post(both, `/budget-jobs/${jobId}/cancel`);
    },
    "POST /requests/:request_id/contribute": async () => {
      const { fileRequest } = await import("../../src/services/request-service.js");
      const request = await runAtLabel(A, "a test", () =>
        fileRequest({
          ask: `Find the first partner's own count (${randomUUID()}).`,
          why: "The node turns on it.",
          satisfiedBy: "The count, with its date.",
          claimIds: [claimAt[A]!],
          filer: { kind: "admin", agent: "claim_steward" },
        })
      );
      return () => post(both, `/requests/${request.id}/contribute`, { owls: 2 });
    },
    "POST /showings/:showing_id/pages/:page_id/commission": async () => {
      // A page at rl-a, asked to be shown at rl-b: its redaction waits on the ledger at rl-a.
      const id = await seedClaimAt(A);
      await rawQuery(
        `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'supported', 0.7, 'A summary at a.', 'The reasoning at a.', true, $2)`,
        [id, A]
      );
      await rawQuery(
        `INSERT INTO parties (name, is_own_organization) SELECT $1, true WHERE NOT EXISTS (SELECT 1 FROM parties WHERE is_own_organization)`,
        [OWN_ORGANIZATION]
      );
      const { askShowing } = await import("../../src/services/showing-service.js");
      const asked = await askShowing({ nodeId: id, pageLabel: A, toLabel: B, form: "once", scope: "node", actor: { id: both.id, holding: ["direct"] } });
      const [page] = await rawQuery<{ id: string }>(`SELECT id FROM showing_pages WHERE showing_id = $1`, [asked.showing_id]);
      return () => post(both, `/showings/${asked.showing_id}/pages/${page!.id}/commission`, { owls: 2 });
    },
    "POST /grants/:id/approve": async () => {
      const { grantId } = await mandateAt(A, both);
      return () => post(both, `/grants/${grantId}/approve`);
    },
    "POST /grants/:id/topup": async () => {
      const { grantId } = await mandateAt(A, both);
      return () => post(both, `/grants/${grantId}/topup`, { owls: 2 });
    },
    "POST /grants/:id/cancel": async () => {
      const { grantId } = await mandateAt(A, both);
      return () => post(both, `/grants/${grantId}/cancel`);
    },
    "POST /mandates/:id/contribute": async () => {
      const { grantId } = await mandateAt(A, onlyA);
      return () => post(both, `/mandates/${grantId}/contribute`, { owls: 2 });
    },
    "POST /mandates/:id/withdraw": async () => {
      const { grantId } = await mandateAt(A, onlyA);
      const backed = await post(both, `/mandates/${grantId}/contribute`, { owls: 2 });
      expect(backed.statusCode, backed.body).toBe(200);
      return () => post(both, `/mandates/${grantId}/withdraw`, {});
    },
    "POST /grant-conversations/:id/messages": async () => {
      const id = await grantConversationAt(A, false);
      return () => post(both, `/grant-conversations/${id}/messages`, { message: "One more thing." });
    },
    "POST /grant-conversations/:id/fund": async () => {
      const id = await grantConversationAt(A, true);
      return () => post(both, `/grant-conversations/${id}/fund`, { budget_owls: 5 });
    },
    "POST /correspondents/:id/poke": async () => {
      const { grantId } = await mandateAt(A, both);
      const [c] = await rawQuery<{ id: string }>(
        `INSERT INTO correspondents (grant_id, title, brief, audience, heartbeat_hours, created_by, sensitivity_label)
         VALUES ($1, 'The first partner, weekly', $2, 'The partner team', 168, 'grantmaker', $3) RETURNING id`,
        [grantId, "Report what changed on the first partner's nodes, plainly, for the people who manage the account.", A]
      );
      return () => post(both, `/correspondents/${c!.id}/poke`, { note: "An update now, please." });
    },
    "POST /assistant/conversations/:id/messages": async () => {
      const id = await assistantConversationAt(A);
      return () => post(both, `/assistant/conversations/${id}/messages`, { message: "And now?" });
    },
    "POST /assistant/conversations/:id/stop": async () => {
      const id = await assistantConversationAt(A);
      return () => post(both, `/assistant/conversations/${id}/stop`);
    },
    "PATCH /assistant/conversations/:id": async () => {
      const id = await assistantConversationAt(A);
      const models = (await as(both, { url: `/assistant/conversations/${id}` })).json().conversation.models as Array<{ id: string }>;
      return () => as(both, { method: "PATCH", url: `/assistant/conversations/${id}`, payload: { model: models[0]!.id } });
    },
    "DELETE /assistant/conversations/:id": async () => {
      const id = await assistantConversationAt(A);
      return () => as(both, { method: "DELETE", url: `/assistant/conversations/${id}` });
    },
    "POST /assistant/conversations/:id/held/:action_id": async () => {
      const claimId = await seedClaimAt(A);
      const id = await assistantConversationAt(A, async (input) => {
        await input.hold("fund_claim_assessment", "assess", { claim_id: claimId, owls: 2 });
      });
      const held = (await as(both, { url: `/assistant/conversations/${id}` })).json().conversation.held_actions as Array<{ id: string }>;
      return () => post(both, `/assistant/conversations/${id}/held/${held[0]!.id}`, { decision: "run" });
    },
    "POST /pages": async () => {
      const id = await pageAt(A);
      return () => post(both, "/pages", { id, title: "A page, revised", body: "Other text." });
    },
    "DELETE /pages/:id": async () => {
      const id = await pageAt(A);
      return () => as(both, { method: "DELETE", url: `/pages/${id}` });
    },
    "PATCH /reports/:id": async () => {
      const [r] = await rawQuery<{ id: string }>(
        `INSERT INTO agent_reports (dedupe_key, title, body, agent, severity, kind, sensitivity_label)
         VALUES ($1, 'A report at a', 'details', 'claim_steward', 'medium', 'tool_gap', $2) RETURNING id`,
        [`request-labels-${randomUUID()}`, A]
      );
      return () => as(both, { method: "PATCH", url: `/reports/${r!.id}`, payload: { status: "triaged" } });
    },
    "PATCH /findings/:id": async () => {
      const [f] = await rawQuery<{ id: string }>(
        `INSERT INTO agent_findings (headline, account, claim_id, importance, agent, sensitivity_label)
         VALUES ('A finding at a', 'What was found.', $1, 5, 'steward', $2) RETURNING id`,
        [claimAt[A], A]
      );
      return () => as(both, { method: "PATCH", url: `/findings/${f!.id}`, payload: { status: "withdrawn", note: "Superseded." } });
    },
    "POST /admin/attempts/:id/cancel": async () => {
      const { attemptId } = await prizeClaimAtA();
      return () => post(both, `/admin/attempts/${attemptId}/cancel`);
    },
    "POST /prize-claims/:id/attachments": async () => {
      const { prizeClaimId } = await prizeClaimAtA();
      return () => post(both, `/prize-claims/${prizeClaimId}/attachments`, {});
    },
    "POST /prize-claims/:id/code": async () => {
      const { prizeClaimId } = await prizeClaimAtA();
      return () => post(both, `/prize-claims/${prizeClaimId}/code`);
    },
    "POST /prize-claims/:id/withdraw": async () => {
      const { prizeClaimId } = await prizeClaimAtA();
      return () => post(both, `/prize-claims/${prizeClaimId}/withdraw`, { code: "000000" });
    },
    "POST /prize-claims/:id/payee": async () => {
      const { prizeClaimId } = await prizeClaimAtA();
      return () => post(both, `/prize-claims/${prizeClaimId}/payee`, { code: "000000", legal_name: "A Person", country: "GB" });
    },
    "POST /prize-claims/:id/challenge": async () => {
      const { prizeClaimId } = await prizeClaimAtA();
      return () =>
        post(onlyA, `/prize-claims/${prizeClaimId}/challenge`, {
          ground: "statement_defect",
          content: "The statement does not say what the node says.",
          evidence_urls: [],
        });
    },
  };

  /** One request for each route that starts something new, with rl-a named. */
  const NEW_AT_A: Record<string, () => Promise<Drive>> = {
    "POST /claims/propose": async () => () =>
      post(both, "/claims/propose", { claim: `The first partner renewed ${randomUUID()}`, label: A }),
    "POST /sources": async () => () =>
      post(both, "/sources", { url: `https://example.org/request-labels/sweep/${randomUUID()}`, content: "Text.", label: A }),
    "POST /contributions": async () => () =>
      post(both, "/contributions", { contribution_type: "propose_request", content: "Someone should count this.", label: A }),
    "POST /grants": async () => {
      const { createApiKey } = await import("../../src/services/api-key-service.js");
      const key = await createApiKey({ userId: both.id, name: "seeding at a", scope: "service", workLabel: A });
      return () =>
        withKey(key.plaintext, { method: "POST", url: "/grants", payload: { name: "A direct mandate", policy: "agent", budget_owls: 5, scope_query: "the first partner" } });
    },
    "POST /grant-conversations": async () => () => post(both, "/grant-conversations", { message: "Draft.", label: A }),
    "POST /assistant/conversations": async () => () => post(both, "/assistant/conversations", { message: "Hello.", label: A }),
    "POST /pages": async () => () => post(both, "/pages", { title: "A new page", body: "Some text.", label: A }),
    // Neither gets as far as writing: the registration is signed by no key, and the package is not one.
    "POST /publishers": async () => () =>
      post(both, "/publishers", { public_key: "A".repeat(43) + "=", hosting: "own_machines", signature: "A".repeat(86) + "==", label: A }),
    "POST /published-pages": async () => () => post(both, "/published-pages", { package: { format: "not-a-package" }, label: A }),
    "POST /extension/analyze": async () => () =>
      post(both, "/extension/analyze", { url: `https://example.org/${randomUUID()}`, title: "A page", text: "Some page text to analyze. ".repeat(20), label: A }),
    "POST /extension/chat": async () => () =>
      post(both, "/extension/chat", { question: "What is this?", page: { url: null, title: null, text: "Some page text." }, label: A }),
  };

  /**
   * The routes a request must really get through for this to mean anything.
   * Each of these has to answer 2xx, and each in ADDS_ROWS has to add or
   * remove a row of some labelled table (the others change rows that are
   * already there, or the owl ledger, which carries no label). The routes
   * in neither list are driven all the same and held to the same check;
   * they may be refused by a rule of their own (a one-time code, an
   * upload's form, a bounty's window).
   */
  const ADDS_ROWS = [
    "POST /claims/:claim_id/order",
    "POST /claims/:claim_id/contribute",
    "POST /claims/:claim_id/decompose",
    "PATCH /claims/:claim_id",
    "POST /contributions",
    "POST /appeals",
    "POST /requests/:request_id/contribute",
    "POST /showings/:showing_id/pages/:page_id/commission",
    "POST /grant-conversations/:id/fund",
    "POST /correspondents/:id/poke",
    "DELETE /assistant/conversations/:id",
    "POST /assistant/conversations/:id/held/:action_id",
    "DELETE /pages/:id",
    "POST /claims/propose",
    "POST /sources",
    "POST /grants",
    "POST /grant-conversations",
    "POST /assistant/conversations",
  ];
  const MUST_SUCCEED = [
    ...ADDS_ROWS,
    "DELETE /orders/:id",
    "POST /budget-jobs/:id/topup",
    "POST /grants/:id/topup",
    "POST /grants/:id/cancel",
    "POST /mandates/:id/contribute",
    "POST /grant-conversations/:id/messages",
    "POST /assistant/conversations/:id/messages",
    "POST /pages",
    "PATCH /reports/:id",
    "PATCH /findings/:id",
  ];

  it("has a request here for every rule that takes its label from a row or from the person", () => {
    const fromRow = Object.entries(REQUEST_LABELS).filter(([, r]) => r.rule === "from").map(([k]) => k).sort();
    expect(Object.keys(FROM_A_ROW).sort()).toEqual(fromRow);
    const chosen = Object.entries(REQUEST_LABELS)
      .filter(([, r]) => r.rule === "chosen" || (r.rule === "from" && r.otherwise === "chosen"))
      .map(([k]) => k)
      .sort();
    expect(Object.keys(NEW_AT_A).sort()).toEqual(chosen);
  });

  const outcomes: Record<string, { status: number; wrote: string[] }> = {};

  for (const [group, drives] of [
    ["about a row at rl-a", FROM_A_ROW],
    ["new, at rl-a", NEW_AT_A],
  ] as const) {
    for (const key of Object.keys(drives)) {
      it(`${key} (${group}) changes nothing at any other label`, async () => {
        const drive = await drives[key]!();
        await settleAssistantTurns();
        await settleGrantConversationTurns();
        await new Promise((r) => setTimeout(r, 80));
        const { res, wrote } = await writesOnlyAt(A, key, drive);
        outcomes[`${key} (${group})`] = { status: res.statusCode, wrote };
        if (MUST_SUCCEED.includes(key)) {
          expect(res.statusCode, `${key}: ${res.body}`).toBeLessThan(300);
          if (ADDS_ROWS.includes(key)) expect(wrote.length, `${key} wrote nothing`).toBeGreaterThan(0);
        } else {
          // Refused by a rule of its own, or done: never a fault.
          expect(res.statusCode, `${key}: ${res.body}`).toBeLessThan(500);
        }
      });
    }
  }

  it("got through on the routes that matter", async () => {
    // Written to the file REQUEST_LABEL_SWEEP names, when set: what each route answered and wrote.
    if (process.env.REQUEST_LABEL_SWEEP) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.REQUEST_LABEL_SWEEP, JSON.stringify(outcomes, null, 1));
    }
    expect(Object.keys(outcomes).length).toBe(Object.keys(FROM_A_ROW).length + Object.keys(NEW_AT_A).length);
  });
});

describe("a route the table says adds no labelled row", () => {
  /** Make a request and check that no labelled table changed at any label. */
  async function writesNothingLabelled(what: string, act: () => Promise<{ statusCode: number; body: string }>) {
    const before = await census();
    const res = await act();
    await new Promise((r) => setTimeout(r, 80));
    const after = await census();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => (before.get(k) ?? 0) !== (after.get(k) ?? 0));
    expect(changed, what).toEqual([]);
    expect(res.statusCode, `${what}: ${res.body}`).toBeLessThan(300);
    return res;
  }

  it("adds none: accounts, keys, consents, allowances and the administrators' writes", async () => {
    const person = await signIn("none-rules");
    await writesNothingLabelled("POST /users/provision", () =>
      app.inject({
        method: "POST",
        url: "/users/provision",
        headers: { "x-api-key": SERVICE_KEY },
        payload: { external_id: person.externalId, display_name: "none-rules again" },
      })
    );
    const granted = await writesNothingLabelled("POST /permissions/grants", () =>
      as(admin, { method: "POST", url: "/permissions/grants", payload: { permission: "read", account_id: person.id, label: A } })
    );
    const key = await writesNothingLabelled("POST /api-keys", () =>
      as(person, { method: "POST", url: "/api-keys", payload: { name: "a key", label: A } })
    );
    await writesNothingLabelled("DELETE /api-keys/:key_id", () =>
      as(person, { method: "DELETE", url: `/api-keys/${(key as unknown as { json: () => { id: string } }).json().id}` })
    );
    await writesNothingLabelled("PUT /assistant/allowance", () =>
      as(person, { method: "PUT", url: "/assistant/allowance", payload: { kinds: ["propose"] } })
    );
    const { client } = await registerClient({
      name: `none-rules ${randomUUID()}`,
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    const consent = await createAuthorizationRequest({
      client,
      redirectUri: "https://client.example/callback",
      scope: "mcp",
      state: null,
      codeChallenge: crypto.createHash("sha256").update("verifier", "ascii").digest("base64url"),
      resource: null,
    });
    await writesNothingLabelled("POST /oauth/requests/:request_id/approve", () =>
      as(person, { method: "POST", url: `/oauth/requests/${consent.id}/approve`, payload: { label: A } })
    );
    const party = await writesNothingLabelled("POST /parties", () =>
      as(admin, { method: "POST", url: "/parties", payload: { name: `A partner ${randomUUID().slice(0, 8)}` } })
    );
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'A partner''s page', $2) RETURNING id`,
      [`https://example.org/request-labels/party/${randomUUID()}`, A]
    );
    await writesNothingLabelled("PUT /sources/:source_id/party", () =>
      as(admin, {
        method: "PUT",
        url: `/sources/${source!.id}/party`,
        payload: { party_id: (party as unknown as { json: () => { party: { id: string } } }).json().party.id },
      })
    );
    expect(await labelOf("sources", source!.id)).toBe(A);
    await writesNothingLabelled("DELETE /permissions/grants/:grant_id", () =>
      as(admin, {
        method: "DELETE",
        url: `/permissions/grants/${(granted as unknown as { json: () => { grant: { id: string } } }).json().grant.id}`,
      })
    );
    await writesNothingLabelled("POST /labels/:label/reads", () =>
      as(admin, { method: "POST", url: `/labels/${B}/reads`, payload: { reads: A } })
    );
    await writesNothingLabelled("DELETE /labels/:label/reads/:reads", () =>
      as(admin, { method: "DELETE", url: `/labels/${B}/reads/${A}` })
    );
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
