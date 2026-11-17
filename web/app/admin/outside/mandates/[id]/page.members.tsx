import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import { Card, Empty, Kv, Pill, WorkHead, WorkPage, owls, plural, shortWhen, type Tone } from "@/components/work/ui";
import { british, fetchPublicConversation } from "@/lib/outside-api";
import { fundPublicMandateAction, sayToGrantmakerAction } from "../../actions";
import { HeadSub, Note, loadAccount, tryRead } from "../../parts";

export const metadata: Metadata = { title: "Public mandate · Minerval" };
export const dynamic = "force-dynamic";

// The organisation's conversation with the public graph's Grantmaker about a
// new public mandate, as the public graph serves it to the organisation's
// account. What a person writes here is sent as written. Paying for the drafted
// mandate spends public owls and makes it public.

interface Message {
  role?: string;
  content?: string;
  text?: string;
  at?: string;
}

interface Draft {
  title?: string;
  objective?: string;
  expected_cost_owls?: number;
  warnings?: Array<string | { message?: string; text?: string }>;
}

const STATUS: Record<string, { tone: Tone; text: string }> = {
  active: { tone: "info", text: "Draft" },
  proposed: { tone: "info", text: "Drafted · not funded" },
  funded: { tone: "ok", text: "Funded" },
  declined: { tone: "bad", text: "Declined" },
  abandoned: { tone: "neu", text: "Abandoned" },
};

export default async function PublicMandateConversation({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct")) return <NeedsPermission title="Public mandate" permission="direct" />;
  const { id } = await params;
  const [{ data: account, problem: accountProblem }, { data: conversation, problem }] = await Promise.all([
    loadAccount(who.externalId),
    tryRead(() => fetchPublicConversation(who.externalId, id), "The conversation could not be read from the public graph"),
  ]);
  const body = (conversation?.conversation ?? conversation ?? {}) as Record<string, any>;
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  const turn = (body.turn ?? conversation?.turn ?? {}) as { state?: string; error?: string };
  const mandate = (body.mandate ?? conversation?.mandate ?? null) as Draft | null;
  const status = typeof body.status === "string" ? body.status : null;
  const pageUrl = typeof body.page_url === "string" ? body.page_url : null;
  const replying = turn.state === "replying";
  const funded = status === "funded" || !!body.grant_id;
  const title = mandate?.title ?? "New public mandate";
  const balance = account?.connected ? (account.public_owls ?? 0) : null;
  const warnings = (mandate?.warnings ?? []).map((w) => (typeof w === "string" ? w : (w.message ?? w.text ?? ""))).filter(Boolean);
  const pill = status ? STATUS[status] : null;

  return (
    <WorkPage>
      <WorkHead
        crumbs={[
          { href: "/admin/outside", label: "Public graph" },
          { href: "/admin/outside#mandates", label: "Mandates" },
        ]}
        title={title}
        sub={
          <HeadSub account={account} problem={accountProblem}>
            {pill && <Pill tone={pill.tone}>{pill.text}</Pill>} {body.created_at ? `Started ${shortWhen(body.created_at)} · the` : "The"} conversation is
            on the public graph
          </HeadSub>
        }
        actions={
          pageUrl && (
            <a className="w-btn" href={pageUrl} target="_blank" rel="noreferrer">
              View on public graph ↗
            </a>
          )
        }
      />

      {accountProblem && <Note tone="bad">{accountProblem}</Note>}
      {account && !account.connected ? (
        <Note tone="warn">{british(account.in_words ?? "This deployment is not connected to the public graph.")}</Note>
      ) : (
        problem && <Note tone="bad">{problem}</Note>
      )}

      <div className="w-grid2">
        <section className="w-card" aria-label="Conversation">
          <div className="w-card-h">
            Conversation
            <span className="w-spacer w-faint" style={{ fontWeight: 400 }}>
              {plural(messages.length, "message")} · public Grantmaker
            </span>
          </div>
          {messages.length === 0 && !replying && <Empty>Nothing has been said yet.</Empty>}
          {messages.map((m, i) => {
            const ours = m.role === "user" || m.role === "funder";
            return (
              <div key={i} className="w-pub-msg">
                <div className="w-pub-msg-a">
                  <span className="w-avatar">{ours ? "Org" : "G"}</span>
                  {ours ? (account?.account?.name ?? "The organisation") : "Public Grantmaker"}
                  {m.at && <time dateTime={m.at}>{shortWhen(m.at)}</time>}
                </div>
                <p>{m.content ?? m.text ?? ""}</p>
              </div>
            );
          })}
          {replying && (
            <div className="w-pub-msg w-muted w-small">
              <div className="w-pub-msg-a">
                <span className="w-avatar">G</span>
                <span className="w-muted" style={{ fontWeight: 400 }}>
                  The Grantmaker is replying… <Link href={`/admin/outside/mandates/${id}`}>Reload</Link>
                </span>
              </div>
            </div>
          )}
          {turn.state === "failed" && (
            <div className="w-pub-msg">
              <Note tone="bad">
                The Grantmaker&apos;s turn did not finish: {turn.error ?? "no reason given"}. A short message asks it again.
              </Note>
            </div>
          )}
          {!funded && account?.connected !== false && (
            <div className="w-card-b" style={{ borderTop: "1px solid var(--w-rule)" }}>
              <WorkForm action={sayToGrantmakerAction} submit="Send" lock="Sent as written, and public">
                <input type="hidden" name="conversation_id" value={id} />
                <div className="w-field">
                  <label htmlFor="say">Write to the public Grantmaker</label>
                  <textarea id="say" className="w-input" name="message" rows={4} required maxLength={10000} placeholder="Your words, as the public will read them" />
                  <span className="w-help">Sent under the organisation&apos;s account. Nothing from this deployment is added.</span>
                </div>
              </WorkForm>
            </div>
          )}
        </section>

        <aside className="w-col">
          <Card title={<>Draft mandate {mandate?.title && pill && <Pill tone={pill.tone}>{pill.text}</Pill>}</>}>
            {mandate?.title ? (
              <div className="w-col" style={{ gap: 12 }}>
                <Kv
                  rows={[
                    ["Title", mandate.title],
                    ["Objective", mandate.objective ? <span className="w-small">{mandate.objective}</span> : "—"],
                    mandate.expected_cost_owls !== undefined && ["Expected cost", `${owls(mandate.expected_cost_owls)} public owls`],
                    ["Funder", account?.account?.name ?? "The organisation"],
                    body.updated_at && ["Updated", <span className="w-muted" key="u">{shortWhen(body.updated_at)}</span>],
                  ]}
                />
                {warnings.length > 0 && (
                  <Note tone="warn">
                    <span>
                      The Grantmaker warns: {warnings.map(british).join(" ")}
                    </span>
                  </Note>
                )}
              </div>
            ) : (
              <span className="w-muted w-small">Nothing drafted yet. The Grantmaker drafts the mandate as the conversation goes.</span>
            )}
          </Card>

          {mandate?.title && !funded && (
            <Card title="Fund">
              <WorkForm action={fundPublicMandateAction} submit="Fund with public owls" primary lock="Public at once: scope, funder, budget · unspent owls return">
                <input type="hidden" name="conversation_id" value={id} />
                <div className="w-field">
                  <label htmlFor="budget">Budget (public owls)</label>
                  <input
                    id="budget"
                    className="w-input"
                    name="owls"
                    type="number"
                    min="1"
                    step="1"
                    required
                    defaultValue={mandate.expected_cost_owls ? Math.ceil(mandate.expected_cost_owls) : undefined}
                  />
                  <span className="w-help">{balance !== null ? `${owls(balance)} public owls available` : "The balance could not be read"}</span>
                </div>
                {replying && <span className="w-help">The draft may still change: the Grantmaker is replying.</span>}
              </WorkForm>
            </Card>
          )}

          {funded && (
            <Note tone="ok">
              Funded. The mandate is public on the public graph.
              {typeof body.mandate_page_url === "string" && (
                <a href={body.mandate_page_url} target="_blank" rel="noreferrer">
                  Mandate page ↗
                </a>
              )}
            </Note>
          )}

          <Link className="w-small" href="/admin/outside#mandates">
            ← Back to public mandates
          </Link>
        </aside>
      </div>
    </WorkPage>
  );
}
