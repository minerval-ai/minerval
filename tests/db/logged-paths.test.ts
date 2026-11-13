/**
 * The model work that the best-effort log leaves out on purpose, against
 * real Postgres: the MCP tools match_claim and extract_claims, called
 * through the real MCP server, and the naming of an Assistant conversation,
 * through the real service. Each is run twice with the same scripted model,
 * once with the log best-effort (as the public graph runs) and once in
 * record mode.
 *
 * Best-effort: nothing of the caller's text reaches agent_runs or
 * agent_steps, as before. Record mode: every run the work makes is logged
 * with the record every run has (the prompt step with its setup, the steps,
 * the seal), private to its caller, and the work fails when a log cannot be
 * written. In both, the caller gets the same result and pays the same.
 *
 * No model is called: the three provider adapters answer from a script and
 * meter a fixed cost. Everything else is the real path, from the tool
 * handler through the quota and the charge to the rows.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

// Tracing is off under vitest by default; production runs with it on.
vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

const CALL_COST_MICRO_USD = 2_500;

const model = vi.hoisted(() => ({
  /** Every call the scripted adapters served, in order. */
  calls: [] as Array<{ kind: string; system: string }>,
}));

const fake = vi.hoisted(() => (name: "anthropic" | "openai" | "openrouter") => {
  const systemText = (system: unknown) =>
    typeof system === "string" ? system : Array.isArray(system) ? system.join("\n") : "";
  const served = async (kind: string, req: { model: string; system?: unknown }) => {
    const { recordCallUsage } = await import("../../src/llm/providers/metering.js");
    model.calls.push({ kind, system: systemText(req.system) });
    const usage = { inputTokens: 900, outputTokens: 60 };
    recordCallUsage(name, req.model, { ...usage, costMicroUsd: 2_500 });
    return usage;
  };
  return {
    name,
    // Naming a conversation.
    complete: async (req: { model: string; system?: unknown }) => ({
      content: "Eggs and heart disease",
      model: req.model,
      usage: await served("complete", req),
      stopReason: "end_turn",
    }),
    // The domain prior.
    completeStructured: async (req: { model: string; system?: unknown }) => {
      await served("structured", req);
      return { domains: [] };
    },
    // The Matcher decides at once that the node is new; the Extractor
    // finishes at once with nothing recorded.
    completeWithTools: async (req: { model: string; system?: unknown; tools: Array<{ name?: string }> }) => {
      const usage = await served("tools", req);
      const matcher = req.tools.some((t) => t.name === "submit_match_decision");
      const call = matcher
        ? {
            type: "tool_use" as const,
            id: "tu_1",
            name: "submit_match_decision",
            input: {
              is_match: false,
              matched_claim_id: null,
              new_canonical_form: "Dietary cholesterol from eggs raises the risk of heart disease.",
              instance_stance: "affirms",
              confidence: 0.8,
              reasoning: "No node in the graph states this.",
              alternative_matches: [],
              relationship_notes: null,
              kind: null,
            },
          }
        : { type: "tool_use" as const, id: "tu_1", name: "finish_extraction", input: { document_problem: null } };
      return {
        content: "",
        model: req.model,
        usage,
        stopReason: "tool_use",
        toolUses: [{ id: call.id, name: call.name, input: call.input }],
        rawContent: [call],
      };
    },
  };
});

vi.mock("../../src/llm/providers/anthropic.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/anthropic.js")>()),
  anthropicAdapter: fake("anthropic"),
}));
vi.mock("../../src/llm/providers/openai.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/openai.js")>()),
  openaiAdapter: fake("openai"),
}));
vi.mock("../../src/llm/providers/openrouter.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/openrouter.js")>()),
  openrouterAdapter: fake("openrouter"),
}));

// The Assistant's own reply is not what is under test: only the naming is.
vi.mock("../../src/llm/agents/assistant.js", () => ({
  runAssistantTurn: vi.fn(async () => ({ reply: "A reply.", stopped: null, toolUses: [], runId: null })),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { complete } from "../../src/llm/client.js";
import { UnloggedModelCallError } from "../../src/llm/logged-run.js";
import { getAssistantTitleSystemPrompt } from "../../src/llm/prompts/assistant.js";
import { assistantAuth } from "../../src/llm/tools/assistant-tools.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import {
  getAssistantConversation,
  settleAssistantTurns,
  startAssistantConversation,
} from "../../src/services/assistant-service.js";
import { getEntitlement } from "../../src/services/billing-service.js";
import { getPromptSet } from "../../src/services/prompt-set.js";
import { getRunSummary, verifyRunLog } from "../../src/services/run-view-service.js";
import { hashText, roleText } from "../../src/services/setup-split.js";
import { settleTextAnalyses } from "../../src/services/text-analysis-service.js";
import { READERS_OWN_REASON } from "../../src/services/trace-service.js";
import { creditOwls, owlBalance, seedUser, OWL } from "./helpers.js";

const config = loadConfig() as { runLogMode: "best_effort" | "record" };
let app: FastifyInstance;

beforeAll(async () => {
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await settleAssistantTurns();
  await settleTextAnalyses();
  await app?.close();
});

afterEach(() => {
  config.runLogMode = "best_effort";
  model.calls.length = 0;
});

interface RunRow {
  id: string;
  agent: string;
  user_id: string | null;
  steps: number | null;
  outcome: string | null;
  private_reasons: string[];
  sensitivity_label: string;
  sealed_at: Date | null;
  log_hash: string | null;
}

const RUN_COLUMNS = `id, agent, user_id, steps, outcome, private_reasons, sensitivity_label, sealed_at, log_hash`;

async function runsOfRequest(requestId: string): Promise<RunRow[]> {
  return rawQuery<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE request_id = $1 ORDER BY started_at, agent`,
    [requestId]
  );
}

/** A user's runs once each has closed; best-effort runs close after the work returns. */
async function runsOfUser(userId: string, expected: number): Promise<RunRow[]> {
  let rows: RunRow[] = [];
  for (let i = 0; i < 100; i++) {
    rows = await rawQuery<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE user_id = $1 ORDER BY started_at, agent`,
      [userId]
    );
    if (rows.length >= expected && rows.every((r) => r.outcome !== null)) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return rows;
}

async function stepsOf(runId: string): Promise<Array<{ seq: number; kind: string; content: Record<string, unknown> }>> {
  return rawQuery(`SELECT seq, kind, content FROM agent_steps WHERE run_id = $1 ORDER BY seq`, [runId]);
}

/** The metered rows of one request, once the fire-and-forget inserts have landed. */
async function usageOfRequest(requestId: string, expected: number) {
  let rows: Array<{ agent: string; run_id: string | null; cost_micro_usd: string }> = [];
  for (let i = 0; i < 100; i++) {
    rows = await rawQuery(
      `SELECT agent, run_id, cost_micro_usd FROM llm_usage WHERE request_id = $1 ORDER BY agent`,
      [requestId]
    );
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return rows;
}

/** A user with owls to spend, and what the account holds before any work is charged. */
async function account(label: string): Promise<{ id: string; externalId: null; start: number }> {
  const id = await seedUser(label);
  await creditOwls(id, 5 * OWL);
  // Reading the entitlement mints the signup and monthly grants, so they
  // are in the starting balance and not in what a call is seen to cost.
  await getEntitlement(id);
  return { id, externalId: null, start: await owlBalance(id) };
}

/** What the account has been charged since it was made. */
async function charged(user: { id: string; start: number }): Promise<number> {
  return user.start - (await owlBalance(user.id));
}

/** Call one tool of the real MCP server as `user`; the request id ties its runs together. */
async function callTool(user: { id: string; externalId: null }, name: string, args: Record<string, unknown>) {
  const requestId = `logged-paths-${randomUUID()}`;
  const server = buildMcpServer({ auth: assistantAuth(user), requestId });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "logged-paths-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // An error the SDK reports in words.
    }
    return { requestId, isError: result.isError === true, payload, text };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

const ASSERTION = "Eating eggs every day raises your risk of heart disease.";

describe("match_claim", () => {
  it("leaves no run while the log is best-effort, as before", async () => {
    const user = await account("logged-paths match best-effort");
    const call = await callTool(user, "match_claim", { assertion: ASSERTION });

    expect(call.isError).toBe(false);
    expect(call.payload).toMatchObject({ matched: false, proposed_kind: "claim" });
    // The domain prior and the Matcher both ran, and both were metered.
    expect(model.calls.map((c) => c.kind)).toEqual(["structured", "tools"]);
    const usage = await usageOfRequest(call.requestId, 2);
    expect(usage.map((u) => [u.agent, u.run_id])).toEqual([
      ["extractor", null],
      ["matcher", null],
    ]);
    expect(await runsOfRequest(call.requestId)).toEqual([]);
    expect(await charged(user)).toBe(2 * CALL_COST_MICRO_USD);
  });

  it("is logged in record mode: each run sealed and private, the same result, the same charge", async () => {
    // What the same call returns and costs with the log best-effort.
    const other = await account("logged-paths match baseline");
    const baseline = await callTool(other, "match_claim", { assertion: ASSERTION });
    model.calls.length = 0;

    config.runLogMode = "record";
    const user = await account("logged-paths match record");
    const call = await callTool(user, "match_claim", { assertion: ASSERTION });

    expect(call.isError).toBe(false);
    expect(call.payload).toEqual(baseline.payload);
    expect(model.calls.map((c) => c.kind)).toEqual(["structured", "tools"]);
    expect(await charged(user)).toBe(2 * CALL_COST_MICRO_USD);
    expect(await charged(other)).toBe(2 * CALL_COST_MICRO_USD);

    // Both runs were closed before the tool answered: record mode waits on the seal.
    const runs = await runsOfRequest(call.requestId);
    expect(runs.map((r) => r.agent).sort()).toEqual(["extractor", "matcher"]);
    for (const run of runs) {
      expect(run).toMatchObject({
        user_id: user.id,
        outcome: "ok",
        private_reasons: [READERS_OWN_REASON],
        sensitivity_label: "public",
      });
      expect(run.sealed_at).not.toBeNull();
      expect(await verifyRunLog(run.id, { isService: true })).toMatchObject({ sealed: true, intact: true, problem: null });
      // The transcript holds the caller's passage, so only the service key reads it.
      expect(await getRunSummary(run.id)).toMatchObject({ withheld: true, private_reasons: [READERS_OWN_REASON] });
    }

    // The record every run has: the prompt step with its setup, then the steps.
    const prior = await stepsOf(runs.find((r) => r.agent === "extractor")!.id);
    expect(prior.map((s) => s.kind)).toEqual(["prompt", "completion"]);
    const matcher = await stepsOf(runs.find((r) => r.agent === "matcher")!.id);
    expect(matcher.map((s) => s.kind)).toEqual(["prompt", "assistant"]);
    for (const steps of [prior, matcher]) {
      expect(steps[0]!.content.setup).toMatchObject({
        promptSet: getPromptSet().hash,
        label: "public",
        featuresOff: [],
      });
    }
    expect(JSON.stringify(matcher[0]!.content.initialMessages)).toContain(ASSERTION);

    // Each metered call now names the run it was made in.
    const usage = await usageOfRequest(call.requestId, 2);
    expect(usage.map((u) => u.run_id).sort()).toEqual(runs.map((r) => r.id).sort());
  });

  it("fails in record mode when a log cannot be written, and the caller is not charged", async () => {
    config.runLogMode = "record";
    const user = await account("logged-paths match unwritable");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Postgres cannot store this byte in jsonb, so the prompt step is lost.
    const call = await callTool(user, "match_claim", { assertion: "A passage with a bad \u0000 byte in it." });
    errors.mockRestore();

    expect(call.isError).toBe(true);
    expect(call.text).toContain("could not be written whole");
    const runs = await runsOfRequest(call.requestId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.sealed_at === null)).toBe(true);
    expect(await charged(user)).toBe(0);
  });
});

describe("extract_claims", () => {
  async function extract(user: { id: string; externalId: null; start: number }) {
    const started = await callTool(user, "extract_claims", { text: `${ASSERTION} So says my doctor.` });
    expect(started.isError).toBe(false);
    await settleTextAnalyses();
    const jobId = (started.payload as { job_id: string }).job_id;
    const read = await callTool(user, "get_text_analysis", { job_id: jobId });
    return { requestId: started.requestId, result: read.payload as { status: string; result: unknown } };
  }

  it("leaves no run while the log is best-effort, and one sealed private run in record mode", async () => {
    const first = await account("logged-paths extract best-effort");
    const plain = await extract(first);
    expect(plain.result).toMatchObject({ status: "complete", result: { claims: [] } });
    expect(await runsOfRequest(plain.requestId)).toEqual([]);
    expect(await charged(first)).toBe(CALL_COST_MICRO_USD);

    config.runLogMode = "record";
    const second = await account("logged-paths extract record");
    const logged = await extract(second);
    expect(logged.result).toMatchObject({ status: "complete", result: { claims: [] } });
    expect(logged.result.result).toEqual(plain.result.result);

    const runs = await runsOfRequest(logged.requestId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agent: "extractor",
      user_id: second.id,
      outcome: "ok",
      private_reasons: [READERS_OWN_REASON],
    });
    expect(runs[0]!.sealed_at).not.toBeNull();
    expect((await stepsOf(runs[0]!.id)).map((s) => s.kind)).toEqual(["prompt", "assistant", "tool_results"]);
    expect(await verifyRunLog(runs[0]!.id, { isService: true })).toMatchObject({ sealed: true, intact: true });

    expect(await charged(second)).toBe(CALL_COST_MICRO_USD);
  });
});

describe("naming an Assistant conversation", () => {
  const MESSAGE = "Is it true that eating eggs every day is bad for your heart?";

  async function converse(label: string) {
    const user = await account(label);
    const started = await startAssistantConversation({ app, user, message: MESSAGE });
    if (!started.ok) throw new Error(started.message);
    await settleAssistantTurns();
    const convo = (await getAssistantConversation(started.conversation.id, user.id))!;
    return { user, convo };
  }

  it("is named the same and charged the same in both modes", async () => {
    const plain = await converse("logged-paths naming best-effort");
    config.runLogMode = "record";
    const logged = await converse("logged-paths naming record");
    for (const { convo } of [plain, logged]) {
      expect(convo.title).toBe("Eggs and heart disease");
      expect(convo.spentMicroUsd).toBe(CALL_COST_MICRO_USD);
    }
    expect(await charged(plain.user)).toBe(CALL_COST_MICRO_USD);
    expect(await charged(logged.user)).toBe(CALL_COST_MICRO_USD);
  });

  it("writes no step while the log is best-effort, as before", async () => {
    const { user } = await converse("logged-paths naming unlogged");
    // The naming run's row is opened outside untraced(), as it always was; it holds nothing.
    const runs = await runsOfUser(user.id, 1);
    expect(runs.map((r) => [r.agent, r.steps])).toEqual([["assistant", 0]]);
    expect(await stepsOf(runs[0]!.id)).toEqual([]);
  });

  it("is a logged run in record mode, under the published naming prompt", async () => {
    config.runLogMode = "record";
    const { user } = await converse("logged-paths naming logged");
    const runs = await runsOfUser(user.id, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: "assistant", outcome: "ok", private_reasons: ["agent:assistant"] });
    expect(runs[0]!.sealed_at).not.toBeNull();
    expect(await verifyRunLog(runs[0]!.id, { isService: true })).toMatchObject({ sealed: true, intact: true });

    const steps = await stepsOf(runs[0]!.id);
    expect(steps.map((s) => s.kind)).toEqual(["prompt", "completion"]);
    expect(JSON.stringify(steps[0]!.content.initialMessages)).toContain(MESSAGE);
    expect(steps[1]!.content.output).toBe("Eggs and heart disease");

    // The role part the run records is the prompt set's "assistant-title",
    // not a new version of the Assistant's own prompt.
    const titleHash = hashText(roleText(getAssistantTitleSystemPrompt()));
    const setup = steps[0]!.content.setup as { promptSet: string; parts: Array<{ kind: string; hash: string }> };
    expect(setup.promptSet).toBe(getPromptSet().hash);
    expect(setup.parts.filter((p) => p.kind === "role").map((p) => p.hash)).toEqual([titleHash]);
    expect(getPromptSet().roles.find((r) => r.name === "assistant-title")?.blocks).toEqual([titleHash]);
    let stored: Array<{ name: string; public: boolean }> = [];
    for (let i = 0; i < 100 && stored.length === 0; i++) {
      stored = await rawQuery(`SELECT name, public FROM setup_parts WHERE kind = 'role' AND hash = $1`, [titleHash]);
      if (stored.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(stored).toEqual([{ name: "assistant-title", public: true }]);
  });
});

describe("the model seam, against the real configuration", () => {
  const ask = () =>
    complete({ model: loadConfig().matcherModel, messages: [{ role: "user", content: "anything" }] });

  it("refuses a call outside a run in record mode, and makes it while the log is best-effort", async () => {
    await expect(ask()).resolves.toMatchObject({ content: "Eggs and heart disease" });
    config.runLogMode = "record";
    await expect(ask()).rejects.toBeInstanceOf(UnloggedModelCallError);
    expect(model.calls).toHaveLength(1);
  });
});
