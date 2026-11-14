/**
 * The label a request works at (src/server/request-labels.ts): builds the
 * real app and checks that every route that is not a read has a rule there.
 * A failure means a route was added without deciding which label it writes
 * at: add it to REQUEST_LABELS as "from" the row it is about, as "chosen"
 * when it starts something new, or as "none" with the reason it adds no
 * row that carries a label.
 *
 * The app is built twice. Members-only, with every feature on, is where the
 * rules bind, and it mounts the routes the public graph does not have. Open
 * is the public graph, where nothing here may show: no `label` field in any
 * route's schema or in the OpenAPI document.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CARRIERS, REQUEST_LABELS, takesChosenLabel } from "../../../src/server/request-labels.js";
import { LABEL_FIELD, LABEL_MESSAGES, chooseLabel } from "../../../src/server/plugins/request-label.js";
import { routeKey } from "../../../src/server/plugins/route-catalog.js";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

const saved = { ...process.env };

async function build(env: Record<string, string>): Promise<FastifyInstance> {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved, { ENVIRONMENT: "staging", LOG_LEVEL: "fatal", API_KEYS: "env-service-key" }, env);
  if (!("READS" in env)) delete process.env.READS;
  vi.resetModules();
  const { buildApp } = await import("../../../src/server/app.js");
  const app = await buildApp();
  await app.ready();
  return app;
}

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const isRead = (key: string) => key.startsWith("GET ");

describe("every route that writes has a rule for its label", () => {
  let app: FastifyInstance;
  let keys: string[];
  /** The routes mounted only where a deployment creates its own owls (OWLS=created), which the first app does not have. */
  let createdOnly: FastifyInstance["routeCatalog"];
  beforeAll(async () => {
    app = await build({ READS: "members" });
    keys = app.routeCatalog.map((r) => routeKey(r.method, r.url));
    const created = await build({ READS: "members", OWLS: "created" });
    createdOnly = created.routeCatalog.filter((r) => !keys.includes(routeKey(r.method, r.url)));
    await created.close();
    keys = [...keys, ...createdOnly.map((r) => routeKey(r.method, r.url))];
  });
  afterAll(() => app?.close());

  it("sees the routes of a deployment that creates its own owls as well", () => {
    expect(createdOnly.map((r) => routeKey(r.method, r.url)).sort()).toEqual(["GET /owls/created", "POST /owls/created"]);
  });

  it("sees the whole route table", () => {
    expect(keys.filter((k) => !isRead(k)).length).toBeGreaterThan(60);
  });

  it("decides every route that is not a read", () => {
    const undecided = keys.filter((key) => !isRead(key) && !(key in REQUEST_LABELS));
    expect(undecided, "add these to REQUEST_LABELS in src/server/request-labels.ts").toEqual([]);
  });

  it("names no route that does not exist, and no read", () => {
    const mounted = new Set(keys);
    expect(Object.keys(REQUEST_LABELS).filter((key) => !mounted.has(key))).toEqual([]);
    expect(Object.keys(REQUEST_LABELS).filter(isRead)).toEqual([]);
  });

  it("gives every rule its reason", () => {
    for (const [key, rule] of Object.entries(REQUEST_LABELS)) {
      expect(rule.why.trim().length, key).toBeGreaterThan(10);
    }
  });

  it("reads each row's id from a field its route really has", () => {
    for (const [key, rule] of Object.entries(REQUEST_LABELS)) {
      if (rule.rule !== "from") continue;
      expect(rule.carrier in CARRIERS, key).toBe(true);
      const route = [...app.routeCatalog, ...createdOnly].find((r) => routeKey(r.method, r.url) === key)!;
      if (rule.in === "params") {
        expect(route.url.split("/"), key).toContain(`:${rule.field}`);
      } else {
        const body = route.schema?.body as { properties?: Record<string, unknown> } | undefined;
        expect(Object.keys(body?.properties ?? {}), key).toContain(rule.field);
      }
    }
  });

  it("starts nothing new without asking: the routes that start something are the ones listed here", () => {
    // The test's own statement of what is new, so that a rule changed from
    // "chosen" to something quieter is seen.
    expect(
      Object.entries(REQUEST_LABELS)
        .filter(([, rule]) => takesChosenLabel(rule))
        .map(([key]) => key)
        .sort()
    ).toEqual([
      "POST /assistant/conversations",
      "POST /claims/propose",
      "POST /connections",
      "POST /contributions",
      "POST /extension/analyze",
      "POST /file-sets",
      "POST /file-sets/register",
      "POST /grant-conversations",
      "POST /grants",
      "POST /pages",
      "POST /published-mandates",
      "POST /published-pages",
      "POST /publishers",
      "POST /reports",
      "POST /sources",
      "POST /standing-mandates/:name",
    ]);
  });

  it("shows the label field in the OpenAPI document on those routes and the two that make a credential, and on no other", () => {
    const doc = app.swagger() as { paths: Record<string, Record<string, { requestBody?: unknown }>> };
    const withLabel: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const body = JSON.stringify(operation.requestBody ?? {});
        if (body.includes(LABEL_FIELD.description)) {
          withLabel.push(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1").replace(/\/$/, "") || "/"}`);
        }
      }
    }
    const expected = [
      ...Object.entries(REQUEST_LABELS).filter(([, rule]) => takesChosenLabel(rule)).map(([key]) => key),
      "POST /api-keys",
      "POST /oauth/requests/:request_id/approve",
    ].sort();
    expect(withLabel.sort()).toEqual(expected);
  });

  it("offers no MCP tool a label to choose", async () => {
    const { buildMcpServer } = await import("../../../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const auth: RequestAuth = {
      method: "api_key",
      userId: "11111111-1111-4111-8111-111111111111",
      apiKeyId: "k",
      contributorExternalId: "x:u",
      isService: false,
      isSession: false,
      standing: {
        member: true,
        grants: [
          { permission: "direct", label: null, partyId: null, group: null },
          { permission: "fund", label: null, partyId: null, group: null },
          { permission: "administer", label: null, partyId: null, group: null },
        ],
        clearance: ["internal", "public"],
        rawSourceLabels: ["public"],
        groups: [],
      },
      fixedLabel: { label: "internal", of: "API key" },
    };
    const server = buildMcpServer({ auth, requestId: "r", app });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(100);
    const offering = tools
      .filter((t) => "label" in ((t.inputSchema as { properties?: object }).properties ?? {}))
      .map((t) => t.name);
    expect(offering).toEqual([]);
    await client.close();
  });
});

describe("on the public graph", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await build({});
  });
  afterAll(() => app?.close());

  it("no route's schema and no part of the OpenAPI document has the field", () => {
    expect(JSON.stringify(app.swagger())).not.toContain(LABEL_FIELD.description);
    for (const key of ["POST /sources", "POST /claims/propose", "POST /grant-conversations", "POST /api-keys"]) {
      const route = app.routeCatalog.find((r) => routeKey(r.method, r.url) === key)!;
      const body = route.schema?.body as { properties?: Record<string, unknown> } | undefined;
      expect(Object.keys(body?.properties ?? {}), key).not.toContain("label");
    }
  });
});

describe("choosing a label", () => {
  const standing = (clearance: string[]) => ({
    member: true,
    grants: [],
    clearance,
    rawSourceLabels: ["public"],
    groups: [],
  });
  const session: RequestAuth = {
    method: "env_key",
    userId: "u",
    apiKeyId: null,
    contributorExternalId: "x:u",
    isService: true,
    isSession: true,
    standing: standing(["internal", "public"]),
  };
  const key: RequestAuth = {
    ...session,
    method: "api_key",
    isService: false,
    isSession: false,
    fixedLabel: { label: "internal", of: "API key" },
  };

  it("asks nothing where the deployment has one label", () => {
    expect(chooseLabel(session, undefined, false)).toEqual({});
    expect(chooseLabel(session, "public", false)).toEqual({});
    expect(chooseLabel(session, "internal", false)).toMatchObject({ refusal: { status: 400, code: "UNKNOWN_LABEL" } });
  });

  it("takes a session's label from the person, among the labels they read, and has no default", () => {
    expect(chooseLabel(session, "internal", true)).toEqual({ label: "internal" });
    expect(chooseLabel(session, "public", true)).toEqual({ label: "public" });
    expect(chooseLabel(session, undefined, true)).toEqual({
      refusal: {
        status: 400,
        code: "LABEL_REQUIRED",
        error: LABEL_MESSAGES.required(["internal", "public"]),
        labels: ["internal", "public"],
      },
    });
    expect(chooseLabel(session, "", true)).toMatchObject({ refusal: { code: "LABEL_REQUIRED" } });
    expect(chooseLabel(session, "restricted", true)).toMatchObject({ refusal: { status: 403, code: "LABEL_NOT_READABLE" } });
    // A person who reads public alone is asked all the same: nothing is public by omission.
    const publicOnly = { ...session, standing: standing(["public"]) };
    expect(chooseLabel(publicOnly, undefined, true)).toMatchObject({ refusal: { code: "LABEL_REQUIRED", labels: ["public"] } });
  });

  it("takes a credential's label from the credential, and refuses a request that names another", () => {
    expect(chooseLabel(key, undefined, true)).toEqual({ label: "internal" });
    expect(chooseLabel(key, "internal", true)).toEqual({ label: "internal" });
    expect(chooseLabel(key, "public", true)).toMatchObject({ refusal: { status: 400, code: "LABEL_FIXED", label: "internal" } });
  });

  it("says each refusal in plain words", () => {
    expect(LABEL_MESSAGES.required(["internal", "public"])).toBe(
      'This starts something new, and this deployment holds material at more than one label, so the request has to say ' +
        'which label it is for. Send "label" with one of: "internal", "public". There is no default, so that nothing is ' +
        "filed as public by omission. GET /labels/mine says who reads each label."
    );
    expect(LABEL_MESSAGES.fixed({ label: "internal", of: "access token" }, "public")).toBe(
      'This access token works at the label "internal", fixed when it was made, and the request named "public". It ' +
        'does not choose a label for each request. Leave "label" out.'
    );
    expect(LABEL_MESSAGES.mismatch({ label: "internal", of: "API key" }, "node", "public")).toBe(
      'This API key works at the label "internal", and the node this request is about is labeled "public". It can read ' +
        "that node, and it acts only on what carries its own label, so that nothing read at one label is written where " +
        'another label\'s readers see it. Use a credential made for "public".'
    );
    expect(LABEL_MESSAGES.credentialNotReadable({ label: "internal", of: "Assistant conversation" })).toBe(
      'This conversation works at the label "internal", which this account may no longer read, so it is refused. A run ' +
        "or a credential never reads more than the person it acts for."
    );
  });
});
