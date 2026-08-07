"use client";

import { useState } from "react";
import type { ClaimCitationPayload } from "@/lib/types";

// "Cite this claim" (#290): carries the claim's provenance out of the graph
// intact. The panel serves the conventional citation (pinned to the current
// assessment version) with one-click copies of the plain-text, BibTeX, and
// CSL JSON renderings, plus the full evidence record — assessment, arguments
// with their basis subclaims, verbatim quotes, live disagreement — as a JSON
// download. Fetched on first open through the BFF, never with the page.

type PanelState = "idle" | "loading" | "error" | "ready";

export function CiteClaim({ claimId }: { claimId: string }) {
  const [payload, setPayload] = useState<ClaimCitationPayload | null>(null);
  const [state, setState] = useState<PanelState>("idle");
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    if (state === "ready" || state === "loading") return;
    setState("loading");
    try {
      const res = await fetch(`/api/claims/${claimId}/citation`);
      if (!res.ok) throw new Error(String(res.status));
      setPayload((await res.json()) as ClaimCitationPayload);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1800);
    } catch {
      // Clipboard unavailable (permissions, non-secure context) — the text
      // is on screen to select by hand.
    }
  }

  function downloadRecord() {
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `minerval-claim-${claimId.slice(0, 8)}-evidence.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
      if ((e.target as HTMLDetailsElement).open) void load();
    }}>
      <summary>Cite this claim: a formal citation with its evidence attached</summary>
      <div style={{ marginTop: ".7rem" }}>
        {state === "loading" && (
          <p style={{ fontFamily: "var(--sans)", fontSize: ".8rem", color: "var(--muted)" }}>
            Assembling the citation…
          </p>
        )}
        {state === "error" && (
          <p style={{ fontFamily: "var(--sans)", fontSize: ".8rem", color: "var(--muted)" }}>
            The citation could not be assembled; this page may not be connected
            to the live graph.
          </p>
        )}
        {state === "ready" && payload && (
          <>
            <blockquote
              style={{
                fontFamily: "var(--sans)",
                fontSize: ".82rem",
                lineHeight: 1.5,
                margin: "0 0 .6rem",
                padding: ".6rem .8rem",
                borderLeft: "2px solid var(--rule)",
                color: "var(--ink-soft)",
                userSelect: "all",
              }}
            >
              {payload.citation.text}
            </blockquote>
            <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)", margin: "0 0 .6rem" }}>
              The citation pins this claim&apos;s id
              {payload.citation.assessment_version
                ? ` and assessment v${payload.citation.assessment_version}`
                : ""}{" "}
              with a retrieval date, so what you cite stays resolvable even
              after the claim is reassessed or reworded. The evidence record
              carries the why: the assessment and its reasoning, the arguments
              and their subclaims, the verbatim quotes with sources, and any
              live disagreement.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: ".45rem" }}>
              <button type="button" style={buttonStyle} onClick={() => copy("text", payload.citation.text)}>
                {copied === "text" ? "copied ✓" : "copy citation"}
              </button>
              <button type="button" style={buttonStyle} onClick={() => copy("bibtex", payload.citation.bibtex)}>
                {copied === "bibtex" ? "copied ✓" : "copy BibTeX"}
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => copy("csl", JSON.stringify(payload.citation.csl, null, 2))}
              >
                {copied === "csl" ? "copied ✓" : "copy CSL JSON"}
              </button>
              <button type="button" style={buttonStyle} onClick={downloadRecord}>
                download evidence record (JSON)
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
