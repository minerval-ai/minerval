import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  getGrantConversation,
  AccountApiError,
  type GrantConversationView,
} from "../../../../../lib/account-api";
import { GrantmakerConversation } from "../../../GrantmakerConversation";

export const metadata: Metadata = { title: "A mandate, in draft · Minerval" };
export const dynamic = "force-dynamic";

// A conversation with a Grantmaker that has not been funded yet: the draft
// of a mandate. Once it is funded it is the mandate's own conversation, and
// this address leads there.
export default async function DraftMandatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(`/ask/mandates/c/${id}`)}`);
  if (!accountApiConfigured()) notFound();

  let convo: GrantConversationView;
  try {
    convo = await getGrantConversation(session.externalId, id);
  } catch (err) {
    if (err instanceof AccountApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  if (convo.grant_id) redirect(`/ask/mandates/${convo.grant_id}`);

  return (
    <GrantmakerConversation
      key={convo.id}
      conversationId={convo.id}
      title={convo.mandate?.title ?? "A mandate, in draft"}
    />
  );
}
