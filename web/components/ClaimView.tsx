import Link from "next/link";
import type { ClaimDetail } from "@/lib/types";
import {
  statusMeta, isStatus, claimTypeMeta, decompositionNote,
  DEFINED_IN, VERDICT_CONFIDENCE_GLOSS, SEED_PRELIM_GLOSS,
} from "@/lib/ontology";
import { buildClaimTextMap } from "@/lib/claim-links";
import { modelDisplayName } from "@/lib/model-names";
import { StatusBadge, Credence, VerdictConfidence, Swatch, Importance } from "./Assessment";
import { Term } from "./Term";
import { AssessmentText } from "./AssessmentText";
import { DecompositionTree } from "./DecompositionTree";
import { ContributionRecord } from "./claim/ContributionRecord";
import { Contribute } from "./claim/Contribute";

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function ClaimView({ detail }: { detail: ClaimDetail }) {
  const { claim, tree, instances, trajectory, record } = detail;
  // Live data can be mid-pipeline: an assessment row may exist with a null
  // status. Only treat it as a real assessment when the status is on-enum.
  const assessment =
    detail.assessment && isStatus(detail.assessment.status) ? detail.assessment : null;
  // Steward-seeded prior (#285): the parent claim's Steward's preliminary
  // credence and note. The API only serves it while the claim is unassessed;
  // the gate here keeps the invariant even against a stale cache — a seed
  // must never render beside a real assessment.
  const seed =
    !assessment && detail.seed && (detail.seed.credence != null || detail.seed.note)
      ? detail.seed
      : null;
  const claimType = claimTypeMeta(claim.claim_type);
  const hasTree = !!(tree && tree.children && tree.children.length > 0);
  // Canonical text for [[claim:<id>]] references in assessment prose (#203):
  // assessments cite subclaims, and subclaims live in the tree already held.
  const linkTexts = buildClaimTextMap(tree);

  return (
    <article className="col">
      {/* eyebrow: type + state */}
      <div className="claim-eyebrow">
        <span className="sc">Claim</span>
        {claimType ? (
          <Term gloss={claimType.gloss} href={DEFINED_IN.claimType} className="tag kind">
            {claimType.label}
          </Term>
        ) : (
          <span className="tag kind">{claim.claim_type?.replace(/_/g, " ")}</span>
        )}
        {claim.state !== "active" && <span className="tag">{claim.state.replace(/_/g, " ")}</span>}
        {typeof claim.importance === "number" && (
          <span style={{ marginLeft: "auto" }}>
            <Importance value={claim.importance} />
          </span>
        )}
      </div>

      {/* hero: the canonical claim */}
      <h1 className="claim-hero">{claim.text}</h1>

      {!assessment && (
        <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)", marginTop: "-.5rem" }}>
          Not yet assessed — this claim has been extracted but has not completed the
          assessment pipeline.
        </p>
      )}

      {/* Steward-seeded prior (#285): the hint left by the Steward of the
          parent claim when it created this subclaim. The label is applied
          here, mechanically — the authoring Steward never writes its own
          disclaimer — and the whole block disappears the moment this claim's
          own assessment lands (the API stops serving the seed). */}
      {seed && (
        <aside className="seed-prelim" aria-label="Preliminary note">
          <p className="seed-prelim-label">
            <span className="sc">Preliminary</span>
            {" — from the Steward of "}
            {seed.seeded_by ? (
              <Link href={`/claims/${seed.seeded_by.id}`}>{seed.seeded_by.text}</Link>
            ) : (
              "the claim this one was decomposed from"
            )}
            , recorded when this subclaim was created and pending this
            claim&apos;s own assessment.
          </p>
          {seed.credence != null && (
            <p className="seed-prelim-credence">
              <Term gloss={SEED_PRELIM_GLOSS} href={DEFINED_IN.confidence} className="conf-quiet">
                preliminary credence {seed.credence.toFixed(2)}
              </Term>
            </p>
          )}
          {seed.note && <p className="seed-prelim-note">{seed.note}</p>}
        </aside>
      )}

      {/* assessment band */}
      {assessment && (
        <div className="claim-assess">
          <StatusBadge status={assessment.status} size="lg" />
          {/* Credence (P(claim true)) gets the meter, when the Steward stated
              one; verdict confidence is meta and stays a quiet labelled figure
              so the two are never mistaken for each other (#160). */}
          <Credence value={assessment.claim_credence} />
          <VerdictConfidence value={assessment.confidence} />
          {/* The one date most readers want (#196). assessed_at, not
              updated_at: only the former honestly means "last assessed"
              (#160). The assessing model rides along (#294): a verdict is only
              as trustworthy as its assessor. Legacy assessments have no
              recorded model — date only, no dangling separator. */}
          <span className="assess-when">
            last assessed {fmtDate(assessment.assessed_at)}
            {assessment.model ? ` · ${modelDisplayName(assessment.model)}` : ""}
          </span>
          {/* No subclaim-status chips here: subclaim_summary is never computed
              by the pipeline (always {}), so the chips only ever rendered for
              fixtures — a feature that looked implemented but wasn't (#160).
              The margin compass gives the real breakdown, scored by effect on
              this claim rather than by each subclaim's own status. */}
        </div>
      )}

      {/* reasoning trace */}
      {assessment && (
        <section>
          <h2>Assessment</h2>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
            {statusMeta(assessment.status).def}
          </p>
          {/* Reader-facing assessment — the primary content, styled as lead prose
              rather than an inset box. The fuller reasoning trace stays accessible
              just below, behind a disclosure, for anyone who wants the full
              defensible chain. Older assessments have no distinct summary (the API
              returns the trace as the summary); only show the separate reasoning
              disclosure when it actually differs. */}
          <div className="assessment-body">
            <AssessmentText content={assessment.summary} texts={linkTexts} />
          </div>
          {assessment.reasoning_trace &&
            assessment.reasoning_trace !== assessment.summary && (
              <details className="reasoning-detail">
                <summary>Full reasoning — evidence and decisions behind this verdict</summary>
                <div className="reasoning">
                  <AssessmentText content={assessment.reasoning_trace} texts={linkTexts} />
                </div>
              </details>
            )}
        </section>
      )}

      {/* decomposition */}
      <section>
        <h2>Decomposition</h2>
        {hasTree ? (
          <>
            <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
              {tree!.children.some((c) => c.argument_name)
                ? "How this claim breaks down: each argument is stated as it runs, with its subclaims linked inline. ↗\uFE0E opens a subclaim; the map shows how they fit together."
                : "The claims this one rests on directly. ↗\uFE0E opens a subclaim; the map shows how they fit together."}
            </p>
            <DecompositionTree tree={tree!} />
          </>
        ) : (
          <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
            {decompositionNote({
              decompositionStatus: claim.decomposition_status,
              assessed: !!assessment,
              stewardState: claim.steward_state,
            })}
          </p>
        )}
      </section>

      {/* provenance */}
      {instances && instances.length > 0 && (
        <section>
          <h2>Provenance</h2>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
            Where this claim has been said, linked to its canonical form.
          </p>
          {instances.map((inst) => (
            <div className="instance" key={inst.id}>
              <blockquote>{inst.original_text}</blockquote>
              <div className="instance-cite">
                {inst.source_url ? (
                  <a href={inst.source_url}>{inst.source_title}</a>
                ) : (
                  <span>{inst.source_title}</span>
                )}
                {inst.source_type && <span className="tag">{inst.source_type.replace(/_/g, " ")}</span>}
                {/* This score is the Extractor's, not the Matcher's: it says
                    "this passage states a genuine, well-formed claim", not how
                    well the passage matches the canonical form (#160). */}
                <span
                  className="conf-num"
                  title="The Extractor's confidence that this passage states a genuine, well-formed claim."
                >
                  extraction {inst.confidence.toFixed(2)}
                </span>
              </div>
              {inst.context && (
                <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--muted)", margin: ".35rem 0 0" }}>
                  {inst.context}
                </p>
              )}
            </div>
          ))}
        </section>
      )}

      {/* assessment history (#196) — an appendix, not a companion to the
          verdict: most readers only want the last-assessed date, which lives
          in the assessment band up top. The full record (contributions,
          decisions, arbitration) is one link deeper. */}
      {assessment && trajectory && trajectory.history.length > 1 && (
        <section>
          <h2>Assessment history</h2>
          <div
            className="traj"
            style={{ fontFamily: "var(--sans)", fontSize: ".82rem", lineHeight: 1.45, color: "var(--ink-soft)", maxWidth: "30rem" }}
          >
            {trajectory.history.map((p, i) => (
              <div className="traj-point" key={i}>
                <span className="traj-dot"><Swatch status={p.status} /></span>
                <span className="traj-body">
                  <span className="sc" style={{ color: "var(--muted)" }}>{fmtDate(p.assessed_at)}</span>
                  {statusMeta(p.status).label}
                  {typeof p.confidence === "number" && (
                    <span title={VERDICT_CONFIDENCE_GLOSS}> · {p.confidence.toFixed(2)}</span>
                  )}
                  {p.trigger && <em style={{ color: "var(--faint)" }}> — {p.trigger.replace(/_/g, " ")}</em>}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--faint)" }}>
            {trajectory.status_transitions} status change{trajectory.status_transitions === 1 ? "" : "s"} over{" "}
            {trajectory.total_assessments} assessments.{" "}
            <Link href={`/claims/${claim.id}/history`}>full history →</Link>
          </p>
        </section>
      )}

      {/* contribution record (#171) — the public exchanges, rendered as
          history after the claim's own content. Hidden entirely when no
          contribution has been made. */}
      {record && record.length > 0 && <ContributionRecord record={record} />}

      {/* contribution entry (#174): the companion of the contribution record
          above — the record shows past exchanges, this is where a new one
          starts. Kept at the end of the reading column so the page itself
          stays unmarked by the exchanges behind it. */}
      <Contribute claimId={claim.id} />

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)" }}>
        Created by {claim.created_by} · {fmtDate(claim.created_at)}.
        {/* the last-assessed date moved into the assessment band (#196) */}
        {" "}Every judgment on this page is accompanied by a reasoning trace.
      </p>
    </article>
  );
}
