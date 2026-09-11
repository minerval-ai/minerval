import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiConfigured, fetchFinding } from "../../../lib/api";
import { FindingCard, FindingSightings } from "../../../components/Findings";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const result = apiConfigured() ? await fetchFinding(id) : null;
  return {
    title: result ? `${result.finding.headline} · Minerval` : "Finding · Minerval",
    description: result ? result.finding.account.split(/\n{2,}/)[0] : undefined,
  };
}

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!apiConfigured()) {
    return (
      <div className="col">
        <p className="sc"><Link href="/findings">← findings</Link></p>
        <p>The frontend is not connected to a Minerval API, so this finding is unavailable.</p>
      </div>
    );
  }
  const result = await fetchFinding(id);
  if (!result) notFound();
  return (
    <div className="col">
      <p className="sc" style={{ marginBottom: "1.2rem" }}><Link href="/findings">← findings</Link></p>
      <FindingCard finding={result.finding} />
      <FindingSightings sightings={result.sightings} />
    </div>
  );
}
