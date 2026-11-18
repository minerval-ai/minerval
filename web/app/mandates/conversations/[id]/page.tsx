import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiConfigured, fetchPublicGrantConversation } from "@/lib/api";
import { dateish } from "@/lib/account-format";
import { PageBack, PageHead } from "@/components/PageHead";
import { Prose } from "@/components/mandate/Sheet";

export const metadata: Metadata = { title: "A granting conversation · Minerval" };

// A conversation with a Grantmaker, as anyone may read it. Talking to a
// Grantmaker directs the public graph, so every conversation begun since that
// rule is public from its first message, funded or not (docs/allocation.md,
// "Directing the public graph is public"). The funder is shown by name only
// if they chose to be. A conversation held before the rule was promised
// privacy, and is not found here.
export default async function PublicGrantConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!apiConfigured()) notFound();
  const convo = await fetchPublicGrantConversation(id);
  if (!convo) notFound();
  const title = convo.draft?.title ?? "A mandate in conversation";

  return (
    <div className="col">
      <PageBack href={convo.grant_id ? `/mandates/${convo.grant_id}` : "/mandates"} label={convo.grant_id ? "The mandate" : "Mandates"} />
      <PageHead
        kicker="Granting conversation"
        title={title}
        lede={
          <>
            Between a Grantmaker and {convo.funder}, begun {dateish(convo.created_at)}.{" "}
            {convo.grant_id ? (
              <>
                It was funded, and became <Link href={`/mandates/${convo.grant_id}`}>this mandate</Link>.
              </>
            ) : convo.status === "declined" ? (
              "The Grantmaker declined to draft a mandate from it."
            ) : (
              "It has not been funded."
            )}
          </>
        }
      />
      <p className="acct-note">
        Talking to a Grantmaker directs the public graph, so the conversation is public, as the funder was told
        before they began. A Grantmaker works for the graph, and money buys attention, never a conclusion.
      </p>
      <ol className="gc-public" style={{ listStyle: "none", padding: 0, display: "grid", gap: "1.25rem" }}>
        {convo.messages.map((m, i) => (
          <li key={i}>
            <div className="sc" style={{ color: "var(--muted)", fontSize: ".8rem" }}>
              {m.role === "assistant" ? "The Grantmaker" : m.via === "assistant" ? `${convo.funder}'s Assistant` : convo.funder}
              {" · "}
              {dateish(m.at)}
            </div>
            <Prose text={m.content} />
          </li>
        ))}
      </ol>
    </div>
  );
}
