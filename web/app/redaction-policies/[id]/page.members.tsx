import { redirect } from "next/navigation";
import { viewer } from "@/components/admin/access";
import { fetchPolicy } from "@/lib/inside-api";

export const dynamic = "force-dynamic";

// One version of a boundary's policy is now read on the boundary's page
// (gates/[id], the Policy tab), whose versions rail lists every version by
// its number. A policy's boundary_id is its gate's gate_id.
export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { id } = await params;
  const policy = await fetchPolicy(who.externalId, id).catch(() => null);
  if (!policy) redirect("/gates");
  redirect(`/gates/${encodeURIComponent(policy.boundary_id)}?tab=policy${policy.in_force ? "" : `&version=${policy.version}`}`);
}
