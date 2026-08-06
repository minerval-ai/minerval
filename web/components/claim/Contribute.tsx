"use client";

import { useEffect, useRef, useState } from "react";
import { useViewerSession } from "../useViewerSession";

// The contribution entry point on a claim page (#174). Visible to every
// reader — the prompt is also the advertisement that the page is challengeable
// — with the action itself gated behind sign-in. Submissions go to the
// Contribution Reviewer via POST /api/contributions; nothing writes to the
// graph directly (#157). The exchange record itself arrives with #171.
//
// Deep links: ?contribute=<type>&quote=<text> preselects a type and quotes a
// passage (used by the browser extension), and #contribute scrolls here.

const TYPES = [
  {
    value: "challenge",
    label: "Challenge the assessment",
    hint: "Dispute the verdict or its reasoning, with the evidence or argument the assessment missed.",
    placeholder:
      "What does the assessment get wrong, and what evidence or reasoning shows it?",
  },
  {
    value: "support",
    label: "Add supporting evidence",
    hint: "Evidence that bears on the claim and is missing from the page.",
    placeholder: "What is the evidence, and what does it show about the claim?",
  },
  {
    value: "propose_edit",
    label: "Dispute the wording",
    hint: "The canonical form should be the neutral statement both sides would accept.",
    placeholder: "What is wrong with the current wording?",
  },
  {
    value: "add_instance",
    label: "Report where this claim is made",
    hint: "A source that states this claim, so the page can cite it in the author's own words.",
    placeholder:
      "Where is the claim stated, and does the source affirm or deny it? Add the link below.",
  },
  {
    value: "propose_argument",
    label: "Add an argument",
    hint: "A distinct line of reasoning, for or against, that the page does not yet carry.",
    placeholder: "State the argument plainly: its premises and what they establish.",
  },
  {
    value: "propose_merge",
    label: "Flag a duplicate",
    hint: "This claim and another turn on the same considerations and should be one node.",
    placeholder: "Why are the two claims the same claim?",
  },
  {
    value: "propose_split",
    label: "Flag a conflation",
    hint: "This claim bundles distinct propositions that would accumulate different evidence.",
    placeholder: "Which distinct claims are bundled here, and how do they come apart?",
  },
] as const;

type TypeValue = (typeof TYPES)[number]["value"];

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; contributionId: string | null }
  | { kind: "error"; message: string };

function isTypeValue(v: string | null): v is TypeValue {
  return TYPES.some((t) => t.value === v);
}

export function Contribute({ claimId }: { claimId: string }) {
  const [open, setOpen] = useState(false);
  const session = useViewerSession();
  const [type, setType] = useState<TypeValue>("challenge");
  const [prefill, setPrefill] = useState("");
  const [status, setStatus] = useState<SubmitState>({ kind: "idle" });
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("contribute");
    if (wanted !== null || window.location.hash === "#contribute") {
      setOpen(true);
      if (isTypeValue(wanted)) setType(wanted);
      const quote = params.get("quote");
      if (quote) setPrefill(`On the passage: “${quote.trim()}”\n\n`);
      setTimeout(
        () => sectionRef.current?.scrollIntoView({ block: "start" }),
        50,
      );
    }
  }, []);

  const meta = TYPES.find((t) => t.value === type)!;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim_id: claimId,
          contribution_type: type,
          content: data.get("content"),
          evidence_urls: String(data.get("evidence") ?? "")
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean),
          ...(type === "propose_edit"
            ? { proposed_canonical_form: data.get("proposed_wording") }
            : {}),
          ...(type === "propose_merge"
            ? {
                // Accept a pasted claim-page address as well as a bare id.
                merge_target_claim_id:
                  String(data.get("merge_target") ?? "").match(
                    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
                  )?.[0] ?? String(data.get("merge_target") ?? "").trim(),
              }
            : {}),
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
          message: body?.error ?? "The contribution could not be submitted.",
        });
      }
    } catch {
      setStatus({
        kind: "error",
        message: "The contribution could not be submitted. Please try again later.",
      });
    }
  }

  // Return the reader to this claim with the panel open after signing in.
  const callback =
    typeof window === "undefined"
      ? `/claims/${claimId}`
      : `${window.location.pathname}?contribute=${type}`;

  return (
    <section id="contribute" ref={sectionRef}>
      <h2>Contribute</h2>
      <p className="contribute-lede">
        Every judgment on this page is open to challenge. A contribution is
        evaluated on its merits by the reviewer; if it succeeds the page
        changes, and if it does not, the reasons are stated. Either way the
        exchange becomes part of the claim&rsquo;s public record.
      </p>

      {!open && (
        <button className="contribute-open" onClick={() => setOpen(true)}>
          Challenge or add to this claim
        </button>
      )}

      {open && session.kind === "signed-out" && (
        <div className="contribute-box">
          <p style={{ margin: 0 }}>
            Contributing requires an account, so that every challenge is signed,
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
            <strong>Received.</strong> The contribution is awaiting review on
            its merits.{" "}
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
                The decision and its reasoning are tracked in{" "}
                <a href="/account">your account</a>.
              </>
            )}
          </p>
        </div>
      )}

      {open && session.kind === "signed-in" && status.kind !== "sent" && (
        <form className="contribute-box" onSubmit={onSubmit}>
          <label className="contribute-label" htmlFor="contribute-type">
            What kind of contribution?
          </label>
          <select
            className="contribute-field"
            id="contribute-type"
            value={type}
            onChange={(e) => setType(e.target.value as TypeValue)}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="contribute-hint">{meta.hint}</p>

          {type === "propose_edit" && (
            <>
              <label className="contribute-label" htmlFor="contribute-wording">
                Proposed wording
              </label>
              <input
                className="contribute-field"
                id="contribute-wording"
                name="proposed_wording"
                maxLength={2000}
                placeholder="The neutral statement of what is in dispute"
                required
              />
            </>
          )}

          {type === "propose_merge" && (
            <>
              <label className="contribute-label" htmlFor="contribute-merge">
                The claim this duplicates
              </label>
              <input
                className="contribute-field"
                id="contribute-merge"
                name="merge_target"
                placeholder="Paste the other claim's id or page address"
                required
              />
            </>
          )}

          <label className="contribute-label" htmlFor="contribute-content">
            Your contribution
          </label>
          <textarea
            className="contribute-field"
            id="contribute-content"
            name="content"
            rows={6}
            maxLength={10000}
            placeholder={meta.placeholder}
            defaultValue={prefill}
            required
          />

          <label className="contribute-label" htmlFor="contribute-evidence">
            Evidence links <span className="contribute-optional">(one per line, optional)</span>
          </label>
          <textarea
            className="contribute-field"
            id="contribute-evidence"
            name="evidence"
            rows={2}
            placeholder={"https://…"}
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
