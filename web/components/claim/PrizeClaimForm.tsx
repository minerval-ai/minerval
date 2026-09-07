"use client";

import { useState } from "react";
import Link from "next/link";
import type { BountySummary, FormalizationSummary } from "@/lib/types";
import { formatOwls } from "@/lib/format";
import { PRIZE_PAYMENT_SENTENCE, PRIZE_TAX_SANCTIONS_NOTICE, resolutionPhrase } from "@/lib/prizes";
import { PRIZE_RULES_VERSION } from "@/lib/prize-rules";
import { useViewerSession } from "../useViewerSession";

// The claim-prize form (docs/mathematics.md §8.4): one component for every
// domain; the bounty's condition decides which attachments are required, and
// for a Lean statement the Lean source is. Everything binding happens on the
// server: the route rejects a stale statement version, the API validates the
// files independently of the BFF, and the payee steps come later, on the
// account page, once the prize is payable. Nothing here charges owls.

const CONTENT_MIN = 200;
const CONTENT_MAX = 20_000;
const LINKS_MAX = 10;
const LEAN_MAX_BYTES = 256 * 1024;
const LEAN_MAX_LINES = 20_000;
const DOCS_MAX = 5;
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOCS_TOTAL_BYTES = 25 * 1024 * 1024;

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; contributionId: string | null }
  | { kind: "error"; message: string };

export function PrizeClaimForm({
  claimId, bounty, formalization,
}: {
  claimId: string;
  bounty: BountySummary;
  formalization: FormalizationSummary;
}) {
  const session = useViewerSession();
  const [status, setStatus] = useState<SubmitState>({ kind: "idle" });
  const [leanMode, setLeanMode] = useState<"file" | "paste">("file");
  const [contentLen, setContentLen] = useState(0);
  const directions =
    bounty.resolution === "either" ? (["proof", "disproof"] as const) : ([bounty.resolution] as const);

  function clientCheck(data: FormData): string | null {
    const content = String(data.get("content") ?? "").trim();
    if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
      return `The written account must run between ${CONTENT_MIN.toLocaleString()} and ${CONTENT_MAX.toLocaleString()} characters.`;
    }
    const links = String(data.get("links") ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (links.length > LINKS_MAX) return `At most ${LINKS_MAX} links.`;
    for (const u of links) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw 0;
      } catch {
        return `Links must be full web addresses; "${u}" is not.`;
      }
    }
    const leanFile = data.get("lean_file");
    const leanSource = String(data.get("lean_source") ?? "");
    if (leanMode === "file") {
      if (!(leanFile instanceof File) || leanFile.size === 0) return "Attach the Lean file.";
      if (leanFile.size > LEAN_MAX_BYTES) return "The Lean file must be at most 256 KiB.";
      data.delete("lean_source");
    } else {
      if (!leanSource.trim()) return "Paste the Lean source.";
      if (new TextEncoder().encode(leanSource).length > LEAN_MAX_BYTES) return "The Lean source must be at most 256 KiB.";
      if (leanSource.split("\n").length > LEAN_MAX_LINES) return "The Lean source must be at most 20,000 lines.";
      data.delete("lean_file");
    }
    const docs = data.getAll("documents").filter((f): f is File => f instanceof File && f.size > 0);
    data.delete("documents");
    for (const d of docs) data.append("documents", d);
    if (docs.length > DOCS_MAX) return `At most ${DOCS_MAX} documents.`;
    if (docs.some((d) => d.size > DOC_MAX_BYTES)) return "Each document must be at most 10 MiB.";
    if (docs.reduce((s, d) => s + d.size, 0) > DOCS_TOTAL_BYTES) return "Documents must total at most 25 MiB.";
    if (!String(data.get("tools_disclosure") ?? "").trim()) return "Say which tools were used, or that none were.";
    if (!/^[A-Za-z]{2}$/.test(String(data.get("residency_country") ?? "").trim())) {
      return "Give your country of residence as its two-letter code, such as GB or DE.";
    }
    if (!data.get("us_person")) return "Say whether you are a U.S. person.";
    if (!String(data.get("credit_name") ?? "").trim()) return "Choose a credit name for the record.";
    for (const k of ["declare_eligible", "declare_understands", "declare_cc0", "declare_rules"]) {
      if (data.get(k) !== "on") return "Each declaration must be made.";
    }
    return null;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const problem = clientCheck(data);
    if (problem) {
      setStatus({ kind: "error", message: problem });
      return;
    }
    setStatus({ kind: "sending" });
    try {
      const res = await fetch(`/api/claims/${encodeURIComponent(claimId)}/prize-claims`, {
        method: "POST",
        body: data,
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; contribution?: { id?: string } | null }
        | null;
      if (res.ok) {
        setStatus({ kind: "sent", contributionId: body?.contribution?.id ?? null });
      } else {
        setStatus({ kind: "error", message: body?.error ?? "The submission could not be filed." });
      }
    } catch {
      setStatus({ kind: "error", message: "The submission could not be filed. Please try again later." });
    }
  }

  const callback = `/claims/${claimId}/prize/claim`;

  if (session.kind === "loading") {
    return <div className="contribute-box"><p style={{ margin: 0, color: "var(--muted)" }}>…</p></div>;
  }

  if (session.kind === "signed-out") {
    return (
      <div className="contribute-box">
        <p style={{ margin: 0 }}>
          Filing a prize claim requires an account, so that every submission is
          signed, answerable, and appealable, and so that a prize can be paid
          to the person who earned it.
        </p>
        <p style={{ margin: ".6rem 0 0" }}>
          <a
            className="signin-button"
            style={{ display: "inline-block", textDecoration: "none" }}
            href={`/signin?callbackUrl=${encodeURIComponent(callback)}`}
          >
            Sign in to file a claim
          </a>
        </p>
      </div>
    );
  }

  if (status.kind === "sent") {
    return (
      <div className="contribute-box" role="status">
        <p style={{ margin: 0 }}>
          <strong>Received.</strong> Your submission is queued for the checker;
          submissions on this statement are checked in order of receipt, and
          the time of receipt is your priority.{" "}
          {status.contributionId ? (
            <>
              The checker&rsquo;s verdict and every later decision will appear on{" "}
              <Link href={`/contributions/${status.contributionId}`}>its public record</Link>, and
              its progress is tracked in <Link href="/account">your account</Link>.
            </>
          ) : (
            <>Its progress is tracked in <Link href="/account">your account</Link>.</>
          )}
        </p>
      </div>
    );
  }

  return (
    <form className="contribute-box prize-form" onSubmit={onSubmit}>
      <input type="hidden" name="formalization_id" value={formalization.id} />
      <input type="hidden" name="statement_version" value={formalization.version} />
      <input type="hidden" name="rules_version" value={bounty.rules_version || PRIZE_RULES_VERSION} />

      <p className="contribute-hint" style={{ marginTop: 0 }}>
        Statement {formalization.version} · <span className="mono">{formalization.pin_id}</span> ·{" "}
        <span className="mono">sha256 {formalization.source_hash.slice(0, 12)}…</span>. The claim is
        filed against this version; if the statement is revised before you file, the form asks
        you to reload.
      </p>

      <label className="contribute-label">Direction</label>
      <div className="prize-form-radios">
        {directions.map((d, i) => (
          <label key={d}>
            <input type="radio" name="direction" value={d} defaultChecked={i === 0} required /> {d}
          </label>
        ))}
      </div>
      <p className="contribute-hint">
        The prize asks for a {resolutionPhrase(bounty.resolution)}. A proof is{" "}
        <code>theorem {formalization.namespace}.proof : {formalization.namespace}.Statement</code>;
        a disproof is <code>theorem {formalization.namespace}.disproof : ¬ {formalization.namespace}.Statement</code>.
        The checker supplies the header; your file must not import anything.
      </p>

      <label className="contribute-label" htmlFor="prize-content">Written account</label>
      <textarea
        className="contribute-field"
        id="prize-content"
        name="content"
        rows={10}
        minLength={CONTENT_MIN}
        maxLength={CONTENT_MAX}
        placeholder="The approach, in your own words: what the proof does, what it rests on, and where the difficulty lay. This account is public at once, like any contribution."
        onChange={(e) => setContentLen(e.target.value.length)}
        required
      />
      <p className="contribute-hint">
        {contentLen.toLocaleString()} of {CONTENT_MIN}–{CONTENT_MAX.toLocaleString()} characters.
      </p>

      <label className="contribute-label">Lean source</label>
      <div className="prize-form-radios">
        <label>
          <input type="radio" name="lean_mode" checked={leanMode === "file"} onChange={() => setLeanMode("file")} /> a .lean file
        </label>
        <label>
          <input type="radio" name="lean_mode" checked={leanMode === "paste"} onChange={() => setLeanMode("paste")} /> pasted
        </label>
      </div>
      {leanMode === "file" ? (
        <input className="contribute-field" type="file" name="lean_file" accept=".lean,text/plain" />
      ) : (
        <textarea
          className="contribute-field mono"
          name="lean_source"
          rows={12}
          spellCheck={false}
          placeholder={`theorem ${formalization.namespace}.proof : ${formalization.namespace}.Statement := by\n  …`}
        />
      )}
      <p className="contribute-hint">
        One file, at most 256 KiB and 20,000 lines, valid UTF-8. Allowed axioms are
        propext, Classical.choice, and Quot.sound; the static policy published with the
        rules names what is refused before anything runs. The source stays confidential to
        Minerval and its agents until the claim is accepted or the prize closes.
      </p>

      <label className="contribute-label" htmlFor="prize-links">
        Links <span className="contribute-optional">(one per line, up to ten, optional)</span>
      </label>
      <textarea className="contribute-field" id="prize-links" name="links" rows={2} placeholder="https://…" />

      <label className="contribute-label" htmlFor="prize-docs">
        Documents and data <span className="contribute-optional">(optional)</span>
      </label>
      <input
        className="contribute-field"
        id="prize-docs"
        type="file"
        name="documents"
        multiple
        accept=".pdf,.md,.txt,.csv,.json,.zip,application/pdf,text/markdown,text/plain,text/csv,application/json,application/zip"
      />
      <p className="contribute-hint">
        PDF, Markdown, text, CSV, JSON, or zip; at most five files, 10 MiB each, 25 MiB in all.
        Nested archives are refused.
      </p>

      <label className="contribute-label" htmlFor="prize-tools">Tools used</label>
      <textarea
        className="contribute-field"
        id="prize-tools"
        name="tools_disclosure"
        rows={3}
        placeholder="Which proof assistants, search tools, and AI systems were used, and for what. AI assistance is allowed and must be disclosed; write “none” if none."
        required
      />

      <label className="contribute-label" htmlFor="prize-country">Country of residence</label>
      <input
        className="contribute-field mono"
        id="prize-country"
        name="residency_country"
        maxLength={2}
        pattern="[A-Za-z]{2}"
        placeholder="two-letter code, e.g. GB"
        autoCapitalize="characters"
        style={{ maxWidth: "12rem" }}
        required
      />
      <label className="contribute-label">Are you a U.S. person for tax purposes?</label>
      <div className="prize-form-radios">
        <label><input type="radio" name="us_person" value="yes" required /> yes</label>
        <label><input type="radio" name="us_person" value="no" /> no</label>
      </div>
      <p className="contribute-hint">
        The country as its ISO two-letter code. Residents of comprehensively sanctioned
        jurisdictions, and for now of Italy and Brazil, are not eligible. The answer decides
        which tax form is asked for if the prize is paid: a W-9 for a U.S. person, a W-8BEN
        otherwise.
      </p>

      <label className="contribute-label" htmlFor="prize-credit">Credit name</label>
      <input
        className="contribute-field"
        id="prize-credit"
        name="credit_name"
        maxLength={80}
        placeholder="Your name, or a pseudonym, as it will appear on the record"
        required
      />

      <label className="contribute-label">Declarations</label>
      <div className="prize-form-checks">
        <label>
          <input type="checkbox" name="declare_eligible" required /> I am a natural person aged 18 or
          over, not Minerval or a contractor on this program, not a funder of the Mathematics
          mandate, and not resident where the prize cannot lawfully be paid.
        </label>
        <label>
          <input type="checkbox" name="declare_understands" required /> I understand the proof I am
          submitting and can answer for it; it is my own work or properly attributed, and it does
          not reproduce a proof Minerval&rsquo;s own solver produced.
        </label>
        <label>
          <input type="checkbox" name="declare_cc0" required /> On acceptance, or when the prize
          closes, I dedicate the submission to the public domain under CC0 1.0, and for material
          without copyright I grant the broadest license available.
        </label>
        <label>
          <input type="checkbox" name="declare_rules" required /> I have read{" "}
          <Link href="/prizes/rules">the rules, version {bounty.rules_version || PRIZE_RULES_VERSION}</Link>,
          and I file this claim under them.
        </label>
      </div>

      <div className="prize-form-pay">
        <span className="sc">Payment</span>
        <p>
          The prize is {formatOwls(bounty.amount_micro_usd)}. {PRIZE_PAYMENT_SENTENCE} Nothing
          binding is collected here: if your submission is accepted and the challenge window
          closes, the account page asks for identity and residency, a tax form, and sanctions
          screening, to be completed within ninety days.
        </p>
        <p>{PRIZE_TAX_SANCTIONS_NOTICE}</p>
      </div>

      <div className="contribute-actions">
        <button className="signin-button" type="submit" disabled={status.kind === "sending"}>
          {status.kind === "sending" ? "Filing…" : "File the claim"}
        </button>
        <span className="contribute-hint" style={{ margin: 0 }}>
          filing as {session.name ?? "you"} · entry is free
        </span>
      </div>
      {status.kind === "error" && <p className="contribute-error">{status.message}</p>}
    </form>
  );
}
