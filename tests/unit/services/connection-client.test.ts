import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeMcpServer, type FakeMcpServer } from "../../fake-mcp-server.js";
import {
  callServerTool,
  credentialPresent,
  listServerTools,
  resultText,
  type ConnectionTarget,
} from "../../../src/services/connection-client.js";

/**
 * The deployment as a client of an organization's MCP server
 * (src/services/connection-client.ts), against a real server over HTTP: what
 * it lists, what a call returns, where the credential goes, and how each
 * kind of failure comes back as a value.
 */

let server: FakeMcpServer;
const ENV = "CONNECTION_CLIENT_TEST_TOKEN";

const target = (over: Partial<ConnectionTarget> = {}): ConnectionTarget => ({
  transport: "streamable_http",
  url: server.url,
  credentialEnv: null,
  credentialHeader: "Authorization",
  timeoutSeconds: 10,
  ...over,
});

beforeAll(async () => {
  server = await startFakeMcpServer();
});

afterAll(async () => {
  await server.close();
  delete process.env[ENV];
});

beforeEach(() => {
  server.calls.length = 0;
  server.requireBearer = null;
  server.answerStatus = null;
  server.redirectTo = null;
  server.callDelayMs = 0;
  delete process.env[ENV];
});

describe("listing a server's tools", () => {
  it("returns each tool as the server defines it, markings included", async () => {
    const listed = await listServerTools(target());
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["broken", "delete_rows", "read_rows", "search_notes", "shifting_report"]);
    const read = listed.tools.find((t) => t.name === "read_rows")!;
    expect(read.description).toBe("Read rows from a table of the warehouse.");
    expect(read.annotations).toEqual({ readOnlyHint: true });
    expect((read.inputSchema as { required: string[] }).required).toEqual(["table"]);
    expect(listed.tools.find((t) => t.name === "delete_rows")!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    // A tool the server marks in no way has no markings, not false ones.
    expect(listed.tools.find((t) => t.name === "search_notes")!.annotations).toBeNull();
  });
});

describe("a call", () => {
  it("returns the result as text", async () => {
    const called = await callServerTool(target(), "read_rows", { table: "refunds" });
    expect(called).toEqual({ ok: true, isError: false, text: "table=refunds\nmonth,refunds\n2026-09,412\n2026-10,388\n" });
    expect(server.calls.map((c) => [c.tool, c.args])).toEqual([["read_rows", { table: "refunds" }]]);
  });

  it("returns the system's own error as an answer, not a failure", async () => {
    const called = await callServerTool(target(), "broken", {});
    expect(called).toEqual({ ok: true, isError: true, text: 'relation "refunds_2027" does not exist' });
  });

  it("sends the credential from the named environment variable, in the header", async () => {
    process.env[ENV] = "token-abc";
    server.requireBearer = "token-abc";
    const called = await callServerTool(target({ credentialEnv: ENV }), "read_rows", { table: "t" });
    expect(called.ok).toBe(true);
    expect(server.calls[0]!.headers.authorization).toBe("Bearer token-abc");

    server.requireBearer = null;
    await callServerTool(target({ credentialEnv: ENV, credentialHeader: "X-Api-Key" }), "read_rows", { table: "t" });
    expect(server.calls[1]!.headers["x-api-key"]).toBe("token-abc");
    expect(server.calls[1]!.headers.authorization).toBeUndefined();
  });

  it("is not sent when the variable is not set, and says which variable", async () => {
    const called = await callServerTool(target({ credentialEnv: ENV }), "read_rows", { table: "t" });
    expect(called).toEqual({
      ok: false,
      failure: {
        kind: "credential_missing",
        message: `the environment variable ${ENV}, which holds its credential, is not set where the deployment runs`,
      },
    });
    expect(server.calls).toEqual([]);
    expect(credentialPresent(ENV)).toBe(false);
    expect(credentialPresent(null)).toBe(true);
  });

  it("never reads a variable that was not named for a connection", async () => {
    process.env.NOT_A_CONNECTION_SECRET = "database-password";
    try {
      const called = await callServerTool(target({ credentialEnv: "NOT_A_CONNECTION_SECRET" }), "read_rows", { table: "t" });
      expect(called.ok).toBe(false);
      expect(server.calls).toEqual([]);
    } finally {
      delete process.env.NOT_A_CONNECTION_SECRET;
    }
  });
});

describe("a failure", () => {
  it("is a refused credential when the system answers 401", async () => {
    process.env[ENV] = "old-token-value";
    server.requireBearer = "current";
    const called = await callServerTool(target({ credentialEnv: ENV }), "read_rows", { table: "t" });
    expect(called.ok).toBe(false);
    if (called.ok) return;
    expect(called.failure.kind).toBe("credential_refused");
    expect(called.failure.message).toContain("the system refused the deployment's credential");
    expect(called.failure.message).toBe(
      "the system refused the deployment's credential (HTTP 401); it may have expired or been withdrawn"
    );
    expect(called.failure.message).not.toContain("old-token-value");
    expect(server.calls).toEqual([]);
  });

  it("is an unreachable system when nothing listens at the address", async () => {
    const down = await startFakeMcpServer();
    const url = down.url;
    await down.close();
    const listed = await listServerTools(target({ url }));
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.failure.kind).toBe("unreachable");
    expect(listed.failure.message).toContain("the system could not be reached");
  });

  it("is no answer when the call outlasts its time, and the call was sent once", async () => {
    server.callDelayMs = 2500;
    const called = await callServerTool(target({ timeoutSeconds: 1 }), "read_rows", { table: "slow" });
    expect(called).toEqual({
      ok: false,
      failure: { kind: "no_answer", message: "the system did not answer within 1 seconds" },
    });
    expect(server.calls.filter((c) => c.args.table === "slow").length).toBe(1);
  });

  it("is a plain failure, kept to a line, for anything else", async () => {
    server.answerStatus = 500;
    const called = await callServerTool(target(), "read_rows", { table: "t" });
    expect(called.ok).toBe(false);
    if (called.ok) return;
    expect(called.failure.kind).toBe("failed");
    expect(called.failure.message.length).toBeLessThanOrEqual(300);
  });

  it("does not follow a redirect: the credential goes to the address given and nowhere else", async () => {
    const elsewhere = await startFakeMcpServer();
    try {
      process.env[ENV] = "token-abc";
      server.redirectTo = elsewhere.url;
      const called = await callServerTool(target({ credentialEnv: ENV }), "read_rows", { table: "t" });
      expect(called.ok).toBe(false);
      expect(elsewhere.requests).toBe(0);
      expect(elsewhere.calls).toEqual([]);
      expect(server.calls).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it("is a plain failure for a transport the deployment does not speak", async () => {
    const called = await callServerTool(target({ transport: "stdio" }), "read_rows", { table: "t" });
    expect(called).toEqual({
      ok: false,
      failure: { kind: "failed", message: 'this deployment does not speak the transport "stdio"' },
    });
  });
});

describe("a result's text", () => {
  it("keeps text, and names what is not text by type, size and hash", () => {
    const text = resultText({
      content: [
        { type: "text", text: "a" },
        { type: "image", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
        { type: "resource", resource: { uri: "file:///x", text: "embedded" } },
        { type: "resource_link", uri: "https://example.org/x" },
      ],
    });
    expect(text.split("\n")).toEqual([
      "a",
      expect.stringMatching(/^\[image returned and not kept: image\/png, 9 bytes, sha256 [0-9a-f]{64}\]$/),
      "embedded",
      "[link returned: https://example.org/x]",
    ]);
  });

  it("falls back to structured content, and drops what a text column cannot hold", () => {
    expect(resultText({ content: [], structuredContent: { rows: 2 } })).toBe('{\n  "rows": 2\n}');
    expect(resultText({ content: [{ type: "text", text: "a\u0000b" }] })).toBe("ab");
  });
});
