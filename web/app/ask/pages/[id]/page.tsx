import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  getPage,
  AccountApiError,
  type PageView as Page,
} from "../../../../lib/account-api";
import { PageHead } from "@/components/PageHead";
import { fmtDate } from "@/lib/format";
import { PageView } from "./PageView";

export const metadata: Metadata = { title: "Page · Minerval" };
export const dynamic = "force-dynamic";

// A page an agent saved for the user. Private: anyone else gets a 404.
export default async function AskPagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  if (!accountApiConfigured()) notFound();

  let page: Page;
  try {
    page = await getPage(session.externalId, id);
  } catch (err) {
    if (err instanceof AccountApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  return (
    <div className="col-wide account">
      <PageHead
        back={{ href: "/ask", label: "ask" }}
        kicker="Page"
        title={page.title}
        meta={<>Saved {fmtDate(page.saved_at)}</>}
      />
      <PageView key={page.saved_at} page={page} />
    </div>
  );
}
