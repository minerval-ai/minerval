"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IMPORTANCE_FLOORS, claimTypeMeta, type ImportanceFloor } from "@/lib/ontology";
import type { AssessedFilter, ClaimType } from "@/lib/types";
import { useSuggestedClaim } from "@/components/useSuggestedClaim";

// Defaults the browse feed lands on: only assessed claims, no importance floor.
// These are the values omitted from the URL, so a shared link stays clean and
// "/claims" means exactly this.
const DEFAULT_ASSESSED: AssessedFilter = "assessed";
const DEFAULT_IMP: ImportanceFloor = "any";

type PrizeFilter = "any" | "with";

const PRIZE_SEGMENTS: { value: PrizeFilter; label: string; title: string }[] = [
  { value: "any", label: "Any", title: "Every claim, with or without a prize" },
  { value: "with", label: "With a prize", title: "Claims with a live prize for a machine-checked proof or disproof" },
];

const ASSESSED_SEGMENTS: { value: AssessedFilter; label: string; title: string }[] = [
  { value: "assessed", label: "Assessed", title: "Claims that carry a current verdict" },
  { value: "unassessed", label: "Unassessed", title: "Claims that do not yet carry a verdict" },
  { value: "all", label: "All", title: "Every claim, assessed or not" },
];

function Segmented<T extends string>({
  value, segments, onPick, ariaLabel,
}: {
  value: T;
  segments: { value: T; label: string; title?: string }[];
  onPick: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <span className="segmented" role="group" aria-label={ariaLabel}>
      {segments.map((s) => (
        <button
          key={s.value}
          type="button"
          title={s.title}
          aria-pressed={s.value === value}
          onClick={() => onPick(s.value)}
        >
          {s.label}
        </button>
      ))}
    </span>
  );
}

export function ClaimsControls({
  q, assessed, imp, prizes = false, type, resultCount,
}: {
  q: string;
  assessed: AssessedFilter;
  imp: ImportanceFloor;
  // Only claims with a live prize (docs/mathematics.md §8.3; API with_prizes).
  prizes?: boolean;
  // A claim-type restriction, set by a territory's front door rather than a
  // control of its own; shown as a removable lever while active.
  type?: ClaimType;
  // Omitted on the pre-search overview (#206), where there is no result list to
  // count and a number would misrepresent the territory cards as a feed.
  resultCount?: number;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(q);
  const suggestedClaim = useSuggestedClaim();

  // Build a clean URL — only non-default levers appear. `next` overrides the
  // current value for whichever lever changed; the live search text comes along
  // so flipping a filter never discards what's been typed.
  function go(next: Partial<{
    q: string; assessed: AssessedFilter; imp: ImportanceFloor; prizes: boolean; type: ClaimType | null;
  }>) {
    const nq = (next.q ?? query).trim();
    const na = next.assessed ?? assessed;
    const ni = next.imp ?? imp;
    const np = next.prizes ?? prizes;
    const nt = next.type === undefined ? type : next.type;
    const p = new URLSearchParams();
    if (nq) p.set("q", nq);
    if (na !== DEFAULT_ASSESSED) p.set("assessed", na);
    if (ni !== DEFAULT_IMP) p.set("imp", ni);
    if (np) p.set("prizes", "1");
    if (nt) p.set("type", nt);
    const qs = p.toString();
    router.push(qs ? `/claims?${qs}` : "/claims");
  }

  const isDefault = assessed === DEFAULT_ASSESSED && imp === DEFAULT_IMP && !q && !prizes && !type;
  const typeMeta = type ? claimTypeMeta(type) : null;

  return (
    <div className="claims-controls">
      <form role="search" onSubmit={(e) => { e.preventDefault(); go({ q: query }); }}>
        <input
          className="claims-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search claims: try “${suggestedClaim}”`}
          aria-label="Search claims"
        />
      </form>

      <div className="filter-row">
        <span className="filter-group">
          <span className="sc">Showing</span>
          <Segmented
            ariaLabel="Filter by assessment status"
            value={assessed}
            segments={ASSESSED_SEGMENTS}
            onPick={(v) => go({ assessed: v })}
          />
        </span>

        <span className="filter-group">
          <span className="sc">Importance</span>
          <Segmented
            ariaLabel="Filter by minimum importance"
            value={imp}
            segments={IMPORTANCE_FLOORS.map((f) => ({ value: f.value, label: f.short, title: f.label }))}
            onPick={(v) => go({ imp: v })}
          />
        </span>

        <span className="filter-group">
          <span className="sc">Prizes</span>
          <Segmented
            ariaLabel="Filter by prize"
            value={prizes ? "with" : "any"}
            segments={PRIZE_SEGMENTS}
            onPick={(v) => go({ prizes: v === "with" })}
          />
        </span>

        {type && (
          <span className="filter-group">
            <span className="sc">Type</span>
            <span className="tag kind">{typeMeta?.label ?? type.replace(/_/g, " ")}</span>
            <button type="button" className="filter-reset" onClick={() => go({ type: null })} aria-label="Remove the type filter">
              ×
            </button>
          </span>
        )}

        <span className="filter-meta">
          {typeof resultCount === "number" && (
            <>
              {resultCount} {resultCount === 1 ? "claim" : "claims"}
            </>
          )}
          {!isDefault && (
            <button type="button" className="filter-reset" onClick={() => { setQuery(""); router.push("/claims"); }}>
              reset
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
