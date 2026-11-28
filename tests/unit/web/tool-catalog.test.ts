/**
 * The tool catalog on /docs/tools (web/lib/tool-catalog.ts) groups the
 * server's own tools/list and reads each tool's cost from the notes in its
 * description. Built against the real server, as tests/unit/mcp/parity.test.ts
 * builds it: a new tool that fits no group, or a spend note the catalog no
 * longer reads, fails here rather than showing on the page under "Other" or
 * as free.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../../src/mcp/server.js";
import {
  OTHER_GROUP,
  buildCatalog,
  toolGroup,
  type CatalogTool,
  type ListedTool,
} from "../../../web/lib/tool-catalog.js";

let app: FastifyInstance;
let listed: ListedTool[];
let byName: Map<string, CatalogTool>;

beforeAll(async () => {
  process.env.ENVIRONMENT = "staging";
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../../src/server/app.js");
  app = await buildApp();
  await app.ready();
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
  const client = new Client({ name: "tool-catalog-test", version: "0.0.0" });
  await client.connect(clientSide);
  listed = (await client.listTools()).tools as ListedTool[];
  await client.close();
  byName = new Map(buildCatalog(listed).flatMap((g) => g.tools).map((t) => [t.name, t]));
});

afterAll(async () => {
  await app?.close();
});

describe("the tool catalog", () => {
  it("puts every tool the server registers in a named group", () => {
    expect(listed.length).toBeGreaterThan(100);
    const ungrouped = listed.map((t) => t.name).filter((n) => toolGroup(n).key === OTHER_GROUP.key);
    expect(ungrouped, "add these to a group in web/lib/tool-catalog.ts").toEqual([]);
  });

  it("lists every tool once", () => {
    expect(byName.size).toBe(listed.length);
  });

  it("reads what a call costs from the server's own notes", () => {
    const cost = (n: string) => byName.get(n)?.cost;
    for (const n of ["search_claims", "get_claim", "get_claim_card", "list_graph_changes", "get_run"]) {
      expect(cost(n), n).toBe("read");
    }
    for (const n of ["raise_issue", "state_view", "submit_appeal", "cancel_order"]) {
      expect(cost(n), n).toBe("write");
    }
    for (const n of ["match_claim", "extract_claims", "assess_text", "propose_claim", "submit_source", "order_assessment", "query_sql",
      // Pays, by default, for the reassessment an accepted contribution asks for (#1222).
      "submit_contribution"]) {
      expect(cost(n), n).toBe("charged");
    }
    for (const n of ["fund_claim_assessment", "fund_deep_decomposition", "fund_mandate", "fund_grant", "fund_request_work"]) {
      expect(cost(n), n).toBe("escrow");
    }
  });

  it("names the REST route a generated tool runs, and none for a hand-written one", () => {
    expect(byName.get("get_claim_card")?.route).toBe("GET /claims/:claim_id/card");
    expect(byName.get("propose_claim")?.route).toBe("POST /claims/propose");
    expect(byName.get("search_claims")?.route).toBeNull();
  });

  it("gives each tool a one-line summary and its parameters, without fields", () => {
    const card = byName.get("get_claim_card")!;
    expect(card.summary.length).toBeGreaterThan(10);
    expect(card.summary).not.toMatch(/Same operation as/);
    expect(card.params).toEqual([{ name: "claim_id", required: true }]);
    expect(card.fields).toBe(true);
  });
});
