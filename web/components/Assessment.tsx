import type { AssessmentStatus, QuestionStanding } from "@/lib/types";
import {
  statusMeta, importanceLevel, IMPORTANCE, UNASSESSED_META, DEFINED_IN,
  CREDENCE_GLOSS, VERDICT_CONFIDENCE_GLOSS, disputeMeta, QUESTION_STANDING, isStanding,
} from "@/lib/ontology";
import { Term } from "./Term";

export function StatusBadge({
  status, size = "sm", linkTo,
}: { status: AssessmentStatus | string | null; size?: "sm" | "lg"; linkTo?: string }) {
  const s = statusMeta(status);
  return (
    <Term gloss={s.def} href={DEFINED_IN.status} linkTo={linkTo} className={`badge ${s.cls}${size === "lg" ? " lg" : ""}`}>
      <span className="badge-glyph" aria-hidden>{s.glyph}</span>
      {s.label}
    </Term>
  );
}

// How well answered a question is (§7a, §10): round and in ink, a family of
// its own beside the claim statuses.
export function StandingBadge({
  standing, size = "sm", linkTo,
}: { standing: QuestionStanding | string | null; size?: "sm" | "lg"; linkTo?: string }) {
  if (!isStanding(standing)) {
    return (
      <Term gloss="This question has not yet been assessed." href={DEFINED_IN.question} linkTo={linkTo} className="badge standing unassessed">
        Unassessed
      </Term>
    );
  }
  const s = QUESTION_STANDING[standing];
  return (
    <Term gloss={s.def} href={DEFINED_IN.standing} linkTo={linkTo} className={`badge standing standing-${standing}${size === "lg" ? " lg" : ""}`}>
      <span className="badge-glyph" aria-hidden>{s.glyph}</span>
      {s.label}
    </Term>
  );
}

// How actively the claim is disputed, shown beside the verdict and never in
// its place (#524): "Doubtful · actively disputed". Driven by the claim's
// contestation, not its status; renders nothing below the display threshold
// or when no contestation is recorded (thresholds in lib/ontology.ts).
export function Dispute({
  value, linkTo,
}: { value: number | null | undefined; linkTo?: string }) {
  const d = disputeMeta(value);
  if (!d || typeof value !== "number") return null;
  const gloss = `Contestation ${value.toFixed(2)}, from 0 to 1. ${d.gloss}`;
  return (
    <Term gloss={gloss} href={DEFINED_IN.dispute} linkTo={linkTo} className={`dispute-label dispute-${d.level}`} ariaLabel={d.label}>
      <span className="dispute-sep" aria-hidden>·</span>{d.label}
    </Term>
  );
}

export function Swatch({ status }: { status: AssessmentStatus | string | null }) {
  const s = statusMeta(status);
  return <span className={`swatch ${s.cls}`} title={`${s.label}: ${s.def}`} aria-label={s.label} />;
}

// Shown in place of a StatusBadge when a claim has no current assessment. The
// dashed, muted treatment signals "not yet funded" rather than a verdict —
// many low-value candidates sit unassessed by design until a mandate or a
// reader covers the cost.
export function Unassessed({ linkTo }: { linkTo?: string } = {}) {
  return (
    <Term gloss={UNASSESSED_META.def} href={DEFINED_IN.importance} linkTo={linkTo} className="badge unassessed">
      Unassessed
    </Term>
  );
}

// Importance is administrative — the core of the value estimates that decide
// what gets assessed — not a degree of belief, so it is carried by its band word, never a
// meter. The old five-pip meter, unlabelled on cards and the map, read as
// P(claim true): every other meter here measures belief. The numeric value
// and band definition live in the popover.
export function Importance({
  value, linkTo,
}: { value: number | null | undefined; linkTo?: string }) {
  if (typeof value !== "number") return null;
  const meta = IMPORTANCE[importanceLevel(value)];
  const gloss = `Importance ${value.toFixed(2)}, from 0 to 1 · ${meta.label}: ${meta.gloss}. Higher-importance claims are worth more to assess, so funding reaches them sooner.`;
  return (
    <Term gloss={gloss} href={DEFINED_IN.importance} linkTo={linkTo} className="imp-label" ariaLabel={`importance: ${meta.label}`}>
      importance · {meta.label}
    </Term>
  );
}

// Credence — the Steward's probability that the claim is true. The one number
// that earns a meter; deliberately neutral-coloured so it never reads as a
// restatement of the verdict. Renders nothing when no credence was stated:
// per constitution §7 the absence is a signal, not a gap to paper over.
export function Credence({ value }: { value: number | null | undefined }) {
  if (typeof value !== "number") return null;
  return (
    <Term gloss={CREDENCE_GLOSS} href={DEFINED_IN.confidence} className="conf credence">
      <span className="sc" style={{ marginRight: ".1rem" }}>credence</span>
      <span className="conf-track">
        <span className="conf-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="conf-num">{value.toFixed(2)}</span>
    </Term>
  );
}

// Verdict confidence — how sure the Steward is of the status itself. Meta, so
// it stays quiet: a small labelled figure, no meter, defined on hover/click.
export function VerdictConfidence({ value }: { value: number | null | undefined }) {
  if (typeof value !== "number") return null;
  return (
    <Term gloss={VERDICT_CONFIDENCE_GLOSS} href={DEFINED_IN.confidence} className="conf-quiet">
      verdict confidence {value.toFixed(2)}
    </Term>
  );
}
