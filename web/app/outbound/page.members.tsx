import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { can, viewer, when } from "@/components/admin/access";
import { WorkNav, day } from "@/components/inside/nav";
import { fetchOutbound, type OutboundNode, type OutboundPackage } from "@/lib/inside-api";
import { releaseProposalAction, sendOutsideAction, writeProposalAction } from "../showings/actions";

export const metadata: Metadata = { title: "Pages sent outside · Minerval" };
export const dynamic = "force-dynamic";

// Where each node shown outside this deployment stands on its way out
// (GET /outbound; docs/published-pages.md, "Inside the deployment"): the
// node on the public graph or its proposal there, each signed package built,
// and each time one was sent or taken as a file, with what the public graph
// answered. A person who directs sends, and is told first what a send shows
// outside.

const STATE_WORDS: Record<string, string> = {
  not_yet_assessed: "says the node is not yet assessed, and carries no page",
  released_whole: "carries the page released whole",
  released_in_part: "carries the page released in part, with each held part named in its place",
  held: "says the node's latest assessment is held, and gives none of that assessment's text. Where an earlier assessment was shown, the package still carries that page",
};

const PROPOSAL_STATE: Record<string, string> = {
  waiting_for_release: "written, and waiting to be released",
  ready: "written and released, and waiting to be sent",
  sent: "sent, and under review on the public graph",
  on_the_public_graph: "admitted: the public graph holds the node",
  not_admitted: "not admitted on the public graph",
  replaced: "replaced by later words",
};

function taken(p: OutboundPackage): boolean {
  return p.sends.some((s) => s.result === "admitted");
}

function PackageRows({ node, mayDirect }: { node: OutboundNode; mayDirect: boolean }) {
  return (
    <div className="acct-scroll">
      <table className="account-table acct-table">
        <thead>
          <tr>
            <th>package</th>
            <th>what it tells the outside</th>
            <th>sent, or carried</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {node.packages.map((p) => (
            <tr key={p.package_id}>
              <td>
                {p.sequence}
                <span className="acct-detail">built {when(p.built_at)}</span>
              </td>
              <td>It {STATE_WORDS[p.state] ?? `gives the node's state as ${p.state.replace(/_/g, " ")}`}.</td>
              <td>
                {p.sends.length === 0 ? (
                  <>Not sent. It waits here.</>
                ) : (
                  p.sends.map((s, i) => (
                    <span className="inside-line" key={i}>
                      {when(s.at)}: {s.how}
                      {s.by ? ` by ${s.by}` : ""}
                      {s.how === "sent to the public graph" ? (s.result === "admitted" ? "; it was taken" : s.result === "refused" ? "; it was refused" : "; it did not arrive") : ""}.
                      {s.the_public_graph_said && <span className="acct-detail">The public graph answered: {s.the_public_graph_said}</span>}
                    </span>
                  ))
                )}
              </td>
              <td>
                {mayDirect && (
                  <form method="post" action={`/api/outbound/packages/${p.package_id}/file`}>
                    <button className="linklike" type="submit">
                      take it as a file
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function OutboundPage() {
  const who = await viewer();
  if (!who) return null;
  const overview = await fetchOutbound(who.externalId);
  const mayDirect = can(who, "direct");
  const releaseFor = new Set(who.mine.grants.filter((g) => g.permission === "release" && g.party).map((g) => g.party!.id));
  const showings = [...new Set(overview.nodes.map((n) => n.showing_id))];

  return (
    <div className="admin-page">
      <PageHead
        title="Pages sent outside"
        lede="What a showing outside has released leaves this deployment in signed packages, each one node's page as the outside is to read it. A package is submitted to the public graph under the organisation's own account, where it is reviewed like any contribution and then weighed as a source by the node's Steward there."
      />
      <WorkNav who={who} current="/outbound" />

      <section className="acct-section admin-first" id="what-a-send-shows">
        <div className="acct-head">
          <h2>What a send shows outside</h2>
        </div>
        <ul className="inside-list acct-measure">
          <li>
            The text of each part that every party it rests on has released, with each removal marked, and for each held part its kind, who
            holds it, any reason given and since when. Nothing else of the page.
          </li>
          <li>
            The verdict with its confidence, what kinds of evidence it was made on, that each source exists, how the page was made, and the
            redaction policy in full.
          </li>
          <li>
            The record of the showing: when it was asked for and whether that was before the node was first assessed, every act on it with
            the permissions the person held, and every assessment made while it stood, the held ones as held. People are numbered, and no
            person&rsquo;s name is sent. Parties&rsquo; names are.
          </li>
          <li>
            That this organisation is attending to this node, and when. A package that says only &ldquo;held&rdquo; or &ldquo;not yet
            assessed&rdquo; still says that.
          </li>
        </ul>
        <p className="acct-prose acct-measure">
          {overview.how_sending_works.by_a_person_each_time} Where the network does not join this deployment to the public graph, a person
          takes a package as a file and submits it there by hand; the public graph checks it the same way however it arrives. Taking a file
          is recorded here with who took it. This deployment is not told what became of a package carried by hand, and has nowhere to record
          a receipt for one: that is read on the public graph.
        </p>
      </section>

      <p className="acct-prose acct-measure">
        This page is for pages. What else passes between this deployment and the public graph (the organisation&rsquo;s account there,
        public mandates, requests taken up, agents&rsquo; reports sent on) is on <Link href="/admin/outside">The public graph</Link>.
      </p>

      {overview.nodes.length === 0 && (
        <p className="account-empty">No page has been asked to be shown outside this deployment.</p>
      )}

      {showings.map((showingId) => {
        const nodes = overview.nodes.filter((n) => n.showing_id === showingId);
        const waiting = nodes.reduce((n, node) => n + node.packages.filter((p) => !taken(p)).length, 0);
        const proposalsReady = nodes.filter((n) => n.proposal?.state === "ready").length;
        const standing = nodes[0]!.sent === "as_released";
        return (
          <section className="acct-section" key={showingId} id={`showing-${showingId}`}>
            <div className="acct-head">
              <h2>{nodes[0]!.node ?? "A node you do not read"}{nodes.length > 1 ? `, and ${nodes.length - 1} under it` : ""}</h2>
            </div>
            <p className="acct-prose acct-measure">
              <Link href={`/showings/${showingId}`}>The showing</Link> has who asked and where each page stands.{" "}
              {standing
                ? "Whoever asked for it chose that each package is sent as soon as it is built, with nobody sending it; that choice is stated in every package."
                : "A person who directs the graph sends its packages."}{" "}
              {waiting + proposalsReady === 0
                ? "Nothing under it waits to be sent."
                : `${waiting} package${waiting === 1 ? "" : "s"}${proposalsReady > 0 ? ` and ${proposalsReady} proposal${proposalsReady === 1 ? "" : "s"} of a node` : ""} wait${waiting + proposalsReady === 1 ? "s" : ""} to be sent.`}
            </p>
            {mayDirect && waiting + proposalsReady > 0 && (
              <ActionForm action={sendOutsideAction} submit="Send what waits under this showing">
                <input type="hidden" name="showing_id" value={showingId} />
                <p className="admin-kept">
                  <small>
                    Sending submits each waiting package, in order, to the public graph under the organisation&rsquo;s account. What is sent
                    is then outside this deployment and is not taken back. The send is recorded here with your name and the permissions you
                    hold.
                  </small>
                </p>
              </ActionForm>
            )}

            {nodes.map((node) => (
              <div className="inside-node" key={node.node_id}>
                {nodes.length > 1 && <h3>{node.node ?? "A node you do not read"}</h3>}
                {node.waiting && <p className="acct-prose acct-measure">{node.waiting}</p>}
                {node.proposal && (
                  <div className="inside-proposal">
                    <p className="acct-prose acct-measure">
                      The words it is proposed in, written {day(node.proposal.written_at)} ({PROPOSAL_STATE[node.proposal.state] ?? node.proposal.state}):
                    </p>
                    <blockquote>{node.proposal.text}</blockquote>
                    {node.proposal.waits_on
                      .filter((p) => releaseFor.has(p.id))
                      .map((p) => (
                        <ActionForm key={p.id} action={releaseProposalAction} submit={`Release these words for ${p.name}`}>
                          <input type="hidden" name="proposal_id" value={node.proposal!.proposal_id} />
                          <input type="hidden" name="party_id" value={p.id} />
                          <p className="admin-kept">
                            <small>These words become public when they are sent, as a proposal anyone can read. A release is not taken back.</small>
                          </p>
                        </ActionForm>
                      ))}
                  </div>
                )}
                {!node.public_node_id && mayDirect && node.proposal?.state !== "sent" && node.proposal?.state !== "on_the_public_graph" && (
                  <details className="admin-args">
                    <summary>{node.proposal ? "propose it in other words" : "write the words it is proposed in"}</summary>
                    <ActionForm action={writeProposalAction} submit="Record these words">
                      <input type="hidden" name="showing_id" value={showingId} />
                      <input type="hidden" name="node_id" value={node.node_id} />
                      <label>
                        The node as it is to be proposed to the public graph
                        <textarea name="text" rows={3} />
                        <small>
                          Left blank, the node&rsquo;s own wording is used. These words are yours, and are public once sent: they go to the
                          public graph as a proposal under the organisation&rsquo;s account, which is reviewed there like anyone&rsquo;s. Each
                          party the node&rsquo;s wording rests on releases them first, unless they are word for word a wording those parties
                          already released.
                        </small>
                      </label>
                    </ActionForm>
                  </details>
                )}
                {node.public_node_id && node.packages.length === 0 && <p className="account-empty">No package has been built for it yet.</p>}
                {node.packages.length > 0 && <PackageRows node={node} mayDirect={mayDirect} />}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
