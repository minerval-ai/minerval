import type { Metadata } from "next";
import { loadRequest } from "@/lib/data";
import { apiConfigured, fetchClaimCards } from "@/lib/api";
import { askHeadline } from "@/lib/requests";
import { RequestView } from "@/components/request/Requests";
import { PageHead } from "@/components/PageHead";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { request } = await loadRequest(id).catch(() => ({ request: null }));
  if (!request) return { title: "Request · Minerval" };
  return { title: `${askHeadline(request.ask)} · Minerval`, description: request.why };
}

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { request } = await loadRequest(id);
  if (!request) {
    return (
      <div className="col">
        <PageHead back={{ href: "/requests", label: "requests" }} title="Request not found." />
        <p style={{ color: "var(--muted)" }}>There is no request at this address.</p>
      </div>
    );
  }
  const cards = apiConfigured() ? await fetchClaimCards(request.bears_on.map((b) => b.id)) : new Map();
  return <RequestView r={request} cards={cards} />;
}
