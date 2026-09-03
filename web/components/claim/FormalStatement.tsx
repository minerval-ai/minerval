"use client";

import { useState } from "react";
import Link from "next/link";
import type { FormalizationSummary } from "@/lib/types";
import { fmtDate, fmtDateLong } from "@/lib/format";

// The formal statement section (docs/mathematics.md §8.3): between the
// assessment and the decomposition, because it is what a proof would be a
// proof of. The Lean text verbatim in a monospace block with a copy control, a
// meta line with the pin, the publication date, and the statement number, the
// correspondence note in the graph's voice, and a quiet link to the history
// where earlier versions and their retirements are recorded. Omitted entirely
// when no statement exists.
export function FormalStatement({
  claimId, formalization,
}: {
  claimId: string;
  formalization: FormalizationSummary | null | undefined;
}) {
  const [copied, setCopied] = useState(false);
  if (!formalization || !formalization.statement_source) return null;
  const f = formalization;
  const inReview =
    f.status === "published" && f.review_period_ends_at
      && new Date(f.review_period_ends_at).getTime() > Date.now();

  async function copy() {
    try {
      await navigator.clipboard.writeText(f.statement_source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable: the text is on screen to select by hand.
    }
  }

  return (
    <section className="formal">
      <h2>Formal statement</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        The claim as a Lean 4 proposition, checked against Mathlib at the pinned
        revision. A proof of this statement is a proof of the claim as far as the
        statement is faithful to the wording above; the note beneath it says how
        the two correspond.
      </p>
      <div className="formal-block">
        <pre className="formal-src" tabIndex={0}><code>{f.statement_source}</code></pre>
        <button type="button" className="formal-copy" onClick={copy} aria-label="Copy the Lean statement">
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <p className="formal-meta">
        <span className="mono">{f.pin_id}</span>
        {f.published_at && <> · published {fmtDate(f.published_at)}</>}
        {" · "}statement {f.version}
        {f.status !== "published" && <> · {f.status}</>}
        {inReview && <> · in public review until {fmtDate(f.review_period_ends_at)}</>}
        {" · "}
        <span className="mono" title={`source hash ${f.source_hash}`}>
          sha256 {f.source_hash.slice(0, 12)}…
        </span>
      </p>
      {f.correspondence && <p className="formal-note">{f.correspondence}</p>}
      {inReview && (
        <p className="formal-note" style={{ color: "var(--muted)" }}>
          This statement is in its public review period until{" "}
          {fmtDateLong(f.review_period_ends_at)}. A person who shows during the
          period that it does not say what the claim says receives the review
          award, and no prize binds to it before the period ends.
        </p>
      )}
      <p className="order-line" style={{ marginTop: ".2rem" }}>
        <Link href={`/claims/${claimId}/history`}>statement history →</Link>
      </p>
    </section>
  );
}
