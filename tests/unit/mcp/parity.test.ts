/**
 * MCP ↔ REST parity (docs/mcp.md, "Parity with the REST API"): builds the
 * real app and checks that every REST route is an MCP tool, covered by a
 * hand-written tool, or excluded with a stated reason. A failure here means
 * a route was added (or renamed) without deciding its MCP side: add it to
 * ROUTE_TOOLS in src/mcp/route-tools.ts, or, if MCP genuinely should not
 * have it, to MCP_EXCLUDED_ROUTES with the reason.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  MCP_EXCLUDED_PREFIXES,
  MCP_EXCLUDED_ROUTES,
  NATIVE_TOOL_ROUTES,
  ROUTE_TOOLS,
  routeInput,
} from "../../../src/mcp/route-tools.js";
import { routeKey } from "../../../src/server/plugins/route-catalog.js";
import { buildMcpServer } from "../../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let app: FastifyInstance;
let keys: string[];

beforeAll(async () => {
  process.env.ENVIRONMENT = "staging";
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  keys = app.routeCatalog.map((r) => routeKey(r.method, r.url));
});

afterAll(async () => {
  await app?.close();
});

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
    ].filter((key) => !known.has(key));
    expect(stale).toEqual([]);
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
    for (const tool of Object.values(ROUTE_TOOLS)) {
      expect(registered).toContain(tool.name);
      expect(native.has(tool.name)).toBe(false);
    }
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
    for (const tool of Object.values(ROUTE_TOOLS)) {
      const listed = tools.find((t) => t.name === tool.name);
      expect(listed?.inputSchema.type).toBe("object");
      expect(listed?.description).toBeTruthy();
    }
    await client.close();
  });
});
