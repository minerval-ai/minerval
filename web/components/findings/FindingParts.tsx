import Link from "next/link";
import type { ClaimCard, Finding } from "@/lib/types";
import { agentLabel, type FindingsView, findingsHref } from "@/lib/findings";
import { StatusBadge, StandingBadge } from "../Assessment";
import { QUESTION_STANDING, isStanding, statusMeta } from "@/lib/ontology";
import { fmtDate } from "../Findings";

// The pieces the findings index and a finding's own page share: how a
// finding's importance is drawn, how the claim it is about is shown with
// where it stands now, and one entry of the index.

/** Ten ticks, the first `value` of them inked: importance at a glance. */
export function ImportanceTicks({ value }: { value: number }) {
  return (
    <span className="fnd-ticks" role="img" aria-label={`importance ${value} of 10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={i < value ? "on" : undefined} />
      ))}
    </span>
  );
}

/**
 * Where a node stands now: a claim's status with its credence, or a
 * question's standing. `plain` draws the same badge without its glossary
 * link, for use inside something that is already a link (a margin card).
 */
export function Standing({ card, plain = false }: { card: ClaimCard | undefined; plain?: boolean }) {
  if (!card) return null;
  if (card.kind === "question") {
    if (!card.standing) return null;
    if (!plain) return <StandingBadge standing={card.standing} />;
    const s = isStanding(card.standing) ? QUESTION_STANDING[card.standing] : null;
    return s ? <span className={`badge standing standing-${card.standing}`}>{s.label}</span> : null;
  }
  if (!card.assessment_status) return null;
  const s = statusMeta(card.assessment_status);
  return (
    <span className="fnd-standing">
      {plain ? (
        <span className={`badge ${s.cls}`}>
          <span className="badge-glyph" aria-hidden>
            {s.glyph}
          </span>
          {s.label}
        </span>
      ) : (
        <StatusBadge status={card.assessment_status} />
      )}
      {typeof card.assessment_confidence === "number" && (
        <span className="fnd-credence" title="How sure the Steward is of this status, from 0 to 1.">
          {card.assessment_confidence.toFixed(2)}
        </span>
      )}
    </span>
  );
}

/**
 * One finding in the index, kept short so a screen holds many: its importance
 * in a narrow rail, the headline, the claim it is about with where that claim
 * stands, and one line of who noted it, when, and its topics. The headline is
 * the way in; the account is on the finding's own page.
 */
export function FindingListItem({
  finding: f,
  card,
  view,
}: {
  finding: Finding;
  card: ClaimCard | undefined;
  view: FindingsView;
}) {
  return (
    <article className="fnd-item" id={f.id}>
      <div
        className="fnd-rail"
        title={`Importance ${f.importance} of 10: the importance of the finding, not of the claim.`}
      >
        <div className="fnd-rail-n">
          {f.importance}
          <span> / 10</span>
        </div>
        <ImportanceTicks value={f.importance} />
      </div>
      <div className="fnd-body">
        <h2 className="fnd-headline">
          <Link href={`/findings/${f.id}`} className="plain">
            {f.headline}
          </Link>
        </h2>
        {f.claim_text && (
          <p className="fnd-on">
            <span className="sc">On</span>
            <Link href={`/claims/${f.claim_id}`}>{f.claim_text}</Link>
            <Standing card={card} />
          </p>
        )}
        <p className="fnd-foot">
          <span>
            {agentLabel(f.agent)} · {fmtDate(f.first_noted_at)}
            {f.sighting_count > 1 && ` · met ${f.sighting_count} times`}
          </span>
          {f.status === "withdrawn" && <span className="fnd-flag">withdrawn</span>}
          {f.stale && (
            <span
              className="fnd-flag"
              title="This note cites an assessment that is no longer the node’s current one."
            >
              the graph has moved
            </span>
          )}
          {(f.tags ?? []).map((t) => (
            <Link
              key={t.slug}
              href={findingsHref(view, { tag: t.slug })}
              className="tag topic"
              aria-label={`Only findings on ${t.name}`}
            >
              {t.name}
            </Link>
          ))}
        </p>
      </div>
    </article>
  );
}
