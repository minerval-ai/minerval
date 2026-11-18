"use client";

// The filters over the list of releases: a GET form, so a filtered list is an
// address. A choice in a select sends it at once; without script, the button
// does.

import type { ChangeEvent } from "react";

export function ReleasesFilter({
  tab,
  q,
  boundary,
  status,
  ended,
  boundaries,
  statuses,
}: {
  tab: string;
  q: string;
  boundary: string;
  status: string;
  ended: boolean;
  boundaries: string[];
  statuses: Array<{ key: string; label: string }>;
}) {
  const submit = (e: ChangeEvent<HTMLSelectElement>) => e.currentTarget.form?.requestSubmit();
  return (
    <form method="get" action="/releases" className="w-row" role="search" style={{ gap: 8 }}>
      <input type="hidden" name="tab" value={tab} />
      {ended && <input type="hidden" name="ended" value="1" />}
      <input className="w-input" type="search" name="q" defaultValue={q} placeholder="Search nodes" aria-label="Search releases" style={{ width: 240 }} />
      <select className="w-select" name="boundary" defaultValue={boundary} onChange={submit} aria-label="Boundary" style={{ width: "auto" }}>
        <option value="">All boundaries</option>
        {boundaries.map((b) => (
          <option key={b} value={b}>
            {b
              .split("→")
              .map((side) => (side === "?" ? "a label you do not read" : side))
              .join(" → ")}
          </option>
        ))}
      </select>
      <select className="w-select" name="status" defaultValue={status} onChange={submit} aria-label="Status" style={{ width: "auto" }}>
        <option value="">Any status</option>
        {statuses.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      <noscript>
        <button className="w-btn w-sm" type="submit">
          Filter
        </button>
      </noscript>
    </form>
  );
}
