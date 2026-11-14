import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "../../../../auth";
import { accountApiConfigured, fetchMandateUpdates, fetchMandateView } from "../../../../lib/account-api";
import { dateish } from "../../../../lib/account-format";
import { Markdown } from "../../../../components/Markdown";
import { PageHead } from "@/components/PageHead";
import { Sheet } from "../../../../components/mandate/Sheet";

export const metadata: Metadata = { title: "Mandate updates · Minerval" };
export const dynamic = "force-dynamic";

// Every update a mandate's Grantmaker has left on its record, newest first.
// The mandate's own page shows the latest; this is how a reader goes back
// through how it got where it is.

const PER_PAGE = 10;

export default async function MandateUpdatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  if (!accountApiConfigured()) notFound();
  const session = await auth();
  const viewer = session?.externalId ?? null;
  let title: string;
  try {
    title = (await fetchMandateView(id, viewer)).title;
  } catch {
    notFound();
  }
  const asked = Number((await searchParams).page);
  const page = Number.isInteger(asked) && asked > 1 ? asked : 1;
  const { total, updates } = await fetchMandateUpdates(id, { offset: (page - 1) * PER_PAGE, limit: PER_PAGE }, viewer);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="mnd">
      <PageHead
        back={{ href: `/mandates/${id}`, label: "the mandate" }}
        kicker="Mandate"
        title="Its Grantmaker&rsquo;s updates"
        meta={title}
        lede="At the end of each sitting a mandate&rsquo;s Grantmaker writes what woke it, what it found, what it did and what comes next. The mandate keeps its latest hundred."
      />
      {updates.length === 0 ? (
        <p className="acct-note">{page > 1 ? "There are no updates this far back." : "Its Grantmaker has written none yet."}</p>
      ) : (
        <div className="mnd-sheets mnd-updates">
          {updates.map((u, i) => (
            <Sheet key={`${u.at}-${i}`} label={dateish(u.at)} by="written by its Grantmaker">
              <Markdown>{u.note}</Markdown>
            </Sheet>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="acct-pager">
          <span className="acct-num">
            Page {page} of {pages} · {total} updates
          </span>
          <nav className="mnd-pages" aria-label="Pages of updates">
            {page > 1 && <Link href={`/mandates/${id}/updates${page > 2 ? `?page=${page - 1}` : ""}`}>← Newer</Link>}
            {page < pages && <Link href={`/mandates/${id}/updates?page=${page + 1}`}>Older →</Link>}
          </nav>
        </div>
      )}
    </div>
  );
}
