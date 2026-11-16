import type { Metadata } from "next";
import { loadRequestsPage } from "@/lib/data";
import { apiConfigured, fetchClaimCards } from "@/lib/api";
import { parseRequestsView } from "@/lib/requests";
import { RequestIndex } from "@/components/request/Requests";

export const metadata: Metadata = {
  title: "Requests · Minerval",
  description:
    "Open problems the graph wants worked on: measurements, replications, datasets, documents and research that would settle what it holds open, most important first.",
};

export const revalidate = 60;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseRequestsView(await searchParams);
  const { requests, total, facets, failed } = await loadRequestsPage(view);
  // Where each request's first node stands now, beside it in the list.
  const cards = apiConfigured()
    ? await fetchClaimCards(requests.flatMap((r) => (r.bears_on[0] ? [r.bears_on[0].id] : [])))
    : new Map();
  return <RequestIndex view={view} requests={requests} total={total} facets={facets} cards={cards} failed={failed} />;
}
