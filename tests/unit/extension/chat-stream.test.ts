import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The extension's chat client reads the answer as an event stream: text as
 * it forms, then the finished reply. Network chunks split events anywhere,
 * so the parser must hold a partial event until its blank line arrives.
 */

vi.mock("../../../extension/lib/settings", () => ({
  getSettings: async () => ({ apiBaseUrl: "https://api.example", apiKey: "k" }),
}));

import { chat } from "../../../extension/lib/api";

const input = {
  type: "chat" as const,
  messages: [{ role: "user" as const, content: "is this true?" }],
  page: { url: null, title: null, claims: [] },
};

function streamOf(chunks: string[], contentType = "text/event-stream"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("extension chat stream", () => {
  it("passes text as it forms and resolves to the finished reply", async () => {
    const fetchMock = vi.fn(async () =>
      streamOf([
        'event: text\ndata: {"delta":"Look',
        'ing it up.","turn":0}\n\nevent: text\ndata: {"delta":"It is ","turn":1}\n',
        '\nevent: text\ndata: {"delta":"true.","turn":1}\n\nevent: done\ndata: {"reply":"It is true.","citations":[]}\n\n',
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const seen: Array<[string, number]> = [];
    const reply = await chat(input, (delta, turn) => seen.push([delta, turn]));

    expect(reply).toEqual({ reply: "It is true.", citations: [] });
    expect(seen).toEqual([
      ["Looking it up.", 0],
      ["It is ", 1],
      ["true.", 1],
    ]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
  });

  it("throws the server's message on an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamOf(['event: text\ndata: {"delta":"Half","turn":0}\n\nevent: error\ndata: {"error":"The answer could not be finished."}\n\n'])
      )
    );
    await expect(chat(input)).rejects.toThrow("The answer could not be finished.");
  });

  it("throws when the stream ends without a finished reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamOf(['event: text\ndata: {"delta":"Half","turn":0}\n\n'])));
    await expect(chat(input)).rejects.toThrow(/stopped before it finished/);
  });

  it("reads a plain JSON answer from an API that does not stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamOf(['{"reply":"At once.","citations":[]}'], "application/json"))
    );
    await expect(chat(input)).resolves.toEqual({ reply: "At once.", citations: [] });
  });
});
