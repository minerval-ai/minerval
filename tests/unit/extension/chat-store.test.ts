import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  askInTab,
  chatKey,
  clearTabChat,
  readTabChat,
  settleInterruptedChats,
  watchTabChat,
  writeTabChat,
  type TabChat,
} from "../../../extension/lib/chat-store";
import type { ChatResponse } from "../../../extension/lib/types";

/**
 * A tab's chat lives in session storage and the background worker writes
 * each answer into it, so the conversation and an answer still being
 * written both survive the popup closing.
 */

type Listener = (changes: Record<string, { newValue?: unknown }>) => void;

function fakeSessionStorage() {
  let data: Record<string, unknown> = {};
  const listeners = new Set<Listener>();
  const notify = (changes: Record<string, { newValue?: unknown }>) =>
    listeners.forEach((l) => l(changes));
  return {
    get: async (key: string | null) =>
      key === null ? structuredClone(data) : key in data ? { [key]: structuredClone(data[key]) } : {},
    set: async (items: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(items) };
      notify(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])));
    },
    remove: async (key: string) => {
      delete data[key];
      notify({ [key]: {} });
    },
    onChanged: {
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
    },
  };
}

const PAGE = "https://example.com/article";
const context = { url: PAGE, title: "Article", claims: [] };

beforeEach(() => {
  vi.stubGlobal("chrome", { storage: { session: fakeSessionStorage() } });
});

describe("extension tab chat", () => {
  it("keeps the question and the finished answer in the tab's stored chat", async () => {
    const chat = vi.fn(async (_input, onText: (d: string, t: number) => void) => {
      onText("It is ", 0);
      onText("true.", 0);
      return { reply: "It is true. [claim:x]", citations: [] } as ChatResponse;
    });

    const { answer } = await askInTab({ tabId: 7, page: PAGE, question: "Is it true?", context }, chat);
    // The question is stored before the answer arrives, marked in flight.
    const asked = await readTabChat(7, PAGE);
    expect(asked.messages).toEqual([{ role: "user", content: "Is it true?" }]);
    expect(asked.pending).not.toBeNull();

    await answer;
    const done = await readTabChat(7, PAGE);
    expect(done.pending).toBeNull();
    expect(done.messages).toEqual([
      { role: "user", content: "Is it true?" },
      { role: "assistant", content: "It is true. [claim:x]", citations: [] },
    ]);
    expect(chat.mock.calls[0]![0].messages).toEqual([{ role: "user", content: "Is it true?" }]);
  });

  it("continues the same Assistant conversation, and keeps what the reply carried", async () => {
    const first = vi.fn(async (_input, _onText, onConversation: (id: string) => void) => {
      onConversation("c1");
      return {
        reply: "ok",
        citations: [],
        conversation_id: "c1",
        cost_micro_usd: 50_000,
        waiting: 1,
        pages: ["p1"],
      } as ChatResponse;
    });
    await (await askInTab({ tabId: 3, page: PAGE, question: "one", context }, first)).answer;
    expect(first.mock.calls[0]![0].conversationId).toBeNull();
    const stored = await readTabChat(3, PAGE);
    expect(stored.conversationId).toBe("c1");
    expect(stored.messages[1]).toEqual({
      role: "assistant",
      content: "ok",
      citations: [],
      cost: 50_000,
      waiting: 1,
      pages: ["p1"],
    });

    const second = vi.fn(async () => ({ reply: "again", citations: [], conversation_id: "c1" }) as ChatResponse);
    await (await askInTab({ tabId: 3, page: PAGE, question: "two", context }, second)).answer;
    expect(second.mock.calls[0]![0].conversationId).toBe("c1");

    // "New" drops the tab's record, so the next question opens another.
    await clearTabChat(3);
    const third = vi.fn(async () => ({ reply: "fresh", citations: [] }) as ChatResponse);
    await (await askInTab({ tabId: 3, page: PAGE, question: "three", context }, third)).answer;
    expect(third.mock.calls[0]![0].conversationId).toBeNull();
  });

  it("sends the earlier turns with the next question", async () => {
    const reply = async () => ({ reply: "ok", citations: [] });
    await (await askInTab({ tabId: 1, page: PAGE, question: "one", context }, reply)).answer;
    const chat = vi.fn(reply);
    await (await askInTab({ tabId: 1, page: PAGE, question: "two", context }, chat)).answer;
    expect(chat.mock.calls[0]![0].messages.map((m: { content: string }) => m.content)).toEqual([
      "one",
      "ok",
      "two",
    ]);
  });

  it("shows the answer's text as it forms, starting over on a new model turn", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (r: ChatResponse) => void;
      let onText!: (d: string, t: number) => void;
      const chat = (_input: unknown, cb: (d: string, t: number) => void) => {
        onText = cb;
        return new Promise<ChatResponse>((resolve) => (finish = resolve));
      };
      const { answer } = await askInTab({ tabId: 2, page: PAGE, question: "q", context }, chat);

      onText("Looking", 0);
      onText(" it up.", 0);
      await vi.advanceTimersByTimeAsync(200);
      expect((await readTabChat(2, PAGE)).pending).toEqual({ text: "Looking it up.", turn: 0 });

      onText("It is", 1);
      await vi.advanceTimersByTimeAsync(200);
      expect((await readTabChat(2, PAGE)).pending).toEqual({ text: "It is", turn: 1 });

      finish({ reply: "It is so.", citations: [] });
      await answer;
      expect((await readTabChat(2, PAGE)).pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores a failed answer's error and lets the next question through", async () => {
    const failing = async () => {
      throw new Error("Out of owls");
    };
    await (await askInTab({ tabId: 3, page: PAGE, question: "q", context }, failing)).answer;
    const failed = await readTabChat(3, PAGE);
    expect(failed.error).toBe("Out of owls");
    expect(failed.pending).toBeNull();

    await (await askInTab({ tabId: 3, page: PAGE, question: "again", context }, async () => ({
      reply: "ok",
      citations: [],
    }))).answer;
    expect((await readTabChat(3, PAGE)).error).toBeNull();
  });

  it("turns down a second question while an answer is being written", async () => {
    const never = () => new Promise<ChatResponse>(() => {});
    await askInTab({ tabId: 4, page: PAGE, question: "q", context }, never);
    await expect(
      askInTab({ tabId: 4, page: PAGE, question: "q2", context }, never)
    ).rejects.toThrow(/already being written/);
  });

  it("starts over on another page, and keeps the first page's chat until replaced", async () => {
    const reply = async () => ({ reply: "ok", citations: [] });
    await (await askInTab({ tabId: 5, page: PAGE, question: "q", context }, reply)).answer;
    expect((await readTabChat(5, "https://example.com/other")).messages).toEqual([]);
    // Coming back to the page (say, with Back) finds its chat still there.
    expect((await readTabChat(5, PAGE)).messages).toHaveLength(2);
  });

  it("drops an answer whose chat was cleared while it was being written", async () => {
    let finish!: (r: ChatResponse) => void;
    const { answer } = await askInTab(
      { tabId: 6, page: PAGE, question: "q", context },
      () => new Promise<ChatResponse>((resolve) => (finish = resolve))
    );
    await clearTabChat(6);
    finish({ reply: "late", citations: [] });
    await answer;
    expect((await chrome.storage.session.get(chatKey(6)))[chatKey(6)]).toBeUndefined();
  });

  it("marks answers a stopped worker left in flight as interrupted", async () => {
    const stuck: TabChat = {
      page: PAGE,
      messages: [{ role: "user", content: "q" }],
      pending: { text: "half", turn: 0 },
      error: null,
    };
    await writeTabChat(8, stuck);
    await settleInterruptedChats();
    const settled = await readTabChat(8, PAGE);
    expect(settled.pending).toBeNull();
    expect(settled.error).toMatch(/interrupted/);
    expect(settled.messages).toEqual(stuck.messages);
  });

  it("tells a watcher when the tab's chat changes", async () => {
    const seen: Array<TabChat | undefined> = [];
    const unwatch = watchTabChat(9, (c) => seen.push(c));
    await writeTabChat(10, { page: PAGE, messages: [], pending: null, error: null });
    await clearTabChat(9);
    unwatch();
    await clearTabChat(9);
    expect(seen).toEqual([undefined]);
  });
});
