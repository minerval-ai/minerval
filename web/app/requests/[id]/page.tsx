import { loadRequest } from "@/lib/data";
import { RequestView } from "@/components/request/Requests";
import { PageHead } from "@/components/PageHead";

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
  return <RequestView r={request} />;
}
