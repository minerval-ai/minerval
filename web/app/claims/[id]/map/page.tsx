import Link from "next/link";
import type { Metadata } from "next";
import { loadClaim } from "@/lib/data";
import { GraphView } from "@/components/graph/GraphView";

// The claim map (issue #79): /claims/:id/map is a sibling VIEW of /claims/:id,
// not a separate feature — the same address seen as structure instead of prose.
// Orientation happens here; investigation happens on the claim page.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { detail } = await loadClaim(id);
  if (!detail) return { title: "Claim map · Minerval" };
  const text = detail.claim.text;
  return {
    title: `${text.length > 80 ? `${text.slice(0, 77)}…` : text} · map · Minerval`,
    description: `The claim graph around: ${text}`,
  };
}

export default async function ClaimMapPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { detail, source } = await loadClaim(id);
  if (!detail) {
    // Same plain-language treatment as the claim page's not-found state (#195).
    return (
      <div className="col">
        <p className="sc"><Link href="/claims">← claims</Link></p>
        <h1 className="claim-hero">Claim not found.</h1>
        {source === "fixture" ? (
          <>
            <p style={{ color: "var(--muted)" }}>
              This preview is not connected to the live graph, so only a sample claim is
              available.
            </p>
            <p><Link href="/claims/inflation-2022/map">→ open the sample claim as a map</Link></p>
          </>
        ) : (
          <>
            <p style={{ color: "var(--muted)" }}>
              There is no claim at this address. The link may be mistyped or out of date.
            </p>
            <p><Link href="/claims">→ browse and search all claims</Link></p>
          </>
        )}
      </div>
    );
  }
  return <GraphView initialDetail={detail} source={source} />;
}
