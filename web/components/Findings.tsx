import Link from "next/link";
import type { Finding, FindingRef, FindingSighting } from "@/lib/types";
import { AssessmentText } from "./AssessmentText";

/**
 * A notable finding (#394), rendered as it was written: the headline as a
 * claim about the world, the account as assessment-style prose, and the
 * footing beneath (the claim it is about, the records it cites, who noted it
 * and when, how many later runs met the same finding). No editorializing
 * layer sits between the record and the reader; the page's only additions
 * are mechanical: the stale marker when a cited assessment has been
 * superseded, and the withdrawal note when an operator has taken it down.
 */

const AGENT_LABELS: Record<string, string> = {
  steward: "Claim Steward",
  claim_steward: "Claim Steward",
  curator: "Curator",
  grantmaker: "Grantmaker",
  mandate_review: "Grantmaker",
  contribution_reviewer: "Contribution Reviewer",
  reviewer: "Contribution Reviewer",
  dispute_arbitrator: "Dispute Arbitrator",
  arbitrator: "Dispute Arbitrator",
  audit_agent: "Audit Agent",
  audit: "Audit Agent",
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent.replace(/_/g, " ");
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Refs link where the site has a page for the record; the rest are shown as
// ids so a reader can follow them through the API.
function refHref(ref: FindingRef): string | null {
  switch (ref.kind) {
    case "claim":
      return `/claims/${ref.id}`;
    case "contribution":
      return `/contributions/${ref.id}`;
    default:
      return null;
  }
}

export function FindingRefs({ refs, claimId }: { refs: FindingRef[]; claimId: string }) {
  if (refs.length === 0) return null;
  return (
    <span className="finding-refs">
      {refs.map((r) => {
        const href = refHref(r);
        const label = `${r.kind.replace(/_/g, " ")} ${r.id.slice(0, 8)}`;
        const isSubject = r.kind === "claim" && r.id === claimId;
        return href && !isSubject ? (
          <Link key={`${r.kind}:${r.id}`} href={href} className="tag" title={r.id}>{label}</Link>
        ) : (
          <span key={`${r.kind}:${r.id}`} className="tag" title={r.id}>{label}</span>
        );
      })}
    </span>
  );
}

export function FindingImportance({ value }: { value: number }) {
  return (
    <span
      className="finding-importance"
      title={`Importance ${value} of 10: the importance of the finding, not of the claim.`}
      aria-label={`importance ${value} of 10`}
    >
      <span className="sc">importance</span> {value}<span className="of">/10</span>
    </span>
  );
}

export function FindingCard({
  finding, showClaim = true, headingLevel = 2,
}: {
  finding: Finding;
  showClaim?: boolean;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="finding" id={finding.id}>
      <div className="finding-eyebrow">
        <FindingImportance value={finding.importance} />
        <span className="finding-meta">
          {agentLabel(finding.agent)} · {fmtDate(finding.first_noted_at)}
          {finding.sighting_count > 1 && ` · met ${finding.sighting_count} times`}
        </span>
      </div>
      <Heading className="finding-headline">
        <Link href={`/findings/${finding.id}`} className="plain">{finding.headline}</Link>
      </Heading>
      {finding.status === "withdrawn" && (
        <p className="finding-notice">
          <span className="sc">Withdrawn</span>
          {finding.withdrawn_note ? ` · ${finding.withdrawn_note}` : ""}
        </p>
      )}
      {finding.stale && (
        <p className="finding-notice">
          <span className="sc">The graph has moved</span> · this note cites an assessment that
          is no longer the claim&apos;s current one; read the claim for the present verdict.
        </p>
      )}
      <div className="finding-account">
        <AssessmentText content={finding.account} />
      </div>
      <p className="finding-footing">
        {showClaim && finding.claim_text && (
          <>
            <span className="sc">On</span>{" "}
            <Link href={`/claims/${finding.claim_id}`}>{finding.claim_text}</Link>
            {" · "}
          </>
        )}
        <span className="sc">Cites</span> <FindingRefs refs={finding.refs} claimId={finding.claim_id} />
      </p>
    </article>
  );
}

export function FindingSightings({ sightings }: { sightings: FindingSighting[] }) {
  if (sightings.length === 0) return null;
  return (
    <section className="finding-sightings">
      <h2>Later sightings</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        Runs that met the same finding afterwards and said so, each in its own words.
      </p>
      {sightings.map((s) => (
        <div key={s.id} className="finding-sighting">
          <p className="finding-meta">
            {agentLabel(s.agent)} · {fmtDate(s.noted_at)}
            {typeof s.importance === "number" && ` · rated ${s.importance}/10`}
          </p>
          {s.account && (
            <div className="finding-account">
              <AssessmentText content={s.account} />
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
