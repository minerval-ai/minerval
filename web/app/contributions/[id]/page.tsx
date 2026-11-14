import type { Metadata } from "next";
import Link from "next/link";
import { figureWords, stanceWords } from "@/lib/stated-views";
import { notFound } from "next/navigation";
import {
  apiConfigured,
  fetchContribution,
  fetchContributorProfile,
} from "../../../lib/api";
import { loadClaim } from "../../../lib/data";
import { PageHead } from "@/components/PageHead";

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
  state_view: "Stated view",
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
        <PageHead title="Contribution" />
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
  // A view stated to the graph directly (§4). Its review admits it or does
  // not: an accept says the statement met the bar of form and good faith,
  // never that the view is right, so the page says "admitted".
  const sv = detail.stated_view ?? null;
  const statusLabel =
    sv && c.review_status === "accepted"
      ? "Admitted"
      : (STATUS_LABELS[c.review_status] ?? c.review_status.replace(/_/g, " "));
  const isIntake = c.claim_id === null;
  // An accepted proposal: the claim, question or quantity it became (#157).
  const becameId =
    c.became_claim_id ??
    (c.claim_id &&
    (c.contribution_type === "propose_claim" ||
      c.contribution_type === "propose_question" ||
      c.contribution_type === "propose_quantity")
      ? c.claim_id
      : null);

  return (
    <div className="col">
      <PageHead
        kicker="Contribution"
        tags={
          <>
            <span className="tag kind">{typeLabel}</span>
            <span className="tag">{statusLabel}</span>
          </>
        }
        variant="statement"
        // what the contribution is about: the claim, quoted, or the proposal
        title={
          (isIntake || becameId) && c.proposed_canonical_form ? (
            c.proposed_canonical_form
          ) : claim ? (
            <>
              On the claim:{" "}
              <Link href={`/claims/${c.claim_id}`}>{claim.claim.text}</Link>
            </>
          ) : c.claim_id ? (
            <>
              On <Link href={`/claims/${c.claim_id}`}>this claim</Link>
            </>
          ) : (
            "A proposed addition to the graph"
          )
        }
      />

      {becameId && (
        <div className="contribute-box" style={{ marginTop: "1rem" }}>
          <p style={{ margin: 0 }}>
            <strong>In the graph.</strong> This proposal now lives at{" "}
            <Link href={`/claims/${becameId}`}>
              {claim?.claim.text ?? "its page"}
            </Link>
            . Its assessment may still be under way; the page shows where it
            stands.
          </p>
        </div>
      )}

      <section>
        <h2>{sv ? "The statement" : "The contribution"}</h2>
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
        {sv ? (
          <>
            <p style={{ fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--ink-soft)" }}>
              A view stated to the graph directly by{" "}
              <Link href={`/contributors/${sv.speaker.id}`}>{sv.speaker.name}</Link>
              {sv.speaker.verified
                ? ", an account Minerval has verified"
                : ". The name is the account\u2019s own, and nobody has checked who is behind it"}
              . It {stanceWords(sv.stance, claim?.claim.kind ?? "claim")}
              {sv.probability != null ? `, with a probability of ${sv.probability.toFixed(2)}` : ""}
              {figureWords(sv.figure) ? `: ${figureWords(sv.figure)}` : ""}.
            </p>
            <div className="instance">
              <blockquote>{sv.statement}</blockquote>
            </div>
            <h3 style={{ fontSize: "1rem", margin: "1rem 0 .3rem" }}>Stake, as declared</h3>
            <p style={{ fontFamily: "var(--sans)", fontSize: ".86rem" }}>
              {sv.stake ?? "The speaker declares no stake in the answer."}
            </p>
            <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--muted)", marginTop: "-.5rem" }}>
              A stake is a fact about a source, not a finding against it.
            </p>
            {sv.reasons && (
              <>
                <h3 style={{ fontSize: "1rem", margin: "1rem 0 .3rem" }}>Its reasons</h3>
                <div className="assessment-body">
                  {sv.reasons.split(/\n{2,}/).map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="assessment-body">
            {c.content.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        )}
        {c.evidence_urls.length > 0 && (
          <>
            <p style={{ fontFamily: "var(--sans)", fontSize: ".8rem", color: "var(--muted)", marginBottom: ".2rem" }}>
              {sv ? "Links given with it:" : "Evidence submitted with it:"}
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

      {c.through_published_page && (
        <section>
          <h2>Made through a published page</h2>
          <p>
            This contribution was made through{" "}
            <Link href={`/claims/${c.through_published_page.node_id}?published=${c.through_published_page.published_page_id}`}>
              the redacted assessment on sealed evidence
            </Link>{" "}
            that {c.through_published_page.publisher}&rsquo;s graph publishes on this claim. It is reviewed here like any
            contribution. What that graph has said became of it: {c.through_published_page.in_words}
          </p>
        </section>
      )}

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
            {sv && c.review_status === "accepted" && (
              <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)" }}>
                Admitted means the statement met the bar of form and good faith. It is not a
                finding that the view is right, and it gives the view no weight in the assessment.
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

      {/* What became of a stated view's reasons (§14): they go to the
          Steward when the view is admitted, and its answer is kept here,
          in the record, and not on the claim's page. */}
      {sv?.reasons && (
        <section>
          <h2>The Steward&rsquo;s answer</h2>
          {!sv.instance_id ? (
            <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
              The reasons go to the Steward once the statement is admitted.
            </p>
          ) : !sv.challenge ? (
            <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
              No message to the Steward is recorded for these reasons.
            </p>
          ) : sv.challenge.state === "waiting" ? (
            <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
              The reasons were put to the Steward as a challenge on {fmtDate(sv.challenge.sent_at)}.
              They have not been weighed yet: they wait for the next assessment pass, and the
              answer will appear here.
            </p>
          ) : (
            <>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
                Answered {fmtDate(sv.challenge.answered_at ?? sv.challenge.sent_at)} ·{" "}
                {sv.challenge.outcome === "changed"
                  ? "the page changed"
                  : sv.challenge.outcome === "disagree"
                    ? "the Steward disagreed"
                    : "weighed, and nothing changed"}
              </p>
              {sv.challenge.note && (
                <div className="assessment-body">
                  {sv.challenge.note.split(/\n{2,}/).map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)" }}>
        {sv
          ? "A stated view is reviewed for form and good faith, never for whether it is right, and every decision is recorded with its reasoning, open to inspection and challenge."
          : "Contributions are evaluated on their merits, and every decision is recorded with its reasoning, open to inspection and challenge."}
      </p>
    </div>
  );
}
