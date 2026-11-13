import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  accountApiConfigured,
  getSharedPage,
  type PageView as Page,
} from "../../../lib/account-api";
import { PageHead } from "@/components/PageHead";
import { fmtDate } from "@/lib/format";
import { PageView } from "../../ask/pages/[id]/PageView";

export const dynamic = "force-dynamic";

// A page someone shared by link. Whoever holds the link reads it, signed in
// or not; it is not listed anywhere and search engines are asked to leave it.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const page = accountApiConfigured() ? await getSharedPage(token).catch(() => null) : null;
  return {
    title: page ? `${page.title} · Minerval` : "Shared page · Minerval",
    robots: { index: false, follow: false },
  };
}

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!accountApiConfigured()) notFound();
  const shared = await getSharedPage(token);
  if (!shared) notFound();
  // The reader's copy has no owner's fields; the view needs none of them.
  const page: Page = {
    ...shared,
    id: "",
    created_at: shared.saved_at,
    page_url: "",
    shared_url: null,
    versions: [],
  };
  return (
    <div className="col-wide account">
      <PageHead
        kicker="Shared page"
        title={page.title}
        meta={<>Saved {fmtDate(page.saved_at)} · made with the Minerval Assistant</>}
      />
      <PageView page={page} mode="shared" />
    </div>
  );
}
