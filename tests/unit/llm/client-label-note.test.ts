/**
 * The LLM client tells an agent run the label it works at, on a graph with
 * more than one label (src/llm/label-note.ts): once, at the head of the
 * conversation's first task message. Where `public` is the only label,
 * which is the public graph, nothing is asked of the database and every
 * call is sent exactly as given.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;

const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  complete: vi.fn(),
  recordAgentStep: vi.fn(),
  /** What the process last learned about enforcement: null before it has asked. */
  known: null as boolean | null,
  /** What the database client answers: the labels read, or null where nothing is held. */
  reads: vi.fn(),
  /** When the mirror stood, at each asking; empty where no mirror is held. */
  mirrorAsOf: [] as string[],
  mirrorAsked: 0,
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () => ({
    name: "anthropic",
    completeWithTools: mocks.completeWithTools,
    complete: mocks.complete,
  }),
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: mocks.recordAgentStep,
  markRunPrivate: vi.fn(),
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
}));

// Which providers and services are cleared for a label is its own subject
// (client-provider-clearance.test.ts). Here every one is, so that what a
// run is sent differs from what it was given by the label note alone.
vi.mock("../../../src/llm/provider-clearance.js", () => ({
  assertProviderCleared: vi.fn(),
}));

vi.mock("../../../src/llm/uncleared-services-note.js", () => ({
  unclearedServicesNote: () => "",
  withoutUnclearedTools: <T>(tools: T) => tools,
}));

vi.mock("../../../src/db/client.js", () => ({
  currentReadClearance: mocks.reads,
}));

// Whether this deployment keeps a mirror, and the time it stands at
// (services/mirrored-node-service.ts). None, unless a test says so.
vi.mock("../../../src/services/mirrored-node-service.js", () => ({
  holdsMirror: () => mocks.mirrorAsOf.length > 0,
  publicGraphAsOf: async () => {
    mocks.mirrorAsked++;
    return mocks.mirrorAsOf[Math.min(mocks.mirrorAsked - 1, mocks.mirrorAsOf.length - 1)] ?? null;
  },
}));

vi.mock("../../../src/db/clearance.js", async (original) => ({
  ...(await original<typeof import("../../../src/db/clearance.js")>()),
  enforcementLastKnown: () => mocks.known,
}));

import { complete, toolUseLoop } from "../../../src/llm/client.js";
import { runAtLabel, runWithUsageContext, withAgent } from "../../../src/llm/usage-context.js";
import { FEATURES_OFF_NOTE_SEPARATOR } from "../../../src/llm/features-off-note.js";
import { labelNote, mirrorNote } from "../../../src/llm/label-note.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const finalTurn = { content: "done", model: "m", usage, stopReason: "end_turn", toolUses: [], rawContent: [{ type: "text", text: "done" }] };
const toolTurn = {
  content: "",
  model: "m",
  usage,
  stopReason: "tool_use",
  toolUses: [{ id: "t1", name: "search", input: { q: "x" } }],
  rawContent: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
};
const tools = [{ name: "search", description: "find things", input_schema: { type: "object" as const } }];

function capture(mock: ReturnType<typeof vi.fn>, ...turns: unknown[]) {
  const sent: MessageParam[][] = [];
  let i = 0;
  mock.mockImplementation(async (options: { messages: MessageParam[] }) => {
    sent.push(structuredClone(options.messages));
    return turns[Math.min(i++, turns.length - 1)];
  });
  return sent;
}

beforeEach(() => {
  mocks.completeWithTools.mockReset();
  mocks.complete.mockReset();
  mocks.recordAgentStep.mockReset();
  mocks.reads.mockReset();
  mocks.known = null;
  mocks.mirrorAsOf = [];
  mocks.mirrorAsked = 0;
});

describe("where public is the only label", () => {
  it("sends an agent run exactly the messages it was given, and asks the database nothing once that is known", async () => {
    mocks.known = false;
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent).toEqual([[{ role: "user", content: "go" }]]);
    expect(mocks.reads).not.toHaveBeenCalled();
  });

  it("sends the messages as given when the database answers that nothing is held", async () => {
    mocks.reads.mockResolvedValue(null);
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent).toEqual([[{ role: "user", content: "go" }]]);
  });

  it("sends the messages as given when there is no database to ask, as when the client is driven alone", async () => {
    mocks.reads.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent).toEqual([[{ role: "user", content: "go" }]]);
  });
});

describe("where a second label exists", () => {
  beforeEach(() => {
    mocks.known = true;
  });

  it("tells a run at a label what it reads and writes, once, at the head of its first message", async () => {
    mocks.reads.mockResolvedValue(["internal", "public"]);
    // A Steward records judgments, so its note says how a judgment at each
    // label works for the one it writes; any other role's says how to read one.
    const note = labelNote("internal", ["internal", "public"], { writesJudgments: true });
    expect(note).toContain("## A judgment at each label");
    const sent = capture(mocks.completeWithTools, toolTurn, finalTurn);
    let transcript: MessageParam[] = [];
    await runAtLabel("internal", "a test", () =>
      withAgent("steward", () =>
        toolUseLoop({
          initialMessages: [{ role: "user", content: "go" }],
          tools,
          system: "the constitution",
          executeTool: async () => "search-output",
          onEnd: (t) => {
            transcript = t;
          },
        })
      )
    );
    const briefed = `${note}${FEATURES_OFF_NOTE_SEPARATOR}go`;
    expect(sent[0]).toEqual([{ role: "user", content: briefed }]);
    // The second turn carries it once, in the first message, and nowhere else.
    expect(sent[1]![0]).toEqual({ role: "user", content: briefed });
    expect(JSON.stringify(sent[1]).split("This run's label").length - 1).toBe(1);
    expect(transcript[0]).toEqual({ role: "user", content: briefed });
  });

  it("tells a run nothing gave a label that it works at public", async () => {
    mocks.reads.mockResolvedValue(["public"]);
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent[0]![0]!.content).toBe(`${labelNote("public", ["public"])}${FEATURES_OFF_NOTE_SEPARATOR}go`);
    expect(String(sent[0]![0]!.content)).not.toContain("## A judgment at each label");
  });

  it("says nothing to a call outside any agent run", async () => {
    mocks.reads.mockResolvedValue(["internal", "public"]);
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await runWithUsageContext({ label: "internal" }, () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent).toEqual([[{ role: "user", content: "go" }]]);
  });

  it("does not start a run it cannot brief: a failure to work out what the run reads fails the call", async () => {
    mocks.reads.mockRejectedValue(new Error("the database is away"));
    capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await expect(
      withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }))
    ).rejects.toThrow("the database is away");
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe("on a deployment that mirrors the public graph", () => {
  it("asks nothing about a mirror where none is held", async () => {
    mocks.known = false;
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("steward", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent).toEqual([[{ role: "user", content: "go" }]]);
    expect(mocks.mirrorAsked).toBe(0);
  });

  it("tells a run what is mirrored inside its label note, once, as things stood when it started", async () => {
    mocks.known = true;
    mocks.reads.mockResolvedValue(["internal", "public"]);
    // A batch is applied between the first turn and the second.
    mocks.mirrorAsOf = ["2026-11-12T17:08:45.113Z", "2026-11-12T18:30:00.000Z"];
    const note = labelNote("internal", ["internal", "public"], {
      writesJudgments: true,
      mirror: { publicGraphAsOf: "2026-11-12T17:08:45.113Z" },
    });
    expect(note).toContain("It shows the public graph as of 2026-11-12 17:08 UTC");
    const sent = capture(mocks.completeWithTools, toolTurn, finalTurn);
    await runAtLabel("internal", "a test", () =>
      withAgent("steward", () =>
        toolUseLoop({
          initialMessages: [{ role: "user", content: "go" }],
          tools,
          system: "the constitution",
          executeTool: async () => "search-output",
        })
      )
    );
    const briefed = `${note}${FEATURES_OFF_NOTE_SEPARATOR}go`;
    expect(sent[0]).toEqual([{ role: "user", content: briefed }]);
    expect(sent[1]![0]).toEqual({ role: "user", content: briefed });
    expect(JSON.stringify(sent[1]).split("read through a mirror").length - 1).toBe(1);
  });

  it("gives a deployment whose only label is public the passage on its own", async () => {
    mocks.known = false;
    mocks.mirrorAsOf = ["2026-11-12T17:08:45.113Z"];
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent[0]![0]!.content).toBe(
      `${mirrorNote({ publicGraphAsOf: "2026-11-12T17:08:45.113Z" })}${FEATURES_OFF_NOTE_SEPARATOR}go`
    );
  });

  it("says nothing of a mirror that has applied no batch yet", async () => {
    mocks.known = false;
    mocks.mirrorAsOf = [""];
    const sent = capture(mocks.complete, { content: "hello", model: "m", usage, stopReason: "end_turn" });
    await withAgent("matcher", () => complete({ messages: [{ role: "user", content: "go" }], model: "m" }));
    expect(sent).toEqual([[{ role: "user", content: "go" }]]);
  });
});
