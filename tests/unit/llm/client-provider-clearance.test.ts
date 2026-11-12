/**
 * The LLM client holds every call to the label of the run making it
 * (src/llm/provider-clearance.ts, src/provider-labels.ts): the model's
 * provider must be cleared for that label or nothing is sent, the tools of
 * an outside service that is not cleared are not offered, the run is told
 * which in its first task message, and the prompt step's setup records the
 * provider. With only `public`, which is the public graph, every call is
 * sent exactly as it was given.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;

const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  completeWithToolsStreaming: vi.fn(),
  complete: vi.fn(),
  completeStructured: vi.fn(),
  recordAgentStep: vi.fn(),
  undefinedLabels: vi.fn(async (_names: readonly string[]) => [] as string[]),
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () => ({
    name: "anthropic",
    completeWithTools: mocks.completeWithTools,
    completeWithToolsStreaming: mocks.completeWithToolsStreaming,
    complete: mocks.complete,
    completeStructured: mocks.completeStructured,
  }),
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: mocks.recordAgentStep,
  markRunPrivate: vi.fn(),
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));

// The one question the check asks the database: which of these labels are
// not defined. Answered from here; the real table is in tests/db.
vi.mock("../../../src/services/label-service.js", () => ({
  undefinedLabels: mocks.undefinedLabels,
}));

import {
  complete,
  completeStructured,
  completeWithTools,
  longRunToolLoop,
  toolUseLoop,
} from "../../../src/llm/client.js";
import { runWithUsageContext, withAgent } from "../../../src/llm/usage-context.js";
import { resetProviderClearanceForTests } from "../../../src/llm/provider-clearance.js";
import { FEATURES_OFF_NOTE_SEPARATOR, featuresOffNote } from "../../../src/llm/features-off-note.js";
import { ProviderNotClearedError, UndefinedProviderLabelError } from "../../../src/provider-labels.js";
import { loadConfig } from "../../../src/config.js";
import { MODELS, OPENROUTER_MODELS } from "../../../src/llm/models.js";

// The deployment's settings as config loading parsed them: the loaded config
// is one object per process, so setting them on it is what the client reads.
const deployment = loadConfig() as unknown as {
  providerLabels: Record<string, string[]>;
  featuresOff: string[];
  elicitApiKey: string;
  pangramApiKey: string;
};
const loaded = { ...deployment };
afterAll(() => {
  Object.assign(deployment, loaded);
});

// An Anthropic model that searches the web inside the turn, one that does
// not (its web_search is the loop's own tool), and the cheap tier on OpenRouter.
const SONNET = MODELS.sonnet;
const HAIKU = MODELS.haiku;
const CHEAP = OPENROUTER_MODELS.flash;
const LOCAL = "endpoint:local/meta-llama/Llama-3.3-70B-Instruct";

const usage = { inputTokens: 1, outputTokens: 1 };
const finalTurn = {
  content: "done",
  model: "m",
  usage,
  stopReason: "end_turn",
  toolUses: [],
  rawContent: [{ type: "text", text: "done" }],
};

const search = { name: "search_claims", description: "search the graph", input_schema: { type: "object" as const } };
const readPage = { name: "read_page", description: "read a page", input_schema: { type: "object" as const } };
const clientWebSearch = { name: "web_search", description: "search the web", input_schema: { type: "object" as const } };
const serverWebSearch = { type: "web_search_20260209" as const, name: "web_search" as const };
const elicit = { name: "elicit_search_papers", description: "papers", input_schema: { type: "object" as const } };
const pangram = { name: "pangram_check_ai", description: "ai check", input_schema: { type: "object" as const } };
const figure = { name: "view_image", description: "view", input_schema: { type: "object" as const } };
const everyTool = [search, readPage, clientWebSearch, elicit, pangram, figure];

/** What a call was sent, copied at the time of the call. */
function sent(mock: ReturnType<typeof vi.fn>, call = 0): { messages: MessageParam[]; tools?: Array<{ name: string }> } {
  return mock.mock.calls[call]![0] as { messages: MessageParam[]; tools?: Array<{ name: string }> };
}

const newTrace = () => ({ runId: "run-c", seq: { n: 0 }, ready: Promise.resolve() });

async function promptSetup(): Promise<{ provider: string | null; label: string; model: string }> {
  const call = mocks.recordAgentStep.mock.calls.find((c) => c[1] === "prompt");
  return ((await call![2]) as { setup: { provider: string | null; label: string; model: string } }).setup;
}

/** Each of the client's functions that sends a request, as one call at whatever label is in context. */
const paths: Array<[string, () => Promise<unknown>, () => ReturnType<typeof vi.fn>]> = [
  ["complete", () => complete({ messages: [{ role: "user", content: "go" }], model: SONNET, tools: everyTool }), () => mocks.complete],
  [
    "completeWithTools",
    () => completeWithTools({ messages: [{ role: "user", content: "go" }], model: SONNET, tools: everyTool }),
    () => mocks.completeWithTools,
  ],
  [
    "completeStructured",
    () => completeStructured({ messages: [{ role: "user", content: "go" }], model: SONNET, schema: {}, schemaName: "X" }),
    () => mocks.completeStructured,
  ],
  [
    "toolUseLoop",
    () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        model: SONNET,
        tools: everyTool,
        executeTool: async () => "unused",
      }),
    () => mocks.completeWithTools,
  ],
  [
    "longRunToolLoop",
    () =>
      longRunToolLoop({
        initialMessages: [{ role: "user", content: "go" }],
        model: SONNET,
        tools: everyTool,
        executeTool: async () => "unused",
      }),
    () => mocks.completeWithToolsStreaming,
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderClearanceForTests();
  mocks.undefinedLabels.mockImplementation(async () => []);
  mocks.complete.mockResolvedValue({ content: "done", model: "m", usage, stopReason: "end_turn" });
  mocks.completeStructured.mockResolvedValue({ ok: true });
  mocks.completeWithTools.mockResolvedValue(finalTurn);
  mocks.completeWithToolsStreaming.mockResolvedValue(finalTurn);
  Object.assign(deployment, { providerLabels: {}, featuresOff: [], elicitApiKey: "", pangramApiKey: "" });
});

describe("with only public, which is the public graph", () => {
  it.each(paths)("%s sends the request as it was given, and asks the database nothing", async (_name, run, adapter) => {
    await withAgent("steward", run);
    expect(adapter()).toHaveBeenCalledTimes(1);
    const request = sent(adapter());
    // No passage heads the task message, and no tool is withheld.
    expect(request.messages[0]).toEqual({ role: "user", content: "go" });
    if (request.tools) expect(request.tools).toEqual(everyTool);
    expect(mocks.undefinedLabels).not.toHaveBeenCalled();
  });

  it("hands on the caller's own tools array, untouched", async () => {
    await withAgent("steward", () =>
      completeWithTools({ messages: [{ role: "user", content: "go" }], model: SONNET, tools: everyTool })
    );
    expect(sent(mocks.completeWithTools).tools).toBe(everyTool);
  });

  it("records the provider in the prompt step's setup", async () => {
    await runWithUsageContext({ trace: newTrace() }, () =>
      complete({ messages: [{ role: "user", content: "go" }], model: SONNET })
    );
    expect(await promptSetup()).toMatchObject({ provider: "anthropic", label: "public", model: SONNET });

    mocks.recordAgentStep.mockClear();
    await runWithUsageContext({ trace: newTrace() }, () =>
      toolUseLoop({ initialMessages: [{ role: "user", content: "go" }], model: CHEAP, tools: [], executeTool: async () => "" })
    );
    expect(await promptSetup()).toMatchObject({ provider: "openrouter", label: "public", model: CHEAP });
  });
});

describe("a run at a second label, with no provider cleared for it", () => {
  it.each(paths)("%s fails before any request, naming the label, the provider and the setting", async (_name, run, adapter) => {
    const call = runWithUsageContext({ label: "internal", trace: newTrace() }, () => withAgent("steward", run));
    await expect(call).rejects.toBeInstanceOf(ProviderNotClearedError);
    await expect(call).rejects.toThrow(
      'anthropic is not cleared for the label "internal", so nothing was sent to it. PROVIDER_LABELS ' +
        "lists the labels each model provider and outside service may receive text at, and one it " +
        'does not list is cleared for "public" alone. To clear this one, set its entry to ' +
        '"anthropic":["public","internal"].'
    );
    expect(adapter()).not.toHaveBeenCalled();
    // Nothing of the run was recorded either: it did not start.
    expect(mocks.recordAgentStep).not.toHaveBeenCalled();
  });

  it("does not fall back to a provider that is cleared", async () => {
    deployment.providerLabels = { openrouter: ["public", "internal"] };
    await expect(
      runWithUsageContext({ label: "internal" }, () => complete({ messages: [{ role: "user", content: "go" }], model: SONNET }))
    ).rejects.toThrow(/^anthropic is not cleared for the label "internal"/);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("is not served because the provider is cleared for a label this one reads", async () => {
    // Cleared for public and for restricted: neither says anything about internal.
    deployment.providerLabels = { anthropic: ["public", "restricted"] };
    await expect(
      runWithUsageContext({ label: "internal" }, () => complete({ messages: [{ role: "user", content: "go" }], model: SONNET }))
    ).rejects.toThrow(/set its entry to "anthropic":\["public","restricted","internal"\]\.$/);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("holds an endpoint of the deployment's own to the same rule", async () => {
    await expect(
      runWithUsageContext({ label: "internal" }, () => complete({ messages: [{ role: "user", content: "go" }], model: LOCAL }))
    ).rejects.toThrow(/^endpoint:local is not cleared for the label "internal"/);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe("a run at a second label, with its provider cleared", () => {
  const TOOLS_NOTE =
    "This deployment has not cleared some outside services to receive the material this run works " +
    "with: web search; reading pages and files from the web. Their tools are not offered to you, so " +
    "what your instructions and skills say about using them does not apply here.";
  const EMBEDDINGS_NOTE =
    "The service that search by meaning relies on is not cleared for it either, so a search of the " +
    "graph matches on keywords where it can and returns an error where it cannot.";
  const CLOSING = "The rest of your instructions hold as written.";

  it.each(paths)("%s is served", async (_name, run, adapter) => {
    deployment.providerLabels = { anthropic: ["public", "internal"] };
    await runWithUsageContext({ label: "internal" }, () => withAgent("steward", run));
    expect(adapter()).toHaveBeenCalledTimes(1);
  });

  it("is not offered the tools of a service that is not cleared, and is told which and why", async () => {
    deployment.providerLabels = { anthropic: ["public", "internal"] };
    deployment.elicitApiKey = "k";
    deployment.pangramApiKey = "k";
    await runWithUsageContext({ label: "internal", trace: newTrace() }, () =>
      withAgent("steward", () =>
        toolUseLoop({
          initialMessages: [{ role: "user", content: "go" }],
          model: HAIKU,
          tools: everyTool,
          executeTool: async () => "unused",
        })
      )
    );
    const request = sent(mocks.completeWithTools);
    expect(request.tools!.map((t) => t.name)).toEqual(["search_claims"]);
    const note =
      "This deployment has not cleared some outside services to receive the material this run works " +
      "with: web search; reading pages and files from the web; Elicit's search of papers and trials; " +
      "Pangram's checks for AI-generated writing and for matching text on the web. Their tools are not " +
      "offered to you, so what your instructions and skills say about using them does not apply here. " +
      `${EMBEDDINGS_NOTE} ${CLOSING}`;
    expect(request.messages[0]).toEqual({ role: "user", content: `${note}${FEATURES_OFF_NOTE_SEPARATOR}go` });

    // The prompt step records what the model was offered and told, and who served it.
    const step = (await mocks.recordAgentStep.mock.calls.find((c) => c[1] === "prompt")![2]) as {
      setup: { provider: string; label: string };
      tools: Array<{ name: string }>;
      initialMessages: MessageParam[];
    };
    expect(step.setup).toMatchObject({ provider: "anthropic", label: "internal" });
    expect(step.tools.map((t) => t.name)).toEqual(["search_claims"]);
    expect(step.initialMessages[0]!.content).toBe(`${note}${FEATURES_OFF_NOTE_SEPARATOR}go`);
  });

  it("keeps the web search its model's provider runs inside the turn, and says nothing of it", async () => {
    deployment.providerLabels = { anthropic: ["public", "internal"], embeddings: ["public", "internal"] };
    await runWithUsageContext({ label: "internal" }, () =>
      withAgent("steward", () =>
        toolUseLoop({
          initialMessages: [{ role: "user", content: "go" }],
          model: SONNET,
          tools: [search, serverWebSearch, readPage],
          executeTool: async () => "unused",
        })
      )
    );
    const request = sent(mocks.completeWithTools);
    expect(request.tools).toEqual([search, serverWebSearch]);
    expect(request.messages[0]!.content).toBe(
      "This deployment has not cleared one outside service to receive the material this run works " +
        "with: reading pages and files from the web. Its tools are not offered to you, so what your " +
        `instructions and skills say about using it does not apply here. ${CLOSING}${FEATURES_OFF_NOTE_SEPARATOR}go`
    );
  });

  it("names only the services this deployment has a key for, and tells the run once", async () => {
    deployment.providerLabels = { openrouter: ["public", "internal"] };
    const messages: MessageParam[] = [{ role: "user", content: "go" }];
    const toolTurn = {
      ...finalTurn,
      stopReason: "tool_use",
      toolUses: [{ id: "t1", name: "search_claims", input: {} }],
      rawContent: [{ type: "tool_use", id: "t1", name: "search_claims", input: {} }],
    };
    const turns: MessageParam[][] = [];
    let n = 0;
    mocks.completeWithTools.mockImplementation(async (options: { messages: MessageParam[] }) => {
      turns.push(structuredClone(options.messages));
      return n++ === 0 ? toolTurn : finalTurn;
    });
    await runWithUsageContext({ label: "internal" }, () =>
      withAgent("matcher", () =>
        toolUseLoop({ initialMessages: messages, model: CHEAP, tools: [search], executeTool: async () => "found" })
      )
    );
    const note = `${TOOLS_NOTE} ${EMBEDDINGS_NOTE} ${CLOSING}`;
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn[0]!.content).toBe(`${note}${FEATURES_OFF_NOTE_SEPARATOR}go`);
      expect(JSON.stringify(turn).split("has not cleared").length - 1).toBe(1);
    }
  });

  it("says only that search by meaning is unavailable when embeddings are all that is not cleared", async () => {
    deployment.providerLabels = {
      anthropic: ["public", "internal"],
      web_search: ["public", "internal"],
      web_pages: ["public", "internal"],
    };
    await runWithUsageContext({ label: "internal" }, () =>
      withAgent("steward", () =>
        complete({ messages: [{ role: "user", content: "go" }], model: SONNET, tools: everyTool })
      )
    );
    const request = sent(mocks.complete);
    // Elicit and Pangram are not cleared either, but this deployment has no
    // key for them, so there was never a tool of theirs to speak of.
    expect(request.tools).toEqual([search, readPage, clientWebSearch, figure]);
    expect(request.messages[0]!.content).toBe(
      "This deployment has not cleared the service that search by meaning relies on to receive the " +
        "material this run works with, so a search of the graph matches on keywords where it can and " +
        `returns an error where it cannot. ${CLOSING}${FEATURES_OFF_NOTE_SEPARATOR}go`
    );
  });

  it("is told nothing, and offered everything, when every service is cleared too", async () => {
    const all = ["public", "internal"];
    deployment.providerLabels = {
      anthropic: all,
      embeddings: all,
      web_search: all,
      web_pages: all,
      elicit: all,
      pangram: all,
    };
    deployment.elicitApiKey = "k";
    deployment.pangramApiKey = "k";
    await runWithUsageContext({ label: "internal" }, () => withAgent("steward", paths[3]![1]));
    const request = sent(mocks.completeWithTools);
    expect(request.messages[0]).toEqual({ role: "user", content: "go" });
    expect(request.tools).toEqual(everyTool);
  });

  it("puts the features-off note and this one in one passage", async () => {
    deployment.providerLabels = { anthropic: ["public", "internal"], embeddings: ["public", "internal"] };
    deployment.featuresOff = ["mathematics"];
    await runWithUsageContext({ label: "internal" }, () =>
      withAgent("steward", () => complete({ messages: [{ role: "user", content: "go" }], model: SONNET }))
    );
    const off = featuresOffNote({ featuresOff: ["mathematics"] });
    expect(sent(mocks.complete).messages[0]!.content).toBe(
      `${off}\n\nThis deployment has not cleared one outside service to receive the material this run ` +
        "works with: reading pages and files from the web. Its tools are not offered to you, so what " +
        `your instructions and skills say about using it does not apply here. ${CLOSING}${FEATURES_OFF_NOTE_SEPARATOR}go`
    );
  });

  it("withholds the tools from a call outside an agent run too, though it adds no passage", async () => {
    deployment.providerLabels = { anthropic: ["public", "internal"] };
    await runWithUsageContext({ label: "internal" }, () =>
      completeWithTools({ messages: [{ role: "user", content: "go" }], model: SONNET, tools: everyTool })
    );
    const request = sent(mocks.completeWithTools);
    expect(request.tools!.map((t) => t.name)).toEqual(["search_claims"]);
    expect(request.messages[0]).toEqual({ role: "user", content: "go" });
  });

  it("serves a run on the deployment's own endpoint once that endpoint is cleared, and records it", async () => {
    deployment.providerLabels = { "endpoint:local": ["internal"] };
    await runWithUsageContext({ label: "internal", trace: newTrace() }, () =>
      complete({ messages: [{ role: "user", content: "go" }], model: LOCAL })
    );
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(await promptSetup()).toMatchObject({ provider: "endpoint:local", label: "internal", model: LOCAL });
  });
});

describe("a label the setting names and the deployment does not define", () => {
  it("is reported at first use, for every call, until the setting or the table is put right", async () => {
    deployment.providerLabels = { anthropic: ["public", "restrcted"], embeddings: ["restrcted"] };
    mocks.undefinedLabels.mockImplementation(async (names) => [...names]);

    // A public call is refused too: the setting is wrong, whoever is asking.
    const call = complete({ messages: [{ role: "user", content: "go" }], model: SONNET });
    await expect(call).rejects.toBeInstanceOf(UndefinedProviderLabelError);
    await expect(call).rejects.toThrow(
      'PROVIDER_LABELS names "restrcted" (for anthropic, embeddings), which this deployment does not ' +
        "define as a label, so nothing was sent. A label is a row in labels and is never created " +
        "from configuration: define it first, or correct the name in PROVIDER_LABELS."
    );
    expect(mocks.undefinedLabels).toHaveBeenCalledWith(["restrcted"]);
    expect(mocks.complete).not.toHaveBeenCalled();

    // The label is defined: the next call goes through, and the table is not asked again.
    mocks.undefinedLabels.mockClear();
    mocks.undefinedLabels.mockImplementation(async () => []);
    await complete({ messages: [{ role: "user", content: "go" }], model: SONNET });
    await complete({ messages: [{ role: "user", content: "go" }], model: SONNET });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.undefinedLabels).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of the database for a setting that names only public", async () => {
    deployment.providerLabels = { web_pages: [], anthropic: ["public"] };
    await complete({ messages: [{ role: "user", content: "go" }], model: SONNET });
    expect(mocks.undefinedLabels).not.toHaveBeenCalled();
  });
});
