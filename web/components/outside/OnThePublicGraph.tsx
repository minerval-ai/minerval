import { PUBLIC_GRAPH_LABEL } from "@/lib/label-layers";
import Link from "next/link";
import { ActionForm } from "@/components/admin/ActionForm";
import { askPublicMandateAction, assessHereAction, fundPublicNodeAction } from "@/app/admin/outside/actions";
import { LabelChoice } from "@/components/admin/LabelChoice";
import { fetchMyLabels } from "@/lib/admin-api";
import { membersOnly } from "@/lib/members";
import { british, fetchPublicAccount, fetchPublicRequests } from "@/lib/outside-api";
import { holds, loadStanding } from "@/lib/standing";

// On a private deployment, under the page of a node the mirror holds: "Fund
// this on the public graph" (docs/outward-acts.md). The node's public
// assessment is the public graph's own, made on public evidence, and
// nothing here can pay for it with this deployment's owls. A person who may
// act on the public graph can pay for it there with the organisation's
// public owls, or ask one of its public mandates to. Both show outside that
// the organisation wanted this node looked at, which the form says. On the
// public site, and for a node that exists only here, this renders nothing.
export async function OnThePublicGraph({ nodeId }: { nodeId: string }) {
  if (!membersOnly()) return null;
  const standing = await loadStanding();
  if (standing.state !== "signed_in" || !standing.mine.member) return null;
  const requests = await fetchPublicRequests(standing.externalId, nodeId).catch(() => null);
  if (!requests?.node_is_on_the_public_graph) return null;
  const mayAct = holds(standing, "direct");
  // The deployment's own labels the person may file at. The node's public
  // version is the mirror's, and nothing here works at the public graph's
  // label on it.
  const mine = holds(standing, "fund") ? await fetchMyLabels(standing.externalId).catch(() => null) : null;
  const own = mine ? { ...mine, labels: mine.labels.filter((l) => l.name !== PUBLIC_GRAPH_LABEL) } : null;
  const account = mayAct ? await fetchPublicAccount(standing.externalId).catch(() => null) : null;
  const open = requests.requests.filter((r) => ["open", "addressed", "in_progress"].includes(r.state_on_the_public_graph));
  return (
    <section className="col" id="on-the-public-graph" style={{ marginTop: "2.5rem" }}>
      <h2>On the public graph</h2>
      <p className="section-note">
        This node is the public graph&rsquo;s own, read here from the mirror. Its public assessment is made there, on public
        evidence, and is paid for there in public owls.
      </p>
      {open.length > 0 && (
        <p className="section-note">
          {open.length} open request{open.length === 1 ? "" : "s"} on the public graph bear{open.length === 1 ? "s" : ""} on it:{" "}
          {open.map((r, i) => (
            <span key={r.public_request_id}>
              {i > 0 && "; "}
              {r.ask}
              {r.here.length > 0 ? " (adopted here)" : ""}
            </span>
          ))}
          . <Link href="/admin/outside/requests">Public requests</Link>
        </p>
      )}
      {own && own.must_choose && own.labels.length > 0 && (
        <ActionForm action={assessHereAction} submit="Assess it here">
          <input type="hidden" name="node_id" value={nodeId} />
          <p className="section-note">
            Or have this deployment&rsquo;s Steward assess it at one of your labels, on everything that label reads: the
            organisation&rsquo;s own judgment of the node, recorded beside the public one and read only by that label&rsquo;s readers.
            It is paid for from your balance of this deployment&rsquo;s owls, what the run does not spend comes back, and nothing is sent outside.
          </p>
          <LabelChoice mine={own} what="The label the assessment is made and read at." />
        </ActionForm>
      )}
      {mayAct && account?.connected && (
        <>
          <p className="admin-notice">{british(requests.what_funding_it_there_shows ?? "")}</p>
          <ActionForm action={fundPublicNodeAction} submit="Fund this on the public graph">
            <input type="hidden" name="node_id" value={nodeId} />
            <label>
              Budget, in public owls
              <input name="owls" type="number" min="0.01" max="100" step="0.01" required />
              <small>
                The organisation has {(account.public_owls ?? 0).toLocaleString("en-GB", { maximumFractionDigits: 2 })} public owls. What
                the run does not spend comes back there.
              </small>
            </label>
          </ActionForm>
          {(account.public_mandates ?? []).length > 0 && (
            <ActionForm action={askPublicMandateAction} submit="Ask a public mandate instead">
              <input type="hidden" name="node_id" value={nodeId} />
              <label>
                One of the organisation&rsquo;s public mandates
                <select name="mandate_id" defaultValue="">
                  <option value="" disabled>
                    Choose a mandate
                  </option>
                  {(account.public_mandates ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title ?? m.id}
                    </option>
                  ))}
                </select>
                <small>Its officers there decide whether its money pays. The request names this node and carries no words.</small>
              </label>
            </ActionForm>
          )}
        </>
      )}
      {mayAct && account && !account.connected && <p className="admin-notice">{british(account.in_words ?? "")}</p>}
      {!mayAct && <p className="section-note">A person who directs the graph can pay for a fresh public assessment of it from the organisation&rsquo;s public owls.</p>}
    </section>
  );
}
