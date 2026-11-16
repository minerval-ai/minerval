import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { viewer } from "@/components/admin/access";
import { Hash, WorkNav, day } from "@/components/inside/nav";
import { fetchPolicies } from "@/lib/inside-api";

export const metadata: Metadata = { title: "Redaction policies · Minerval" };
export const dynamic = "force-dynamic";

// The redaction policies the reader may read (GET /redaction-policies): the
// newest version for each boundary a page is shown across. A boundary is a
// pair: the label a page was written at, and who it is shown to. A reader
// of the label a page is shown to reads the policy without being told the
// label it was written at, which the API does not name to them.

export default async function PoliciesPage() {
  const who = await viewer();
  if (!who) return null;
  const policies = await fetchPolicies(who.externalId);
  // Each boundary is served once for each side the reader reads; where they read both, keep the row that names the label.
  const byBoundary = new Map<string, (typeof policies)[number]>();
  for (const p of policies) {
    const had = byBoundary.get(p.boundary_id);
    if (!had || (!had.from_label && p.from_label)) byBoundary.set(p.boundary_id, p);
  }
  const rows = [...byBoundary.values()];

  return (
    <div className="admin-page">
      <PageHead
        title="Redaction policies"
        lede="When a page is shown to people who do not read the label it was written at, a Redactor removes the passages a policy covers and marks each where it stood. There is one policy for each boundary: the label the pages are written at, and who they are shown to."
      />
      <WorkNav who={who} current="/redaction-policies" />

      <section className="acct-section admin-first">
        <div className="acct-head">
          <h2>The policies you can read</h2>
        </div>
        <p className="acct-prose acct-measure">
          The policy in force at a boundary is read in full by everyone a page is shown to under it, and a page shown outside carries the
          whole text with it. So a reader on the other side can always see what kinds of thing were removed, and under what rule. You read
          the policy of every boundary whose pages are shown to a label you read, and of every boundary from a label you read.
        </p>
        {rows.length === 0 ? (
          <p className="account-empty">
            No page has been asked to be shown across a boundary you read, so none has a policy yet. A boundary&rsquo;s policy starts, the
            first time a page is asked to be shown across it, from a text that is the same for every boundary.
          </p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>pages written at</th>
                  <th>shown to</th>
                  <th>version in force</th>
                  <th>categories</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.boundary_id}>
                    <td>{p.from_label ? <code>{p.from_label}</code> : <span className="acct-detail">a label you do not read</span>}</td>
                    <td>{p.shown_to === "outside this deployment" ? "people outside this deployment" : <code>{p.shown_to}</code>}</td>
                    <td>
                      <Link href={`/redaction-policies/${p.policy_id}`}>Version {p.version}</Link>
                      <span className="acct-detail">
                        saved {day(p.saved_at)} · <Hash value={p.hash} />
                      </span>
                      {p.starting_text && <span className="acct-detail">the text every boundary starts from</span>}
                    </td>
                    <td>{p.categories.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
