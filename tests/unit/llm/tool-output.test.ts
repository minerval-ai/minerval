import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * A tool that shows the model an image (tool-output.ts, #912): both loops
 * send it as an image block inside the tool_result, the trace keeps its
 * digest and not its bytes, each provider dialect carries it in a form its
 * API reads, and a paused session does not carry it at all.
 */

const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  completeWithToolsStreaming: vi.fn(),
  recordAgentStep: vi.fn(),
  trace: null as unknown,
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () => ({
    name: "anthropic",
    completeWithTools: mocks.completeWithTools,
    completeWithToolsStreaming: mocks.completeWithToolsStreaming,
  }),
}));
vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: mocks.recordAgentStep,
  markRunPrivate: vi.fn(),
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/llm/usage-context.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/llm/usage-context.js")>();
  return { ...real, getUsageContext: () => ({ ...real.getUsageContext(), trace: mocks.trace }) };
});

import { longRunToolLoop, toolUseLoop, type ToolCompletionResult } from "../../../src/llm/client.js";
import { toChatMessages, TOOL_IMAGES_LEAD } from "../../../src/llm/providers/openai-dialect.js";
import { toResponsesInput } from "../../../src/llm/providers/responses-dialect.js";
import { modelImageTokenCap, modelReadsPdfDocuments, modelSeesImages, MODELS, OPENROUTER_MODELS } from "../../../src/llm/models.js";
import { toolOutputForTrace, toolOutputText, toolResultContent, type ToolOutput } from "../../../src/llm/tool-output.js";
import { portableTranscript } from "../../../src/services/session-service.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PDF = Buffer.from("%PDF-1.5\n");
const shown: ToolOutput = {
  text: '{"ok":true,"width":640}',
  attachments: [{ kind: "image", mediaType: "image/png", data: PNG }],
};
const IMAGE_BLOCK = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
};

const usage = { inputTokens: 1, outputTokens: 1 };
function toolTurn(...ids: string[]): ToolCompletionResult {
  return {
    content: "",
    model: MODELS.strong,
    usage,
    stopReason: "tool_use",
    toolUses: ids.map((id) => ({ id, name: id.startsWith("v") ? "view_image" : "search", input: { id } })),
    rawContent: ids.map((id) => ({ type: "tool_use", id, name: "x", input: {} })) as unknown as Anthropic.ContentBlock[],
  };
}
const endTurn: ToolCompletionResult = {
  content: "done",
  model: MODELS.strong,
  usage,
  stopReason: "end_turn",
  toolUses: [],
  rawContent: [{ type: "text", text: "done" }] as unknown as Anthropic.ContentBlock[],
};
const tools = [{ name: "view_image", description: "d", input_schema: { type: "object" as const } }];
const executeTool = async (name: string) => (name === "view_image" ? shown : "plain text");

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function") (m as ReturnType<typeof vi.fn>).mockReset();
  mocks.trace = null;
});

describe("ToolOutput", () => {
  it("leaves a string result exactly as it was", () => {
    expect(toolResultContent("ok")).toBe("ok");
    expect(toolOutputForTrace("ok")).toBe("ok");
    expect(toolOutputText("ok")).toBe("ok");
    expect(toolResultContent({ text: "only text", attachments: [] })).toBe("only text");
  });

  it("becomes a text block followed by what is shown, images and PDFs each in their block", () => {
    expect(toolResultContent({ ...shown, attachments: [...shown.attachments, { kind: "pdf", data: PDF }] })).toEqual([
      { type: "text", text: shown.text },
      IMAGE_BLOCK,
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } },
    ]);
    expect(toolOutputText(shown)).toBe(shown.text);
  });

  it("is recorded in the trace by digest, never by its bytes", () => {
    const line = toolOutputForTrace(shown);
    expect(line).toBe(
      `${shown.text}\n[shown to the model: image/png, 8 bytes, sha256 ${createHash("sha256").update(PNG).digest("hex")}]`
    );
    expect(line).not.toContain(PNG.toString("base64"));
  });
});

describe("the loops pass an image to the model", () => {
  it("toolUseLoop: as an image block in the tool_result, beside a plain result", async () => {
    mocks.trace = { runId: "r" };
    const seen: Anthropic.MessageParam[][] = [];
    mocks.completeWithTools.mockImplementation(async (req: { messages: Anthropic.MessageParam[] }) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      return seen.length === 1 ? toolTurn("v1", "s1") : endTurn;
    });
    await toolUseLoop({ initialMessages: [{ role: "user", content: "go" }], tools, model: MODELS.strong, executeTool, turnCounter: false });

    const results = (seen[1]!.at(-1)!.content as Anthropic.ToolResultBlockParam[]).filter((b) => b.type === "tool_result");
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "v1", content: [{ type: "text", text: shown.text }, IMAGE_BLOCK] },
      { type: "tool_result", tool_use_id: "s1", content: "plain text" },
    ]);

    const step = mocks.recordAgentStep.mock.calls.find((c) => c[1] === "tool_results")![2] as Array<{ name: string; output: string }>;
    expect(step[0]!.output).toMatch(/^\{"ok":true,"width":640\}\n\[shown to the model: image\/png, 8 bytes, sha256 [0-9a-f]{64}\]$/);
    expect(step[1]!.output).toBe("plain text");
    expect(JSON.stringify(step)).not.toContain(PNG.toString("base64"));
  });

  it("longRunToolLoop: the same, on the path the strong-tier Researcher runs", async () => {
    const seen: Anthropic.MessageParam[][] = [];
    mocks.completeWithToolsStreaming.mockImplementation(async (req: { messages: Anthropic.MessageParam[] }) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      return seen.length === 1 ? toolTurn("v1") : endTurn;
    });
    await longRunToolLoop({ initialMessages: [{ role: "user", content: "go" }], tools, model: MODELS.frontier, executeTool });
    expect(seen[1]!.at(-1)!.content).toEqual([
      { type: "tool_result", tool_use_id: "v1", content: [{ type: "text", text: shown.text }, IMAGE_BLOCK] },
    ]);
  });
});

describe("the OpenAI-shaped dialects", () => {
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "v1", name: "view_image", input: { url: "u" } },
        { type: "tool_use", id: "s1", name: "search", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "v1", content: toolResultContent(shown) },
        { type: "tool_result", tool_use_id: "s1", content: "plain text" },
        { type: "text", text: "Turn 1 of 6 used; 5 remain." },
      ],
    },
  ];
  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;

  it("Chat Completions: every call answered first, then the image in a user message, then the text that rode along", () => {
    expect(toChatMessages(history).slice(2)).toEqual([
      { role: "tool", tool_call_id: "v1", content: shown.text },
      { role: "tool", tool_call_id: "s1", content: "plain text" },
      {
        role: "user",
        content: [
          { type: "text", text: TOOL_IMAGES_LEAD },
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: "Turn 1 of 6 used; 5 remain." },
        ],
      },
    ]);
  });

  it("Responses: outputs in place, then the image as input_image", () => {
    expect(toResponsesInput(history).slice(3)).toEqual([
      { type: "function_call_output", call_id: "v1", output: shown.text },
      { type: "function_call_output", call_id: "s1", output: "plain text" },
      {
        role: "user",
        content: [
          { type: "input_text", text: TOOL_IMAGES_LEAD },
          { type: "input_image", image_url: dataUrl, detail: "auto" },
        ],
      },
      { role: "user", content: "Turn 1 of 6 used; 5 remain." },
    ]);
  });

  it("names a PDF document they cannot carry, where the model reads the result", () => {
    const withPdf: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "v1", content: toolResultContent({ text: "t", attachments: [{ kind: "pdf", data: PDF }] }) },
        ],
      },
    ];
    expect(toChatMessages(withPdf)).toEqual([
      { role: "tool", tool_call_id: "v1", content: "t\n[A document attached to a tool result could not be passed to this model.]" },
    ]);
    expect(toResponsesInput(withPdf)).toEqual([
      { type: "function_call_output", call_id: "v1", output: "t\n[A document attached to a tool result could not be passed to this model.]" },
    ]);
  });

  it("leaves a result with no attachment as it always was", () => {
    const plain: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "plain text" }, { type: "text", text: "note" }] },
    ];
    expect(toChatMessages(plain)).toEqual([
      { role: "tool", tool_call_id: "s1", content: "plain text" },
      { role: "user", content: "note" },
    ]);
  });
});

describe("which models are shown what", () => {
  it("every Claude model sees images and reads a PDF document", () => {
    for (const id of [MODELS.frontier, MODELS.strong, MODELS.opus, MODELS.sonnet, MODELS.haiku]) {
      expect(modelSeesImages(id), id).toBe(true);
      expect(modelReadsPdfDocuments(id), id).toBe(true);
    }
  });

  it("elsewhere only the families known to take images, and none is sent a PDF", () => {
    expect(modelSeesImages(OPENROUTER_MODELS.flash)).toBe(true);
    for (const id of ["gpt-5-nano", "gpt-4o", "openai/gpt-5", "google/gemini-3-pro", "anthropic/claude-opus-5-5"]) {
      expect(modelSeesImages(id), id).toBe(true);
      expect(modelReadsPdfDocuments(id), id).toBe(false);
    }
    for (const id of ["z-ai/glm-5.3-prime", "qwen/qwen3-235b-a22b", "gpt-3.5-turbo", "o3-mini", "deepseek/deepseek-v4-flash"]) {
      expect(modelSeesImages(id), id).toBe(false);
    }
  });

  it("knows the visual-token cap of each resolution tier", () => {
    expect(modelImageTokenCap(MODELS.frontier)).toBe(4784);
    expect(modelImageTokenCap(MODELS.sonnet)).toBe(4784);
    expect(modelImageTokenCap(MODELS.haiku)).toBe(1568);
    expect(modelImageTokenCap("claude-sonnet-4-6")).toBe(1568);
    expect(modelImageTokenCap("claude-opus-4-7")).toBe(4784);
  });
});

describe("portableTranscript", () => {
  it("marks where an image was shown and does not carry its bytes into a paused session", () => {
    const out = portableTranscript([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "v1", content: toolResultContent(shown) },
          { type: "tool_result", tool_use_id: "s1", content: "plain text" },
        ],
      },
    ]);
    expect(out[0]!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "v1",
        content: [
          { type: "text", text: shown.text },
          { type: "text", text: "[The image this call showed is not carried into a resumed session. Call the tool again to see it.]" },
        ],
      },
      { type: "tool_result", tool_use_id: "s1", content: "plain text" },
    ]);
    expect(JSON.stringify(out)).not.toContain(PNG.toString("base64"));
  });
});
