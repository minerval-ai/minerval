import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { GrantmakerConversation } from "../../GrantmakerConversation";
import { fetchMyLabels } from "../../../../lib/admin-api";
import { loadStanding } from "../../../../lib/standing";
import { membersOnly } from "../../../../lib/members";

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
  // A members-only deployment with more than one label asks which one the mandate works at.
  const standing = await loadStanding();
  const labels =
    standing.state === "signed_in" ? await fetchMyLabels(session.externalId).catch(() => null) : null;

  return (
    <GrantmakerConversation
      key={here}
      title="A new mandate"
      labels={labels}
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
        {membersOnly() ? (
          <p className="ask-public-notice">
            <strong>Every member who reads this mandate&rsquo;s label can read this conversation</strong>, from
            your first message, whether or not you fund it: what directs the graph is open to those it directs.
          </p>
        ) : (
        <p className="ask-public-notice">
          <strong>This conversation is public from your first message</strong>, whether or not you fund it.
          Talking to a Grantmaker directs the public graph, and what directs it is public, so that anyone can
          see why work was paid for. You are shown as &ldquo;a reader&rdquo; unless you choose to be named.
          Weigh anything you would not publish with your <a href="/ask">Assistant</a> first, or in a private
          graph your organization runs.
        </p>
        )}
      </div>
    </GrantmakerConversation>
  );
}
