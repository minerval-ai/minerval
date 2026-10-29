import { loadRequests } from "@/lib/data";
import { RequestIndex } from "@/components/request/Requests";

export const metadata = { title: "Requests · Minerval" };

export default async function RequestsPage() {
  const { requests } = await loadRequests();
  return <RequestIndex requests={requests} />;
}
