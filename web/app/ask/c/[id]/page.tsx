import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  getAssistantConversation,
  AccountApiError,
  type AssistantConversationView,
} from "../../../../lib/account-api";
import { PageHead } from "@/components/PageHead";
import { AssistantConversation } from "../../AssistantConversation";

export const metadata: Metadata = { title: "Ask · Minerval" };
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
  if (!session?.externalId) redirect("/signin");
  if (!accountApiConfigured()) notFound();

  let convo: AssistantConversationView;
  try {
    convo = await getAssistantConversation(session.externalId, id);
  } catch (err) {
    if (err instanceof AccountApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  return (
    <div className="col account">
      <PageHead back={{ href: "/ask", label: "ask" }} title={convo.title} />
      <AssistantConversation
        initial={convo}
        models={convo.models}
        balanceMicroUsd={convo.balance_micro_usd}
        allowedAlways={convo.allowed_kinds.always}
        kindLabels={convo.allowed_kinds.labels}
      />
    </div>
  );
}
