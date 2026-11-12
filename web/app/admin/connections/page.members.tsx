import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, NeedsPermission, Notice, can, viewer, when } from "@/components/admin/access";
import { fetchConnections, fetchLabels, fetchParties } from "@/lib/admin-api";
import { CONNECTION_STATE_WORDS, count } from "@/lib/admin-words";
import { addConnectionAction } from "../actions";
import { ConnectionFields } from "./ConnectionFields";

export const metadata: Metadata = { title: "Connections · Minerval" };
export const dynamic = "force-dynamic";

// The organization's own systems the deployment is connected to, so that
// agents read its data where it lives (docs/connections.md). The notice at
// the top is the API's, shown in full wherever a connection is added or
// changed.

export default async function ConnectionsPage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Connections" permission="administer" />;

  const [{ notice, connections }, labels, parties] = await Promise.all([
    fetchConnections(who.externalId),
    fetchLabels(who.externalId),
    fetchParties(who.externalId),
  ]);

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title="Connections"
        lede="Most of what an organisation knows is in a warehouse, a wiki, a ticket system or a log store, and not in documents someone will upload. A connection points this deployment at an MCP server over one such system, and the agents that weigh evidence are offered the tools you pick from it."
      />
      <AdminNav current="/admin/connections" />
      <Notice>{notice}</Notice>

      <section className="acct-section admin-first" id="connections">
        <div className="acct-head">
          <h2>Connected systems</h2>
        </div>
        {connections.length === 0 ? (
          <p className="account-empty">
            No system is connected. An administrator adds one below; nothing is offered to an agent
            until its tools have been looked at and picked.
          </p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>connection</th>
                  <th>whose system</th>
                  <th>label</th>
                  <th>state</th>
                  <th className="acct-num">tools offered</th>
                  <th className="acct-num">calls</th>
                  <th className="acct-num">kept</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => {
                  const listed = c.tools.filter((t) => t.listed);
                  const withdrawn = c.tools.filter((t) => t.withdrawn !== null).length;
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/admin/connections/${c.id}`}>{c.name}</Link>
                      </td>
                      <td>{c.party.name}</td>
                      <td>
                        <code>{c.label}</code>
                      </td>
                      <td>
                        {CONNECTION_STATE_WORDS[c.state.status] ?? c.state.status}
                        {c.state.status === "failing" && c.state.last_error && (
                          <span className="acct-detail">since {when(c.state.last_error.at)}</span>
                        )}
                        {withdrawn > 0 && (
                          <span className="acct-detail">{count(withdrawn, "tool")} withdrawn</span>
                        )}
                      </td>
                      <td className="acct-num">
                        {c.tools.filter((t) => t.offered).length} of {listed.length}
                      </td>
                      <td className="acct-num">{c.tools.reduce((n, t) => n + t.calls, 0).toLocaleString("en-GB")}</td>
                      <td className="acct-num">
                        {c.tools.reduce((n, t) => n + t.readings_kept, 0).toLocaleString("en-GB")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="acct-section" id="add">
        <div className="acct-head">
          <h2>Add a connection</h2>
        </div>
        {parties.length === 0 ? (
          <p className="account-empty">
            A connection belongs to a party, and none is recorded yet. Add the party first on{" "}
            <Link href="/admin/labels#parties">Labels and parties</Link>.
          </p>
        ) : (
          <>
            <p className="acct-prose acct-measure">
              The connection is saved with no tool offered, and its server is then asked for its
              tools so that you can pick among them. A server that does not answer yet is still
              added, and its page says why it did not. The address is your choice and is expected
              to be inside the organisation&rsquo;s network.
            </p>
            <ActionForm action={addConnectionAction} submit="Add the connection and look at its tools">
              <ConnectionFields labels={labels} parties={parties} />
            </ActionForm>
          </>
        )}
      </section>
    </div>
  );
}
