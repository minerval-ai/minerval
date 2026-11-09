import type { Metadata } from "next";
import Link from "next/link";
import { loadArgument } from "@/lib/data";
import { ARGUMENT_FIXTURE_IDS } from "@/lib/fixtures-argument";
import { ArgumentView } from "@/components/argument/ArgumentView";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { page } = await loadArgument(id);
  if (!page) return { title: "Argument · Minerval" };
  const name = page.argument.name ?? "An argument";
  return {
    title: `${name.length > 80 ? `${name.slice(0, 77)}…` : name} · Minerval`,
    description: `An argument on Minerval: its reasoning, whether it follows, its premises, and where it is made.`,
  };
}

// An argument's page at a permanent URL (#541): exports, proposals and run
// logs point at arguments here, as they point at claims at /claims/:id.
export default async function ArgumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { page, source } = await loadArgument(id);
  if (!page) {
    return (
      <div className="col">
        <p className="sc"><Link href="/claims">← claims</Link></p>
        <h1 className="claim-hero">Argument not found.</h1>
        {source === "fixture" ? (
          <>
            <p style={{ color: "var(--muted)" }}>
              This preview is not connected to the live graph, so only a sample argument is available.
            </p>
            <ul>
              {ARGUMENT_FIXTURE_IDS.map((aid) => (
                <li key={aid}><Link href={`/arguments/${aid}`}>→ open the sample argument</Link></li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p style={{ color: "var(--muted)" }}>
              There is no argument at this address. The link may be mistyped or out of date.
            </p>
            <p><Link href="/claims">→ browse and search all claims</Link></p>
          </>
        )}
      </div>
    );
  }
  return <ArgumentView page={page} source={source} />;
}
