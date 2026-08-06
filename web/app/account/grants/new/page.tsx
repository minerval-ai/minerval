import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { GrantConversation } from "./GrantConversation";

export const metadata: Metadata = { title: "New grant — Minerval" };

// Grants are made by talking, not by form: the Grantmaker agent designs the
// mandate in conversation, quotes its cost in owls, and can refuse mandates
// that would compromise the graph. ?claim_id= seeds the opening message
// when arriving from a claim page.
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
        Tell the Grantmaker what you want the graph to pay attention to. It
        will survey what exists, ask what it needs to, and propose a concrete
        mandate with an honest price in owls. Talking costs nothing; your
        budget escrows only when you fund the proposal, and whatever the work
        doesn&rsquo;t spend comes back. One thing to know going in: the
        Grantmaker works for the integrity of the graph, so it will decline
        any mandate designed to steer conclusions rather than fund attention.
      </p>
      <GrantConversation initialClaimId={claim_id ?? ""} />
    </div>
  );
}
