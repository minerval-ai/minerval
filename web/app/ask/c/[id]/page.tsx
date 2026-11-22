import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  getAssistantConversation,
  AccountApiError,
  type AssistantConversationView,
} from "../../../../lib/account-api";
import { AssistantConversation } from "../../AssistantConversation";
import { loadOwlSource } from "../../../../lib/load-owl-source";
import { currentGuest } from "../../../../lib/guest";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Ask · Minerval" };
}
export const dynamic = "force-dynamic";

// One conversation with the Assistant. Private to its user: anyone else
// gets a 404, signed out a sign-in.
export default async function AskConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  // A visitor with no account sees their guest's conversations (lib/guest.ts).
  const externalId = session?.externalId ?? (await currentGuest());
  if (!externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(`/ask/c/${id}`)}`);
  if (!accountApiConfigured()) notFound();

  let convo: AssistantConversationView;
  // Where owls come from here, for the notice shown when the balance is 0.
  const owlSource = session?.externalId ? loadOwlSource(externalId) : Promise.resolve({ kind: "none" } as const);
  try {
    convo = await getAssistantConversation(externalId, id, session?.externalId ? "switch" : "self");
  } catch (err) {
    if (err instanceof AccountApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  return (
    <AssistantConversation
      key={convo.id}
      initial={convo}
      models={convo.models}
      balanceMicroUsd={convo.balance_micro_usd}
      allowedAlways={convo.allowed_kinds.always}
      kindLabels={convo.allowed_kinds.labels}
      owlSource={await owlSource}
      guest={convo.guest ?? null}
    />
  );
}
