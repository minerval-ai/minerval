import Link from "next/link";
import { loadRequest } from "@/lib/data";
import { RequestView } from "@/components/request/Requests";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { request } = await loadRequest(id);
  if (!request) {
    return (
      <div className="col">
        <p className="sc"><Link href="/requests">← requests</Link></p>
        <h1 className="claim-hero">Request not found.</h1>
        <p style={{ color: "var(--muted)" }}>There is no request at this address.</p>
      </div>
    );
  }
  return <RequestView r={request} />;
}
