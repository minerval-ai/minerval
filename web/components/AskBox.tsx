"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// One line that opens the Assistant with a question already written. It
// sends nothing itself: the Ask page shows what the work costs and who it is
// charged to before the question is sent.
export function AskBox({
  nodeId,
  placeholder = "Ask the Assistant…",
  label = "Ask",
  about,
}: {
  /** What the page is about when it is not a node, added to the question in words. */
  about?: string;
  /** The node whose page this box sits on, which the Assistant is told. */
  nodeId?: string;
  placeholder?: string;
  label?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      className="ask-box"
      onSubmit={(e) => {
        e.preventDefault();
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", about ? `${q.trim()} (about ${about})` : q.trim());
        if (nodeId) params.set("node", nodeId);
        const query = params.toString();
        router.push(query ? `/ask?${query}` : "/ask");
      }}
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={2000}
      />
      <button className="order-button" type="submit">
        {label}
      </button>
    </form>
  );
}
