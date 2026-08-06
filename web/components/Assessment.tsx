import type { AssessmentStatus } from "@/lib/types";
import {
  statusMeta, importanceLevel, IMPORTANCE, UNASSESSED_META, DEFINED_IN,
  CREDENCE_GLOSS, VERDICT_CONFIDENCE_GLOSS,
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

export function Swatch({ status }: { status: AssessmentStatus | string | null }) {
  const s = statusMeta(status);
  return <span className={`swatch ${s.cls}`} title={`${s.label}: ${s.def}`} aria-label={s.label} />;
}

// Shown in place of a StatusBadge when a claim has no current assessment. The
// dashed, muted treatment signals "still queued" rather than a verdict — many
// low-importance claims sit unassessed under the Steward's budget by design.
export function Unassessed({ linkTo }: { linkTo?: string } = {}) {
  return (
    <Term gloss={UNASSESSED_META.def} href={DEFINED_IN.importance} linkTo={linkTo} className="badge unassessed">
      Unassessed
    </Term>
  );
}

// Importance is administrative — what the Steward assesses and decomposes
// first — not a degree of belief, so it is carried by its band word, never a
// meter. The old five-pip meter, unlabelled on cards and the map, read as
// P(claim true): every other meter here measures belief. The numeric value
// and band definition live in the popover.
export function Importance({
  value, linkTo,
}: { value: number | null | undefined; linkTo?: string }) {
  if (typeof value !== "number") return null;
  const meta = IMPORTANCE[importanceLevel(value)];
  const gloss = `Importance ${value.toFixed(2)}, from 0 to 1 · ${meta.label}: ${meta.gloss}. The Steward assesses and decomposes higher-importance claims first.`;
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
