"use client";

import { useState } from "react";
import { checkShownPage, type PageToCheck, type ShownPageCheck } from "@/lib/shown-page-check";

// "Check this page", for a page shown inside the deployment
// (docs/showing-a-page.md, "The fingerprint"): fetches the page as the API
// serves it to this reader and rebuilds its fingerprint here, in the
// reader's own browser, from the parts and salts they were shown. It says
// what it confirmed, what failed, and what a check of this kind cannot show.
export function CheckShownPage({ showingId, pageId, arrivedOk }: { showingId: string; pageId: string; arrivedOk: boolean }) {
  const [state, setState] = useState<"idle" | "checking" | "done" | "unavailable">("idle");
  const [check, setCheck] = useState<ShownPageCheck | null>(null);

  async function run() {
    setState("checking");
    try {
      const res = await fetch(`/api/showings/${showingId}/pages/${pageId}`);
      if (!res.ok) throw new Error("unavailable");
      setCheck(await checkShownPage((await res.json()) as PageToCheck));
      setState("done");
    } catch {
      setState("unavailable");
    }
  }

  return (
    <div className="check-page">
      <p>
        {check
          ? check.ok
            ? `Checked just now, in your browser: ${check.released} released part${check.released === 1 ? " is" : "s are"} word for word what was recorded when the redaction finished, with each removal marked where it was made, and ${check.held} held part${check.held === 1 ? " is" : "s are"} in the recorded place and of the recorded kind.`
            : "Checked just now, in your browser: the page does not match its fingerprint."
          : arrivedOk
            ? "When this page was read for you, the deployment rebuilt its fingerprint from the parts shown and it matched the one recorded before anyone decided what to release."
            : "When this page was read for you, the deployment's own check of it did not match."}{" "}
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
        <li>What the held parts say. The check confirms their kinds, their places and that they have not changed.</li>
        <li>What was removed inside the released parts, or whether the policy called for it. The marks show where and under which category.</li>
        <li>That the assessment shown was the only one made.</li>
        <li>
          That the fingerprint itself was recorded when the record says. It is this deployment&rsquo;s own record, so the check shows that the
          parts match it and leaves the record to be taken on the deployment&rsquo;s word.
        </li>
      </ul>
    </div>
  );
}
