import { loadClaim } from "@/lib/data";
import { claimPreview } from "@/lib/preview";
import { OG_CONTENT_TYPE, OG_SIZE, claimCard, missingCard } from "@/lib/og/card";

// The card a pasted claim link unfurls into: the claim, and the graph's
// judgment of it as the page states it (lib/og/card.tsx). Next attaches this
// image to the claim page and the views beneath it (history, map), and reuses
// it for the Twitter card.
export const alt = "A claim on Minerval, with the graph's current assessment of it";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { detail } = await loadClaim(id);
  if (!detail) return missingCard("Claim", "Claim not found.");
  return claimCard(claimPreview(detail));
}
