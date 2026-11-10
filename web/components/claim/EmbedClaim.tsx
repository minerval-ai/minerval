"use client";

import { useState } from "react";
import { SITE_ORIGIN, badgeMarkdown, iframeSnippet, scriptSnippet } from "@/lib/embed";

// "Embed this claim": the three ways to show a claim, with the graph's
// judgment of it, on another site. Each is a snippet to paste: the script
// embed (a quotation that becomes the card and sizes itself), the bare
// iframe (for tools that take no script), and the badge (an image, for a
// README). All three are served from the claim's card, so what they show is
// the status with its confidence, dispute beside it, and an "as of" date.
// Sits with "Cite this claim": both carry the claim out of the graph.

export function EmbedClaim({ claimId, text, kind }: { claimId: string; text: string; kind?: string }) {
  // Snippets name the site the reader is on, so a preview deployment hands
  // out snippets that work against itself; minerval.ai until the panel opens.
  const [origin, setOrigin] = useState(SITE_ORIGIN);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1800);
    } catch {
      // Clipboard unavailable (permissions, non-secure context): the snippet
      // is on screen to select by hand.
    }
  }

  const snippets = [
    {
      key: "script",
      label: "Card",
      note: "Fits its column and sizes itself. Without the script it stays a quotation with its link.",
      code: scriptSnippet(origin, claimId, text),
    },
    {
      key: "iframe",
      label: "Iframe",
      note: "Where scripts are not allowed. A fixed height; add ?theme=light or ?theme=dark to fix its colours.",
      code: iframeSnippet(origin, claimId, text, { kind }).html,
    },
    {
      key: "badge",
      label: "Badge",
      note: "An image for a README or a forum post, in Markdown.",
      code: badgeMarkdown(origin, claimId),
    },
  ];

  const buttonStyle: React.CSSProperties = {
    fontFamily: "var(--sans)",
    fontSize: ".74rem",
    padding: ".25rem .6rem",
    background: "none",
    border: "1px solid var(--rule)",
    borderRadius: "3px",
    color: "var(--ink-soft)",
    cursor: "pointer",
  };

  return (
    <details className="reasoning-detail" onToggle={(e) => {
      if ((e.target as HTMLDetailsElement).open) setOrigin(window.location.origin);
    }}>
      <summary>Embed this claim: show it on another site with its current assessment</summary>
      <div style={{ marginTop: ".7rem" }}>
        <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)", margin: "0 0 .8rem" }}>
          An embed reports the graph&apos;s judgment as it stands when the page is
          viewed: the status with its confidence, how disputed the claim is, and
          the date. It links back here.
        </p>
        {snippets.map((s) => (
          <div key={s.key} style={{ margin: "0 0 .9rem" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: ".6rem", flexWrap: "wrap", marginBottom: ".3rem" }}>
              <span className="sc">{s.label}</span>
              <span style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--muted)", flex: "1 1 12rem" }}>
                {s.note}
              </span>
              <button type="button" style={buttonStyle} onClick={() => copy(s.key, s.code)}>
                {copied === s.key ? "copied ✓" : "copy"}
              </button>
            </div>
            <pre
              style={{
                fontFamily: "var(--mono)",
                fontSize: ".7rem",
                lineHeight: 1.5,
                margin: 0,
                padding: ".55rem .7rem",
                background: "var(--paper-sunk)",
                border: "1px solid var(--rule-soft)",
                borderRadius: "3px",
                color: "var(--ink-soft)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: "8.5rem",
                overflow: "auto",
                userSelect: "all",
              }}
            >
              {s.code}
            </pre>
          </div>
        ))}
        {/* The badge as it currently reads, so the reader sees what they are pasting. */}
        <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)", margin: 0 }}>
          The badge now:{" "}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/embed/claims/${encodeURIComponent(claimId)}/badge.svg`}
            alt="Minerval's judgment of this claim"
            height={20}
            loading="lazy"
            style={{ verticalAlign: "middle" }}
          />
        </p>
      </div>
    </details>
  );
}
