import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the MCP SDK client so no network is dialed. The adapter (#299) is a
// thin proxy; what we verify is the gating, the allowlist/prefixing, and the
// graceful-degradation contract (§20) — never the provider itself.
const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // `function`, not an arrow: the adapter calls `new Client(...)`, and
  // vitest 4+ constructs through the implementation.
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: mockConnect,
      listTools: mockListTools,
      callTool: mockCallTool,
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const { mockMeterExternal } = vi.hoisted(() => ({ mockMeterExternal: vi.fn(async () => undefined) }));
vi.mock("../../../../src/services/usage-service.js", () => ({
  meterExternalUsage: mockMeterExternal,
}));

import {
  elicitConfigured,
  getElicitToolDefinitions,
  executeElicitTool,
  isElicitTool,
  resetElicitClientForTests,
} from "../../../../src/llm/tools/elicit-tools.js";
import type { Config } from "../../../../src/config.js";
import { withCostMeter } from "../../../../src/llm/usage-context.js";

const baseConfig = {
  elicitApiKey: "test-key",
  elicitMcpUrl: "https://elicit.example/api/mcp",
  elicitUsdPerCall: 0.1,
} as Config;

const disabledConfig = { ...baseConfig, elicitApiKey: "" } as Config;

describe("elicit gating", () => {
  it("is off entirely without an API key", () => {
    expect(elicitConfigured(disabledConfig)).toBe(false);
    expect(elicitConfigured(baseConfig)).toBe(true);
  });

  it("recognizes prefixed tool names", () => {
    expect(isElicitTool("elicit_search_papers")).toBe(true);
    expect(isElicitTool("search_claims")).toBe(false);
  });
});

describe("getElicitToolDefinitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetElicitClientForTests();
    mockConnect.mockResolvedValue(undefined);
  });

  it("returns [] when unconfigured, without dialing the provider", async () => {
    expect(await getElicitToolDefinitions(disabledConfig)).toEqual([]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("exposes only the allowlisted search tools, prefixed elicit_", async () => {
    mockListTools.mockResolvedValueOnce({
      tools: [
        {
          name: "search_papers",
          description: "Search papers",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search_trials",
          description: "Search trials",
          inputSchema: { type: "object", properties: {} },
        },
        // Long-running/expensive tools must NOT reach the Steward's toolset.
        {
          name: "create_report",
          description: "Create a research report",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    const defs = await getElicitToolDefinitions(baseConfig);
    expect(defs.map((d) => d.name)).toEqual([
      "elicit_search_papers",
      "elicit_search_trials",
    ]);
    // The price is part of the definition: the agent decides with it.
    expect(defs[0]!.description).toBe("Search papers\n\nEach call costs $0.10 against the run's budget.");
  });

  it("degrades to [] when the provider is unreachable (§20)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await getElicitToolDefinitions(baseConfig)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("executeElicitTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetElicitClientForTests();
    mockConnect.mockResolvedValue(undefined);
  });

  it("proxies the call with the prefix stripped and returns text content", async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"papers":[{"title":"A study"}]}' }],
    });

    const out = await executeElicitTool(
      "elicit_search_papers",
      { query: "GLP-1 agonists for weight loss" },
      baseConfig
    );
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "search_papers",
      arguments: { query: "GLP-1 agonists for weight loss" },
    });
    expect(out).toBe('{"papers":[{"title":"A study"}]}');
    // Every call that reached Elicit is metered at the configured per-call price.
    expect(mockMeterExternal).toHaveBeenCalledWith({
      provider: "elicit",
      model: "elicit/search_papers",
      units: 1,
      unitKind: "call",
      costMicroUsd: 100_000,
    });
  });

  it("declines a call the run's budget cannot cover, before dialing Elicit", async () => {
    const { value } = await withCostMeter(
      () => executeElicitTool("elicit_search_papers", { query: "x" }, baseConfig),
      { ceilingMicroUsd: 50_000 }
    );
    expect(JSON.parse(value)).toMatchObject({ success: false });
    expect(JSON.parse(value).message).toContain("$0.10");
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(mockMeterExternal).not.toHaveBeenCalled();
  });

  it("meters nothing for a call that never reached Elicit", async () => {
    mockMeterExternal.mockClear();
    await executeElicitTool("elicit_create_report", {}, baseConfig);
    mockCallTool.mockRejectedValueOnce(new Error("down"));
    await executeElicitTool("elicit_search_papers", { query: "x" }, baseConfig);
    expect(mockMeterExternal).not.toHaveBeenCalled();
  });

  it("rejects tools outside the allowlist even with the prefix", async () => {
    const out = JSON.parse(
      await executeElicitTool("elicit_create_report", {}, baseConfig)
    );
    expect(out.success).toBe(false);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it("returns a structured error on a provider isError result", async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "quota exceeded" }],
    });
    const out = JSON.parse(
      await executeElicitTool("elicit_search_papers", { query: "q" }, baseConfig)
    );
    expect(out.success).toBe(false);
    expect(out.message).toContain("quota exceeded");
  });

  it("returns a structured error instead of throwing when the call fails (§20)", async () => {
    mockCallTool.mockRejectedValueOnce(new Error("socket hang up"));
    const out = JSON.parse(
      await executeElicitTool("elicit_search_papers", { query: "q" }, baseConfig)
    );
    expect(out.success).toBe(false);
    expect(out.message).toContain("socket hang up");
  });
});
