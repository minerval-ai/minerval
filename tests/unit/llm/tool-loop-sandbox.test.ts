import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The code-execution sandbox in the ordinary tool loop: a loop that offers
 * it meters each turn that used it by the turn's wall-clock seconds at the
 * published container rate, into the enclosing meter, so the pass budget
 * binds it (instrument-harness.ts). A loop that does not offer it meters
 * nothing, and neither does a turn that did not use it.
 */

const createMock = vi.fn();
const external = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: vi.fn() } };
  },
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ anthropicApiKey: "test-key" }),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));
vi.mock("../../../src/services/usage-service.js", async (importOriginal) => {
  const { getUsageContext } = await import("../../../src/llm/usage-context.js");
  return {
    ...(await importOriginal<typeof import("../../../src/services/usage-service.js")>()),
    meterExternalUsage: vi.fn(async (usage: { costMicroUsd: number }) => {
      external.push(usage as unknown as Record<string, unknown>);
      const meter = getUsageContext().meter;
      if (meter) meter.billedMicroUsd += Math.round(usage.costMicroUsd);
    }),
  };
});

import { toolUseLoop } from "../../../src/llm/client.js";
import { MODELS } from "../../../src/llm/models.js";
import { CODE_EXECUTION_TOOL, CODE_EXECUTION_USD_PER_HOUR } from "../../../src/llm/instrument-harness.js";
import { runBudget, withPassBudget } from "../../../src/llm/usage-context.js";

const ranCode = {
  content: [
    { type: "server_tool_use", id: "srv1", name: "code_execution", input: { code: "print(1+1)" } },
    { type: "code_execution_tool_result", tool_use_id: "srv1", content: { type: "code_execution_result", stdout: "2" } },
    { type: "text", text: "Done." },
  ],
  usage: { input_tokens: 0, output_tokens: 0 },
  stop_reason: "end_turn",
  container: { id: "c1" },
};
const plain = {
  content: [{ type: "text", text: "Done." }],
  usage: { input_tokens: 0, output_tokens: 0 },
  stop_reason: "end_turn",
  container: null,
};
const search = { name: "search", description: "d", input_schema: { type: "object" as const } };

/** The clock advances by half this on every read, so a turn takes measurable time. */
const TURN_SECONDS = 72;

beforeEach(() => {
  createMock.mockReset();
  external.length = 0;
  let t = 0;
  vi.spyOn(Date, "now").mockImplementation(() => {
    const v = t;
    t += (TURN_SECONDS * 1000) / 2;
    return v;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loop(tools: unknown[]) {
  const { value } = await withPassBudget({ microUsd: 1_000_000, source: "the test" }, async () => {
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools: tools as never,
      model: MODELS.haiku,
      executeTool: async () => "ok",
    });
    return runBudget()!.spentMicroUsd;
  });
  return value;
}

describe("the sandbox in toolUseLoop", () => {
  it("meters a turn that ran code by its container time, against the pass budget", async () => {
    createMock.mockResolvedValueOnce(ranCode);
    const spent = await loop([search, CODE_EXECUTION_TOOL]);
    expect(external).toHaveLength(1);
    const row = external[0]!;
    expect(row.provider).toBe("anthropic_code_execution");
    expect(row.unitKind).toBe("container_seconds");
    expect(row.units).toBeGreaterThan(0);
    const expected = ((row.units as number) / 3600) * CODE_EXECUTION_USD_PER_HOUR * 1_000_000;
    expect(row.costMicroUsd).toBeCloseTo(expected);
    expect(spent).toBeGreaterThanOrEqual(Math.round(expected));
  });

  it("meters nothing on a turn that did not run code", async () => {
    createMock.mockResolvedValueOnce(plain);
    await loop([search, CODE_EXECUTION_TOOL]);
    expect(external).toHaveLength(0);
  });

  it("meters nothing when the loop does not offer the sandbox", async () => {
    createMock.mockResolvedValueOnce(ranCode);
    await loop([search]);
    expect(external).toHaveLength(0);
  });
});
