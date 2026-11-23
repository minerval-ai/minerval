import Link from "next/link";
import { SeveralAssessments, SeveralCounted, severalAmong } from "@/components/SeveralAssessments";
import type { ClaimDetail, ListDetail, ListEntry, ListFidelity } from "@/lib/types";
import { CASE_FIDELITY_DEF, DEFINED_IN, LIST_FIDELITY, isFidelity } from "@/lib/ontology";
import { buildClaimTextMap } from "@/lib/claim-links";
import { modelDisplayName } from "@/lib/model-names";
import { describeEstimate } from "@/lib/quantity";
import { StatusBadge, StandingBadge, Importance, Unassessed } from "@/components/Assessment";
import { AssessmentText } from "@/components/AssessmentText";
import { Term } from "@/components/Term";
import { Contribute } from "@/components/claim/Contribute";
import { CiteClaim } from "@/components/claim/CiteClaim";
import { PageHead } from "@/components/PageHead";
import styles from "./list.module.css";

// A list's page (constitution §7b). It leads with what the list is for and
// what qualifies an entry, then how faithful the list is to those criteria,
// then the entries in the Steward's order, each with its own verdict and why
// it is on the list, then what was considered and left out. The list's
// judgment is never a verdict on its entries: those show beside each entry,
// in the status colour that is theirs, and the list's own marks are ink.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const KIND_WORD: Record<string, string> = { claim: "claim", quantity: "quantity", question: "question" };

// `of` says which artifact the fidelity is of: the four words are every
// artifact's, and what each means is said of a list or of a safety case.
export function FidelityBadge({
  fidelity, size = "sm", of = "list",
}: { fidelity: ListFidelity | string | null; size?: "sm" | "lg"; of?: "list" | "case" }) {
  if (!isFidelity(fidelity)) {
    return (
      <Term gloss={of === "case" ? "No Steward has judged this case yet." : "No Steward has judged this list yet."} href={DEFINED_IN.list} className="badge standing unassessed">
        Unjudged
      </Term>
    );
  }
  const f = LIST_FIDELITY[fidelity];
  return (
    <Term gloss={of === "case" ? CASE_FIDELITY_DEF[fidelity] : f.def} href={DEFINED_IN.list} className={`badge standing ${styles.fidelity} ${styles[`f_${fidelity}`] ?? ""}${size === "lg" ? " lg" : ""}`}>
      <span className="badge-glyph" aria-hidden>{f.glyph}</span>
      {f.label}
    </Term>
  );
}

/** An entry's own judgment, as the node's page shows it. */
function EntryMark({ e }: { e: ListEntry }) {
  if (e.kind === "quantity") {
    return e.estimate && e.unit ? <span className="qty-chip">{describeEstimate(e.estimate, e.unit).lead}</span> : <Unassessed />;
  }
  if (e.kind === "question") return <StandingBadge standing={e.standing ?? null} />;
  return (
    <>
      {e.status ? <StatusBadge status={e.status} /> : <Unassessed />}
      <SeveralAssessments id={e.id} n={e.judgments_in_force} />
    </>
  );
}

function Spec({ list }: { list: ListDetail }) {
  const spec = list.spec;
  if (!spec) return null;
  return (
    <section id="criteria" className={styles.spec} aria-label="What the list is">
      <dl>
        <dt>For</dt>
        <dd>{spec.purpose}</dd>
        <dt>Includes</dt>
        <dd>{spec.inclusion}</dd>
        {spec.exclusion && (
          <>
            <dt>Excludes</dt>
            <dd>{spec.exclusion}</dd>
          </>
        )}
        {spec.ordering && (
          <>
            <dt>Ordered by</dt>
            <dd>{spec.ordering}</dd>
          </>
        )}
        {spec.entry_kinds && spec.entry_kinds.length > 0 && (
          <>
            <dt>Entries are</dt>
            <dd>{spec.entry_kinds.map((k) => `${KIND_WORD[k] ?? k}s`).join(" and ")}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Entries({ list }: { list: ListDetail }) {
  return (
    <section id="entries">
      <h2>
        Entries <span className={styles.count}>{list.entries.length}</span>
      </h2>
      {list.entries.length === 0 ? (
        <p className={styles.empty}>Nothing is on the list yet.</p>
      ) : (
        <ol className={styles.entries}>
          {list.entries.map((e, i) => (
            <li key={e.id} className={styles.entry}>
              <span className={styles.n} aria-hidden>{i + 1}</span>
              <div className={styles.entryBody}>
                <p className={styles.entryText}>
                  <Link href={`/claims/${e.id}`}>{e.text}</Link>
                </p>
                <div className={styles.entryMeta}>
                  <EntryMark e={e} />
                  {e.kind !== "claim" && <span className={styles.kind}>{KIND_WORD[e.kind] ?? e.kind}</span>}
                  {e.changed_since && (
                    <Term
                      gloss="This entry's verdict moved, or it joined the list, after the list was last judged. The list's Steward has not yet looked at it as it stands."
                      href={DEFINED_IN.list}
                      className={styles.moved}
                    >
                      changed since judged
                    </Term>
                  )}
                </div>
                <p className={styles.note}>{e.note}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LeftOut({ list }: { list: ListDetail }) {
  if (list.left_out.length === 0) return null;
  return (
    <section id="left-out">
      <h2>Considered and left out</h2>
      <ul className={styles.leftOut}>
        {list.left_out.map((l) => (
          <li key={l.id}>
            {l.text ? <Link href={`/claims/${l.id}`}>{l.text}</Link> : <span className={styles.gone}>A node no longer in the graph</span>}
            <span className={styles.reason}>{l.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ListView({ detail, fixture = false }: { detail: ClaimDetail; fixture?: boolean }) {
  const { claim } = detail;
  const list = detail.list!;
  const a = list.assessment;
  const texts = buildClaimTextMap(detail.tree);
  for (const e of list.entries) texts.set(e.id, e.text);

  return (
    <article className="col">
      <PageHead
        back={{ href: "/claims", label: "claims" }}
        kicker="List"
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

      <Spec list={list} />

      <div className="claim-assess">
        <span className="verdict-pair">
          <FidelityBadge fidelity={list.fidelity} size="lg" />
        </span>
        {a && (
          <span className="assess-when">
            last judged {fmtDate(a.assessed_at)}
            {a.model ? ` · ${modelDisplayName(a.model)}` : ""}
          </span>
        )}
      </div>

      {list.stale && (
        <p className={styles.stale} role="status">
          <span className="sc">Stale</span>{" "}
          {list.changed_entries === 1
            ? "One entry has changed since this list was judged."
            : `${list.changed_entries} entries have changed since this list was judged.`}{" "}
          The judgment below was made against the graph as it was; the entries show their verdicts as they are now.
        </p>
      )}

      {a?.summary ? (
        <section>
          <h2>Assessment</h2>
          <div className="assessment-body">
            <AssessmentText content={a.summary} texts={texts} />
          </div>
          {a.gaps && (
            <p className={styles.gaps}>
              <span className="sc">Known to be missing</span> {a.gaps}
            </p>
          )}
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
        <p className={styles.empty}>Not yet judged.</p>
      )}

      <Entries list={list} />
      <LeftOut list={list} />

      <div className="page-exits">
        <CiteClaim claimId={claim.id} />
      </div>
      <Contribute claimId={claim.id} />

      <hr className="thin" />
      <p className={styles.foot}>
        Created by {claim.created_by} · {fmtDate(claim.created_at)}.{" "}
        <Term
          gloss="A list is made from nodes the graph holds, under criteria a reader can check. It is judged for fidelity to those criteria, not for truth, and carries no weight as evidence (constitution §7b)."
          href={DEFINED_IN.list}
        >
          What a list is
        </Term>
        .
      </p>
    </article>
  );
}

// The left margin of a list's page: its fidelity, and a jump-list.
export function ListRail({ detail }: { detail: ClaimDetail }) {
  const list = detail.list!;
  const f = isFidelity(list.fidelity) ? LIST_FIDELITY[list.fidelity] : null;
  const items: [string, string, number][] = [
    ["entries", "entr", list.entries.length],
    ["left-out", "left out", list.left_out.length],
  ];
  return (
    <aside className={styles.rail} aria-label="List">
      <span className="sc">List</span>
      <p className={styles.railFidelity}>
        {f ? <><span aria-hidden>{f.glyph}</span> {f.label.toLowerCase()}</> : "unjudged"}
        {list.stale && <span className={styles.railStale}> · stale</span>}
      </p>
      <ul className={styles.railList}>
        <li><a href="#criteria">criteria</a></li>
        {items.filter(([, , n]) => n > 0).map(([id, label, n]) => (
          <li key={id}>
            <a href={`#${id}`}>
              <span className={styles.railN}>{n}</span> {id === "entries" ? (n === 1 ? "entry" : "entries") : label}
            </a>
          </li>
        ))}
      </ul>
      <SeveralCounted n={severalAmong(list.entries)} of="entries" />
    </aside>
  );
}
