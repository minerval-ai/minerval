import { describe, it, expect } from "vitest";
import {
  CONNECTION_NOTICE,
  CONNECTION_TOOL_SEPARATOR,
  credentialHeaders,
  isConnectionToolName,
  isCredentialEnvName,
  isReadingAddress,
  isToolPrefix,
  markedAsWriting,
  offeredNameProblem,
  offeredToolName,
  parseOfferedToolName,
  readOnlyHint,
  readingAddress,
  toolDefinitionHash,
  toolPrefixFromName,
  type ServerToolDefinition,
} from "../../src/connections.js";
import { TOOL_READS, toolPrivateReason } from "../../src/llm/run-visibility.js";

/**
 * The parts of a connection that need no database (src/connections.ts): how
 * a tool is named for an agent, what a pick is held to, what the server's
 * markings mean, and which environment variable may hold a credential.
 */

const tool: ServerToolDefinition = {
  name: "run_query",
  description: "Run a read-only query.",
  inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  annotations: { readOnlyHint: true },
};

describe("a connection's tool names", () => {
  it("are the prefix, the separator, and the server's own name", () => {
    expect(offeredToolName("warehouse", "run_query")).toBe("warehouse__run_query");
    expect(parseOfferedToolName("warehouse__run_query")).toEqual({ prefix: "warehouse", tool: "run_query" });
    // The server's name may itself hold the separator; the prefix never does.
    expect(parseOfferedToolName("wiki__a__b")).toEqual({ prefix: "wiki", tool: "a__b" });
    expect(parseOfferedToolName("get_claim")).toBeNull();
    expect(parseOfferedToolName("__x")).toBeNull();
  });

  it("cannot collide with a built-in tool: no built-in name holds the separator", () => {
    // TOOL_READS lists every tool the graph's agents can call, and
    // tests/unit/llm/run-visibility.test.ts fails when one is missing.
    const colliding = Object.keys(TOOL_READS).filter((name) => name.includes(CONNECTION_TOOL_SEPARATOR));
    expect(colliding).toEqual([]);
    expect(isConnectionToolName("keep_reading")).toBe(false);
    expect(isConnectionToolName("warehouse__run_query")).toBe(true);
  });

  it("take a prefix that is one short lower-case word with single underscores", () => {
    for (const ok of ["warehouse", "eval_logs", "a1", "x_y_z"]) expect(isToolPrefix(ok), ok).toBe(true);
    for (const bad of ["", "Warehouse", "1abc", "a__b", "a_", "_a", "a-b", "a b", "x".repeat(25)]) {
      expect(isToolPrefix(bad), bad).toBe(false);
    }
    expect(toolPrefixFromName("Finance Warehouse (EU)")).toBe("finance_warehouse_eu");
    expect(toolPrefixFromName("2026 logs")).toBe("c2026_logs");
    expect(toolPrefixFromName("???")).toBe("connection");
    expect(isToolPrefix(toolPrefixFromName("An extremely long name for a connection to a system"))).toBe(true);
  });

  it("are refused where a model could not be given the name", () => {
    expect(offeredNameProblem("warehouse", "run_query")).toBeNull();
    expect(offeredNameProblem("warehouse", "run.query")).toContain("cannot be given as a tool name");
    expect(offeredNameProblem("warehouse", "q".repeat(60))).toContain("at most 64 characters");
  });

  it("make a run that calls one private, by the shape of the name", () => {
    expect(toolPrivateReason("warehouse__run_query")).toBe("tool:warehouse__run_query");
    expect(toolPrivateReason("keep_reading")).toBe("tool:keep_reading");
    expect(toolPrivateReason("open_reading")).toBe("tool:open_reading");
  });
});

describe("what a pick is held to", () => {
  it("is a hash that moves with the name, the description, the schema and the markings", () => {
    const base = toolDefinitionHash(tool);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(toolDefinitionHash({ ...tool })).toBe(base);
    // Key order in the schema is not a change.
    expect(
      toolDefinitionHash({ ...tool, inputSchema: { required: ["sql"], properties: { sql: { type: "string" } }, type: "object" } })
    ).toBe(base);
    expect(toolDefinitionHash({ ...tool, name: "run_query2" })).not.toBe(base);
    expect(toolDefinitionHash({ ...tool, description: "Run a query." })).not.toBe(base);
    expect(
      toolDefinitionHash({ ...tool, inputSchema: { type: "object", properties: { sql: { type: "string" }, commit: { type: "boolean" } } } })
    ).not.toBe(base);
    expect(toolDefinitionHash({ ...tool, annotations: { readOnlyHint: false } })).not.toBe(base);
    expect(toolDefinitionHash({ ...tool, annotations: null })).not.toBe(base);
  });

  it("reads the server's markings as a hint, and as writing only where the server says so", () => {
    expect(readOnlyHint({ readOnlyHint: true })).toBe(true);
    expect(readOnlyHint({ readOnlyHint: false })).toBe(false);
    expect(readOnlyHint({})).toBeNull();
    expect(readOnlyHint(null)).toBeNull();
    expect(markedAsWriting({ readOnlyHint: false })).toBe(true);
    expect(markedAsWriting({ destructiveHint: true })).toBe(true);
    expect(markedAsWriting({ readOnlyHint: true })).toBe(false);
    // No marking is not a marking as writing: most servers mark nothing.
    expect(markedAsWriting(null)).toBe(false);
    expect(markedAsWriting({})).toBe(false);
  });
});

describe("a connection's credential", () => {
  it("is named by an environment variable that was named for a connection", () => {
    expect(isCredentialEnvName("CONNECTION_WAREHOUSE_TOKEN")).toBe(true);
    for (const other of ["DATABASE_URL", "ANTHROPIC_API_KEY", "connection_token", "CONNECTION_", "CONNECTION_a", "CONNECTION_X Y"]) {
      expect(isCredentialEnvName(other), other).toBe(false);
    }
  });

  it("is sent as a bearer token in Authorization, and as it is in any other header", () => {
    expect(credentialHeaders("Authorization", "s3cret")).toEqual({ Authorization: "Bearer s3cret" });
    expect(credentialHeaders("authorization", "s3cret")).toEqual({ Authorization: "Bearer s3cret" });
    expect(credentialHeaders("X-Api-Key", "s3cret")).toEqual({ "X-Api-Key": "s3cret" });
  });
});

describe("a reading's address", () => {
  it("names the connection and the call, and is not a web address", () => {
    const address = readingAddress("warehouse", "11111111-1111-4111-8111-111111111111");
    expect(address).toBe("reading:warehouse/11111111-1111-4111-8111-111111111111");
    expect(isReadingAddress(address)).toBe(true);
    expect(isReadingAddress("https://example.org/reading:x")).toBe(false);
  });
});

describe("what an administrator is told", () => {
  it("asks for a read-only credential and says plainly what cannot be proved", () => {
    expect(CONNECTION_NOTICE).toContain("Grant it a read-only credential at the system itself");
    expect(CONNECTION_NOTICE).toContain("This deployment cannot prove that a tool only reads.");
    expect(CONNECTION_NOTICE).toContain("is a hint");
    expect(CONNECTION_NOTICE).toContain("only the tools you pick");
    expect(CONNECTION_NOTICE).toContain("withdrawn until an administrator looks at it again");
    expect(CONNECTION_NOTICE).not.toMatch(/—/);
  });
});
