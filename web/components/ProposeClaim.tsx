"use client";

import { useEffect, useRef, useState } from "react";
import { useViewerSession } from "./useViewerSession";

// The claims-index contribution entry (#174): the "I know something the graph
// is missing" path. Challenges and evidence about an existing claim belong on
// that claim's page; what starts here is a claim the graph does not hold yet.
// The proposal is intake (#157): it goes to review, and only acceptance
// materializes anything.
//
// Deep link: ?propose=<text> prefills and opens the form (used by the browser
// extension when a highlighted statement matches nothing in the graph).

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

  const callback =
    typeof window === "undefined" ? "/claims" : `${window.location.pathname}?propose=`;

  return (
    <section id="propose" ref={sectionRef} style={{ marginTop: "2.6rem" }}>
      <h2>Contribute</h2>
      <p className="contribute-lede">
        If a claim here is wrong, or missing evidence, open it: every claim page
        carries its own entry for challenges, evidence, and corrections. If the
        graph is missing a claim entirely, propose it below. A proposal is
        reviewed on its merits; accepted claims are matched against the graph
        and enter it with their reasoning on record.
      </p>

      {!open && (
        <button className="contribute-open" onClick={() => setOpen(true)}>
          Propose a claim
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
          <p style={{ margin: 0 }}>
            <strong>Received.</strong> The proposal is awaiting review. If it
            is accepted, it is matched against existing claims and enters the
            graph.{" "}
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
        </div>
      )}

      {open && session.kind === "signed-in" && status.kind !== "sent" && (
        <form className="contribute-box" onSubmit={onSubmit}>
          <label className="contribute-label" htmlFor="propose-claim">
            The claim
          </label>
          <input
            className="contribute-field"
            id="propose-claim"
            name="claim"
            maxLength={500}
            placeholder="One neutral sentence stating a proposition people dispute with evidence"
            defaultValue={prefill || searchQuery || ""}
            required
          />
          <p className="contribute-hint">
            The best form is short and frame-free: the statement both sides
            would accept as what is in dispute.
          </p>

          <label className="contribute-label" htmlFor="propose-argument">
            Why it belongs in the graph
          </label>
          <textarea
            className="contribute-field"
            id="propose-argument"
            name="argument"
            rows={5}
            maxLength={5000}
            placeholder="The evidence or reasoning that bears on it, with sources if you have them"
            required
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
