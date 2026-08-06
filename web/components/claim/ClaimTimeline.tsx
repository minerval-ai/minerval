import Link from "next/link";
import type { ClaimEvent, ClaimEventsPage } from "@/lib/types";
import { statusMeta, VERDICT_CONFIDENCE_GLOSS, CREDENCE_GLOSS } from "@/lib/ontology";
import { Swatch } from "@/components/Assessment";
import { ArgumentText } from "@/components/ArgumentText";
import styles from "./timeline.module.css";

// The full claim history (issue #175): assessments, contributions, and the
// decisions made about them, interleaved newest-first. Decisions arrive in
// several forms from several parties (steward, reviewer, arbitrator, and
// whatever joins them later), so rendering is one switch over the event kind
// with a common entry anatomy: marker on the spine, dateline, headline, body.
// An unrecognized kind still renders a generic entry rather than vanishing.

const ACTOR_LABELS: Record<string, string> = {
  claim_steward: "Claim Steward",
  contribution_reviewer: "Contribution Reviewer",
  dispute_arbitrator: "Dispute Arbitrator",
  extractor: "Extractor",
  decomposer: "Decomposer",
  curator: "Curator",
  system: "System",
};

// Mirrors the contributor page's vocabulary for contribution types.
const TYPE_LABELS: Record<string, string> = {
  challenge: "Challenge",
  support: "Supporting evidence",
  propose_merge: "Merge proposal",
  propose_split: "Split proposal",
  propose_edit: "Edit proposal",
  add_instance: "Source instance",
  propose_argument: "Argument",
  propose_claim: "Claim proposal",
  propose_source: "Source proposal",
};

const DECISION_LABELS: Record<string, string> = {
  accept: "accepted",
  reject: "rejected",
  escalate: "escalated to arbitration",
};

const OUTCOME_LABELS: Record<string, string> = {
  uphold_original: "original decision upheld",
  overturn: "decision overturned",
  modify: "decision modified",
  mark_contested: "claim marked contested",
  human_review: "referred for human review",
};

// Why a reassessment ran, in words. Unknown triggers fall back to the raw
// label with underscores unfolded, so new backend triggers degrade gracefully.
const TRIGGER_PHRASES: Record<string, string> = {
  structure_and_assess: "initial assessment",
  pipeline_assessment: "initial assessment",
  steward_reassessment: "steward review",
  subclaim_change: "a subclaim changed",
  contribution_accepted: "an accepted contribution",
  user_order: "a reader's order",
  steward_escalation: "an escalated review",
  escalated_review: "an escalated review",
  appeal: "an appeal",
  conflict_resolution: "conflict resolution",
  curator_change: "a curator change",
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function typeLabel(t: string | null) {
  return (t && TYPE_LABELS[t]) || "Contribution";
}

function triggerPhrase(t: string) {
  return TRIGGER_PHRASES[t] ?? t.replace(/_/g, " ");
}

// Agent actors render by name; anything else is a contributor id and links to
// their public record.
function Actor({ id }: { id: string }) {
  const label = ACTOR_LABELS[id];
  if (label) return <>{label}</>;
  return <Link href={`/contributors/${id}`}>contributor</Link>;
}

function Dateline({
  event, trigger,
}: { event: ClaimEvent; trigger?: string | null }) {
  return (
    <p className={styles.meta}>
      {fmtDate(event.at)} · <Actor id={event.actor} />
      {trigger && <span className={styles.metaTrigger}> · after {triggerPhrase(trigger)}</span>}
    </p>
  );
}

function AssessmentEntry({
  e, texts,
}: { e: Extract<ClaimEvent, { kind: "assessment" }>; texts?: Map<string, string> }) {
  const meta = statusMeta(e.status);
  const changed = e.prev_status !== null && e.prev_status !== e.status;
  const headline = e.prev_status === null
    ? `Assessed ${meta.label}`
    : changed
      ? `Reassessed: ${statusMeta(e.prev_status).label} → ${meta.label}`
      : `Reassessed: still ${meta.label}`;
  return (
    <>
      <span className={styles.marker}><Swatch status={e.status} /></span>
      <div className={styles.body}>
        <Dateline event={e} trigger={e.trigger} />
        <p className={styles.headline}>{headline}</p>
        <p className={styles.figures}>
          <span title={VERDICT_CONFIDENCE_GLOSS}>
            verdict confidence{" "}
            {e.prev_confidence !== null && e.prev_confidence !== e.confidence
              ? `${e.prev_confidence.toFixed(2)} → ${e.confidence.toFixed(2)}`
              : e.confidence.toFixed(2)}
          </span>
          {typeof e.claim_credence === "number" && (
            <span title={CREDENCE_GLOSS}> · credence {e.claim_credence.toFixed(2)}</span>
          )}
        </p>
        {/* A verdict-changing assessment gets its summary; a routine
            reassessment that landed in the same place stays one line, so a
            long run of quiet re-checks doesn't drown the record. */}
        {/* Summaries may carry [[claim:<id>]] references and bare source
            URLs (#203); render them as links, like the claim page does. */}
        {(e.prev_status === null || changed) && e.summary && (
          <p className={styles.prose}>
            <ArgumentText content={e.summary} texts={texts} />
          </p>
        )}
      </div>
    </>
  );
}

function ContributionEntry({ e }: { e: Extract<ClaimEvent, { kind: "contribution" }> }) {
  return (
    <>
      <span className={styles.marker}><span className={styles.mActor} /></span>
      <div className={styles.body}>
        <Dateline event={e} />
        <p className={styles.headline}>
          {typeLabel(e.contribution_type)} submitted
          {e.review_status === "pending" && <span className="tag">awaiting review</span>}
        </p>
        <blockquote className={styles.quote}>{e.content}</blockquote>
        {e.evidence_urls.length > 0 && (
          <p className={styles.evidence}>
            {e.evidence_urls.map((url) => (
              <a key={url} href={url} rel="nofollow noopener">evidence ↗&#xFE0E;</a>
            ))}
          </p>
        )}
      </div>
    </>
  );
}

function ReviewEntry({ e }: { e: Extract<ClaimEvent, { kind: "review" }> }) {
  return (
    <>
      <span className={styles.marker}><span className={styles.mDecision} /></span>
      <div className={styles.body}>
        <Dateline event={e} />
        <p className={styles.headline}>
          {typeLabel(e.contribution_type)} {DECISION_LABELS[e.decision] ?? e.decision}
        </p>
        {e.reasoning && <p className={styles.prose}>{e.reasoning}</p>}
        {e.suspected_bad_faith && (
          <p className={styles.badFaith}>Flagged as suspected bad faith.</p>
        )}
        {e.policy_citations.length > 0 && (
          <p className={styles.citations}>
            {e.policy_citations.map((c) => (
              <span key={c} className="tag">{c}</span>
            ))}
          </p>
        )}
      </div>
    </>
  );
}

function AppealEntry({ e }: { e: Extract<ClaimEvent, { kind: "appeal" }> }) {
  return (
    <>
      <span className={styles.marker}><span className={styles.mActor} /></span>
      <div className={styles.body}>
        <Dateline event={e} />
        <p className={styles.headline}>Appeal filed</p>
        <blockquote className={styles.quote}>{e.reasoning}</blockquote>
      </div>
    </>
  );
}

function ArbitrationEntry({ e }: { e: Extract<ClaimEvent, { kind: "arbitration" }> }) {
  return (
    <>
      <span className={styles.marker}><span className={styles.mDecision} /></span>
      <div className={styles.body}>
        <Dateline event={e} />
        <p className={styles.headline}>
          Arbitration: {OUTCOME_LABELS[e.outcome] ?? e.outcome.replace(/_/g, " ")}
          {e.consensus_achieved === false && <span className="tag">split panel</span>}
          {e.human_review_recommended && <span className="tag">human review recommended</span>}
        </p>
        {e.reasoning && <p className={styles.prose}>{e.reasoning}</p>}
      </div>
    </>
  );
}

function StewardNoteEntry({ e }: { e: Extract<ClaimEvent, { kind: "steward_note" }> }) {
  const action = e.action.replace(/_/g, " ");
  return (
    <>
      <span className={styles.marker}><span className={styles.mNote} /></span>
      <div className={styles.body}>
        <Dateline event={e} />
        <p className={styles.headline}>
          {action.charAt(0).toUpperCase() + action.slice(1)}
        </p>
        {e.reasoning && <p className={styles.prose}>{e.reasoning}</p>}
      </div>
    </>
  );
}

function CreatedEntry({ e }: { e: Extract<ClaimEvent, { kind: "created" }> }) {
  return (
    <>
      <span className={styles.marker}><span className={styles.mCreated} /></span>
      <div className={styles.body}>
        <Dateline event={e} />
        <p className={styles.headline}>Claim entered the graph</p>
      </div>
    </>
  );
}

function Entry({ event, texts }: { event: ClaimEvent; texts?: Map<string, string> }) {
  switch (event.kind) {
    case "assessment": return <AssessmentEntry e={event} texts={texts} />;
    case "contribution": return <ContributionEntry e={event} />;
    case "review": return <ReviewEntry e={event} />;
    case "appeal": return <AppealEntry e={event} />;
    case "arbitration": return <ArbitrationEntry e={event} />;
    case "steward_note": return <StewardNoteEntry e={event} />;
    case "created": return <CreatedEntry e={event} />;
    default:
      // A kind this build predates: show the record exists rather than hiding it.
      return (
        <>
          <span className={styles.marker}><span className={styles.mNote} /></span>
          <div className={styles.body}>
            <Dateline event={event} />
            <p className={styles.headline}>
              {(event as ClaimEvent).kind.replace(/_/g, " ")}
            </p>
          </div>
        </>
      );
  }
}

export function ClaimTimeline({
  page, texts,
}: {
  page: ClaimEventsPage;
  /** id → canonical text for resolving bare [[claim:<id>]] references (#203). */
  texts?: Map<string, string>;
}) {
  const { events, total } = page;
  return (
    <>
      <ol className={styles.timeline} aria-label="Claim history">
        {events.map((event) => (
          <li className={styles.entry} key={event.id} id={event.id}>
            <Entry event={event} texts={texts} />
          </li>
        ))}
      </ol>
      {total > events.length && (
        <p className={styles.windowNote}>
          Showing the {events.length} most recent of {total} events.
        </p>
      )}
    </>
  );
}

// One line for the page header: what kind of record this is, at a glance.
export function summarizeEvents(page: ClaimEventsPage): string {
  const n = (kind: ClaimEvent["kind"]) => page.events.filter((e) => e.kind === kind).length;
  const assessments = n("assessment");
  const contributorActs = n("contribution") + n("appeal");
  const decisions = n("review") + n("arbitration") + n("steward_note");
  const parts = [
    `${page.total} event${page.total === 1 ? "" : "s"}`,
    `${assessments} assessment${assessments === 1 ? "" : "s"}`,
  ];
  if (contributorActs > 0) {
    parts.push(`${contributorActs} contribution${contributorActs === 1 ? "" : "s"}`);
  }
  if (decisions > 0) parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
