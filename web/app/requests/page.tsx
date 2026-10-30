import { loadRequests } from "@/lib/data";
import { RequestIndex } from "@/components/request/Requests";

export const metadata = { title: "Requests · Minerval" };

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = (await searchParams).q?.trim() ?? "";
  const { requests } = await loadRequests(q);
  return <RequestIndex requests={requests} q={q} />;
}
