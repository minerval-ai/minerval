import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The extension's chat is a conversation with the Assistant: a question
 * opens one (with the page it came from) or continues the tab's, and the
 * reply is read from the conversation until its turn is done.
 */

vi.mock("../../../extension/lib/settings", () => ({
  getSettings: async () => ({ apiBaseUrl: "https://api.example", apiKey: "k" }),
  isCustomApiBaseUrl: () => true,
}));

import { chat, stopChat } from "../../../extension/lib/api";

const page = {
  url: "https://example.com/a",
  title: "An article",
  claims: Array.from({ length: 250 }, (_, i) => ({
    verbatim_text: `passage ${i}`,
    verdict: "matched",
    claim_id: null,
    canonical_form: null,
    status: null,
  })),
};
const input = {
  type: "chat" as const,
  messages: [{ role: "user" as const, content: "is this true?" }],
  page,
};

type Turn = { state: string; error?: string | null; partial?: string | null; note?: string | null };
function convo(turn: Turn, messages: unknown[] = [], held: unknown[] = []) {
  return {
    conversation: {
      id: "c1",
      messages,
      held_actions: held,
      turn: { error: null, partial: null, note: null, ...turn },
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers each request in turn; records what was asked. */
function serve(responses: Response[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
      return responses.shift() ?? json(convo({ state: "idle" }));
    })
  );
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function run<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.runAllTimersAsync();
  const out = await settled;
  if ("error" in out) throw out.error;
  return out.value;
}

describe("extension chat with the Assistant", () => {
  it("opens a conversation with the page, shows the reply forming, and returns it", async () => {
    const reply = {
      role: "assistant",
      content: "It is inconclusive [claim:n1].",
      citations: [{ id: "n1", text: "Eggs raise risk", status: "inconclusive", url: "https://minerval.ai/claims/n1" }],
      cost_micro_usd: 120_000,
      cards: [
        { type: "held", id: "h1" },
        { type: "held", id: "h2" },
        { type: "page", id: "p1" },
      ],
    };
    const calls = serve([
      json(convo({ state: "replying" }), 201),
      json(convo({ state: "replying", note: "Reading the decomposition" })),
      json(convo({ state: "replying", partial: "It is" })),
      json(
        convo({ state: "idle" }, [{ role: "user", content: "is this true?" }, reply], [
          { id: "h1", status: "held" },
          { id: "h2", status: "declined" },
        ])
      ),
    ]);
    const seen: string[] = [];
    let started = "";
    const out = await run(chat(input, (text) => seen.push(text), (id) => (started = id)));

    expect(calls[0]).toMatchObject({ url: "https://api.example/assistant/conversations", method: "POST" });
    const sent = calls[0]!.body as { message: string; page: typeof page };
    expect(sent.message).toBe("is this true?");
    expect(sent.page.url).toBe(page.url);
    // The route takes at most 200 findings.
    expect(sent.page.claims).toHaveLength(200);
    expect(calls[1]).toMatchObject({ url: "https://api.example/assistant/conversations/c1", method: "GET" });

    expect(started).toBe("c1");
    expect(seen).toEqual(["Reading the decomposition", "It is"]);
    expect(out).toEqual({
      reply: "It is inconclusive [claim:n1].",
      citations: [
        { id: "n1", canonical_form: "Eggs raise risk", status: "inconclusive", url: "https://minerval.ai/claims/n1" },
      ],
      conversation_id: "c1",
      cost_micro_usd: 120_000,
      // Only the action still waiting counts.
      waiting: 1,
      pages: ["p1"],
    });
  });

  it("continues the tab's conversation without sending the page again", async () => {
    const calls = serve([
      json(convo({ state: "idle" }, [{ role: "assistant", content: "Yes." }])),
    ]);
    const out = await run(chat({ ...input, conversationId: "c1" }));
    expect(calls[0]).toMatchObject({
      url: "https://api.example/assistant/conversations/c1/messages",
      body: { message: "is this true?" },
    });
    expect(out.reply).toBe("Yes.");
  });

  it("says why when the turn failed, and when the balance is empty", async () => {
    serve([json(convo({ state: "replying" }), 201), json(convo({ state: "failed", error: "model unavailable" }))]);
    await expect(run(chat(input))).rejects.toThrow(/could not reply \(model unavailable\)/);

    serve([json({ error: "Your balance is 0.", code: "INSUFFICIENT_OWLS" }, 402)]);
    await expect(run(chat(input))).rejects.toThrow("Your balance is 0.");
  });

  it("keeps reading through a dropped read", async () => {
    serve([
      json(convo({ state: "replying" }), 201),
      json({ error: "bad gateway" }, 502),
      json(convo({ state: "idle" }, [{ role: "assistant", content: "Done.", stopped: "user" }])),
    ]);
    await expect(run(chat(input))).resolves.toMatchObject({ reply: "Done.", stopped: "user" });
  });

  it("asks a running reply to stop", async () => {
    const calls = serve([json({ stopping: true })]);
    await stopChat("c1");
    expect(calls[0]).toMatchObject({
      url: "https://api.example/assistant/conversations/c1/stop",
      method: "POST",
    });
  });
});
