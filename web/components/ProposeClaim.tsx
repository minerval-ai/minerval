"use client";

import { useEffect, useRef, useState } from "react";
import { useViewerSession } from "./useViewerSession";

// The claims-index contribution entry (#174): the "I know something the graph
// is missing" path. Challenges and evidence about an existing claim belong on
// that claim's page; what starts here is something the graph does not hold
// yet. The proposer does not choose its kind: the Matcher decides whether it
// enters as a claim, a question or a quantity (§2, §7a). Saying why it
// belongs is optional.
// The proposal is intake (#157): it goes to review, and only acceptance
// materializes anything.
//
// Deep link: ?propose=<text> prefills and opens the form (used by the browser
// extension when a highlighted statement matches nothing in the graph).
// Otherwise the form starts from the reader's search, if there is one, so a
// search that found nothing, or nothing quite right, is one click from
// proposing it.

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; contributionId: string | null }
  | { kind: "error"; message: string };

export function ProposeClaim({ searchQuery }: { searchQuery?: string }) {
  const [open, setOpen] = useState(false);
  const session = useViewerSession();
  const [prefill, setPrefill] = useState("");
  const [status, setStatus] = useState<SubmitState>({ kind: "idle" });
  // Where the sent proposal stands, polled so that once review accepts it the
  // contributor gets a link to the node it became, not a void.
  const [outcome, setOutcome] = useState<{
    reviewStatus: string;
    becameClaimId: string | null;
  } | null>(null);

  const sentId = status.kind === "sent" ? status.contributionId : null;
  useEffect(() => {
    if (!sentId) return;
    let stopped = false;
    let tries = 0;
    // Review usually lands within a few minutes; after ~10 the record page
    // and the account page carry the outcome instead.
    const MAX_TRIES = 120;
    async function poll() {
      if (stopped) return;
      tries += 1;
      try {
        const res = await fetch(`/api/contributions/${sentId}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as {
            review_status?: string;
            became_claim_id?: string | null;
          };
          if (!stopped && body.review_status) {
            setOutcome({
              reviewStatus: body.review_status,
              becameClaimId: body.became_claim_id ?? null,
            });
            if (body.became_claim_id || body.review_status !== "pending") return;
          }
        }
      } catch {
        // Transient: try again on the next tick.
      }
      if (!stopped && tries < MAX_TRIES) setTimeout(poll, 5000);
    }
    const first = setTimeout(poll, 3000);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [sentId]);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const proposed = params.get("propose");
    if (proposed !== null || window.location.hash === "#propose") {
      setOpen(true);
      if (proposed) setPrefill(proposed.trim());
      setTimeout(
        () => sectionRef.current?.scrollIntoView({ block: "start" }),
        50,
      );
    }
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/claims/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim: data.get("claim"),
          argument: data.get("argument"),
        }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          contribution?: { id?: string };
        } | null;
        setStatus({
          kind: "sent",
          contributionId: body?.contribution?.id ?? null,
        });
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setStatus({
          kind: "error",
          message: body?.error ?? "The proposal could not be submitted.",
        });
      }
    } catch {
      setStatus({
        kind: "error",
        message: "The proposal could not be submitted. Please try again later.",
      });
    }
  }

  const initialText = prefill || searchQuery?.trim() || "";
  // Signing in comes back to the form with the text still in it.
  const callback =
    typeof window === "undefined"
      ? "/claims"
      : `${window.location.pathname}?propose=${encodeURIComponent(initialText)}`;

  return (
    <section id="propose" ref={sectionRef} style={{ marginTop: "2.6rem" }}>
      <h2>Contribute</h2>
      <p className="contribute-lede">
        If a claim here is wrong, or missing evidence, open it: every claim page
        carries its own entry for challenges, evidence, and corrections. If the
        graph is missing a claim or a question entirely, propose it below. A
        proposal is reviewed on its merits; accepted proposals are matched
        against the graph and enter it with their reasoning on record.
      </p>

      {!open && (
        <button className="contribute-open" onClick={() => setOpen(true)}>
          {initialText
            ? `Propose “${initialText.length > 80 ? `${initialText.slice(0, 80)}…` : initialText}” `
            : "Propose a claim or question"}
        </button>
      )}

      {open && session.kind === "signed-out" && (
        <div className="contribute-box">
          <p style={{ margin: 0 }}>
            Contributing requires an account, so that every proposal is signed,
            answerable, and appealable. Reading never does.
          </p>
          <p style={{ margin: ".6rem 0 0" }}>
            <a
              className="signin-button"
              style={{ display: "inline-block", textDecoration: "none" }}
              href={`/signin?callbackUrl=${encodeURIComponent(callback)}`}
            >
              Sign in to contribute
            </a>
          </p>
        </div>
      )}

      {open && session.kind === "loading" && (
        <div className="contribute-box">
          <p style={{ margin: 0, color: "var(--muted)" }}>…</p>
        </div>
      )}

      {open && session.kind === "signed-in" && status.kind === "sent" && (
        <div className="contribute-box">
          {outcome?.becameClaimId ? (
            <p style={{ margin: 0 }}>
              <strong>Accepted.</strong> It is in the graph:{" "}
              <a href={`/claims/${outcome.becameClaimId}`}>open its page</a>.
              Its assessment may still be under way. The review is on{" "}
              <a href={`/contributions/${status.contributionId}`}>
                its public record
              </a>
              .
            </p>
          ) : outcome && outcome.reviewStatus !== "pending" ? (
            <p style={{ margin: 0 }}>
              <strong>Reviewed</strong> (
              {outcome.reviewStatus.replace(/_/g, " ")}). The decision and its
              reasoning are on{" "}
              <a href={`/contributions/${status.contributionId}`}>
                its public record
              </a>
              .
            </p>
          ) : (
          <p style={{ margin: 0 }}>
            <strong>Received.</strong> The proposal is awaiting review. If it
            is accepted, it is matched against the graph and enters it, and a
            link to its page appears here.{" "}
            {status.contributionId ? (
              <>
                The decision and its reasoning will appear on{" "}
                <a href={`/contributions/${status.contributionId}`}>
                  its public record
                </a>
                , and the outcome is tracked in{" "}
                <a href="/account">your account</a>.
              </>
            ) : (
              <>
                The outcome is tracked in <a href="/account">your account</a>.
              </>
            )}
          </p>
          )}
        </div>
      )}

      {open && session.kind === "signed-in" && status.kind !== "sent" && (
        <form className="contribute-box" onSubmit={onSubmit}>

          <label className="contribute-label" htmlFor="propose-claim">
            What the graph is missing
          </label>
          <input
            className="contribute-field"
            id="propose-claim"
            name="claim"
            maxLength={500}
            placeholder="One neutral sentence: a claim, or a question"
            // Keyed on the text so a new search (a client-side navigation
            // that keeps this component mounted) refills the field.
            key={initialText}
            defaultValue={initialText}
            required
          />
          <p className="contribute-hint">
            The best form is short and frame-free: it presupposes no answer.
            Whether it enters as a claim, a question or a quantity is decided
            when it is matched against the graph.
          </p>

          <label className="contribute-label" htmlFor="propose-argument">
            Your reasoning (optional)
          </label>
          <textarea
            className="contribute-field"
            id="propose-argument"
            name="argument"
            rows={5}
            maxLength={5000}
            placeholder="Evidence or reasoning that bears on it, or why it needs asking, with sources if you have them"
          />

          <div className="contribute-actions">
            <button
              className="signin-button"
              type="submit"
              disabled={status.kind === "sending"}
            >
              {status.kind === "sending" ? "Submitting…" : "Submit for review"}
            </button>
            <span className="contribute-hint" style={{ margin: 0 }}>
              contributing as {session.name ?? "you"}
            </span>
          </div>
          {status.kind === "error" && (
            <p className="contribute-error">{status.message}</p>
          )}
        </form>
      )}
    </section>
  );
}
