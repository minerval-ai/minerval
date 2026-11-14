import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { AdminNav, Notice, viewer, when } from "@/components/admin/access";
import { british, fetchReportsForSending, type ReportForSending } from "@/lib/outside-api";

export const metadata: Metadata = { title: "Agents' reports · Minerval" };
export const dynamic = "force-dynamic";

// The agents' reports of problems, kept inside this deployment, and where
// each one that is about Minerval's machinery stands at the gate to outside
// (docs/outward-acts.md). A report goes to Minerval's maintainers the way
// anything written at a label goes to readers who do not read it: through
// the gate, under its setting. Approving one, where a person decides as
// well, is done on the gate's page like any other item.

export default async function ReportsPage() {
  const who = await viewer();
  if (!who) return null;
  const listed = await fetchReportsForSending(who.externalId);
  const offered = listed.reports.filter((r) => r.offered_to_the_gate);
  const kept = listed.reports.filter((r) => !r.offered_to_the_gate);

  const Facts = ({ r }: { r: ReportForSending }) => (
    <p className="acct-note">
      The facts, in fixed words: {r.facts.tool ? <code>{r.facts.tool}</code> : "no tool of Minerval's own named"} · {r.facts.kind.replace(/_/g, " ")} ·{" "}
      {r.facts.severity} · seen {r.facts.seen} time{r.facts.seen === 1 ? "" : "s"}, {r.facts.first_seen} to {r.facts.last_seen} · Minerval at migration{" "}
      {r.facts.minerval.migration}, prompt set <span className="admin-hash">{r.facts.minerval.prompt_set.slice(0, 12)}…</span>
    </p>
  );

  return (
    <div className="admin-page">
      <PageHead
        kicker="The public graph"
        title="Agents' reports"
        lede="When an agent here finds that a tool fails or is missing, it files a report. On the public graph such a report goes to Minerval's maintainers. Here it stays inside, at the label of the run that wrote it, unless it is about Minerval's machinery: then it goes to the gate to outside, so that Minerval can still hear when its machinery fails, and leaves only as that gate lets it."
      />
      <AdminNav current="/admin/outside/reports" />

      <section className="acct-section admin-first" id="offered">
        <div className="acct-head">
          <h2>At the gate to outside</h2>
          <span className="acct-note">those Audit&rsquo;s triage found to be about Minerval&rsquo;s machinery</span>
        </div>
        <Notice>{british(listed.how_a_report_goes)}</Notice>
        {offered.length === 0 ? (
          <p className="account-empty">No report at a label you read is about Minerval&rsquo;s machinery.</p>
        ) : (
          offered.map((r) => (
            <div key={r.report_id} className="admin-report">
              <div className="acct-sub">
                <h3>{r.as_written.title}</h3>
                <span className="acct-note">
                  filed by {r.filed_by} · {british(r.at_the_gate?.stands ?? "not yet offered to the gate")}
                </span>
              </div>
              <Facts r={r} />
              <pre className="admin-pre">
                {r.as_written.title}
                {"\n\n"}
                {r.as_written.body}
              </pre>
              <p className="acct-note">
                These are the words as written. What goes is what the gate lets through, with each removal marked and each held part named
                {r.at_the_gate && !r.sent ? (
                  <>
                    {" "}
                    (<Link href="/gate">the gate&rsquo;s queue</Link>).
                  </>
                ) : (
                  "."
                )}
              </p>
              {r.sent && (
                <p className="acct-note">
                  Sent {when(r.sent.at)}, filed with Minerval&rsquo;s maintainers as private.
                </p>
              )}
              {r.sent?.came_back && (
                <Notice>
                  What came back from Minerval&rsquo;s maintainers, as of {when(r.sent.came_back.asked_at)}: {r.sent.came_back.status}.{" "}
                  {r.sent.came_back.maintainers_note ?? "They have left no note."}
                </Notice>
              )}
            </div>
          ))
        )}
      </section>

      <section className="acct-section" id="kept">
        <div className="acct-head">
          <h2>Kept inside</h2>
          <span className="acct-note">{british(listed.listed)}</span>
        </div>
        {kept.length === 0 ? (
          <p className="account-empty">No other report at a label you read.</p>
        ) : (
          <table className="account-table acct-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Filed by</th>
                <th>What it is about</th>
                <th>Audit&rsquo;s note</th>
              </tr>
            </thead>
            <tbody>
              {kept.map((r) => (
                <tr key={r.report_id}>
                  <td>{r.as_written.title}</td>
                  <td>{r.filed_by}</td>
                  <td>{r.about ?? ""}</td>
                  <td>{r.audit_note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
