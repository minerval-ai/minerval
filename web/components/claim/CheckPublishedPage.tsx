"use client";

import { useState } from "react";
import { verifyPublishedPage, type PackageCheck } from "@/lib/published-page/verify";

// "Check this page" (docs/published-pages.md): fetches the package exactly
// as its publisher signed it and runs the check here, in the reader's own
// browser, with the same code the graph ran when the package arrived. It
// says what it confirmed, what failed, and what a check of this kind cannot
// show.
export function CheckPublishedPage({ publishedPageId, pkg, arrived }: { publishedPageId: string; pkg: number; arrived: PackageCheck }) {
  const [state, setState] = useState<"idle" | "checking" | "done" | "unavailable">("idle");
  const [check, setCheck] = useState<PackageCheck | null>(null);
  const href = `/api/published-pages/${publishedPageId}/package?package=${pkg}`;

  async function run() {
    setState("checking");
    try {
      const res = await fetch(href);
      if (!res.ok) throw new Error("unavailable");
      const body = (await res.json()) as { package: unknown; publisher_key: string | null };
      setCheck(await verifyPublishedPage(body.package, { publisherKey: body.publisher_key }));
      setState("done");
    } catch {
      setState("unavailable");
    }
  }

  const shown = check ?? arrived;
  return (
    <div className="check-page">
      <p>
        {check
          ? check.ok
            ? "Checked just now, in your browser: the package checks out."
            : "Checked just now, in your browser: the package does not check out."
          : arrived.ok
            ? "When the package arrived, this graph checked it and it matched."
            : "When the package arrived, this graph's check did not match."}{" "}
        <button type="button" className="linklike" onClick={run} disabled={state === "checking"}>
          {state === "checking" ? "Checking…" : check ? "Check again" : "Check this page"}
        </button>
        {" · "}
        <a href={href} download={`published-page-${publishedPageId}-${pkg}.json`}>download the signed package</a>
      </p>
      {state === "unavailable" && <p className="caution">The package could not be fetched, so nothing was checked.</p>}
      {shown.failed.length > 0 && (
        <>
          <p className="sc">Failed</p>
          <ul>{shown.failed.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </>
      )}
      <p className="sc">Confirmed</p>
      <ul>{shown.confirmed.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <p className="sc">What this check cannot show</p>
      <ul>{shown.cannot_show.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </div>
  );
}
