import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { AdminNav, viewer, when } from "@/components/admin/access";
import { british, fetchSaidBack } from "@/lib/outside-api";

export const metadata: Metadata = { title: "What readers said back · Minerval" };
export const dynamic = "force-dynamic";

// What readers on the public graph said about the pages this deployment
// published (docs/outward-acts.md). Each is shown as it was made, which is
// what the node's Steward is given: it is public text on the public graph.

export default async function SaidBackPage() {
  const who = await viewer();
  if (!who) return null;
  const said = await fetchSaidBack(who.externalId);

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
                  made {when(c.submitted_at)} · received {when(c.received_at)}
                  {c.given_to_the_steward_at ? ` · given to the node’s Steward ${when(c.given_to_the_steward_at)}` : ""}
                </span>
              </div>
              {c.text_written_outside_this_deployment !== undefined && (
                <>
                  <p className="acct-note">
                    As it was written on the public graph, outside this deployment (contribution <code>{c.on_the_public_graph}</code> there):
                  </p>
                  <blockquote className="acct-prose acct-measure" style={{ whiteSpace: "pre-wrap" }}>
                    {c.text_written_outside_this_deployment}
                  </blockquote>
                  {(c.addresses_it_cites ?? []).length > 0 && (
                    <p className="acct-note">Addresses it cites: {(c.addresses_it_cites ?? []).join(" · ")}</p>
                  )}
                </>
              )}
              {c.repeats && <p className="acct-note">Its text is the same as an earlier contribution&rsquo;s, so it is counted with that one. It opened nothing.</p>}
              {c.reassessment && (
                <p className="acct-note">
                  The reassessment it opened at the label the page came from: {c.reassessment}
                  {c.reassessment_as_of ? `, as of ${when(c.reassessment_as_of)}` : ""}. This is what the page&rsquo;s public record says outside.
                </p>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
