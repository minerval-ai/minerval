import { apiConfigured, fetchFinding } from "@/lib/api";
import { OG_CONTENT_TYPE, OG_SIZE, findingCard, missingCard } from "@/lib/og/card";

// The card a pasted finding link unfurls into: the headline, the claim it is
// about, and when it was noted (lib/og/card.tsx).
export const alt = "A finding on Minerval";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A failed read gets the same card as a missing finding, never a broken image.
  const result = apiConfigured() ? await fetchFinding(id).catch(() => null) : null;
  if (!result) return missingCard("Finding", "Finding not found.");
  const f = result.finding;
  return findingCard({
    headline: f.headline,
    claimText: f.claim_text,
    notedAt: f.first_noted_at,
    withdrawn: f.status === "withdrawn",
    stale: f.stale,
  });
}
