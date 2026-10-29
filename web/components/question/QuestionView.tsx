import Link from "next/link";
import type { ClaimDetail, QuestionAnswer, QuestionDetail } from "@/lib/types";
import { DEFINED_IN, QUESTION_STANDING, isStanding, statusMeta, isStatus } from "@/lib/ontology";
import { buildClaimTextMap } from "@/lib/claim-links";
import { modelDisplayName } from "@/lib/model-names";
import { describeEstimate } from "@/lib/quantity";
import { StatusBadge, StandingBadge, Dispute, Importance, Swatch, Unassessed } from "@/components/Assessment";
import { AssessmentText } from "@/components/AssessmentText";
import { Term } from "@/components/Term";
import { Contribute } from "@/components/claim/Contribute";
import { CiteClaim } from "@/components/claim/CiteClaim";
import styles from "./question.module.css";

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

const BASIS: Record<NonNullable<QuestionAnswer["basis"]>, string> = {
  quality: "a serious answer, whether or not anyone prominent holds it",
  prominence: "widely held, so worth assessing",
  both: "serious and widely held",
};

function AnswerMark({ a }: { a: QuestionAnswer }) {
  if (a.kind === "quantity" && a.estimate && a.unit) {
    return <span className="qty-chip">{describeEstimate(a.estimate, a.unit).lead}</span>;
  }
  return a.status ? <StatusBadge status={a.status} /> : <Unassessed />;
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
      <p className={styles.intro}>
        Each candidate answer is a claim or a quantity with a page of its own, in the set for its
        quality or its prominence.{" "}
        {allExclusive
          ? "These answers rule one another out: at most one of them is true."
          : "How the answers bear on one another is recorded pair by pair."}
      </p>
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
                  {a.basis && <span className={styles.basis}>{BASIS[a.basis]}</span>}
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

export function QuestionView({ detail }: { detail: ClaimDetail }) {
  const { claim } = detail;
  const q = detail.question!;
  const a = detail.assessment?.summary ? detail.assessment : null;
  const texts = buildClaimTextMap(detail.tree);
  const standing = isStanding(q.standing) ? q.standing : null;
  const asks = q.instances.filter((i) => i.role === "asks");
  const answers = q.instances.filter((i) => i.role === "answers");
  const answerText = new Map(q.answers.map((x) => [x.id, x.text]));

  return (
    <article className="col">
      <div className="claim-eyebrow">
        <span className="sc">Question</span>
        {claim.state !== "active" && <span className="tag">{claim.state.replace(/_/g, " ")}</span>}
        {typeof claim.importance === "number" && (
          <span style={{ marginLeft: "auto" }}>
            <Importance value={claim.importance} />
          </span>
        )}
      </div>

      <h1 className="claim-hero">{claim.text}</h1>

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
          <h2>Assessment</h2>
          <p className={styles.intro}>
            The Steward&apos;s best answer, and how well answered the question is
            {standing ? `: ${QUESTION_STANDING[standing].def.charAt(0).toLowerCase()}${QUESTION_STANDING[standing].def.slice(1)}` : "."}
          </p>
          <div className="assessment-body">
            <AssessmentText content={a.summary} texts={texts} />
          </div>
          {a.reasoning_trace && a.reasoning_trace !== a.summary && (
            <details className="reasoning-detail">
              <summary>Full reasoning: how the answers were weighed</summary>
              <div className="reasoning">
                <AssessmentText content={a.reasoning_trace} texts={texts} />
              </div>
            </details>
          )}
        </section>
      ) : (
        <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)" }}>
          Not yet assessed.
        </p>
      )}

      {q.answers.length > 0 && <Answers q={q} />}

      {q.subquestions.length > 0 && (
        <section id="subquestions">
          <h2>Subquestions</h2>
          <p className={styles.intro}>Questions whose answers this one needs.</p>
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
          <p className={styles.intro}>Where sources ask this question, and where they answer it.</p>
          {asks.length > 0 && (
            <>
              <h3 className={styles.instHead}>Asked</h3>
              {asks.map((i) => (
                <div className="instance" key={i.id}>
                  {i.verbatim_text && <blockquote>{i.verbatim_text}</blockquote>}
                  <div className="instance-cite">
                    {i.source_url ? <a href={i.source_url}>{i.source_title}</a> : <span>{i.source_title}</span>}
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
                    {i.source_url ? <a href={i.source_url}>{i.source_title}</a> : <span>{i.source_title}</span>}
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

      <CiteClaim claimId={claim.id} />
      <Contribute claimId={claim.id} />

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
    ["answers", "answers", q.answers.length],
    ["subquestions", "subquestions", q.subquestions.length],
    ["presupposes", "presuppositions", q.presuppositions.length],
    ["instances", "sources", q.instances.length],
  ];
  const standing = isStanding(q.standing) ? QUESTION_STANDING[q.standing] : null;
  return (
    <aside className={styles.rail} aria-label="Question">
      <span className="sc">Question</span>
      <p className={styles.railStanding}>
        {standing ? <><span aria-hidden>{standing.glyph}</span> {standing.label.toLowerCase()}</> : "unassessed"}
      </p>
      <ul className={styles.railList}>
        {items.filter(([, , n]) => n > 0).map(([id, label, n]) => (
          <li key={id}>
            <a href={`#${id}`}><span className={styles.railN}>{n}</span> {label}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
