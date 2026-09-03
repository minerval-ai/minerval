import type { Metadata } from "next";
import Link from "next/link";
import { loadAttempt, loadClaim } from "@/lib/data";
import { formatUsd, fmtDate } from "@/lib/format";
import { ATTEMPT_VARIANT_LABEL, attemptOutcomeLabel } from "@/lib/prizes";

// One house attempt (docs/mathematics.md §7.7): the report (the informal
// argument, the approaches tried, the obstruction, what would help, and the
// solver's own confidence) and the notebook, published as CC0 material once
// the claim's steward has acted on the attempt. The transcript is retained
// and not published; auditors and the Arbitrator may request it.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; attemptId: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { detail } = await loadClaim(id);
  if (!detail) return { title: "Attempt · Minerval" };
  const text = detail.claim.text;
  return {
    title: `Attempt · ${text.length > 60 ? `${text.slice(0, 57)}…` : text} · Minerval`,
  };
}

export default async function AttemptPage({
  params,
}: {
  params: Promise<{ id: string; attemptId: string }>;
}) {
  const { id, attemptId } = await params;
  const [{ detail, source }, { attempt }] = await Promise.all([
    loadClaim(id),
    loadAttempt(id, attemptId),
  ]);

  if (!detail || !attempt) {
    return (
      <div className="col">
        <p className="sc"><Link href={detail ? `/claims/${id}` : "/claims"}>← {detail ? "claim page" : "claims"}</Link></p>
        <h1 className="claim-hero">Attempt not found.</h1>
        <p style={{ color: "var(--muted)" }}>
          There is no attempt at this address under this claim. The link may be mistyped or out of date.
        </p>
      </div>
    );
  }

  const published = !!attempt.published_at;
  const report = published ? attempt.report : null;
  const notebook = published && attempt.notebook ? Object.entries(attempt.notebook) : [];

  return (
    <div className="col">
      <p className="sc" style={{ marginBottom: "1.2rem", display: "flex", gap: ".7rem", alignItems: "center" }}>
        <Link href={`/claims/${detail.claim.id}`}>← claim page</Link>
        {source === "fixture" && (
          <span className="tag" title="The API is not connected; showing a design fixture.">
            fixture data
          </span>
        )}
      </p>
      <div className="claim-eyebrow">
        <span className="sc">Attempt</span>
        <span className="tag kind">{ATTEMPT_VARIANT_LABEL[attempt.variant] ?? attempt.variant}</span>
        {attempt.is_calibration && (
          <span className="tag" title="A calibration run: the solver against a theorem with a known proof, so its record on open problems has a baseline.">
            calibration
          </span>
        )}
      </div>
      <h1 className="claim-hero" style={{ fontSize: "1.5rem" }}>
        <Link href={`/claims/${detail.claim.id}`} className="plain">{detail.claim.text}</Link>
      </h1>

      <div className="claim-assess" style={{ gap: "1rem" }}>
        <span className="summary-chip">
          <span className="sc" style={{ marginRight: ".3rem" }}>outcome</span>{attemptOutcomeLabel(attempt)}
        </span>
        <span className="summary-chip">
          <span className="sc" style={{ marginRight: ".3rem" }}>cost</span>
          <span className="mono">{formatUsd(attempt.spent_micro_usd)}</span>
        </span>
        <span className="summary-chip">
          <span className="sc" style={{ marginRight: ".3rem" }}>turns</span>{attempt.turns.toLocaleString("en-US")}
        </span>
        <span className="assess-when">
          {fmtDate(attempt.started_at)}
          {attempt.finished_at && <> → {fmtDate(attempt.finished_at)}</>}
        </span>
      </div>

      <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)", maxWidth: "36rem" }}>
        Minerval&rsquo;s own solver, run against the claim&rsquo;s published
        formal statement at {ATTEMPT_VARIANT_LABEL[attempt.variant] ?? attempt.variant}. Its
        cost is metered real money, charged to the Mathematics mandate as compute,
        never to any prize. What it found is published here so that nobody
        working on the question is at an information disadvantage to the platform.
      </p>

      {!published ? (
        <section>
          <h2>Report</h2>
          <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
            The report and notebook are published once the claim&rsquo;s steward has
            acted on this attempt, and before any prize opens on the statement.
          </p>
        </section>
      ) : (
        <>
          {report && (
            <section>
              <h2>Report</h2>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
                Published {fmtDate(attempt.published_at)} · the solver&rsquo;s confidence that its
                route would settle the statement: {report.confidence.toFixed(2)}
              </p>
              <h3>The argument, informally</h3>
              <div className="assessment-body" style={{ fontSize: "1rem" }}>
                {report.informal_argument.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
              </div>
              {report.approaches_tried.length > 0 && (
                <>
                  <h3>Approaches tried</h3>
                  <ol className="attempt-approaches">
                    {report.approaches_tried.map((a, i) => <li key={i}>{a}</li>)}
                  </ol>
                </>
              )}
              <h3>The obstruction</h3>
              <p>{report.obstruction}</p>
              <h3>What would help</h3>
              <p>{report.what_would_help}</p>
            </section>
          )}
          {notebook.length > 0 && (
            <section>
              <h2>Notebook</h2>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
                The solver&rsquo;s working files, verbatim. Nothing here passed the
                checker as a proof of the statement unless the outcome above says so.
              </p>
              {notebook.map(([name, body]) => (
                <details className="reasoning-detail attempt-file" key={name} open={notebook.length === 1}>
                  <summary><span className="mono">{name}</span></summary>
                  <pre className="prompt-pre"><code>{body}</code></pre>
                </details>
              ))}
            </section>
          )}
        </>
      )}

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)" }}>
        Reports and notebooks are dedicated to the public domain under CC0 1.0.
        The transcript is retained and not published; it is available to
        auditors and to the Dispute Arbitrator on request.
      </p>
    </div>
  );
}
