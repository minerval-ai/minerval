import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { CreateGrantForm } from "./CreateGrantForm";

export const metadata: Metadata = { title: "New grant — Minerval" };

// The create-mandate wizard: scope, policy, budget — three decisions.
// ?claim_id= pre-fills the scope when arriving from a claim page.
export default async function NewGrantPage({
  searchParams,
}: {
  searchParams: Promise<{ claim_id?: string }>;
}) {
  const { claim_id } = await searchParams;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");

  return (
    <div className="col account">
      <p className="claim-eyebrow">
        <Link href="/account/grants">← grants</Link>
      </p>
      <h1>Create a grant</h1>
      <p>
        Your budget escrows when the grant is created, real model spend is
        metered against it as the work runs, a grant that runs dry pauses and
        asks to top up, and whatever isn&rsquo;t spent comes back when the
        mandate completes or you cancel it.
      </p>
      <CreateGrantForm initialClaimId={claim_id ?? ""} />
    </div>
  );
}
