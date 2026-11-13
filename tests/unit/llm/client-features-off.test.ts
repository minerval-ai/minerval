/**
 * The LLM client tells an agent run which features this deployment has
 * switched off (src/llm/features-off-note.ts): once, at the head of the
 * conversation's first task message, in what is sent and in what the run's
 * log records. A call outside an agent run is sent as given, and with every
 * feature on, which is how the public deployment runs, so is every call.
 * The prompt step's setup records the list either way.
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
  // The log is best-effort here, where untraced() keeps work off it.
  recordMode: () => false,
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
}));

import {
  complete,
  completeStructured,
  completeStructuredList,
  completeWithTools,
  longRunToolLoop,
  toolUseLoop,
} from "../../../src/llm/client.js";
import { runWithUsageContext, untraced, withAgent } from "../../../src/llm/usage-context.js";
import { runDateLine } from "../../../src/llm/run-date.js";
import { loadConfig } from "../../../src/config.js";
import {
  FEATURES_OFF_NOTE_SEPARATOR,
  featuresOffNote,
} from "../../../src/llm/features-off-note.js";

// The deployment's FEATURES_OFF as config loading parsed it: the loaded
// config is one object per process, so setting the list on it is what the
// client and the note read.
const deployment = loadConfig() as { featuresOff: string[] };
const loaded = deployment.featuresOff;
afterAll(() => {
  deployment.featuresOff = loaded;
});

const NOTE = featuresOffNote({ featuresOff: ["mathematics"] });
const BRIEFED = `${NOTE}${FEATURES_OFF_NOTE_SEPARATOR}go`;
const DATED_SYSTEM = `the constitution\n\n${runDateLine()}`;

const usage = { inputTokens: 1, outputTokens: 1 };

const toolTurn = {
  content: "",
  model: "m",
  usage,
  stopReason: "tool_use",
  toolUses: [{ id: "t1", name: "search", input: { q: "x" } }],
  rawContent: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
};

const finalTurn = {
  content: "done",
  model: "m",
  usage,
  stopReason: "end_turn",
  toolUses: [],
  rawContent: [{ type: "text", text: "done" }],
};

/**
 * What each model call was sent, copied at the time of the call: the loop
 * keeps appending to the array it passes.
 */
function capture(mock: ReturnType<typeof vi.fn>, ...turns: unknown[]) {
  const sent: Array<{ messages: MessageParam[]; system: unknown }> = [];
  let i = 0;
  mock.mockImplementation(async (options: { messages: MessageParam[]; system?: unknown }) => {
    sent.push({ messages: structuredClone(options.messages), system: options.system });
    return turns[Math.min(i++, turns.length - 1)];
  });
  return sent;
}

const occurrences = (value: unknown, text: string) => JSON.stringify(value).split(JSON.stringify(text).slice(1, -1)).length - 1;

const newTrace = () => ({ runId: "run-f", seq: { n: 0 }, ready: Promise.resolve() });

async function promptStep(): Promise<{
  setup: { featuresOff: string[]; label: string };
  system: unknown;
  initialMessages: MessageParam[];
}> {
  const call = mocks.recordAgentStep.mock.calls.find((c) => c[1] === "prompt");
  return (await call![2]) as Awaited<ReturnType<typeof promptStep>>;
}

const tools = [
  { name: "search", description: "find things", input_schema: { type: "object" as const } },
];

beforeEach(() => {
  mocks.completeWithTools.mockReset();
  mocks.completeWithToolsStreaming.mockReset();
  mocks.complete.mockReset();
  mocks.completeStructured.mockReset();
  mocks.recordAgentStep.mockReset();
  deployment.featuresOff = [];
});

describe("with every feature on", () => {
  it("sends an agent run's tool loop exactly the messages it was given", async () => {
    const sent = capture(mocks.completeWithTools, toolTurn, finalTurn);
    const initialMessages: MessageParam[] = [{ role: "user", content: "go" }];
    let transcript: MessageParam[] = [];

    await runWithUsageContext({ agent: "steward", trace: newTrace() }, () =>
      toolUseLoop({
        initialMessages,
        tools,
        system: "the constitution",
        executeTool: async () => "search-output",
        onEnd: (t) => {
          transcript = t;
        },
      })
    );

    // Today's bytes: the task message alone, then the turn and its results.
    expect(sent[0]).toEqual({ messages: [{ role: "user", content: "go" }], system: DATED_SYSTEM });
    expect(sent[1]!.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: toolTurn.rawContent },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "search-output" },
          { type: "text", text: "Turn 1 of 5 used; 4 remain." },
        ],
      },
    ]);
    expect(transcript[0]).toEqual({ role: "user", content: "go" });
    expect(initialMessages).toEqual([{ role: "user", content: "go" }]);

    // The log says nothing was off, as a list, so it reads differently from
    // a run recorded before the field existed.
    const step = await promptStep();
    expect(step.setup.featuresOff).toEqual([]);
    expect(step.initialMessages).toEqual([{ role: "user", content: "go" }]);
    expect(step.system).toBe(DATED_SYSTEM);
  });

  it("sends an agent run's single calls exactly the messages they were given", async () => {
    const sentStructured = capture(mocks.completeStructured, { ok: true });
    const sentPlain = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    const sentTools = capture(mocks.completeWithTools, finalTurn);
    const messages: MessageParam[] = [{ role: "user", content: "go" }];

    await withAgent("matcher", async () => {
      await completeStructured({ messages, schema: {}, schemaName: "X", model: "m" });
      await complete({ messages, model: "m" });
      await completeWithTools({ messages, tools, model: "m" });
    });

    for (const sent of [sentStructured, sentPlain, sentTools]) {
      expect(sent).toHaveLength(1);
      expect(sent[0]!.messages).toEqual([{ role: "user", content: "go" }]);
    }
  });

  it("sends a long run exactly the messages it was given", async () => {
    const sent = capture(mocks.completeWithToolsStreaming, finalTurn);
    await withAgent("researcher", () =>
      longRunToolLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        model: "claude-opus-5-5",
        executeTool: async () => "unused",
      })
    );
    expect(sent[0]!.messages).toEqual([{ role: "user", content: "go" }]);
  });
});

describe("with mathematics off", () => {
  beforeEach(() => {
    deployment.featuresOff = ["mathematics"];
  });

  it("heads the first message of an agent run's tool loop with the note, once", async () => {
    const sent = capture(mocks.completeWithTools, toolTurn, toolTurn, finalTurn);
    const initialMessages: MessageParam[] = [{ role: "user", content: "go" }];
    let transcript: MessageParam[] = [];

    await runWithUsageContext({ agent: "steward", trace: newTrace() }, () =>
      toolUseLoop({
        initialMessages,
        tools,
        system: "the constitution",
        executeTool: async () => "search-output",
        onEnd: (t) => {
          transcript = t;
        },
      })
    );

    expect(sent).toHaveLength(3);
    // The first turn: the note, the rule, then the task as the agent file built it.
    expect(sent[0]!.messages).toEqual([{ role: "user", content: BRIEFED }]);
    // Every later turn carries it in that first message and nowhere else.
    for (const turn of sent) {
      expect(turn.messages[0]).toEqual({ role: "user", content: BRIEFED });
      expect(occurrences(turn.messages, NOTE)).toBe(1);
      // System blocks are the caller's, dated, and nothing more.
      expect(turn.system).toBe(DATED_SYSTEM);
    }
    expect(sent[2]!.messages).toHaveLength(5);

    // The log records the first message exactly as sent, and the list.
    const step = await promptStep();
    expect(step.initialMessages).toEqual([{ role: "user", content: BRIEFED }]);
    expect(step.system).toBe(DATED_SYSTEM);
    expect(step.setup.featuresOff).toEqual(["mathematics", "prizes"]);

    // The transcript a paused run keeps is the conversation as sent.
    expect(transcript[0]).toEqual({ role: "user", content: BRIEFED });
    expect(occurrences(transcript, NOTE)).toBe(1);
    // The caller's own messages are not edited.
    expect(initialMessages).toEqual([{ role: "user", content: "go" }]);
  });

  it("does the same on the streaming path", async () => {
    const sent = capture(mocks.completeWithToolsStreaming, toolTurn, finalTurn);
    await withAgent("grantmaker", () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        stream: true,
        executeTool: async () => "search-output",
      })
    );
    expect(sent).toHaveLength(2);
    for (const turn of sent) {
      expect(turn.messages[0]).toEqual({ role: "user", content: BRIEFED });
      expect(occurrences(turn.messages, NOTE)).toBe(1);
    }
  });

  it("does the same on the long-run path", async () => {
    const sent = capture(mocks.completeWithToolsStreaming, toolTurn, finalTurn);
    await runWithUsageContext({ agent: "researcher", trace: newTrace() }, () =>
      longRunToolLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        model: "claude-opus-5-5",
        executeTool: async () => "search-output",
      })
    );
    expect(sent).toHaveLength(2);
    for (const turn of sent) {
      expect(turn.messages[0]).toEqual({ role: "user", content: BRIEFED });
      expect(occurrences(turn.messages, NOTE)).toBe(1);
    }
    const step = await promptStep();
    expect(step.initialMessages).toEqual([{ role: "user", content: BRIEFED }]);
    expect(step.setup.featuresOff).toEqual(["mathematics", "prizes"]);
  });

  it("heads an agent run's single calls with it, and logs them as sent", async () => {
    const sentStructured = capture(mocks.completeStructured, { items: [] });
    const sentPlain = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    const sentTools = capture(mocks.completeWithTools, finalTurn);
    const messages: MessageParam[] = [{ role: "user", content: "go" }];

    await runWithUsageContext({ agent: "extractor", trace: newTrace() }, async () => {
      await completeStructured({ messages, schema: {}, schemaName: "X", model: "m" });
      await completeStructuredList({ messages, itemSchema: {}, schemaName: "X", model: "m" });
      await complete({ messages, model: "m" });
      await completeWithTools({ messages, tools, model: "m" });
    });

    expect(sentStructured).toHaveLength(2);
    for (const sent of [...sentStructured, ...sentPlain, ...sentTools]) {
      expect(sent.messages).toEqual([{ role: "user", content: BRIEFED }]);
    }
    expect(messages).toEqual([{ role: "user", content: "go" }]);

    // Each single call's prompt step and completion step carry what was sent.
    const steps = mocks.recordAgentStep.mock.calls;
    expect(steps.map((c) => c[1])).toEqual([
      "prompt", "completion", "prompt", "completion", "prompt", "completion",
    ]);
    for (const [, kind, content] of steps) {
      if (kind === "prompt") {
        const prompt = (await content) as Awaited<ReturnType<typeof promptStep>>;
        expect(prompt.initialMessages).toEqual([{ role: "user", content: BRIEFED }]);
        expect(prompt.setup.featuresOff).toEqual(["mathematics", "prizes"]);
      } else {
        expect((content as { messages: MessageParam[] }).messages).toEqual([
          { role: "user", content: BRIEFED },
        ]);
      }
    }
  });

  it("tells a run that is not traced, which is still an agent's run", async () => {
    const sent = capture(mocks.completeWithTools, finalTurn);
    await untraced(() =>
      withAgent("extractor", () =>
        toolUseLoop({
          initialMessages: [{ role: "user", content: "go" }],
          tools,
          executeTool: async () => "unused",
        })
      )
    );
    expect(sent[0]!.messages).toEqual([{ role: "user", content: BRIEFED }]);
    expect(mocks.recordAgentStep).not.toHaveBeenCalled();
  });

  it("adds it to the first message of a conversation with history, and to no other", async () => {
    const sent = capture(mocks.completeWithTools, finalTurn);
    const history: MessageParam[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "What for?" },
      { role: "user", content: "For the review." },
    ];
    await withAgent("grantmaker", () =>
      toolUseLoop({ initialMessages: history, tools, executeTool: async () => "unused" })
    );
    expect(sent[0]!.messages).toEqual([{ role: "user", content: BRIEFED }, ...history.slice(1)]);
  });

  it("leaves a resumed conversation that already carries it as it is", async () => {
    const sent = capture(mocks.completeWithTools, finalTurn);
    const resumed: MessageParam[] = [
      { role: "user", content: BRIEFED },
      { role: "assistant", content: "Waiting on the research." },
      { role: "user", content: "The research came back." },
    ];
    await withAgent("steward", () =>
      toolUseLoop({ initialMessages: resumed, tools, executeTool: async () => "unused" })
    );
    expect(sent[0]!.messages).toEqual(resumed);
    expect(occurrences(sent[0]!.messages, NOTE)).toBe(1);
  });

  it("adds nothing to a call that is not an agent run", async () => {
    const sentLoop = capture(mocks.completeWithTools, toolTurn, finalTurn);
    const sentStructured = capture(mocks.completeStructured, { ok: true });
    const sentPlain = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    const sentLong = capture(mocks.completeWithToolsStreaming, finalTurn);
    const messages: MessageParam[] = [{ role: "user", content: "go" }];

    // No agent on the context: a helper call, or one a request made directly.
    await toolUseLoop({ initialMessages: messages, tools, executeTool: async () => "search-output" });
    await completeWithTools({ messages, tools, model: "m" });
    await runWithUsageContext({ userId: "u1", requestId: "r1" }, async () => {
      await completeStructured({ messages, schema: {}, schemaName: "X", model: "m" });
      await complete({ messages, model: "m" });
      await longRunToolLoop({
        initialMessages: messages,
        tools,
        model: "claude-opus-5-5",
        executeTool: async () => "unused",
      });
    });

    expect(sentLoop).toHaveLength(3);
    for (const sent of [...sentLoop, ...sentStructured, ...sentPlain, ...sentLong]) {
      expect(sent.messages[0]).toEqual({ role: "user", content: "go" });
      expect(occurrences(sent.messages, NOTE)).toBe(0);
    }
  });
});

describe("with the extension off", () => {
  it("records the one feature, and tells the run of it alone", async () => {
    deployment.featuresOff = ["extension"];
    const sent = capture(mocks.completeWithTools, finalTurn);
    await runWithUsageContext({ agent: "curator", trace: newTrace() }, () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        executeTool: async () => "unused",
      })
    );
    const note = featuresOffNote({ featuresOff: ["extension"] });
    expect(sent[0]!.messages).toEqual([
      { role: "user", content: `${note}${FEATURES_OFF_NOTE_SEPARATOR}go` },
    ]);
    expect((await promptStep()).setup.featuresOff).toEqual(["extension"]);
  });
});
