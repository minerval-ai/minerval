import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { accountApiConfigured, fetchMandateView, type MandateDetailView } from "../../../../lib/account-api";
import { fetchMandateAllocation } from "../../../../lib/api";
import { MandatePanel } from "../../../../components/mandate/MandatePanel";
import { GrantmakerConversation } from "../../GrantmakerConversation";

export const metadata: Metadata = { title: "Its Grantmaker · Minerval" };
export const dynamic = "force-dynamic";

// A manager's conversation with their mandate's Grantmaker, beside the
// mandate at a glance. Only the manager has one: anyone else is sent to the
// mandate's public page.
export default async function MandateConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(`/ask/mandates/${id}`)}`);
  if (!accountApiConfigured()) notFound();

  // The mandate and its operations view are read together; the operations
  // view answers only for an active mandate, and is dropped for any other.
  const [read, allocationRead] = await Promise.all([
    fetchMandateView(id, session.externalId).then(
      (m) => ({ ok: true as const, mandate: m }),
      () => ({ ok: false as const })
    ),
    fetchMandateAllocation(id),
  ]);
  if (!read.ok) notFound();
  const mandate: MandateDetailView = read.mandate;
  if (!mandate.is_manager || !mandate.conversation_id) redirect(`/mandates/${id}`);
  const live = mandate.status === "active";
  const allocation = live ? allocationRead : null;
  const pace = allocation?.budget.pace;

  return (
    <GrantmakerConversation
      key={mandate.conversation_id}
      conversationId={mandate.conversation_id}
      title={mandate.title}
      mandateHref={`/mandates/${mandate.id}`}
      managing={mandate.status !== "planning" && mandate.status !== "pending_approval"}
      suggestions={
        live
          ? [
              { label: "How is it going?", text: "How is the work going, and what are you waiting on?" },
              {
                label: "Change the pace",
                text:
                  pace?.kind === "steady"
                    ? `I'd like to change the pace. It is ${pace.owls} owls every ${pace.period_hours} hours now; make it `
                    : "I'd like to set a steady pace: ",
              },
              { label: "Redirect what remains", text: "For what remains of the budget, I'd like you to " },
            ]
          : []
      }
      panel={<MandatePanel mandate={mandate} allocation={allocation} />}
    />
  );
}
