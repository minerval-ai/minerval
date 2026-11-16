import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, NeedsPermission, Notice, can, viewer, when } from "@/components/admin/access";
import { fetchUsageReports, type OutgoingUsageReports, type UsageReport } from "@/lib/admin-api";
import { count } from "@/lib/admin-words";
import { sendUsageReportsAction } from "../actions";

export const metadata: Metadata = { title: "The usage report · Minerval" };
export const dynamic = "force-dynamic";

// What this deployment reports to the public graph of its own owl spend
// (docs/usage-report.md), exactly as the API describes it: what a report
// says and never says are the API's sentences, and each report is shown as
// the text that is sent, before it is sent and after.

export default async function UsageReportPage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="The usage report" permission="administer" />;

  const outgoing = await fetchUsageReports(who.externalId);
  const unsent = outgoing.reports.filter((r) => r.sent_at === null);

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title="The usage report"
        lede="On the metered price, a private deployment reports to the public graph the owls its agents' runs spent each day, as one total, because that price is in proportion to it. This page shows everything that leaves the deployment for that purpose."
      />
      <AdminNav current="/admin/usage-report" />

      <section className="acct-section admin-first" id="what">
        <div className="acct-head">
          <h2>What is sent, and what never is</h2>
          <span className="acct-note">
            price in force: {outgoing.price === "metered" ? "metered on use" : "flat"}
          </span>
        </div>
        <Notice>{outgoing.what_is_sent}</Notice>
        {outgoing.what_is_never_sent && <Notice>{outgoing.what_is_never_sent}</Notice>}
        {outgoing.corrections && <p className="acct-prose acct-measure">{outgoing.corrections}</p>}
      </section>

      {outgoing.reporting && (
        <>
          <section className="acct-section" id="where">
            <div className="acct-head">
              <h2>Where reports go</h2>
            </div>
            <Destination destination={outgoing.destination} />
            <div className="acct-cols">
              <div className="acct-main">
                <h3>Prepare and send now</h3>
                <p className="acct-prose acct-measure">
                  The deployment does this by itself on a schedule: it writes a report for each
                  day that has ended and has none, and sends what has not been sent, oldest first.
                  This does the same now.
                </p>
                <ActionForm action={sendUsageReportsAction} submit="Prepare and send now">
                  <label>
                    Count again from this day
                    <input name="recount_from" type="date" />
                    <small>
                      Leave empty unless a day&rsquo;s figure may be wrong. Each day from this one
                      on is counted again, and a day whose count has changed gets a correction as a
                      new report.
                    </small>
                  </label>
                </ActionForm>
              </div>
            </div>
          </section>

          <section className="acct-section" id="reports">
            <div className="acct-head">
              <h2>Every report, as sent</h2>
              <span className="acct-note">
                {count(outgoing.reports.length, "report")}
                {unsent.length > 0 && `, ${unsent.length} not yet sent`}
              </span>
            </div>
            {outgoing.reports.length === 0 ? (
              <p className="account-empty">
                No report has been prepared yet. A report is made only of a day that has ended.
              </p>
            ) : (
              outgoing.reports.map((report) => <Report key={report.id} report={report} />)
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Destination({ destination }: { destination: OutgoingUsageReports["destination"] }) {
  if (destination.kind === "online") {
    return (
      <p className="acct-prose acct-measure">
        Reports are sent to <code>{destination.url}</code>, under the organisation&rsquo;s account on
        the public graph.{" "}
        {destination.ready
          ? "The key they are sent under is set."
          : "The key they are sent under (USAGE_REPORT_API_KEY) is not set, so nothing can be sent yet."}
      </p>
    );
  }
  if (destination.kind === "file") {
    return (
      <p className="acct-prose acct-measure">
        Each report is written as a file in <code>{destination.directory}</code>, to be handed over.
        A file is the report and nothing else, and whoever hands it over posts it under the
        organisation&rsquo;s account on the public graph.
      </p>
    );
  }
  return (
    <p className="account-empty">
      Nowhere is set for reports to go, so they are prepared and wait. Whoever runs the deployment
      sets <code>USAGE_REPORT_URL</code> with <code>USAGE_REPORT_API_KEY</code> to send them, or{" "}
      <code>USAGE_REPORT_DIR</code> to write each one as a file to hand over.
    </p>
  );
}

function Report({ report }: { report: UsageReport }) {
  return (
    <div className="admin-report">
      <div className="acct-sub">
        <h3>
          {report.period}
          {report.revision > 0 && <span className="acct-detail">correction {report.revision}</span>}
        </h3>
        <span className="acct-note">
          {report.sent_at
            ? `sent ${when(report.sent_at)}${report.sent_via === "file" ? ", written as a file" : ""}`
            : "not yet sent"}
        </span>
      </div>
      <pre className="admin-pre">{report.body}</pre>
      <p className="acct-note">
        prepared {when(report.prepared_at)} · fingerprint{" "}
        <span className="admin-hash" title={report.body_hash}>
          {report.body_hash.slice(0, 16)}…
        </span>
        {report.last_error && !report.sent_at && (
          <>
            {" "}
            · last tried {when(report.last_attempt_at)}: {report.last_error}
          </>
        )}
      </p>
      {report.receipt !== null && report.receipt !== undefined && (
        <details className="acct-asTable">
          <summary>
            {report.sent_via === "online" ? "What the public graph answered" : "The record of how it left"}
          </summary>
          <pre className="admin-pre">{JSON.stringify(report.receipt, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
