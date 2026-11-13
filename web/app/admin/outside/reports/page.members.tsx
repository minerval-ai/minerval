import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, Notice, can, viewer, when } from "@/components/admin/access";
import { british, fetchReportsForSending, fetchStandingChoices, type ReportForSending, type StandingChoice } from "@/lib/outside-api";
import { commissionWorkAction, sendReportAction, sendReportFactsAction, setChoiceAction } from "../actions";

export const metadata: Metadata = { title: "Agents' reports · Minerval" };
export const dynamic = "force-dynamic";

// The agents' reports of problems, kept inside this deployment, and
// sending one on to Minerval's maintainers (docs/outward-acts.md). A report
// is shown with its facts in fixed words and the agent's words as they
// would go, so that the person who sends it reads exactly what leaves.

export default async function ReportsPage() {
  const who = await viewer();
  if (!who) return null;
  const [listed, choices] = await Promise.all([fetchReportsForSending(who.externalId), fetchStandingChoices(who.externalId)]);
  const release = can(who, "release");
  const direct = can(who, "direct");
  const fund = can(who, "fund");
  const offered = listed.reports.filter((r) => r.offered_for_sending);
  const kept = listed.reports.filter((r) => !r.offered_for_sending);
  const choice = (key: StandingChoice["key"]) => choices.find((c) => c.key === key)!;

  const Choice = ({ c, may }: { c: StandingChoice; may: boolean }) => (
    <div className="admin-report">
      <div className="acct-sub">
        <h3>{british(c.name)}</h3>
        <span className="acct-note">
          {c.on ? "on" : "off"}
          {c.set_by ? `, set by ${c.set_by} on ${when(c.set_at)}` : ", and nobody has set it"}
        </span>
      </div>
      <Notice>{british(c.what_it_shows_outside)}</Notice>
      {may ? (
        <ActionForm action={setChoiceAction} submit={c.on ? "Turn it off" : "Turn it on, under my name"} danger={!c.on}>
          <input type="hidden" name="key" value={c.key} />
          <input type="hidden" name="on" value={c.on ? "false" : "true"} />
        </ActionForm>
      ) : (
        <p className="acct-note">Set by {british(c.who_may_set_it)}.</p>
      )}
    </div>
  );

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
        lede="When an agent here finds that a tool fails or is missing, it files a report. On the public graph such a report goes to Minerval's maintainers. Here it stays inside, at the label of the run that wrote it, unless a person sends it on, so that Minerval can still hear when its machinery fails."
      />
      <AdminNav current="/admin/outside/reports" />

      <section className="acct-section admin-first" id="offered">
        <div className="acct-head">
          <h2>Offered for sending</h2>
          <span className="acct-note">those Audit&rsquo;s triage found to be about Minerval&rsquo;s machinery</span>
        </div>
        <Notice>{british(listed.what_sending_shows)}</Notice>
        {offered.length === 0 ? (
          <p className="account-empty">No report at a label you read is offered for sending.</p>
        ) : (
          offered.map((r) => (
            <div key={r.report_id} className="admin-report">
              <div className="acct-sub">
                <h3>{r.as_written.title}</h3>
                <span className="acct-note">
                  filed by {r.filed_by} · {r.sending?.state ?? "not yet opened"}
                </span>
              </div>
              <Facts r={r} />
              {r.sending?.as_it_would_go ? (
                <>
                  <p className="acct-note">The agent&rsquo;s words as they {r.sending.sent_at ? "went" : "would go"}:</p>
                  <pre className="admin-pre">
                    {r.sending.as_it_would_go.title}
                    {"\n\n"}
                    {r.sending.as_it_would_go.body}
                  </pre>
                  {(r.sending.removed ?? []).length > 0 && (
                    <details className="acct-asTable">
                      <summary>
                        {r.sending.removed!.length} passage{r.sending.removed!.length === 1 ? "" : "s"} removed by the Redactor, and the words as written
                      </summary>
                      <ul>
                        {r.sending.removed!.map((x, i) => (
                          <li key={i}>
                            From the {x.from}, under &ldquo;{x.category}&rdquo;: {x.note}
                          </li>
                        ))}
                      </ul>
                      <pre className="admin-pre">
                        {r.as_written.title}
                        {"\n\n"}
                        {r.as_written.body}
                      </pre>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <pre className="admin-pre">
                    {r.as_written.title}
                    {"\n\n"}
                    {r.as_written.body}
                  </pre>
                  <p className="acct-note">
                    These are the words as written. They do not go as they are: the Redactor&rsquo;s pass comes first, and runs when it is paid for
                    {r.sending?.redaction_expected_cost_owls ? ` (about ${r.sending.redaction_expected_cost_owls} owls)` : ""}.
                  </p>
                  {fund && r.sending?.redaction_action_id && (
                    <ActionForm action={commissionWorkAction} submit="Pay for the redaction">
                      <input type="hidden" name="action_id" value={r.sending.redaction_action_id} />
                      <label>
                        Budget, in owls
                        <input name="owls" type="number" min="0.01" step="0.01" defaultValue={r.sending.redaction_expected_cost_owls ?? 1} required />
                      </label>
                    </ActionForm>
                  )}
                </>
              )}
              {r.sending && !r.sending.sent_at && r.sending.as_it_would_go && release && (
                <ActionForm action={sendReportAction} submit="Send to Minerval">
                  <input type="hidden" name="sending_id" value={r.sending.sending_id} />
                </ActionForm>
              )}
              {r.sending && !r.sending.sent_at && r.sending.as_it_would_go && !release && (
                <p className="acct-note">{british(listed.who_may_send)}</p>
              )}
              {r.sending && !r.sending.facts_sent_at && r.facts.tool && direct && (
                <ActionForm action={sendReportFactsAction} submit="Send the facts alone" inline>
                  <input type="hidden" name="sending_id" value={r.sending.sending_id} />
                </ActionForm>
              )}
              {r.sending?.sent_at && (
                <p className="acct-note">
                  Sent {when(r.sending.sent_at)} by {r.sending.sent_by ?? "a person"}.
                </p>
              )}
              {r.sending?.facts_sent_at && <p className="acct-note">Its facts were sent on their own on {when(r.sending.facts_sent_at)}.</p>}
              {r.sending?.came_back && (
                <Notice>
                  What came back from Minerval&rsquo;s maintainers, as of {when(r.sending.came_back.asked_at)}: {r.sending.came_back.status}.{" "}
                  {r.sending.came_back.maintainers_note ?? "They have left no note."}
                </Notice>
              )}
            </div>
          ))
        )}
      </section>

      <section className="acct-section" id="choices">
        <div className="acct-head">
          <h2>Two standing choices</h2>
          <span className="acct-note">both off until a person turns them on</span>
        </div>
        <Choice c={choice("send_failure_facts")} may={direct} />
        <Choice c={choice("send_redacted_reports")} may={release} />
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
