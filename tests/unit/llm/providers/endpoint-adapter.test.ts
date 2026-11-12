/**
 * The adapter for an endpoint a deployment declares itself
 * (src/llm/providers/endpoint.ts), against a fetch that speaks the
 * OpenAI-compatible Chat Completions dialect the way vLLM, llama.cpp's
 * server, TGI and Ollama do: a plain completion, a tool-calling loop run by
 * the real client, structured output, an error from the endpoint, and
 * metering from the endpoint's declared cost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Mock the transport, not the SDK, as the other adapters' tests do. A failed
// connection is not retried here, so the test of one does not wait.
const fetchMock = vi.fn();
const meterLlmUsage = vi.fn();
vi.hoisted(() => {
  process.env.LLM_MAX_RETRIES = "0";
});

const config = vi.hoisted(() => ({
  current: {
    modelEndpoints: [
      {
        name: "local",
        baseUrl: "http://vllm.internal:8000/v1",
        keyEnv: "TEST_LOCAL_LLM_KEY",
        inputUsdPerMtok: 0.5,
        outputUsdPerMtok: 1.5,
      },
      { name: "free", baseUrl: "http://ollama.internal:11434/v1", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    ],
  } as Record<string, unknown>,
}));

vi.mock("../../../../src/config.js", () => ({ loadConfig: () => config.current }));

vi.mock("../../../../src/services/usage-service.js", () => ({
  meterLlmUsage: (...args: unknown[]) => meterLlmUsage(...args),
}));

vi.mock("../../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { complete, completeStructured, toolUseLoop } from "../../../../src/llm/client.js";
import { getAdapter } from "../../../../src/llm/providers/index.js";
import {
  EndpointUnmeteredError,
  resetEndpointClients,
  schemaMismatch,
} from "../../../../src/llm/providers/endpoint.js";
import { isTransientApiError } from "../../../../src/llm/errors.js";

const MODEL = "endpoint:local/meta-llama/Llama-3.3-70B-Instruct";
const WIRE_MODEL = "meta-llama/Llama-3.3-70B-Instruct";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function sentHeaders(call = 0): Record<string, string> {
  const headers = (fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers;
  return headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: WIRE_MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...overrides,
  };
}

const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];

const schema = {
  type: "object",
  properties: { verdict: { type: "string" }, confidence: { type: ["number", "null"] } },
  required: ["verdict", "confidence"],
  additionalProperties: false,
};

const lookup = {
  name: "lookup",
  description: "Look a thing up.",
  input_schema: { type: "object" as const, properties: { q: { type: "string" } }, required: ["q"] },
};

beforeEach(() => {
  resetEndpointClients();
  meterLlmUsage.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json(completion()));
  vi.stubGlobal("fetch", fetchMock);
  process.env.TEST_LOCAL_LLM_KEY = "local-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TEST_LOCAL_LLM_KEY;
});

describe("a plain completion", () => {
  it("goes to the endpoint's own address, with its key and the model as the endpoint knows it", async () => {
    const result = await complete({ messages, model: MODEL, system: "Be brief.", maxTokens: 64 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://vllm.internal:8000/v1/chat/completions");
    expect(sentHeaders().authorization).toBe("Bearer local-key");
    const body = sentBody();
    expect(body.model).toBe(WIRE_MODEL);
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([
      { role: "system", content: expect.stringContaining("Be brief.") },
      { role: "user", content: "hi" },
    ]);
    // Nothing of another provider's dialect: no sampling parameter nobody
    // asked for, none of OpenRouter's routing fields, no tools.
    for (const key of ["temperature", "usage", "provider", "tools", "tool_choice", "response_format"]) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(result).toMatchObject({ content: "hello", model: MODEL, stopReason: "end_turn" });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("is served by an adapter named for the endpoint", () => {
    expect(getAdapter(MODEL).name).toBe("endpoint:local");
    expect(getAdapter("endpoint:free/llama3.3:70b").name).toBe("endpoint:free");
  });

  it("sends a temperature only when the caller asks for one", async () => {
    await complete({ messages, model: MODEL, temperature: 0.2 });
    expect(sentBody().temperature).toBe(0.2);
  });

  it("needs no key where the endpoint declares none", async () => {
    await complete({ messages, model: "endpoint:free/llama3.3:70b" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://ollama.internal:11434/v1/chat/completions");
    expect(sentBody().model).toBe("llama3.3:70b");
  });
});

describe("metering", () => {
  it("prices the call from the endpoint's declared cost, through the same meter as every provider", async () => {
    await complete({ messages, model: MODEL });
    expect(meterLlmUsage).toHaveBeenCalledTimes(1);
    expect(meterLlmUsage).toHaveBeenCalledWith({
      provider: "endpoint:local",
      // The id the deployment configured, so a usage row says where it was served.
      model: MODEL,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      // 100 tokens at $0.50 and 20 at $1.50 per million, in micro-dollars.
      providerCostMicroUsd: 80,
    });
  });

  it("charges every prompt token at the input rate, cached or not", async () => {
    fetchMock.mockImplementation(async () =>
      json(
        completion({
          usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 900_000 } },
        })
      )
    );
    await complete({ messages, model: MODEL });
    expect(meterLlmUsage.mock.calls[0]![0]).toMatchObject({ inputTokens: 1_000_000, providerCostMicroUsd: 500_000 });
  });

  it("meters a declared cost of nothing as nothing, not at a fallback rate", async () => {
    await complete({ messages, model: "endpoint:free/llama3.3:70b" });
    expect(meterLlmUsage.mock.calls[0]![0]).toMatchObject({
      provider: "endpoint:free",
      inputTokens: 100,
      outputTokens: 20,
      providerCostMicroUsd: 0,
    });
  });

  it("refuses a reply that carries no token usage, and meters nothing", async () => {
    fetchMock.mockImplementation(async () => json(completion({ usage: undefined })));
    const call = complete({ messages, model: MODEL });
    await expect(call).rejects.toBeInstanceOf(EndpointUnmeteredError);
    await expect(call).rejects.toThrow(
      'Endpoint "local" (http://vllm.internal:8000/v1) returned no token usage for model ' +
        `"${MODEL}", so the call could not be priced and its reply was not used. Every call is ` +
        "metered in money, from the tokens the endpoint reports and the rates MODEL_ENDPOINTS " +
        "declares for it. Serve the model from a server that reports usage on each completion " +
        "(vLLM, llama.cpp's server, TGI and Ollama do), or remove whatever strips it."
    );
    expect(meterLlmUsage).not.toHaveBeenCalled();
  });
});

describe("a tool-calling loop", () => {
  it("runs the tool and sends its result back in the dialect", async () => {
    fetchMock
      .mockImplementationOnce(async () =>
        json(
          completion({
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"owls"}' } },
                  ],
                },
              },
            ],
          })
        )
      )
      .mockImplementationOnce(async () => json(completion({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Owls are birds." } }] })));

    const executed: Array<[string, unknown]> = [];
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: "What are owls?" }],
      tools: [lookup],
      model: MODEL,
      executeTool: async (name, input) => {
        executed.push([name, input]);
        return "birds of prey";
      },
    });

    expect(executed).toEqual([["lookup", { q: "owls" }]]);
    expect(result.content).toBe("Owls are birds.");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = sentBody(0);
    expect(first.tool_choice).toBe("auto");
    expect(first.tools).toEqual([
      {
        type: "function",
        function: { name: "lookup", description: "Look a thing up.", parameters: lookup.input_schema },
      },
    ]);

    const second = sentBody(1).messages as Array<Record<string, unknown>>;
    expect(second[0]).toEqual({ role: "user", content: "What are owls?" });
    expect(second[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"owls"}' } }],
    });
    expect(second[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "birds of prey" });
    // Each turn is metered.
    expect(meterLlmUsage).toHaveBeenCalledTimes(2);
  });

  it("takes a tool call the way other servers shape it: no id, arguments as an object, finish reason stop", async () => {
    fetchMock
      .mockImplementationOnce(async () =>
        json(
          completion({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{ type: "function", function: { name: "lookup", arguments: { q: "owls" } } }],
                },
              },
            ],
          })
        )
      )
      .mockImplementationOnce(async () => json(completion()));

    const executed: unknown[] = [];
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools: [lookup],
      model: MODEL,
      executeTool: async (_name, input) => {
        executed.push(input);
        return "ok";
      },
    });

    // The loop did not end on "stop" with the call unrun.
    expect(executed).toEqual([{ q: "owls" }]);
    const second = sentBody(1).messages as Array<Record<string, unknown>>;
    const call = (second[1]!.tool_calls as Array<{ id: string; function: { arguments: string } }>)[0]!;
    expect(call.id).toBe("call_0");
    expect(call.function.arguments).toBe('{"q":"owls"}');
    expect(second[2]).toMatchObject({ role: "tool", tool_call_id: "call_0" });
  });

  it("refuses a server tool by name, since an endpoint runs none", async () => {
    await expect(
      getAdapter(MODEL).completeWithTools({
        messages,
        model: MODEL,
        maxTokens: 64,
        tools: [{ type: "web_search_20260209", name: "web_search" } as Anthropic.Messages.ToolUnion],
      })
    ).rejects.toThrow(/Anthropic server tools \(web_search\) are not supported on the endpoint "local"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("structured output", () => {
  it("asks for the schema as a json_schema response format and returns the parsed reply", async () => {
    fetchMock.mockImplementation(async () =>
      json(completion({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"verdict":"supported","confidence":0.8}' } }] }))
    );
    const result = await completeStructured<{ verdict: string }>({
      messages,
      schema,
      schemaName: "Verdict Shape",
      model: MODEL,
    });
    expect(result).toEqual({ verdict: "supported", confidence: 0.8 });
    const body = sentBody();
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Verdict_Shape", strict: true, schema },
    });
    // Not the forced tool call OpenRouter needs.
    expect(body).not.toHaveProperty("tools");
    expect(meterLlmUsage).toHaveBeenCalledTimes(1);
  });

  it("fails with the endpoint's name when the server answers in prose", async () => {
    fetchMock.mockImplementation(async () =>
      json(completion({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "The verdict is supported." } }] }))
    );
    await expect(completeStructured({ messages, schema, schemaName: "Verdict", model: MODEL })).rejects.toThrow(
      'Endpoint "local" (http://vllm.internal:8000/v1) did not return the structured response ' +
        `"Verdict" from model "${WIRE_MODEL}": the reply is not JSON. The request asked for it with ` +
        "a json_schema response format, which the server has to support and apply for this model."
    );
  });

  it("fails when the reply is JSON of another shape", async () => {
    fetchMock.mockImplementation(async () =>
      json(completion({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"answer":"supported"}' } }] }))
    );
    await expect(completeStructured({ messages, schema, schemaName: "Verdict", model: MODEL })).rejects.toThrow(
      /the reply has no "verdict"\. The request asked for it with a json_schema response format/
    );
  });

  it("says a truncated reply was truncated", async () => {
    fetchMock.mockImplementation(async () =>
      json(completion({ choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: '{"verd' } }] }))
    );
    await expect(
      completeStructured({ messages, schema, schemaName: "Verdict", model: MODEL, maxTokens: 16 })
    ).rejects.toThrow(/was truncated at max_tokens \(16\)/);
  });

  it("checks a reply against the strict subset the seam's schemas use", () => {
    expect(schemaMismatch({ verdict: "x", confidence: null }, schema)).toBeNull();
    expect(schemaMismatch({ verdict: "x", confidence: 1 }, schema)).toBeNull();
    expect(schemaMismatch({ verdict: 3, confidence: null }, schema)).toBe(
      "the reply.verdict is of type integer, where the schema asks for string"
    );
    expect(schemaMismatch([], schema)).toBe("the reply is of type array, where the schema asks for object");
    const list = {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { kind: { enum: ["a", "b"] } }, required: ["kind"] } } },
      required: ["items"],
    };
    expect(schemaMismatch({ items: [{ kind: "a" }, { kind: "b" }] }, list)).toBeNull();
    expect(schemaMismatch({ items: [{ kind: "a" }, { kind: "c" }] }, list)).toBe(
      "the reply.items[1].kind is not one of the values the schema allows"
    );
    const either = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(schemaMismatch(null, either)).toBeNull();
    expect(schemaMismatch(4, either)).toBe("the reply fits none of the schema's alternatives");
  });
});

describe("an error from the endpoint", () => {
  it("is surfaced with the endpoint, its address, the status, the server's words and what was asked of it", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set', type: "BadRequestError" } }, 400)
    );
    const call = toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools: [lookup],
      model: MODEL,
      executeTool: async () => "unused",
    });
    await expect(call).rejects.toThrow(
      'Endpoint "local" (http://vllm.internal:8000/v1) answered 400 for model ' +
        `"${WIRE_MODEL}" (the request carried 1 tool definition): "auto" tool choice requires ` +
        "--enable-auto-tool-choice and --tool-call-parser to be set"
    );
    const err = await call.catch((e: unknown) => e);
    // A request the server will never accept is not retried as a passing fault.
    expect((err as { status?: number }).status).toBe(400);
    expect(isTransientApiError(err)).toBe(false);
    expect(meterLlmUsage).not.toHaveBeenCalled();
  });

  it("keeps a server fault recognisable as one", async () => {
    fetchMock.mockImplementation(async () => json({ error: { message: "CUDA out of memory" } }, 503));
    const err = await complete({ messages, model: MODEL }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('Endpoint "local" (http://vllm.internal:8000/v1) answered 503');
    expect((err as Error).message).toContain("CUDA out of memory");
    expect(isTransientApiError(err)).toBe(true);
  });

  it("says the endpoint could not be reached when nothing answers", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await complete({ messages, model: MODEL }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /^Endpoint "local" \(http:\/\/vllm\.internal:8000\/v1\) could not be reached for model "meta-llama\/Llama-3\.3-70B-Instruct": /
    );
    expect(isTransientApiError(err)).toBe(true);
  });
});

describe("a model id that cannot be served", () => {
  it("names the endpoint nobody declared, and the ones that are", async () => {
    await expect(complete({ messages, model: "endpoint:gpu/qwen3" })).rejects.toThrow(
      'The model ID "endpoint:gpu/qwen3" names the endpoint "gpu", but this deployment declares no ' +
        "endpoint of that name. MODEL_ENDPOINTS declares: local, free."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the environment variable that should hold the key when it is not set", async () => {
    delete process.env.TEST_LOCAL_LLM_KEY;
    await expect(complete({ messages, model: MODEL })).rejects.toThrow(
      'Endpoint "local" reads its key from the environment variable TEST_LOCAL_LLM_KEY, which is not ' +
        'set. Set it, or remove "keyEnv" from the endpoint\'s entry in MODEL_ENDPOINTS if it takes no key.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
