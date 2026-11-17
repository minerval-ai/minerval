import { redirect } from "next/navigation";
import { viewer } from "@/components/admin/access";
import { fetchPolicies, fetchPolicy } from "@/lib/inside-api";

export const dynamic = "force-dynamic";

// One version of a boundary's policy is now read on the boundary's page
// (gates/[id], the Policy tab): the version in force there, and an earlier
// one by its id. A policy's boundary_id is its gate's gate_id.
export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { id } = await params;
  const [policy, listed] = await Promise.all([
    fetchPolicy(who.externalId, id).catch(() => null),
    fetchPolicies(who.externalId).catch(() => []),
  ]);
  if (!policy) redirect("/gates");
  const newest = listed.find((p) => p.boundary_id === policy.boundary_id);
  const older = newest && newest.version !== policy.version;
  redirect(`/gates/${encodeURIComponent(policy.boundary_id)}?tab=policy${older ? `&policy=${encodeURIComponent(policy.policy_id)}` : ""}`);
}
