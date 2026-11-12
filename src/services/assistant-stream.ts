/**
 * A running Assistant turn, as it happens, for whoever is watching it.
 *
 * The turn's state is saved to the conversation about once a second, which
 * is what every reader can rely on. This is the faster path beside it: the
 * process that runs a turn publishes each piece of text, tool call and note
 * the moment it has it, and a stream opened on the same process forwards
 * them. A stream opened on another process hears nothing here and reads the
 * saved state instead (routes/assistant.ts), so the hub is an optimisation
 * that nothing depends on. Nothing is kept: an event with no listener is
 * dropped.
 */
import { EventEmitter } from "node:events";

export type AssistantStreamEvent =
  /** Text the reply gained. A new `turn` starts the text over. */
  | { type: "text"; turn: number; delta: string }
  | { type: "activity"; tool: string; about: string | null }
  | { type: "note"; note: string }
  /** The turn ended, however it ended: read the conversation. */
  | { type: "done" };

const hub = new EventEmitter();
// One listener per open stream; a conversation watched in several tabs is ordinary.
hub.setMaxListeners(0);
/** What a turn running here has so far, for a watcher who joins part-way. */
export interface AssistantStreamState {
  partial: string;
  /** The model turn the text belongs to; -1 before any text. */
  turn: number;
  note: string | null;
  activity: Array<{ tool: string; about: string | null }>;
}

const ACTIVITY_KEPT = 12;
const live = new Map<string, AssistantStreamState>();

/** Mark a conversation's turn as running in this process, until `end` is called. */
export function openAssistantStream(conversationId: string): { end: () => void } {
  live.set(conversationId, { partial: "", turn: -1, note: null, activity: [] });
  return {
    end: () => {
      live.delete(conversationId);
      hub.emit(conversationId, { type: "done" } satisfies AssistantStreamEvent);
    },
  };
}

/** Whether this process is the one running the conversation's turn. */
export function assistantStreamIsLive(conversationId: string): boolean {
  return live.has(conversationId);
}

/** The turn so far, when this process is running it. */
export function assistantStreamState(conversationId: string): AssistantStreamState | null {
  const state = live.get(conversationId);
  return state ? { ...state, activity: [...state.activity] } : null;
}

export function publishAssistantEvent(conversationId: string, event: AssistantStreamEvent): void {
  const state = live.get(conversationId);
  if (state) {
    if (event.type === "text") {
      state.partial = state.turn === event.turn ? state.partial + event.delta : event.delta;
      state.turn = event.turn;
    } else if (event.type === "note") state.note = event.note;
    else if (event.type === "activity") {
      state.activity.push({ tool: event.tool, about: event.about });
      if (state.activity.length > ACTIVITY_KEPT) state.activity.shift();
    }
  }
  hub.emit(conversationId, event);
}

/** Hear a conversation's events as they are published. Returns an unsubscribe. */
export function subscribeAssistantStream(
  conversationId: string,
  listener: (event: AssistantStreamEvent) => void
): () => void {
  hub.on(conversationId, listener);
  return () => hub.off(conversationId, listener);
}
