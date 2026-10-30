// The Grantmaker replies in the background: sending a message returns the
// conversation at once with turn.state "replying", and the reply lands in
// the transcript when the turn finishes (a drafting turn can take minutes).
// The chats read the conversation until the turn is done, showing the
// reply as it forms (turn.partial).

export interface GrantTurn {
  state: "replying" | "idle" | "failed";
  error: string | null;
  /** The reply so far while the Grantmaker writes it. */
  partial?: string | null;
}

// The server saves the reply-so-far about once a second; reading at this
// pace shows it forming without a request per token.
const POLL_MS = 1_500;

/**
 * Read the conversation until its turn is no longer replying, handing each
 * read to `onUpdate`, and return the last one. A read that fails is retried
 * on the next tick; `isCancelled` ends the wait (the component unmounted).
 */
export async function waitForReply<T extends { id: string; turn?: GrantTurn }>(
  convo: T,
  onUpdate: (convo: T) => void,
  isCancelled: () => boolean = () => false
): Promise<T> {
  let current = convo;
  while (current.turn?.state === "replying" && !isCancelled()) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (isCancelled()) break;
    try {
      const res = await fetch(`/api/grant-conversations/${current.id}`, {
        cache: "no-store",
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { conversation?: T };
      if (data.conversation) {
        current = data.conversation;
        onUpdate(current);
      }
    } catch {
      // a dropped read; the next tick tries again
    }
  }
  return current;
}

/** What to tell the funder when a turn ended without a reply. */
export function failedTurnMessage(turn: GrantTurn | undefined): string | null {
  if (turn?.state !== "failed") return null;
  return (
    `The Grantmaker could not reply${turn.error ? ` (${turn.error})` : ""}. ` +
    `Your message is saved; send a short follow-up to ask again.`
  );
}
