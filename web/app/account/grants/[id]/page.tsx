import { redirect } from "next/navigation";

// A grant and the mandate it funds are one thing, and it has one page: the
// mandate's, where its manager also sees what waits on them. This address
// is kept for links already out there.
export default async function GrantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/mandates/${encodeURIComponent(id)}`);
}
