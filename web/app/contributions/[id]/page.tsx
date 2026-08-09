import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  apiConfigured,
  fetchContribution,
  fetchContributorProfile,
} from "../../../lib/api";
import { loadClaim } from "../../../lib/data";

// The public record of a single contribution (#174): the submission, and once
// review lands, the decision with its reasoning. This is where "the reasons
// are stated" is kept for the contributor and for any reader — openness, not
// procedure, is the check on the reviewer's judgment. The page is public like
// the claim pages; the API read it sits on carries no auth.

export const revalidate = 30;

const TYPE_LABELS: Record<string, string> = {
  challenge: "Challenge",
  support: "Supporting evidence",
  propose_edit: "Proposed rewording",
  add_instance: "Reported instance",
  propose_argument: "Proposed argument",
  propose_merge: "Merge proposal",
  propose_split: "Split proposal",
  propose_claim: "Proposed claim",
  propose_source: "Proposed source",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting review",
  accepted: "Accepted",
  rejected: "Rejected",
  escalated: "Escalated to arbitration",
  contested: "Marked contested",
  human_review: "Referred for human review",
  arbitrated: "Arbitrated",
};

const REVIEWER_LABELS: Record<string, string> = {
  contribution_reviewer: "the Contribution Reviewer",
  dispute_arbitrator: "the Dispute Arbitrator",
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = apiConfigured() ? await fetchContribution(id) : null;
  const label =
    TYPE_LABELS[detail?.contribution?.contribution_type ?? ""] ?? "Contribution";
  return { title: `${label} · Minerval` };
}

export default async function ContributionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!apiConfigured()) {
    return (
      <div className="col">
        <h1>Contribution</h1>
        <p>
          The frontend is not connected to a Minerval API (set{" "}
          <code>MINERVAL_API_URL</code>), so contribution records are
          unavailable.
        </p>
      </div>
    );
  }

  const detail = await fetchContribution(id);
  // A present-but-empty contribution is not the same as a missing one, and it
  // used to be worse than either: the object was truthy, so it slipped past the
  // not-found check and then threw on the first field access, turning the whole
  // page into a server-side exception. Treat an unusable payload as not-found
  // and keep the failure legible.
  if (!detail?.contribution?.contribution_type) notFound();
  const { contribution: c, review } = detail;

  // Refer to the claim by what it says, never a bare identifier; the claim
  // text may be unavailable (intake proposals have no claim until accepted).
  const claim = c.claim_id ? (await loadClaim(c.claim_id)).detail : null;
  const contributor = await fetchContributorProfile(c.contributor_id);

  const typeLabel = TYPE_LABELS[c.contribution_type] ?? c.contribution_type.replace(/_/g, " ");
  const statusLabel =
    STATUS_LABELS[c.review_status] ?? c.review_status.replace(/_/g, " ");
  const isIntake = c.claim_id === null;

  return (
    <div className="col">
      <div className="claim-eyebrow">
        <span className="sc">Contribution</span>
        <span className="tag kind">{typeLabel}</span>
        <span className="tag">{statusLabel}</span>
      </div>

      {/* what the contribution is about: the claim, quoted, or the proposal */}
      {isIntake && c.proposed_canonical_form ? (
        <h1 className="claim-hero">{c.proposed_canonical_form}</h1>
      ) : claim ? (
        <h1 className="claim-hero" style={{ fontSize: "1.6rem" }}>
          On the claim:{" "}
          <Link href={`/claims/${c.claim_id}`}>{claim.claim.text}</Link>
        </h1>
      ) : (
        <h1 className="claim-hero" style={{ fontSize: "1.6rem" }}>
          {c.claim_id ? (
            <>
              On <Link href={`/claims/${c.claim_id}`}>this claim</Link>
            </>
          ) : (
            "A proposed addition to the graph"
          )}
        </h1>
      )}

      <section>
        <h2>The contribution</h2>
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
          Submitted {fmtDate(c.submitted_at)}
          {contributor && (
            <>
              {" "}by{" "}
              <Link href={`/contributors/${c.contributor_id}`}>
                {contributor.contributor.display_name}
              </Link>
            </>
          )}
          .
        </p>
        {c.contribution_type === "propose_edit" && c.proposed_canonical_form && (
          <blockquote style={{ fontStyle: "italic" }}>
            Proposed wording: {c.proposed_canonical_form}
          </blockquote>
        )}
        <div className="assessment-body">
          {c.content.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        {c.evidence_urls.length > 0 && (
          <>
            <p style={{ fontFamily: "var(--sans)", fontSize: ".8rem", color: "var(--muted)", marginBottom: ".2rem" }}>
              Evidence submitted with it:
            </p>
            <ul style={{ marginTop: 0 }}>
              {c.evidence_urls.map((u) => (
                <li key={u}>
                  <a href={u} rel="noopener">{u}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2>The review</h2>
        {review ? (
          <>
            <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
              {statusLabel} · decided by{" "}
              {REVIEWER_LABELS[review.reviewed_by] ??
                review.reviewed_by.replace(/_/g, " ")}{" "}
              · {fmtDate(review.reviewed_at)}
            </p>
            <div className="assessment-body">
              {review.reasoning.split(/\n{2,}/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
            {review.policy_citations.length > 0 && (
              <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--muted)" }}>
                Grounds:{" "}
                {review.policy_citations.map((p) => (
                  <span className="tag" key={p} style={{ marginRight: ".35rem" }}>
                    {p}
                  </span>
                ))}
              </p>
            )}
            {c.review_status === "rejected" && (
              <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)" }}>
                A rejection can be appealed through the API
                (<code>POST /appeals</code> with this contribution&rsquo;s id).
                Appeals go to the Dispute Arbitrator, and an overturned
                decision restores standing, reputation, and owls in full.
              </p>
            )}
          </>
        ) : (
          <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
            {c.review_status === "pending"
              ? "Awaiting review. The decision and its reasoning will appear here."
              : `${statusLabel}. The written decision will appear here when it is recorded.`}
          </p>
        )}
      </section>

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)" }}>
        Contributions are evaluated on their merits, and every decision is
        recorded with its reasoning, open to inspection and challenge.
      </p>
    </div>
  );
}
