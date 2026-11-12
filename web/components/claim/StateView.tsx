"use client";

import { useEffect, useRef, useState } from "react";
import { useViewerSession } from "../useViewerSession";

// Stating a view on a node (constitution §4). Visible to every reader, with
// the act itself behind sign-in, since a statement is published under its
// speaker's name. Submissions go through POST /api/claims/:id/stated-views
// to the Contribution Reviewer; nothing shows on the page until it is
// admitted. #state-view opens the form.

type Kind = "claim" | "quantity" | "question";

const STANCES: Record<Kind, Array<{ value: string; label: string }>> = {
  claim: [
    { value: "affirms", label: "Affirm it" },
    { value: "denies", label: "Deny it" },
    { value: "qualifies", label: "Hold it only with a qualification" },
    { value: "gives_probability", label: "Give it a probability and take no side" },
    { value: "open", label: "Treat it as open" },
  ],
  quantity: [
    { value: "states", label: "State a figure for it" },
    { value: "open", label: "Treat the value as open" },
  ],
  question: [
    { value: "answers", label: "Give an answer" },
    { value: "open", label: "Treat it as open" },
  ],
};

const FIGURE_FORMS = [
  { value: "point", label: "One figure" },
  { value: "interval", label: "A range" },
  { value: "above", label: "Above a figure" },
  { value: "below", label: "Below a figure" },
] as const;

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; contributionId: string | null }
  | { kind: "error"; message: string };

export function StateView({ claimId, kind }: { claimId: string; kind: Kind }) {
  const [open, setOpen] = useState(false);
  const session = useViewerSession();
  const [stance, setStance] = useState(STANCES[kind][0]!.value);
  const [figureForm, setFigureForm] = useState<(typeof FIGURE_FORMS)[number]["value"]>("point");
  const [noStake, setNoStake] = useState(false);
  const [status, setStatus] = useState<SubmitState>({ kind: "idle" });
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.location.hash === "#state-view") {
      setOpen(true);
      setTimeout(() => boxRef.current?.scrollIntoView({ block: "start" }), 50);
    }
  }, []);

  const noun = kind === "quantity" ? "quantity" : kind === "question" ? "question" : "claim";
  const name = session.kind === "signed-in" ? (session.name ?? "this account") : "this account";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const number = (field: string) => {
      const raw = String(data.get(field) ?? "").trim();
      return raw === "" ? undefined : Number(raw);
    };
    let figure: Record<string, unknown> | undefined;
    if (kind === "quantity" && stance === "states") {
      figure =
        figureForm === "point"
          ? { form: "point", central: number("figure_a") }
          : figureForm === "interval"
            ? { form: "interval", low: number("figure_a"), high: number("figure_b") }
            : { form: "bound", bound: { side: figureForm, value: number("figure_a") } };
    }
    setStatus({ kind: "sending" });
    try {
      const res = await fetch(`/api/claims/${claimId}/stated-views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statement: data.get("statement"),
          stance,
          ...(kind === "claim" && number("probability") !== undefined ? { probability: number("probability") } : {}),
          ...(figure ? { figure } : {}),
          reasons: data.get("reasons"),
          evidence_urls: String(data.get("evidence") ?? "")
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean),
          ...(noStake ? { no_stake: true } : { stake: data.get("stake") }),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        contribution?: { id?: string };
        error?: string;
      } | null;
      if (res.ok) {
        setStatus({ kind: "sent", contributionId: body?.contribution?.id ?? null });
      } else {
        setStatus({ kind: "error", message: body?.error ?? "The statement could not be submitted." });
      }
    } catch {
      setStatus({ kind: "error", message: "The statement could not be submitted. Please try again later." });
    }
  }

  const callback =
    typeof window === "undefined" ? `/claims/${claimId}#state-view` : `${window.location.pathname}#state-view`;

  return (
    <div id="state-view" ref={boxRef} style={{ marginTop: "1rem" }}>
      {!open && (
        <button className="contribute-open" onClick={() => setOpen(true)}>
          State your view on this {noun}
        </button>
      )}

      {open && session.kind === "signed-out" && (
        <div className="contribute-box">
          <p style={{ margin: 0 }}>
            Stating a view requires an account, because a statement is published under its
            speaker&rsquo;s name. Reading never does.
          </p>
          <p style={{ margin: ".6rem 0 0" }}>
            <a
              className="signin-button"
              style={{ display: "inline-block", textDecoration: "none" }}
              href={`/signin?callbackUrl=${encodeURIComponent(callback)}`}
            >
              Sign in to state a view
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
            <strong>Received.</strong> The statement is awaiting review of its form and good faith,
            never of whether the view is right. It appears on this page once it is admitted.{" "}
            {status.contributionId && (
              <>
                The decision and its reasoning will be on{" "}
                <a href={`/contributions/${status.contributionId}`}>its public record</a>.
              </>
            )}
          </p>
        </div>
      )}

      {open && session.kind === "signed-in" && status.kind !== "sent" && (
        <form className="contribute-box" onSubmit={onSubmit}>
          <p style={{ margin: "0 0 .2rem" }}>
            Say what you, or the organisation this account belongs to, hold about this {noun}. Stating
            a view does not change the assessment, and nobody edits one. The statement is recorded as
            a source, in your own words, and shown beside the assessment under this account&rsquo;s
            name: <strong>{name}</strong>.
          </p>

          <label className="contribute-label" htmlFor="state-view-stance">
            How do you stand toward the {noun}, as it is worded above?
          </label>
          <select
            className="contribute-field"
            id="state-view-stance"
            value={stance}
            onChange={(e) => setStance(e.target.value)}
          >
            {STANCES[kind].map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          {kind === "claim" && (
            <>
              <label className="contribute-label" htmlFor="state-view-probability">
                Your probability that the claim is true{" "}
                <span className="contribute-optional">
                  (0 to 1{stance === "gives_probability" ? "" : ", optional"})
                </span>
              </label>
              <input
                className="contribute-field"
                id="state-view-probability"
                name="probability"
                type="number"
                min={0}
                max={1}
                step="0.01"
                required={stance === "gives_probability"}
                style={{ maxWidth: "8rem" }}
              />
            </>
          )}

          {kind === "quantity" && stance === "states" && (
            <>
              <label className="contribute-label" htmlFor="state-view-figure-form">
                Your figure, in the quantity&rsquo;s own unit
              </label>
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}>
                <select
                  className="contribute-field"
                  id="state-view-figure-form"
                  value={figureForm}
                  onChange={(e) => setFigureForm(e.target.value as typeof figureForm)}
                  style={{ maxWidth: "11rem" }}
                >
                  {FIGURE_FORMS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <input
                  className="contribute-field"
                  name="figure_a"
                  type="number"
                  step="any"
                  required
                  aria-label={figureForm === "interval" ? "From" : "Figure"}
                  style={{ maxWidth: "8rem" }}
                />
                {figureForm === "interval" && (
                  <>
                    <span>to</span>
                    <input
                      className="contribute-field"
                      name="figure_b"
                      type="number"
                      step="any"
                      required
                      aria-label="To"
                      style={{ maxWidth: "8rem" }}
                    />
                  </>
                )}
              </div>
            </>
          )}

          <label className="contribute-label" htmlFor="state-view-statement">
            Your view, in your own words
          </label>
          <textarea
            className="contribute-field"
            id="state-view-statement"
            name="statement"
            rows={3}
            maxLength={2000}
            placeholder={
              kind === "question" ? "Your answer, or why you treat the question as open" : "What you hold, as you would put it"
            }
            required
          />
          <p className="contribute-hint">Shown exactly as written. It is never edited.</p>

          <label className="contribute-label" htmlFor="state-view-reasons">
            Your reasons <span className="contribute-optional">(optional)</span>
          </label>
          <textarea className="contribute-field" id="state-view-reasons" name="reasons" rows={5} maxLength={8000} />
          <p className="contribute-hint">
            Where your reasons go against the assessment they are heard as a challenge: the Steward
            weighs them and answers, and the exchange is kept on the public record. The page changes
            only if they meet the standard everything else on it meets.
          </p>

          <label className="contribute-label" htmlFor="state-view-evidence">
            Links your reasons rest on <span className="contribute-optional">(one per line, optional)</span>
          </label>
          <textarea className="contribute-field" id="state-view-evidence" name="evidence" rows={2} placeholder={"https://…"} />

          <label className="contribute-label" htmlFor="state-view-stake">
            Your stake in the answer
          </label>
          <textarea
            className="contribute-field"
            id="state-view-stake"
            name="stake"
            rows={2}
            maxLength={1000}
            disabled={noStake}
            required={!noStake}
            placeholder="What you or your organisation stand to gain or lose by how this is answered, in a sentence"
          />
          <label style={{ display: "flex", gap: ".4rem", alignItems: "baseline", marginTop: ".4rem" }}>
            <input type="checkbox" checked={noStake} onChange={(e) => setNoStake(e.target.checked)} />
            <span>No stake in how this is answered</span>
          </label>
          <p className="contribute-hint">
            Your stake is recorded with the statement and shown beside it. It is a fact about the
            statement, not a finding against it.
          </p>

          <p className="contribute-hint" style={{ marginTop: ".9rem", color: "var(--ink-soft)" }}>
            Before you submit: a statement is public and permanent. It is published under the name{" "}
            <strong>{name}</strong>, it cannot be edited or withdrawn, and it stays on the record if
            the account is later deleted. To change your view, state it again: the newer statement is
            shown as current and this one stays, dated. Do not include personal details about private
            individuals.
          </p>

          <div className="contribute-actions">
            <button className="signin-button" type="submit" disabled={status.kind === "sending"}>
              {status.kind === "sending" ? "Submitting…" : "Submit statement for review"}
            </button>
            <span className="contribute-hint" style={{ margin: 0 }}>
              reviewed for form and good faith, never for whether the view is right
            </span>
          </div>
          {status.kind === "error" && <p className="contribute-error">{status.message}</p>}
        </form>
      )}
    </div>
  );
}
