import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, NeedsPermission, Notice, can, viewer } from "@/components/admin/access";
import { fetchPublicConversation } from "@/lib/outside-api";
import { fundPublicMandateAction, sayToGrantmakerAction } from "../../actions";

export const metadata: Metadata = { title: "A new public mandate · Minerval" };
export const dynamic = "force-dynamic";

// The organisation's conversation with the public graph's Grantmaker about
// a new public mandate, as the public graph serves it to the organisation's
// account. What a person writes here is sent as written. Paying for the
// drafted mandate spends public owls and makes it public.

interface Message {
  role?: string;
  content?: string;
  text?: string;
}

export default async function PublicMandateConversation({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct")) return <NeedsPermission title="A new public mandate" permission="direct" />;
  const { id } = await params;
  let conversation: Record<string, any> | null = null;
  let problem: string | null = null;
  try {
    conversation = await fetchPublicConversation(who.externalId, id);
  } catch (err) {
    problem = err instanceof Error ? err.message : "The public graph did not answer.";
  }
  const body = (conversation?.conversation ?? conversation ?? {}) as Record<string, any>;
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  const turn = (body.turn ?? conversation?.turn ?? {}) as { state?: string; error?: string };
  const mandate = (body.mandate ?? conversation?.mandate ?? null) as { title?: string; objective?: string } | null;

  return (
    <div className="admin-page">
      <PageHead
        kicker="The public graph"
        title="A new public mandate"
        lede="This conversation is on the public graph, between the organisation's account and the public Grantmaker. The mandate it drafts is public once it is funded."
      />
      <AdminNav current="/admin/outside" />

      <section className="acct-section admin-first">
        <p className="acct-prose">
          <Link href="/admin/outside#mandates">Back to the organisation&rsquo;s public mandates</Link>
        </p>
        {problem && <Notice>{problem}</Notice>}
        {messages.map((m, i) => (
          <div key={i} className="admin-report">
            <div className="acct-sub">
              <h3>{m.role === "user" || m.role === "funder" ? "The organisation" : "The public Grantmaker"}</h3>
            </div>
            <p className="acct-prose acct-measure" style={{ whiteSpace: "pre-wrap" }}>
              {m.content ?? m.text ?? ""}
            </p>
          </div>
        ))}
        {turn.state === "replying" && <p className="account-empty">The public Grantmaker is writing its reply. Reload this page in a moment.</p>}
        {turn.state === "failed" && <Notice>The public Grantmaker&rsquo;s turn did not finish: {turn.error ?? "no reason given"}. A short message asks it again.</Notice>}
      </section>

      {mandate?.title && (
        <section className="acct-section">
          <div className="acct-head">
            <h2>The mandate as drafted</h2>
          </div>
          <p className="acct-prose acct-measure">
            <strong>{mandate.title}</strong>
            {mandate.objective ? `: ${mandate.objective}` : ""}
          </p>
          <Notice>
            Funding it escrows the budget from the organisation&rsquo;s public owls and starts the mandate on the public
            graph. It is public at once: its scope, its funder and its budget. What it does not spend comes back to
            the organisation&rsquo;s public balance.
          </Notice>
          <ActionForm action={fundPublicMandateAction} submit="Fund it with public owls">
            <input type="hidden" name="conversation_id" value={id} />
            <label>
              Budget, in public owls
              <input name="owls" type="number" min="1" step="1" required />
            </label>
          </ActionForm>
        </section>
      )}

      <section className="acct-section">
        <div className="acct-head">
          <h2>Write to the public Grantmaker</h2>
        </div>
        <ActionForm action={sayToGrantmakerAction} submit="Send">
          <input type="hidden" name="conversation_id" value={id} />
          <label>
            In your own words
            <textarea name="message" rows={4} required maxLength={10000} />
            <small>Sent as you write it, under the organisation&rsquo;s account. Nothing from this deployment is added.</small>
          </label>
        </ActionForm>
      </section>
    </div>
  );
}
