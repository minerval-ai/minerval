/**
 * MCP ↔ REST parity (docs/mcp.md, "Parity with the REST API"): builds the
 * real app and checks that every REST route is an MCP tool, covered by a
 * hand-written tool, or excluded with a stated reason. A failure here means
 * a route was added (or renamed) without deciding its MCP side: add it to
 * ROUTE_TOOLS in src/mcp/route-tools.ts, or, if MCP genuinely should not
 * have it, to MCP_EXCLUDED_ROUTES with the reason.
 *
 * The app is built three times: with every feature on, which is what the
 * tables decide for the public graph; with every feature off
 * (src/features.ts), to check that a feature's routes and tools go together
 * and nothing else goes with them; and members-only (src/permissions.ts),
 * which mounts the routes for permissions, parties and labels that the
 * public graph does not have.
 *
 * All of those are built as a deployment that publishes the mirror feed
 * and applies one (src/services/mirror-roles.ts), because the mirror's
 * routes are mounted only where it is configured and the tables decide them
 * too. A fourth build, with the mirror not configured, checks that nothing
 * of it is there by default.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  MCP_EXCLUDED_PREFIXES,
  MCP_EXCLUDED_ROUTES,
  NATIVE_TOOL_ROUTES,
  ROUTE_TOOLS,
  routeInput,
  urlParams,
} from "../../../src/mcp/route-tools.js";
import { CHALLENGE_GROUNDS } from "../../../src/services/prize-claim-service.js";
import { z } from "zod";
import { routeKey } from "../../../src/server/plugins/route-catalog.js";
import { buildMcpServer } from "../../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let app: FastifyInstance;
let keys: string[];

/** Both sides of the mirror, so that every mirror route is mounted. */
const MIRROR_ENV = { MIRROR_PUBLISH: "true", MIRROR_FEED_DIR: "/var/empty/mirror-batches" };

beforeAll(async () => {
  process.env.ENVIRONMENT = "staging";
  process.env.LOG_LEVEL = "fatal";
  Object.assign(process.env, MIRROR_ENV);
  const { buildApp } = await import("../../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  keys = app.routeCatalog.map((r) => routeKey(r.method, r.url));
});

afterAll(async () => {
  await app?.close();
  for (const name of Object.keys(MIRROR_ENV)) delete process.env[name];
});

/**
 * The routes only a members-only deployment mounts, by URL: the test's own
 * statement of them, as FEATURE_ROUTES is of the features' below. The
 * tables name them, the app built here does not have them, and the last
 * block builds the app that does.
 */
const MEMBERS_ONLY_ROUTE = /^\/(permissions|parties|labels|showings|release|redaction-policies|outbound|connections|file-sets)(\/|$)|^\/sources\/:source_id\/party$|^\/operator\/administrators$/;
const membersOnlyRoute = (key: string) => MEMBERS_ONLY_ROUTE.test(key.slice(key.indexOf(" ") + 1));
const openRouteTools = () =>
  Object.entries(ROUTE_TOOLS)
    .filter(([key]) => !membersOnlyRoute(key))
    .map(([, tool]) => tool);

function excludedByPrefix(key: string): boolean {
  const url = key.slice(key.indexOf(" ") + 1);
  return Object.keys(MCP_EXCLUDED_PREFIXES).some((prefix) => url.startsWith(prefix));
}

describe("MCP parity with the REST API", () => {
  it("sees the whole route table", () => {
    // An empty catalog would make every check below pass vacuously.
    expect(keys.length).toBeGreaterThan(100);
  });

  it("decides every route: a tool, a native tool, or an exclusion with a reason", () => {
    const undecided = keys.filter(
      (key) =>
        !(key in ROUTE_TOOLS) &&
        !(key in NATIVE_TOOL_ROUTES) &&
        !(key in MCP_EXCLUDED_ROUTES) &&
        !excludedByPrefix(key)
    );
    expect(undecided).toEqual([]);
  });

  it("decides each route once", () => {
    const twice = keys.filter(
      (key) =>
        [
          key in ROUTE_TOOLS,
          key in NATIVE_TOOL_ROUTES,
          key in MCP_EXCLUDED_ROUTES,
          excludedByPrefix(key),
        ].filter(Boolean).length > 1
    );
    expect(twice).toEqual([]);
  });

  it("names no route that does not exist", () => {
    const known = new Set(keys);
    const stale = [
      ...Object.keys(ROUTE_TOOLS),
      ...Object.keys(NATIVE_TOOL_ROUTES),
      ...Object.keys(MCP_EXCLUDED_ROUTES),
    ].filter((key) => !known.has(key) && !membersOnlyRoute(key));
    expect(stale).toEqual([]);
    // The public graph mounts none of the members-only routes.
    expect(keys.filter(membersOnlyRoute)).toEqual([]);
  });

  it("gives every exclusion a reason", () => {
    for (const reason of [
      ...Object.values(MCP_EXCLUDED_ROUTES),
      ...Object.values(MCP_EXCLUDED_PREFIXES),
    ]) {
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("builds an input schema for every exposed route", () => {
    for (const route of app.routeCatalog) {
      if (!(routeKey(route.method, route.url) in ROUTE_TOOLS)) continue;
      expect(() => routeInput(route)).not.toThrow();
    }
  });

  // #715: a route with no params schema once produced a tool that took
  // nothing and dispatched to a URL with `:id` left in it.
  it("takes every path param of an exposed route as a required input", () => {
    const missing: string[] = [];
    for (const route of app.routeCatalog) {
      const key = routeKey(route.method, route.url);
      if (!(key in ROUTE_TOOLS)) continue;
      const input = routeInput(route);
      const shape = input.schema.shape as Record<string, { isOptional(): boolean }>;
      for (const name of urlParams(route.url)) {
        if (!input.params.includes(name) || !shape[name] || shape[name].isOptional()) {
          missing.push(`${key} :${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("lists the challenge grounds on challenge_prize_claim", () => {
    const route = app.routeCatalog.find(
      (r) => routeKey(r.method, r.url) === "POST /prize-claims/:id/challenge"
    )!;
    const schema = z.toJSONSchema(routeInput(route).schema) as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties.ground?.enum).toEqual([...CHALLENGE_GROUNDS]);
    expect(schema.required).toEqual(expect.arrayContaining(["id", "ground", "content"]));
  });

  // Partial responses (src/server/plugins/partial-response.ts): a tool
  // generated from a GET route takes the route's `fields`, so an agent can
  // ask for less exactly as a REST caller can. The exceptions are the
  // exports that are not JSON objects; a new one belongs in that plugin's
  // UNCOVERED_ROUTES, and here.
  it("gives every tool generated from a GET route an optional fields input, exports aside", () => {
    const without: string[] = [];
    for (const route of app.routeCatalog) {
      const key = routeKey(route.method, route.url);
      const tool = ROUTE_TOOLS[key];
      if (!tool) continue;
      const input = routeInput(route);
      const fields = (input.schema.shape as Record<string, { isOptional(): boolean }>).fields;
      if (route.method !== "GET") {
        expect(fields, key).toBeUndefined();
        continue;
      }
      if (!fields) without.push(tool.name);
      else {
        expect(input.query).toContain("fields");
        expect(fields.isOptional(), key).toBe(true);
      }
    }
    expect(without.sort()).toEqual([
      "export_claim_mira",
      "export_claim_nanopub",
      "export_claim_scasp",
      "get_formalization_lean",
    ]);
  });

  it("registers every tool under a unique name, native tools included", async () => {
    const server = buildMcpServer({
      auth: {
        method: "api_key",
        userId: "u",
        apiKeyId: "k",
        contributorExternalId: "x:u",
        isService: false,
        isSession: false,
      },
      requestId: "r",
      app,
    });
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools
    );
    const native = new Set(Object.values(NATIVE_TOOL_ROUTES).flat());
    for (const name of native) expect(registered).toContain(name);
    for (const tool of Object.values(ROUTE_TOOLS)) expect(native.has(tool.name)).toBe(false);
    for (const tool of openRouteTools()) expect(registered).toContain(tool.name);
    const names = Object.values(ROUTE_TOOLS).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("serves every tool's input schema in tools/list", async () => {
    const server = buildMcpServer({
      auth: {
        method: "api_key",
        userId: "u",
        apiKeyId: "k",
        contributorExternalId: "x:u",
        isService: false,
        isSession: false,
      },
      requestId: "r",
      app,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "parity-test", version: "0.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    for (const tool of openRouteTools()) {
      const listed = tools.find((t) => t.name === tool.name);
      expect(listed?.inputSchema.type).toBe("object");
      expect(listed?.description).toBeTruthy();
    }
    await client.close();
  });
});

/**
 * The same app with every feature switched off (src/features.ts). A
 * feature's routes are not mounted, so the tools generated from them are
 * gone, and so are its hand-written tools; every other route and tool is
 * exactly as it was.
 */
describe("with every feature switched off", () => {
  // Whose route each of these is, by its URL. The tables above say nothing
  // about features, so this is the test's own statement of the three.
  const FEATURE_ROUTES: Record<string, RegExp> = {
    extension: /^\/extension(\/|$)/,
    mathematics: /\/formalization|^\/lean-checks\/|\/attempts(\/|$)/,
    prizes: /priz|\/bount|^\/attachments\//,
  };
  const featureOf = (key: string): string | null => {
    const url = key.slice(key.indexOf(" ") + 1);
    return Object.keys(FEATURE_ROUTES).find((name) => FEATURE_ROUTES[name]!.test(url)) ?? null;
  };
  const AUTH = {
    method: "api_key" as const,
    userId: "u",
    apiKeyId: "k",
    contributorExternalId: "x:u",
    isService: false,
    isSession: false,
  };

  let offApp: FastifyInstance;
  let offKeys: string[];
  let allTools: string[];
  let offTools: string[];
  let client: Client;
  let savedFeaturesOff: string | undefined;

  beforeAll(async () => {
    // The tools with everything on, from the app built at the top.
    const full = buildMcpServer({ auth: AUTH, requestId: "r", app });
    allTools = Object.keys(
      (full as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    );

    // Config is cached in its module, and the app, the features and the MCP
    // server all read it: a second build needs its own copies of all of them.
    savedFeaturesOff = process.env.FEATURES_OFF;
    process.env.FEATURES_OFF = "extension,mathematics,prizes";
    vi.resetModules();
    const { buildApp } = await import("../../../src/server/app.js");
    const mcp = await import("../../../src/mcp/server.js");
    offApp = await buildApp();
    await offApp.ready();
    offKeys = offApp.routeCatalog.map((r) => routeKey(r.method, r.url));

    const server = mcp.buildMcpServer({ auth: AUTH, requestId: "r", app: offApp });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "parity-test-features-off", version: "0.0.0" });
    await client.connect(clientSide);
    offTools = (await client.listTools()).tools.map((t) => t.name);
  });

  afterAll(async () => {
    if (savedFeaturesOff === undefined) delete process.env.FEATURES_OFF;
    else process.env.FEATURES_OFF = savedFeaturesOff;
    await client?.close();
    await offApp?.close();
  });

  it("finds each feature's routes in the full app", () => {
    for (const name of Object.keys(FEATURE_ROUTES)) {
      expect(keys.filter((key) => featureOf(key) === name).length, name).toBeGreaterThan(3);
    }
    // The ones the features are known by.
    for (const key of [
      "POST /extension/analyze",
      "GET /claims/:claim_id/formalization",
      "GET /claims/:claim_id/formalization.lean",
      "GET /lean-checks/:id",
      "POST /admin/attempts/:id/cancel",
      "GET /operator/prizes",
      "POST /bounties/:id/confirm",
      "GET /claims/:id/bounty",
    ]) {
      expect(keys, key).toContain(key);
      expect(featureOf(key), key).not.toBeNull();
    }
  });

  it("mounts none of the features' routes", () => {
    expect(offKeys.filter((key) => featureOf(key) !== null)).toEqual([]);
  });

  it("still mounts every other route", () => {
    expect(offKeys.length).toBeGreaterThan(100);
    expect([...offKeys].sort()).toEqual(keys.filter((key) => featureOf(key) === null).sort());
  });

  it("offers none of the features' tools, generated or hand-written", () => {
    const gone = keys.filter((key) => featureOf(key) !== null);
    const generated = gone.flatMap((key) => (ROUTE_TOOLS[key] ? [ROUTE_TOOLS[key]!.name] : []));
    expect(generated.length).toBeGreaterThan(10);
    for (const name of generated) expect(offTools, name).not.toContain(name);

    // A hand-written tool goes when every route it covers is a feature's:
    // get_claim also covers the formalization read, and stays.
    const mounted = new Set(offKeys);
    const native = [...new Set(Object.values(NATIVE_TOOL_ROUTES).flat())];
    const orphaned = native.filter(
      (name) =>
        !Object.entries(NATIVE_TOOL_ROUTES).some(
          ([key, names]) => names.includes(name) && mounted.has(key)
        )
    );
    expect(orphaned.sort()).toEqual(["get_bounty_terms", "get_page_analysis"]);
    for (const name of orphaned) {
      expect(allTools, name).toContain(name);
      expect(offTools, name).not.toContain(name);
    }
  });

  it("still offers every other tool", () => {
    const gone = new Set([
      ...keys
        .filter((key) => featureOf(key) !== null)
        .flatMap((key) => (ROUTE_TOOLS[key] ? [ROUTE_TOOLS[key]!.name] : [])),
      "get_bounty_terms",
      "get_page_analysis",
    ]);
    expect([...offTools].sort()).toEqual(allTools.filter((name) => !gone.has(name)).sort());
    expect(offTools).toEqual(
      expect.arrayContaining(["get_claim", "search_claims", "list_features", "get_prompt_set"])
    );
  });

  it("says so in GET /setup/features and in list_features", async () => {
    const expected = [
      { name: "extension", on: false },
      { name: "mathematics", on: false },
      { name: "prizes", on: false },
    ];
    const res = await offApp.inject({ method: "GET", url: "/setup/features" });
    expect(res.statusCode).toBe(200);
    const served = res.json() as { features: Array<{ name: string; on: boolean; description: string }> };
    expect(served.features.map(({ name, on }) => ({ name, on }))).toEqual(expected);
    for (const feature of served.features) expect(feature.description.length).toBeGreaterThan(60);

    const result = await client.callTool({ name: "list_features", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const listed = JSON.parse(text) as { features: Array<{ name: string; on: boolean }> };
    expect(listed.features.map(({ name, on }) => ({ name, on }))).toEqual(expected);
  });

  it("reports every feature on in the full app", async () => {
    const res = await app.inject({ method: "GET", url: "/setup/features" });
    expect(res.statusCode).toBe(200);
    const served = res.json() as { features: Array<{ name: string; on: boolean }> };
    expect(served.features.map(({ name, on }) => ({ name, on }))).toEqual([
      { name: "extension", on: true },
      { name: "mathematics", on: true },
      { name: "prizes", on: true },
    ]);
  });
});

/**
 * The same app as a members-only deployment (src/permissions.ts). It mounts
 * everything the public graph does and the routes for permissions, parties
 * and labels besides, each decided in the tables. A tool whose route asks
 * for a permission is offered only to a caller who holds it.
 */
describe("in a members-only deployment", () => {
  const caller = (permissions: string[]) => ({
    method: "api_key" as const,
    userId: "u",
    apiKeyId: "k",
    contributorExternalId: "x:u",
    isService: false,
    isSession: false,
    standing: {
      member: true,
      grants: [
        { permission: "read" as const, label: "internal", partyId: null, group: null },
        ...permissions.map((permission) => ({
          permission: permission as "direct",
          label: null,
          partyId: null,
          group: null,
        })),
      ],
      clearance: ["internal", "public"],
      rawSourceLabels: ["public"],
      groups: [],
    },
  });

  let membersApp: FastifyInstance;
  let membersKeys: string[];
  let toolsOf: (permissions: string[]) => string[];
  let saved: Record<string, string | undefined>;

  beforeAll(async () => {
    saved = { READS: process.env.READS, API_KEYS: process.env.API_KEYS };
    process.env.READS = "members";
    process.env.API_KEYS = "parity-members-key";
    vi.resetModules();
    const { buildApp } = await import("../../../src/server/app.js");
    const mcp = await import("../../../src/mcp/server.js");
    membersApp = await buildApp();
    await membersApp.ready();
    membersKeys = membersApp.routeCatalog.map((r) => routeKey(r.method, r.url));
    toolsOf = (permissions) =>
      Object.keys(
        (
          mcp.buildMcpServer({ auth: caller(permissions), requestId: "r", app: membersApp }) as unknown as {
            _registeredTools: Record<string, unknown>;
          }
        )._registeredTools
      );
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await membersApp?.close();
  });

  it("mounts every route the public graph does, and its own besides", () => {
    const own = membersKeys.filter(membersOnlyRoute);
    expect(own.length).toBeGreaterThan(10);
    expect(membersKeys.filter((key) => !membersOnlyRoute(key)).sort()).toEqual([...keys].sort());
  });

  it("decides each of its own routes once, and the tables name no other", () => {
    const own = membersKeys.filter(membersOnlyRoute);
    for (const key of own) {
      const decisions = [key in ROUTE_TOOLS, key in NATIVE_TOOL_ROUTES, key in MCP_EXCLUDED_ROUTES];
      expect(decisions.filter(Boolean).length, key).toBe(1);
    }
    const named = [
      ...Object.keys(ROUTE_TOOLS),
      ...Object.keys(NATIVE_TOOL_ROUTES),
      ...Object.keys(MCP_EXCLUDED_ROUTES),
    ].filter(membersOnlyRoute);
    expect(named.sort()).toEqual([...own].sort());
  });

  it("offers a caller who holds every permission every tool", () => {
    const tools = toolsOf(["direct", "fund", "administer", "release"]);
    for (const tool of Object.values(ROUTE_TOOLS)) expect(tools, tool.name).toContain(tool.name);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("leaves out the tools of a permission the caller lacks, and nothing else", () => {
    const all = toolsOf(["direct", "fund", "administer", "release"]);
    const needing = (permission: string) =>
      membersApp.routeCatalog
        .filter((r) => r.permissions.includes(permission as "direct"))
        .flatMap((r) => {
          const tool = ROUTE_TOOLS[routeKey(r.method, r.url)];
          return tool ? [tool.name] : [];
        });
    expect(needing("fund").length).toBeGreaterThan(5);
    expect(needing("direct").length).toBeGreaterThan(3);
    expect(needing("administer").length).toBeGreaterThan(3);

    const reader = toolsOf([]);
    expect(needing("release").sort()).toEqual(["get_release_queue", "list_release_rules"]);
    // A route that any one of several permissions opens (the reads of the
    // file sets, for a person who directs or an administrator) is left out
    // for a caller who holds none of them, and offered to one who holds any.
    const needingAnyOf = membersApp.routeCatalog
      .filter((r) => (r.anyPermissions ?? []).length > 0)
      .flatMap((r) => {
        const tool = ROUTE_TOOLS[routeKey(r.method, r.url)];
        return tool ? [tool.name] : [];
      });
    expect(needingAnyOf.sort()).toEqual(["get_file_set", "list_file_set_commands", "list_file_set_files", "list_file_sets"]);
    const gone = new Set([...needing("direct"), ...needing("fund"), ...needing("administer"), ...needing("release"), ...needingAnyOf]);
    expect([...reader].sort()).toEqual(all.filter((name) => !gone.has(name)).sort());
    for (const holding of [["direct"], ["administer"]]) {
      const tools = toolsOf(holding);
      for (const name of needingAnyOf) expect(tools, `${name} for a holder of ${holding[0]}`).toContain(name);
    }
    for (const name of needingAnyOf) expect(toolsOf(["fund"]), name).not.toContain(name);

    const funder = toolsOf(["fund"]);
    for (const name of needing("fund")) expect(funder, name).toContain(name);
    for (const name of needing("direct")) expect(funder, name).not.toContain(name);
  });
});

/**
 * The same app on a deployment that has set nothing for the mirror
 * (src/services/mirror-roles.ts), which is every deployment until someone
 * configures a side. None of the mirror's routes is mounted and none of its
 * tools is offered; every other route and tool is exactly as it was.
 */
describe("with the mirror not configured", () => {
  const isMirror = (key: string) => key.slice(key.indexOf(" ") + 1).startsWith("/mirror");
  const AUTH = {
    method: "api_key" as const,
    userId: "u",
    apiKeyId: "k",
    contributorExternalId: "x:u",
    isService: false,
    isSession: false,
  };
  const MIRROR_TOOLS = ["get_mirror_feed_key", "list_mirror_batches", "get_mirror_status"];

  let plainApp: FastifyInstance;
  let plainKeys: string[];
  let plainTools: string[];
  let allTools: string[];
  let saved: Record<string, string | undefined>;

  beforeAll(async () => {
    const full = buildMcpServer({ auth: AUTH, requestId: "r", app });
    allTools = Object.keys((full as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

    saved = Object.fromEntries(Object.keys(MIRROR_ENV).map((name) => [name, process.env[name]]));
    for (const name of Object.keys(MIRROR_ENV)) delete process.env[name];
    vi.resetModules();
    const { buildApp } = await import("../../../src/server/app.js");
    const mcp = await import("../../../src/mcp/server.js");
    plainApp = await buildApp();
    await plainApp.ready();
    plainKeys = plainApp.routeCatalog.map((r) => routeKey(r.method, r.url));
    const server = mcp.buildMcpServer({ auth: AUTH, requestId: "r", app: plainApp });
    plainTools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await plainApp?.close();
  });

  it("finds the mirror's routes and tools in the app that has it configured", () => {
    expect(keys.filter(isMirror).sort()).toEqual([
      "GET /mirror/feed",
      "GET /mirror/feed/:sequence",
      "GET /mirror/feed/key",
      "GET /mirror/status",
    ]);
    for (const name of MIRROR_TOOLS) expect(allTools, name).toContain(name);
  });

  it("mounts none of them, and every other route", () => {
    expect(plainKeys.filter(isMirror)).toEqual([]);
    expect([...plainKeys].sort()).toEqual(keys.filter((key) => !isMirror(key)).sort());
  });

  it("offers none of the mirror's tools, and every other tool", () => {
    for (const name of MIRROR_TOOLS) expect(plainTools, name).not.toContain(name);
    expect([...plainTools].sort()).toEqual(allTools.filter((name) => !MIRROR_TOOLS.includes(name)).sort());
  });
});
