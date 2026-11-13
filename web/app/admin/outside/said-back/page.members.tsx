import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, can, viewer, when } from "@/components/admin/access";
import { british, fetchSaidBack } from "@/lib/outside-api";
import { commissionWorkAction } from "../actions";

export const metadata: Metadata = { title: "What readers said back · Minerval" };
export const dynamic = "force-dynamic";

// What readers on the public graph said about the pages this deployment
// published (docs/outward-acts.md). The contribution's own text is not
// shown here or given to any agent but one: this page shows the summary
// that one run wrote, which is what the node's Steward is given.

export default async function SaidBackPage() {
  const who = await viewer();
  if (!who) return null;
  const said = await fetchSaidBack(who.externalId);
  const fund = can(who, "fund");

  return (
    <div className="admin-page">
      <PageHead
        kicker="The public graph"
        title="What readers said back"
        lede="A reader of a page this graph published can challenge it, or propose to the node it is a page of. That is the check the public has on what it cannot see, so each one is brought back in to the Steward that can answer it."
      />
      <AdminNav current="/admin/outside/said-back" />

      <section className="acct-section admin-first" id="how">
        <div className="acct-head">
          <h2>How it comes in</h2>
        </div>
        <p className="acct-prose acct-measure">{british(said.how_it_works)}</p>
      </section>

      <section className="acct-section" id="received">
        <div className="acct-head">
          <h2>Received</h2>
          <span className="acct-note">{said.contributions.length} in all; repeats are counted once</span>
        </div>
        {said.contributions.length === 0 ? (
          <p className="account-empty">Nothing has been contributed on the public graph through a page this graph published.</p>
        ) : (
          said.contributions.map((c) => (
            <div key={c.id} className="admin-report">
              <div className="acct-sub">
                <h3>
                  {c.type.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase())} on <Link href={`/claims/${c.node_id}`}>{c.node ?? "a node"}</Link>
                </h3>
                <span className="acct-note">
                  made {when(c.submitted_at)} · received {when(c.received_at)} · {c.read}
                </span>
              </div>
              {c.summary && (
                <p className="acct-prose acct-measure">
                  <strong>The Contribution Reviewer&rsquo;s summary:</strong> {c.summary}
                </p>
              )}
              {c.repeats && <p className="acct-note">It repeats an earlier contribution and is counted with that one. It opened nothing.</p>}
              {c.set_aside_because && <p className="acct-note">Set aside: {c.set_aside_because}.</p>}
              {c.reassessment && (
                <p className="acct-note">
                  The reassessment it opened at the label the page came from: {c.reassessment}
                  {c.reassessment_as_of ? `, as of ${when(c.reassessment_as_of)}` : ""}. This is what the page&rsquo;s public record says outside.
                </p>
              )}
              {c.reading_action_id &&
                (fund ? (
                  <ActionForm action={commissionWorkAction} submit="Pay for the reading">
                    <input type="hidden" name="action_id" value={c.reading_action_id} />
                    <label>
                      Budget, in owls
                      <input name="owls" type="number" min="0.01" step="0.01" defaultValue="1" required />
                      <small>The run works to this budget, and what it does not spend comes back.</small>
                    </label>
                  </ActionForm>
                ) : (
                  <p className="acct-note">It waits to be read. The reading runs when a mandate or a person who may fund pays for it.</p>
                ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
