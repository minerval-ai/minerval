import Link from "next/link";
import type { ContributionExchange } from "@/lib/types";

// The public contribution record (issue #171): each exchange renders as
// history — the contributor's own words, then the review decision and
// reasoning, then any appeal and arbitration outcome. This is deliberately a
// separate section from the assessment: the constitution's Burden of
// Engagement puts the exchange on the claim's public record, but the reply to
// a contributor lives in the review, never in the assessment prose.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const DECISION_LABEL: Record<string, string> = {
  accept: "accepted",
  reject: "rejected",
  escalate: "escalated to arbitration",
};

const OUTCOME_LABEL: Record<string, string> = {
  uphold_original: "original decision upheld",
  overturn: "decision overturned",
  modify: "decision modified",
  mark_contested: "claim marked contested",
  human_review: "referred for human review",
};

function Paras({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </>
  );
}

function Exchange({ exchange }: { exchange: ContributionExchange }) {
  const { contribution, review, appeal, arbitration } = exchange;
  return (
    <div className="exchange">
      <div className="exchange-head">
        <Link href={`/contributors/${contribution.contributor.id}`}>
          {contribution.contributor.display_name}
        </Link>
        <span className="tag kind">{contribution.contribution_type.replace(/_/g, " ")}</span>
        <span className="sc">{fmtDate(contribution.submitted_at)}</span>
        {/* Before a review lands, the head carries the pending state; once one
            exists, the reply line below states the decision instead. */}
        {!review && <span className="tag">{contribution.review_status.replace(/_/g, " ")}</span>}
      </div>
      <blockquote>{contribution.content}</blockquote>
      {contribution.evidence_urls.length > 0 && (
        <div className="exchange-evidence">
          <span className="sc">evidence</span>
          {contribution.evidence_urls.map((url) => (
            <a key={url} href={url}>{url}</a>
          ))}
        </div>
      )}

      {review && (
        <div className="exchange-reply">
          <span className="sc">
            Review · {DECISION_LABEL[review.decision] ?? review.decision.replace(/_/g, " ")} ·{" "}
            {fmtDate(review.reviewed_at)} · {review.reviewed_by.replace(/_/g, " ")}
          </span>
          <Paras text={review.reasoning} />
          {review.policy_citations.length > 0 && (
            <div className="exchange-cite">
              cites {review.policy_citations.join(" · ")}
            </div>
          )}
        </div>
      )}

      {appeal && (
        <div className="exchange-reply">
          <span className="sc">
            Appeal ·{" "}
            <Link href={`/contributors/${appeal.appellant.id}`}>
              {appeal.appellant.display_name}
            </Link>{" "}
            · {fmtDate(appeal.submitted_at)}
            {appeal.status !== "resolved" && <> · {appeal.status.replace(/_/g, " ")}</>}
          </span>
          <Paras text={appeal.appeal_reasoning} />
        </div>
      )}

      {arbitration && (
        <div className="exchange-reply">
          <span className="sc">
            Arbitration · {OUTCOME_LABEL[arbitration.outcome] ?? arbitration.outcome.replace(/_/g, " ")} ·{" "}
            {fmtDate(arbitration.arbitrated_at)} · {arbitration.arbitrated_by.replace(/_/g, " ")}
          </span>
          <Paras text={arbitration.reasoning} />
          {arbitration.human_review_recommended && (
            <div className="exchange-cite">flagged for human review</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContributionRecord({ record }: { record: ContributionExchange[] }) {
  if (record.length === 0) return null;
  return (
    <section>
      <h2>Contribution record</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        Challenges and proposals from contributors, with the review each received.
        Substantive exchanges stay on the claim&apos;s public record.
      </p>
      {record.map((exchange) => (
        <Exchange key={exchange.contribution.id} exchange={exchange} />
      ))}
    </section>
  );
}
