import { normalizePageUrl } from "./page-url";
import type {
  BackgroundRequest,
  ChatCitation,
  ChatPageContext,
  ChatResponse,
  ChatTurn,
} from "./types";

/**
 * Each tab's chat, kept so it survives the popup closing. A toolbar popup is
 * torn down whenever it loses focus, so the conversation can't live in the
 * popup: it lives in chrome.storage.session, keyed by tab, and the background
 * worker owns each answer from question to finished reply. The popup only
 * reads this record and asks the worker to send the next question.
 *
 * storage.session is held in memory (never written to disk), is cleared when
 * the browser quits, and by default is readable only by the extension's own
 * pages and worker, not by content scripts. A tab's chat belongs to the page
 * it was started on: when the tab moves to another page the chat starts over,
 * and closing the tab drops it.
 */

export interface ChatMessage extends ChatTurn {
  citations?: ChatCitation[];
}

export interface TabChat {
  /** The page this chat is about (normalized, so tracking params don't split it). */
  page: string;
  messages: ChatMessage[];
  /** The answer being written, or null when none is in flight. */
  pending: { text: string; turn: number } | null;
  error: string | null;
}

const PREFIX = "chat:";

export function chatKey(tabId: number): string {
  return `${PREFIX}${tabId}`;
}

/** The identity a chat is kept under: the normalized URL, or the raw one. */
export function chatPage(url: string): string {
  return normalizePageUrl(url) ?? url;
}

export function emptyChat(page: string): TabChat {
  return { page, messages: [], pending: null, error: null };
}

/** The tab's chat for this page; a chat left from another page reads as empty. */
export async function readTabChat(tabId: number, page: string): Promise<TabChat> {
  const key = chatKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key] as TabChat | undefined;
  return stored && stored.page === page ? stored : emptyChat(page);
}

export async function writeTabChat(tabId: number, chat: TabChat): Promise<void> {
  await chrome.storage.session.set({ [chatKey(tabId)]: chat });
}

export async function clearTabChat(tabId: number): Promise<void> {
  await chrome.storage.session.remove(chatKey(tabId));
}

/** Call `onChange` whenever the tab's stored chat changes. Returns an unsubscribe. */
export function watchTabChat(tabId: number, onChange: (chat: TabChat | undefined) => void): () => void {
  const key = chatKey(tabId);
  const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (key in changes) onChange(changes[key]!.newValue as TabChat | undefined);
  };
  chrome.storage.session.onChanged.addListener(listener);
  return () => chrome.storage.session.onChanged.removeListener(listener);
}

/**
 * A stored answer marked in flight that no running worker is writing: the
 * worker that was writing it stopped. Marks each one interrupted so the
 * popup doesn't wait on it forever. Run when a worker starts, since a fresh
 * worker is running no answers.
 */
export async function settleInterruptedChats(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const settled: Record<string, TabChat> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PREFIX)) continue;
    const chat = value as TabChat;
    if (!chat.pending) continue;
    settled[key] = {
      ...chat,
      pending: null,
      error: "The answer was interrupted before it finished. Please ask again.",
    };
  }
  if (Object.keys(settled).length) await chrome.storage.session.set(settled);
}

export interface AskInput {
  tabId: number;
  page: string;
  question: string;
  context: ChatPageContext;
}

type ChatFn = (
  input: Extract<BackgroundRequest, { type: "chat" }>,
  onText: (delta: string, turn: number) => void
) => Promise<ChatResponse>;

// How often a streaming answer's text is written to storage, so a popup
// reopened mid-answer shows it forming without a write per token.
const PENDING_WRITE_MS = 150;

/**
 * Ask the next question in a tab's chat. Resolves once the question is
 * stored (rejecting if an answer is already being written) to `answer`, a
 * promise that writes the answer into the stored chat as it forms, then the
 * finished reply or the error, and never rejects. Runs in the background
 * worker, so closing the popup doesn't lose the answer. The answer stays
 * with the page it was asked about: it is dropped only if the tab's chat was
 * cleared, or replaced by one about another page, in the meantime.
 */
export async function askInTab(
  input: AskInput,
  chat: ChatFn
): Promise<{ answer: Promise<void> }> {
  const current = await readTabChat(input.tabId, input.page);
  if (current.pending) throw new Error("An answer is already being written for this page.");

  const messages: ChatMessage[] = [...current.messages, { role: "user", content: input.question }];
  let state: TabChat = { page: input.page, messages, pending: { text: "", turn: -1 }, error: null };
  await writeTabChat(input.tabId, state);

  // Write only if the tab's chat is still this one (not moved to another
  // page or cleared since the question was asked).
  const update = async (next: TabChat) => {
    const key = chatKey(input.tabId);
    const stored = (await chrome.storage.session.get(key))[key] as TabChat | undefined;
    if (!stored || stored.page !== input.page) return;
    state = next;
    await writeTabChat(input.tabId, next);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const flushPending = () => {
    timer = null;
    const snapshot = state;
    // A failed write of the partial text is not worth failing the answer.
    writing = writing.then(() => update(snapshot)).catch(() => {});
  };

  const answer = (async () => {
    try {
      const reply = await chat(
        {
          type: "chat",
          messages: messages.map(({ role, content }) => ({ role, content })),
          page: input.context,
        },
        (delta, turn) => {
          const prev = state.pending;
          // A new model turn (after the agent looks something up) starts over.
          const text = !prev || prev.turn !== turn ? delta : prev.text + delta;
          state = { ...state, pending: { text, turn } };
          timer ??= setTimeout(flushPending, PENDING_WRITE_MS);
        }
      );
      if (timer) clearTimeout(timer);
      await writing;
      await update({
        ...state,
        messages: [
          ...messages,
          { role: "assistant", content: reply.reply, citations: reply.citations },
        ],
        pending: null,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      await writing;
      await update({
        ...state,
        pending: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })().catch(() => {
    // Storage itself failed: nothing is left to tell, and nowhere to tell it.
  });
  return { answer };
}
