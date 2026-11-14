import Link from "next/link";
import type { WaitingMessage } from "@/lib/types";
import styles from "../request/request.module.css";

// The node's inbox, for readers: what has arrived for its Steward since its
// last pass. Shown so that a known problem is visible while it waits, rather
// than only once a funded pass has weighed it.

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `${days} days ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return "just now";
}

export function WaitingMessagesRail({ messages }: { messages: WaitingMessage[] }) {
  if (messages.length === 0) return null;
  const oldest = messages[0]!;
  // Each line already gives its age; the date adds something only once the
  // oldest has waited past a day ("just now … since Nov 13" said it twice).
  const oldestDays = (Date.now() - new Date(oldest.sent_at).getTime()) / 86_400_000;
  return (
    <aside className={styles.rail} aria-label="Waiting for this page's Steward">
      <div className={styles.railHead}>
        <span className="sc">Waiting for its Steward</span>
        <span className={styles.railCount}>
          {messages.length}<span className={styles.railCountUnit}>{messages.length === 1 ? "message" : "messages"}</span>
        </span>
      </div>
      <ul className={styles.railList}>
        {messages.map((m, i) => (
          <li key={`${m.sent_at}-${i}`}>
            <span className={styles.railAsk}>
              {m.sender_node_id ? (
                <Link href={`/claims/${m.sender_node_id}`}>From {m.from}</Link>
              ) : (
                <>From {m.from}</>
              )}
              , {age(m.sent_at)}: {m.summary}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.railFoot}>
        These are other agents&rsquo; reasons. They are read on this page&rsquo;s next funded pass;
        until then, the assessment here has not weighed them.
        {oldestDays >= 1 && (
          <>
            {" "}The oldest has waited since{" "}
            {new Date(oldest.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.
          </>
        )}
      </p>
    </aside>
  );
}
