import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { can, viewer } from "@/components/admin/access";
import { WorkNav, day } from "@/components/inside/nav";
import { fetchShowing, fetchShowings, type ShownShowing, type ShownVersion } from "@/lib/inside-api";
import { stateOfVersion } from "@/lib/inside-words";

export const metadata: Metadata = { title: "Showings · Minerval" };
export const dynamic = "force-dynamic";

// Every showing the reader may see (GET /showings): pages shown to a label
// they read, or outside, and pages asked to be shown from a label they read
// (docs/showing-a-page.md). The first list is what the people a page is
// shown to are told; the second is where each page's redaction stands, for
// the people at the label it was written at.

/** The newest version that is shown, where the latest is not. */
function earlierShown(versions: ShownVersion[]): ShownVersion | undefined {
  return versions.find((v) => v.state === "released_whole" || v.state === "released_in_part");
}

export default async function ShowingsPage() {
  const who = await viewer();
  if (!who) return null;
  const { shown, asked } = await fetchShowings(who.externalId);
  const details = new Map<string, ShownShowing>();
  await Promise.all(
    shown.map(async (s) => {
      const d = await fetchShowing(who.externalId, s.showing_id).catch(() => null);
      if (d) details.set(s.showing_id, d);
    })
  );

  return (
    <div className="admin-page">
      <PageHead
        title="Showings"
        lede="A page written at one label can be shown to people who do not read that label, or to people outside this deployment, without showing them the evidence it rests on. They are given the page as its Steward wrote it, with the passages a redaction policy covers removed and marked, and with any part that is held back named in its place."
      />
      <WorkNav who={who} current="/showings" />

      <section className="acct-section admin-first" id="shown">
        <div className="acct-head">
          <h2>Shown to you, or outside</h2>
        </div>
        <p className="acct-prose acct-measure">
          Pages shown to a label you read, and pages shown outside this deployment, which every member may see as the outside does. Each
          node under a showing is in one of four states: not yet assessed, released whole, released in part, or held.
        </p>
        {shown.length === 0 ? (
          <p className="account-empty">No page has been asked to be shown to a label you read, or outside.</p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>node</th>
                  <th>shown to</th>
                  <th>how</th>
                  <th>asked for</th>
                  <th>where it stands</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const d = details.get(s.showing_id);
                  const node = d?.nodes.find((n) => n.node_id === s.node_id) ?? d?.nodes[0];
                  const latest = node?.versions[0];
                  const more = (d?.nodes.length ?? 1) - 1;
                  return (
                    <tr key={s.showing_id}>
                      <td>
                        <Link href={`/showings/${s.showing_id}`}>{node?.text ?? "A node you do not read"}</Link>
                        {more > 0 && <span className="acct-detail">and {more} under it</span>}
                      </td>
                      <td>{s.shown_to}</td>
                      <td>
                        {s.form}
                        <span className="acct-detail">{s.scope === "under" ? "with what sits under it" : "this node alone"}</span>
                      </td>
                      <td>
                        {day(s.asked_at)}
                        {s.ended_at && <span className="acct-detail">ended {day(s.ended_at)}</span>}
                      </td>
                      <td>
                        {latest ? stateOfVersion(latest) : "Not yet assessed"}
                        {latest?.state === "held" && earlierShown(node?.versions ?? []) && (
                          <span className="acct-detail">
                            That is its latest assessment. The one of {day(earlierShown(node!.versions)!.version_of)} before it is shown:{" "}
                            {stateOfVersion(earlierShown(node!.versions)!).toLowerCase()}.
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="acct-section" id="asked">
        <div className="acct-head">
          <h2>Asked for at a label you read</h2>
        </div>
        <p className="acct-prose acct-measure">
          Pages written at a label you read that someone has asked to be shown elsewhere, with where each stands on its way: its redaction,
          the check of the redaction, and the release queue. The redaction and its check are each a run that happens when someone pays for
          it.
        </p>
        {asked.length === 0 ? (
          <p className="account-empty">
            No page at a label you read has been asked to be shown.{" "}
            {can(who, "direct")
              ? "You can ask from a node's page: open the assessment made at the label, and follow “Ask for this page to be shown”."
              : "A person who holds the permission to direct asks, from a node's page."}
          </p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>node</th>
                  <th>written at</th>
                  <th>shown to</th>
                  <th>how</th>
                  <th>where its latest page stands</th>
                </tr>
              </thead>
              <tbody>
                {asked.map((a) => {
                  const latest = a.pages.find((p) => p.stage !== "overtaken") ?? a.pages[0];
                  return (
                    <tr key={a.showing_id}>
                      <td>
                        <Link href={`/showings/${a.showing_id}`}>{a.node ?? "A node you do not read"}</Link>
                      </td>
                      <td>
                        <code>{a.page_label}</code>
                      </td>
                      <td>{a.shown_to === "outside this deployment" ? a.shown_to : <code>{a.shown_to}</code>}</td>
                      <td>
                        {a.form}
                        <span className="acct-detail">{a.scope === "under" ? "with what sits under it" : "this node alone"}</span>
                        {a.ended_at && <span className="acct-detail">ended {day(a.ended_at)}</span>}
                      </td>
                      <td>{latest ? `${latest.stage_in_words.charAt(0).toUpperCase()}${latest.stage_in_words.slice(1)}.` : "No page has been recorded yet."}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
