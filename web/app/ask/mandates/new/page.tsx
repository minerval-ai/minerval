import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { GrantmakerConversation } from "../../GrantmakerConversation";

export const metadata: Metadata = { title: "Start a mandate · Minerval" };

// A mandate is made by talking, not by filling in a form: a Grantmaker
// drafts it in conversation, quotes its cost in owls, and can decline one
// that would compromise the graph. ?claim_id= seeds the first message when
// arriving from a node's page.
export default async function StartMandatePage({
  searchParams,
}: {
  searchParams: Promise<{ claim_id?: string }>;
}) {
  const { claim_id } = await searchParams;
  const session = await auth();
  const here = `/ask/mandates/new${claim_id ? `?claim_id=${encodeURIComponent(claim_id)}` : ""}`;
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(here)}`);
  const claim = claim_id && /^[0-9a-f-]{36}$/i.test(claim_id) ? claim_id : null;

  return (
    <GrantmakerConversation
      key={here}
      title="A new mandate"
      initialDraft={claim ? `I want to fund work on the area around claim ${claim}.` : ""}
    >
      <div className="ask-welcome">
        <h2>What should this mandate accomplish?</h2>
        <p>
          Tell a Grantmaker what you want the graph to pay attention to: a topic that deserves coverage, a
          claim whose subtree deserves depth, a literature to bring in, a standing interest to keep fresh. It
          surveys what the graph holds, asks what it needs to, and proposes a mandate with its cost in owls.
        </p>
        <p>
          Talking costs nothing. Your owls are escrowed only when you fund the proposal, and what the work does
          not spend comes back. A Grantmaker works for the graph: it declines a mandate designed to steer
          conclusions.
        </p>
      </div>
    </GrantmakerConversation>
  );
}
