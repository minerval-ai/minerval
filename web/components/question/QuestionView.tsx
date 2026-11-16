import { SeveralAssessments, SeveralCounted, severalAmong } from "@/components/SeveralAssessments";
import Link from "next/link";
import type { ClaimDetail, QuestionAnswer, QuestionDetail } from "@/lib/types";
import { DEFINED_IN, QUESTION_STANDING, isStanding, statusMeta, isStatus } from "@/lib/ontology";
import { buildClaimTextMap } from "@/lib/claim-links";
import { modelDisplayName } from "@/lib/model-names";
import { describeEstimate } from "@/lib/quantity";
import { isExamined, notExaminedLine } from "@/lib/coverage";
import { StatusBadge, StandingBadge, Dispute, Importance, Swatch, Unassessed } from "@/components/Assessment";
import { AssessmentText } from "@/components/AssessmentText";
import { Term } from "@/components/Term";
import { Contribute } from "@/components/claim/Contribute";
import { StatedViews } from "@/components/claim/StatedViews";
import { CiteClaim } from "@/components/claim/CiteClaim";
import { EmbedClaim } from "@/components/claim/EmbedClaim";
import styles from "./question.module.css";
import { PageHead } from "@/components/PageHead";
import { sourceHref } from "@/lib/source-address";

// A question's page (constitution §7a): first-class, like a claim's. It
// leads with how well the question is answered and the Steward's best
// answer, then the answers with how they bear on one another, the
// subquestions it needs and what it presupposes, and where sources ask it
// or answer it.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Why an answer is in the set: a short tag, with what it means on hover.
const BASIS: Record<NonNullable<QuestionAnswer["basis"]>, { label: string; gloss: string }> = {
  quality: { label: "serious", gloss: "In the set as a serious answer, whether or not anyone prominent holds it." },
  prominence: { label: "widely held", gloss: "In the set because it is widely held, which makes it worth assessing." },
  both: { label: "serious · widely held", gloss: "In the set as a serious answer, and because it is widely held." },
};

function AnswerMark({ a }: { a: QuestionAnswer }) {
  if (a.kind === "quantity" && a.estimate && a.unit) {
    return <span className="qty-chip">{describeEstimate(a.estimate, a.unit).lead}</span>;
  }
  return (
    <>
      {a.status ? <StatusBadge status={a.status} /> : <Unassessed />}
      <SeveralAssessments id={a.id} n={a.judgments_in_force} />
    </>
  );
}

function Answers({ q }: { q: QuestionDetail }) {
  const letter = new Map(q.answers.map((a, i) => [a.id, LETTERS[i] ?? String(i + 1)]));
  const excludes = (x: string) =>
    q.relations
      .filter((r) => r.relation === "excludes" && (r.a === x || r.b === x))
      .map((r) => (r.a === x ? r.b : r.a));
  const compatible = (x: string) =>
    q.relations
      .filter((r) => r.relation === "compatible" && (r.a === x || r.b === x))
      .map((r) => (r.a === x ? r.b : r.a));
  const n = q.answers.length;
  const allExclusive = n > 1 && q.answers.every((a) => excludes(a.id).length === n - 1);
  return (
    <section id="answers">
      <h2>Answers</h2>
      {/* Where every answer excludes every other, one line says so in place
          of a "rules out" on each row. Otherwise each row says its own. */}
      {allExclusive && (
        <p className={styles.intro}>These answers rule one another out: at most one of them is true.</p>
      )}
      <ol className={styles.answers}>
        {q.answers.map((a) => {
          const ex = excludes(a.id);
          const co = compatible(a.id);
          return (
            <li key={a.id} className={`${styles.answer}${a.favored ? ` ${styles.favored}` : ""}`}>
              <span className={styles.letter} aria-hidden>{letter.get(a.id)}</span>
              <div className={styles.answerBody}>
                <p className={styles.answerText}>
                  <Link href={`/claims/${a.id}`}>{a.text}</Link>
                </p>
                <div className={styles.answerMeta}>
                  <AnswerMark a={a} />
                  {a.favored && <span className={styles.favoredTag}>favored by the assessment</span>}
                  {a.basis && (
                    <Term gloss={BASIS[a.basis].gloss} href={DEFINED_IN.question} className={styles.basis}>
                      {BASIS[a.basis].label}
                    </Term>
                  )}
                  {!allExclusive && ex.length > 0 && (
                    <span className={styles.rel}>rules out {ex.map((x) => letter.get(x)).join(", ")}</span>
                  )}
                  {co.length > 0 && (
                    <span className={styles.rel}>can be true with {co.map((x) => letter.get(x)).join(", ")}</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {q.incomplete && <p className={styles.incomplete}><span className="sc">The set is incomplete</span> {q.incomplete}</p>}
    </section>
  );
}

export function QuestionView({ detail, fixture = false }: { detail: ClaimDetail; fixture?: boolean }) {
  const { claim } = detail;
  const q = detail.question!;
  const a = q.assessment?.summary ? { ...q.assessment, summary: q.assessment.summary } : null;
  const texts = buildClaimTextMap(detail.tree);
  const standing = isStanding(q.standing) ? q.standing : null;
  // Views stated to the graph directly (§4) have a section of their own,
  // so their instances are left out of the lists below.
  const stated = new Set((detail.stated_views ?? []).map((v) => v.instance_id));
  const asks = q.instances.filter((i) => i.role === "asks" && !stated.has(i.id));
  const answers = q.instances.filter((i) => i.role === "answers" && !stated.has(i.id));
  const answerText = new Map(q.answers.map((x) => [x.id, x.text]));

  return (
    <article className="col">
      <PageHead
        back={{ href: "/claims", label: "claims" }}
        kicker="Question"
        tags={
          <>
            {claim.state !== "active" && <span className="tag">{claim.state.replace(/_/g, " ")}</span>}
            {fixture && (
              <span className="tag" title="The API is not connected; showing a design fixture.">
                fixture data
              </span>
            )}
            {typeof claim.importance === "number" && (
              <span style={{ marginLeft: "auto" }}>
                <Importance value={claim.importance} />
              </span>
            )}
          </>
        }
        variant="statement"
        title={claim.text}
      />

      <div className="claim-assess">
        <span className="verdict-pair">
          <StandingBadge standing={standing} size="lg" />
          <Dispute value={claim.contestation} />
        </span>
        {a && (
          <span className="assess-when">
            last assessed {fmtDate(a.assessed_at)}
            {a.model ? ` · ${modelDisplayName(a.model)}` : ""}
          </span>
        )}
      </div>

      {q.presuppositions.length > 0 && (
        <div className={styles.presupposes} id="presupposes">
          <span className="sc">Presupposes</span>
          <ul>
            {q.presuppositions.map((p) => (
              <li key={p.id}>
                {p.status ? <Swatch status={p.status} /> : <span className="swatch st-unassessed" />}{" "}
                <Link href={`/claims/${p.id}`}>{p.text}</Link>
                <SeveralAssessments id={p.id} n={p.judgments_in_force} />
                {p.status && isStatus(p.status) && (
                  <span className={styles.presStatus}> · {statusMeta(p.status).label.toLowerCase()}</span>
                )}
              </li>
            ))}
          </ul>
          {q.presuppositions.some((p) => p.status === "doubtful" || p.status === "contradicted") && (
            <p className={styles.presNote}>
              Where a presupposition fails, the question has no answer of the kind it asks for.
            </p>
          )}
        </div>
      )}

      {a ? (
        <section>
          {/* No caption: the standing's meaning is its badge's gloss. */}
          <h2>Assessment</h2>
          <div className="assessment-body">
            <AssessmentText content={a.summary} texts={texts} />
          </div>
          {a.reasoning_trace && a.reasoning_trace !== a.summary && (
            <details className="reasoning-detail">
              <summary>Full reasoning</summary>
              <div className="reasoning">
                <AssessmentText content={a.reasoning_trace} texts={texts} />
              </div>
            </details>
          )}
        </section>
      ) : (
        <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)" }}>
          {/* No assessment in force: say what that does and does not mean
              (#543). An assessment recorded without a summary is examined,
              and keeps the bare line. */}
          {isExamined(detail.coverage, !!standing) ? "Not yet assessed." : notExaminedLine("question")}
        </p>
      )}

      {/* stated views (§4): what a person or an organisation has told the
          graph it holds, beside the assessment and never inside it. */}
      {!fixture && (detail.stated_views ?? []).length > 0 && (
        <StatedViews claimId={claim.id} kind="question" views={detail.stated_views ?? []} />
      )}

      {q.answers.length > 0 && <Answers q={q} />}

      {q.subquestions.length > 0 && (
        <section id="subquestions">
          <h2>Subquestions</h2>
          <ul className={styles.subqs}>
            {q.subquestions.map((s) => (
              <li key={s.id}>
                <StandingBadge standing={s.standing ?? null} />
                <Link href={`/claims/${s.id}`}>{s.text}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(asks.length > 0 || answers.length > 0) && (
        <section id="instances">
          <h2>Provenance</h2>
          {asks.length > 0 && (
            <>
              <h3 className={styles.instHead}>Asked</h3>
              {asks.map((i) => (
                <div className="instance" key={i.id}>
                  {i.verbatim_text && <blockquote>{i.verbatim_text}</blockquote>}
                  <div className="instance-cite">
                    {sourceHref(i.source_url) ? <a href={sourceHref(i.source_url)!}>{i.source_title}</a> : <span>{i.source_title}</span>}
                    {i.source_type && <span className="tag">{i.source_type.replace(/_/g, " ")}</span>}
                  </div>
                </div>
              ))}
            </>
          )}
          {answers.length > 0 && (
            <>
              <h3 className={styles.instHead}>Answered</h3>
              <ul className={styles.answeredBy}>
                {answers.map((i) => (
                  <li key={i.id}>
                    {sourceHref(i.source_url) ? <a href={sourceHref(i.source_url)!}>{i.source_title}</a> : <span>{i.source_title}</span>}
                    {i.answer_id && (
                      <span className={styles.answeredWith}>
                        {" "}answers <Link href={`/claims/${i.answer_id}`}>{answerText.get(i.answer_id) ?? "an answer"}</Link>
                      </span>
                    )}
                    {i.verbatim_text && <blockquote>{i.verbatim_text}</blockquote>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <div className="page-exits">
        <CiteClaim claimId={claim.id} />
        <EmbedClaim claimId={claim.id} text={claim.text} kind={claim.kind} />
      </div>
      <Contribute claimId={claim.id} />
      {/* with none stated, only the invitation, at the foot */}
      {!fixture && (detail.stated_views ?? []).length === 0 && (
        <StatedViews claimId={claim.id} kind="question" views={[]} />
      )}

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)" }}>
        Created by {claim.created_by} · {fmtDate(claim.created_at)}.{" "}
        <Term gloss="A question is answered rather than affirmed or denied, and has a Steward of its own (constitution §7a)." href={DEFINED_IN.question}>
          What a question is
        </Term>
        .
      </p>
    </article>
  );
}

// The left margin of a question's page: what the question is made of, as a
// jump-list, beside the map card the claim page carries too.
export function QuestionRail({ detail }: { detail: ClaimDetail }) {
  const q = detail.question!;
  const items: [string, string, number][] = [
    ["answers", "answer", q.answers.length],
    ["subquestions", "subquestion", q.subquestions.length],
    ["presupposes", "presupposition", q.presuppositions.length],
    ["instances", "source", q.instances.length],
  ];
  const standing = isStanding(q.standing) ? QUESTION_STANDING[q.standing] : null;
  const listed = items.filter(([, , n]) => n > 0);
  // An unassessed question with nothing under it has nothing to jump to, and
  // its standing already heads the reading column: the rail would only say
  // "unassessed" a third time.
  if (!standing && listed.length === 0) return null;
  return (
    <aside className={styles.rail} aria-label="Question">
      <span className="sc">Question</span>
      <p className={styles.railStanding}>
        {standing ? <><span aria-hidden>{standing.glyph}</span> {standing.label.toLowerCase()}</> : "unassessed"}
      </p>
      <ul className={styles.railList}>
        {listed.map(([id, label, n]) => (
          <li key={id}>
            <a href={`#${id}`}><span className={styles.railN}>{n}</span> {label}{n === 1 ? "" : "s"}</a>
          </li>
        ))}
      </ul>
      <SeveralCounted n={severalAmong([...q.answers, ...q.subquestions, ...q.presuppositions])} of="nodes" />
    </aside>
  );
}
