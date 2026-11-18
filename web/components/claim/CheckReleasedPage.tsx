"use client";

import { useState } from "react";
import { checkReleasedPage, type PageToCheck, type ReleasedPageCheck } from "@/lib/released-page-check";

// "Check this page", for a page shown inside the deployment
// (docs/releasing-a-page.md, "The fingerprint"): fetches the page as the API
// serves it to this reader and rebuilds its fingerprint here, in the
// reader's own browser, from the parts and salts they were shown. It says
// what it confirmed, what failed, and what a check of this kind cannot show.
// `work` draws the same check in the members' workspace (app/workspace.css),
// as the page of a shown version does; the claim's own page keeps the
// reading column's.
export function CheckReleasedPage({
  releaseId,
  pageId,
  arrivedOk,
  work = false,
}: {
  releaseId: string;
  pageId: string;
  arrivedOk: boolean;
  work?: boolean;
}) {
  const [state, setState] = useState<"idle" | "checking" | "done" | "unavailable">("idle");
  const [check, setCheck] = useState<ReleasedPageCheck | null>(null);

  async function run() {
    setState("checking");
    try {
      const res = await fetch(`/api/releases/${releaseId}/pages/${pageId}`);
      if (!res.ok) throw new Error("unavailable");
      setCheck(await checkReleasedPage((await res.json()) as PageToCheck));
      setState("done");
    } catch {
      setState("unavailable");
    }
  }

  const said = check
    ? check.ok
      ? `Checked just now, in your browser: ${check.released} released part${check.released === 1 ? " is" : "s are"} word for word what was recorded when the redaction finished, with each removal marked where it was made, and ${check.held} held part${check.held === 1 ? " is" : "s are"} in the recorded place and of the recorded kind.`
      : "Checked just now, in your browser: the page does not match its fingerprint."
    : arrivedOk
      ? "When this page was read for you, the deployment rebuilt its fingerprint from the parts released and it matched the one recorded before any party consented."
      : "When this page was read for you, the deployment's own check of it did not match.";
  const cannot = [
    "What the held parts say. The check confirms their kinds, their places and that they have not changed.",
    "What was removed inside the released parts, or whether the policy called for it. The marks show where and under which category.",
    "That the assessment shown was the only one made.",
    "That the fingerprint itself was recorded when the record says. It is this deployment’s own record, so the check shows that the parts match it and leaves the record to be taken on the deployment’s word.",
  ];

  if (work) {
    const ok = check ? check.ok : arrivedOk;
    return (
      <div className="w-col" style={{ gap: 10 }}>
        <div className="w-row">
          <button type="button" className="w-btn w-sm" onClick={run} disabled={state === "checking"}>
            {state === "checking" ? "Checking…" : check ? "Check again" : "Check this page"}
          </button>
          <span className="w-help">In your browser</span>
        </div>
        <div className={ok ? "w-banner w-ok" : "w-banner w-bad"} role="status" style={{ fontSize: 12.5, alignItems: "flex-start" }}>
          {said}
        </div>
        {state === "unavailable" && (
          <div className="w-said w-error" role="alert">
            The page could not be fetched, so nothing was checked.
          </div>
        )}
        {check && check.problems.length > 0 && (
          <ul className="w-small" style={{ margin: 0, paddingLeft: 18, color: "var(--w-bad)" }}>
            {check.problems.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        <details className="w-small w-muted">
          <summary style={{ cursor: "pointer" }}>What this check cannot show</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {cannot.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      </div>
    );
  }

  return (
    <div className="check-page">
      <p>
        {said}{" "}
        <button type="button" className="linklike" onClick={run} disabled={state === "checking"}>
          {state === "checking" ? "Checking…" : check ? "Check again" : "Check this page"}
        </button>
      </p>
      {state === "unavailable" && <p className="caution">The page could not be fetched, so nothing was checked.</p>}
      {check && check.problems.length > 0 && (
        <>
          <p className="sc">Failed</p>
          <ul>{check.problems.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </>
      )}
      <p className="sc">What this check cannot show</p>
      <ul>
        {cannot.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
