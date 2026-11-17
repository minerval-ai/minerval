"use client";

import { useSuggestedClaim } from "@/components/useSuggestedClaim";

// The hero search input (issue #116): the placeholder suggests a real claim
// rather than bare topic words, rotating through a small set. Those claims
// are public Minerval's, so a members-only deployment passes its own
// placeholder instead (#1092), which names no claim it may not hold.

export function SearchInput({ placeholder }: { placeholder?: string }) {
  const claim = useSuggestedClaim();

  return (
    <input
      type="search"
      name="q"
      placeholder={placeholder ?? `Search the claim graph: try “${claim}”`}
      aria-label="Search the claim graph"
    />
  );
}
