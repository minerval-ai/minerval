import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { loadClaim, loadFeatures, loadMergedFrom } from "@/lib/data";
import { mergedFromParam, mergedRedirectPath } from "@/lib/merged";
import { claimPreview, describePreview, truncateText } from "@/lib/preview";
import { ClaimMargins } from "@/components/claim/ClaimMargins";
import { MergedFromNote } from "@/components/claim/MergedFromNote";
import { PageHead } from "@/components/PageHead";

// What a pasted link to this page unfurls into: the claim as the title, and
// the graph's judgment of it, whole, as the description (lib/preview.ts). The
// card image is drawn by ./opengraph-image.tsx, which Next attaches to both
// the Open Graph and the Twitter tags. loadClaim is memoized per render, so
// this and the page read the claim once.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { detail } = await loadClaim(id);
  if (!detail) return { title: "Claim not found · Minerval" };
  const preview = claimPreview(detail);
  const description = describePreview(preview);
  const url = `/claims/${detail.claim.id}`;
  // Social titles run longer than a tab title before a platform cuts them.
  const socialTitle = truncateText(preview.text, 200);
  return {
    title: `${truncateText(preview.text, 80)} · Minerval`,
    description,
    alternates: { canonical: url },
    openGraph: { type: "article", siteName: "Minerval", url, title: socialTitle, description },
    twitter: { card: "summary_large_image", title: socialTitle, description },
  };
}

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ merged_from?: string | string[] }>;
}) {
  const { id } = await params;
  const { detail, source } = await loadClaim(id);
  // A claim that was merged into another keeps its address (#884): the
  // reader lands on the survivor's page, which says where they came from.
  const survivorPath = mergedRedirectPath(detail, id);
  if (survivorPath) redirect(survivorPath);
  if (!detail) {
    // Reader-facing, so plain language either way; the fixture case (no API
    // configured, e.g. a local design preview) gets one extra sentence of
    // explanation instead of internal vocabulary (#195).
    return (
      <div className="col">
        <PageHead back={{ href: "/claims", label: "claims" }} title="Claim not found." />
        {source === "fixture" ? (
          <>
            <p style={{ color: "var(--muted)" }}>
              This preview is not connected to the live graph, so only a sample claim is
              available.
            </p>
            <p><Link href="/claims/inflation-2022">→ open the sample claim</Link></p>
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
  const mergedFrom = await loadMergedFrom(
    detail.claim.id,
    mergedFromParam((await searchParams).merged_from),
  );
  return (
    <>
      {mergedFrom && <MergedFromNote from={mergedFrom} />}
      <ClaimMargins detail={detail} source={source} features={await loadFeatures()} />
    </>
  );
}
