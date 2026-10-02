import type { Metadata } from "next";
import Link from "next/link";
import { loadSourcePage } from "@/lib/data";
import { SOURCE_FIXTURE_IDS } from "@/lib/fixtures-source";
import { SourceView } from "@/components/source/SourceView";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { page } = await loadSourcePage(id);
  if (!page) return { title: "Source · Minerval" };
  const title = page.facts.source.title;
  return {
    title: `${title.length > 80 ? `${title.slice(0, 77)}…` : title} · Minerval`,
    description: `A source on Minerval: its record, its text with each claim's reading, and its examinations. ${title}`,
  };
}

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { page, source } = await loadSourcePage(id);
  if (!page) {
    // Plain language either way, as on the claim page (#195); the offline
    // preview names its sample sources instead.
    return (
      <div className="col">
        <p className="sc"><Link href="/claims">← claims</Link></p>
        <h1 className="claim-hero">Source not found.</h1>
        {source === "fixture" ? (
          <>
            <p style={{ color: "var(--muted)" }}>
              This preview is not connected to the live graph, so only sample sources are available.
            </p>
            <ul>
              {SOURCE_FIXTURE_IDS.map((sid) => (
                <li key={sid}><Link href={`/sources/${sid}`}>→ {sid.replace(/-/g, " ")}</Link></li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p style={{ color: "var(--muted)" }}>
              There is no source at this address. The link may be mistyped or out of date.
            </p>
            <p><Link href="/claims">→ browse and search all claims</Link></p>
          </>
        )}
      </div>
    );
  }
  return <SourceView page={page} source={source} />;
}
