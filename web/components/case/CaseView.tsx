import Link from "next/link";
import type { ReactNode } from "react";
import { SeveralAssessments, SeveralCounted } from "@/components/SeveralAssessments";
import type { CaseElement, CaseNodeRef, ClaimDetail, SafetyCaseDetail } from "@/lib/types";
import { CASE_FRAMEWORK, CASE_VERDICT, DEFINED_IN, LIST_FIDELITY, isCaseVerdict, isFidelity } from "@/lib/ontology";
import { buildClaimTextMap } from "@/lib/claim-links";
import { mcpAddress } from "@/lib/mcp-address";
import { modelDisplayName } from "@/lib/model-names";
import { estimateAsRecorded } from "@/lib/quantity";
import { Credence, Importance, StandingBadge, StatusBadge, Unassessed } from "@/components/Assessment";
import { AssessmentText } from "@/components/AssessmentText";
import { Term } from "@/components/Term";
import { Contribute } from "@/components/claim/Contribute";
import { CiteClaim } from "@/components/claim/CiteClaim";
import { FidelityBadge } from "@/components/list/ListView";
import { PageHead } from "@/components/PageHead";
import listStyles from "@/components/list/list.module.css";
import styles from "./case.module.css";

// A safety case's page (constitution §7b, #1211). It leads with what the case
// is about: the system, the deployment, the standard and whose it is. Then
// two judgments, side by side and never merged: the graph's own assessment of
// the conclusion as an ordinary claim, and the case's verdict, which says
// whether the case establishes that conclusion to its standard. Then how far
// the case can be relied on as a piece of work (its fidelity), its structure
// as a tree, what counts against it, and where its form fails.
//
// The graph has no defeaters. "Defeater" is the part an ordinary claim plays
// in this case's structure, so the word appears only inside the structure,
// and the status shown beside such a claim is the graph's assessment of it,
// labelled as that, apart from where the doubt stands in the case.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const BLOCK: Record<string, string> = {
  decomposition: "Decomposition",
  substitution: "Substitution",
  concretion: "Concretion",
  calculation: "Calculation",
  evidence_incorporation: "Evidence incorporation",
};

const STANDING: Record<string, string> = { open: "Open", answered: "Answered", sustained: "Sustained" };

const words = (s: string) => s.replace(/_/g, " ");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const anchorOf = (elementId: string) => `element-${elementId}`;

/** An element in a line: the node it presents, or a step's inference. */
function labelOf(e: CaseElement): string {
  return e.node?.text || e.statement;
}

export function frameworkWords(framework: string): string {
  return CASE_FRAMEWORK[framework] ?? capital(words(framework));
}

/** Where a defeater stands in the case. A sustained one that a party accepted is a residual doubt. */
function standingWords(e: CaseElement): string {
  if (e.standing === "sustained" && e.accepted_by) return `Residual doubt, accepted by ${e.accepted_by}`;
  return e.standing ? (STANDING[e.standing] ?? capital(words(e.standing))) : "Not recorded";
}

/** The graph's own judgment of a node, exactly as the node's page shows it. */
function NodeMark({ node, size = "sm" }: { node: CaseNodeRef; size?: "sm" | "lg" }) {
  const j = node.judgment;
  if (node.kind === "quantity") {
    return j?.estimate ? <span className="qty-chip">{estimateAsRecorded(j.estimate)}</span> : <Unassessed />;
  }
  if (node.kind === "question") return <StandingBadge standing={j?.standing ?? null} size={size} />;
  if (node.kind === "artifact") return <FidelityBadge fidelity={j?.fidelity ?? null} size={size} />;
  return (
    <>
      {j?.status ? <StatusBadge status={j.status} size={size} /> : <Unassessed />}
      <SeveralAssessments id={node.id} n={node.judgments_in_force} />
    </>
  );
}

function Spec({ c }: { c: SafetyCaseDetail }) {
  const spec = c.spec;
  if (!spec) return null;
  return (
    <section id="specification" className={styles.spec} aria-label="What the case is about">
      <dl>
        <dt>System</dt>
        <dd>{spec.system}</dd>
        <dt>Deployment</dt>
        <dd>{spec.deployment}</dd>
        <dt>Standard</dt>
        <dd>
          {spec.standard} <span className={styles.specOf}>Standard of: {spec.standard_of}</span>
        </dd>
        <dt>Framework</dt>
        <dd>{frameworkWords(spec.framework)}</dd>
        <dt>Does not cover</dt>
        <dd>{spec.not_covered ?? <span className={styles.specOf}>Nothing stated.</span>}</dd>
      </dl>
    </section>
  );
}

/** The two judgments. They are about different things and can differ; neither is shown as the other. */
function Judgments({ c }: { c: SafetyCaseDetail }) {
  const a = c.assessment;
  const verdict = a?.verdict ?? c.verdict;
  return (
    <section id="judgments" className={styles.pair} aria-label="The conclusion's assessment and the case's verdict">
      <div className={styles.judgment}>
        <span className="sc">The conclusion, as a claim: where the evidence stands</span>
        {c.conclusion ? (
          <>
            <p className={styles.conclusion}>
              <Link href={`/claims/${c.conclusion.id}`}>{c.conclusion.text}</Link>
            </p>
            <div className={styles.marks}>
              <NodeMark node={c.conclusion} size="lg" />
              <Credence value={c.conclusion.judgment?.credence} />
            </div>
          </>
        ) : (
          <p className={listStyles.empty}>The case names no conclusion this reader can open.</p>
        )}
        <p className={styles.about}>
          The graph&rsquo;s own assessment of the conclusion as an ordinary claim, made on its own page. The case&rsquo;s verdict does not
          change it.
        </p>
      </div>
      <div className={styles.judgment}>
        <span className="sc">The case&rsquo;s verdict</span>
        {isCaseVerdict(verdict) ? (
          <p className={styles.verdict}>{CASE_VERDICT[verdict]}.</p>
        ) : (
          <p className={`${styles.verdict} ${styles.verdictNone}`}>The case has not yet been judged against its standard.</p>
        )}
        {a?.verdict_basis && (
          <p className={styles.basis}>
            <span className={styles.basisLabel}>What the verdict rests on</span>
            {a.verdict_basis}
          </p>
        )}
        {a?.would_change && (
          <p className={styles.basis}>
            <span className={styles.basisLabel}>What would change it</span>
            {a.would_change}
          </p>
        )}
        <p className={styles.about}>
          A statement about the case under its standard, where the burden is on the case. It is not the conclusion&rsquo;s status, and the two
          can differ.
        </p>
      </div>
    </section>
  );
}

function ChangedSince() {
  return (
    <Term
      gloss="This node's verdict moved, or it joined the case, after the case was last judged. The case's Steward has not yet looked at it as it stands."
      href={DEFINED_IN.list}
      className={listStyles.moved}
    >
      changed since judged
    </Term>
  );
}

/** What part an element plays, in a word or two. */
function Role({ e, parent }: { e: CaseElement; parent: CaseElement | null }) {
  if (e.type === "step") {
    const block = e.block ? (BLOCK[e.block] ?? capital(words(e.block))) : null;
    return <span className={styles.role}>{block ? `Step: ${block}` : "Step"}</span>;
  }
  if (e.type === "defeater") {
    return (
      <Term
        gloss="Defeater is the part this claim plays in this case: a doubt raised against the element it hangs under. In the graph it is an ordinary claim, assessed on its own page."
        href={DEFINED_IN.list}
        className={styles.role}
      >
        Defeater
      </Term>
    );
  }
  const role =
    e.type === "side_claim"
      ? "Side claim"
      : e.type === "evidence"
        ? "Evidence"
        : e.type === "claim"
          ? parent === null
            ? "Conclusion"
            : parent.type === "defeater"
              ? "Claim answering the doubt"
              : "Claim"
          : capital(words(e.type));
  return <span className={styles.role}>{role}</span>;
}

function Element({
  e, parent, kids, seen,
}: {
  e: CaseElement;
  parent: CaseElement | null;
  /** Every element's children, by the element they hang under. */
  kids: Map<string, CaseElement[]>;
  /** The elements on the path down to this one, so a malformed structure that loops is drawn once. */
  seen: ReadonlySet<string>;
}) {
  const isStep = e.type === "step";
  const isDefeater = e.type === "defeater";
  const under = seen.has(e.id) ? [] : (kids.get(e.id) ?? []);
  const below = new Set(seen).add(e.id);
  return (
    <li id={anchorOf(e.id)} className={`${styles.element}${isDefeater ? ` ${styles.defeater}` : ""}`}>
      <div className={styles.elementBody}>
        <div className={styles.elementHead}>
          <Role e={e} parent={parent} />
          {isDefeater && parent && (
            <span>
              doubts <a href={`#${anchorOf(parent.id)}`}>the {parent.type === "step" ? "step" : words(parent.type)} it hangs under</a>
            </span>
          )}
          {e.changed_since && <ChangedSince />}
        </div>
        {isStep ? (
          <p className={styles.inference}>{e.statement}</p>
        ) : (
          <>
            <p className={styles.nodeText}>
              {e.node ? <Link href={`/claims/${e.node.id}`}>{e.node.text}</Link> : <span className={styles.gone}>A node no longer in the graph</span>}
            </p>
            {e.node && (
              <div className={styles.meta}>
                <Term
                  gloss={
                    isDefeater
                      ? "The graph's own assessment of this claim, as its own page shows it. It is not where the doubt stands in this case, which is given below."
                      : "The graph's own assessment of this node, as its own page shows it. The case does not change it."
                  }
                  href={DEFINED_IN.status}
                >
                  The graph&rsquo;s assessment of this {e.node.kind === "claim" ? "claim" : words(String(e.node.kind))}
                </Term>
                <NodeMark node={e.node} />
              </div>
            )}
            <p className={styles.line}>
              <span className={styles.lineLabel}>{isDefeater ? "The doubt, as the case states it" : "What the case needs of it"}</span>
              {e.statement}
            </p>
          </>
        )}
        {isDefeater && (
          <>
            <p className={styles.line}>
              <span className={styles.lineLabel}>Where the doubt stands in this case</span>
              <span className={styles.standing}>{standingWords(e)}</span>
              {e.standing_reason ? `. ${e.standing_reason}` : ""}
            </p>
            {e.standing === "sustained" && e.accepted_by && e.acceptance && (
              <p className={styles.line}>
                <span className={styles.lineLabel}>Why it was accepted</span>
                {e.acceptance}
              </p>
            )}
          </>
        )}
        {e.departure && (
          <p className={styles.line}>
            <span className={styles.lineLabel}>Departs from the framework</span>
            {e.departure}
          </p>
        )}
      </div>
      {under.length > 0 && (
        <ul>
          {under.map((k) => (
            <Element key={k.id} e={k} parent={e} kids={kids} seen={below} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The elements as a tree: tops first (the conclusion, and anything hanging under an element the case does not hold), siblings by position. */
function treeOf(elements: CaseElement[]): { tops: CaseElement[]; children: Map<string, CaseElement[]> } {
  const ids = new Set(elements.map((e) => e.id));
  const ordered = [...elements].sort((a, b) => a.position - b.position);
  const children = new Map<string, CaseElement[]>();
  const tops: CaseElement[] = [];
  for (const e of ordered) {
    if (e.parent === null || !ids.has(e.parent) || e.parent === e.id) tops.push(e);
    else children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
  }
  return { tops, children };
}

function Structure({ c }: { c: SafetyCaseDetail }) {
  const { tops, children } = treeOf(c.elements);
  return (
    <section id="structure">
      <h2>
        The case&rsquo;s structure <span className={listStyles.count}>{c.elements.length}</span>
      </h2>
      <p className={styles.sectionNote}>
        Each element hangs under what it argues for, and a doubt under what it doubts. Every element but a step presents a node the graph
        holds, shown with the graph&rsquo;s own assessment of it and, apart from that, what the case needs of it.
      </p>
      {tops.length === 0 ? (
        <p className={listStyles.empty}>The case has no structure yet.</p>
      ) : (
        <ul className={styles.tree}>
          {tops.map((e) => (
            <Element key={e.id} e={e} parent={null} kids={children} seen={new Set()} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A link to an element's place in the structure, by what it presents. */
function ElementLink({ id, byId, lead }: { id: string | null; byId: Map<string, CaseElement>; lead?: ReactNode }) {
  const e = id ? byId.get(id) : undefined;
  if (!e) return null;
  return (
    <span className={styles.where}>
      {lead}
      <a href={`#${anchorOf(e.id)}`}>{labelOf(e)}</a>
    </span>
  );
}

function CountsAgainst({ c, byId }: { c: SafetyCaseDetail; byId: Map<string, CaseElement> }) {
  return (
    <section id="counts-against">
      <h2>
        What counts against the case {c.counts_against.length > 0 && <span className={listStyles.count}>{c.counts_against.length}</span>}
      </h2>
      <p className={styles.sectionNote}>
        The burden is on the case. This is what its own structure shows against it, as it stands now. None of it is a finding about any
        claim the case presents.
      </p>
      {c.counts_against.length === 0 ? (
        <p className={styles.quiet}>Nothing in the case&rsquo;s structure counts against it as it stands.</p>
      ) : (
        <ul className={styles.plain}>
          {c.counts_against.map((x, i) => (
            <li key={i}>
              {x.message}
              <ElementLink id={x.element} byId={byId} lead="At: " />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ResidualDoubts({ c, byId }: { c: SafetyCaseDetail; byId: Map<string, CaseElement> }) {
  const doubts = c.residual_doubts.map((id) => byId.get(id)).filter((e): e is CaseElement => !!e);
  if (doubts.length === 0) return null;
  return (
    <section id="residual-doubts">
      <h2>
        Residual doubts <span className={listStyles.count}>{doubts.length}</span>
      </h2>
      <p className={styles.sectionNote}>
        Doubts the case sustains and proceeds past, each accepted by a named party. They do not count against the case, and the verdict
        rests on them.
      </p>
      <ul className={styles.plain}>
        {doubts.map((e) => (
          <li key={e.id}>
            <a href={`#${anchorOf(e.id)}`}>{labelOf(e)}</a>
            <span className={styles.where}>Accepted by {e.accepted_by}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Form({ c, byId }: { c: SafetyCaseDetail; byId: Map<string, CaseElement> }) {
  const { framework, well_formed, failures } = c.form;
  if (failures.length === 0) {
    if (!well_formed || framework === "none") return null;
    return <p className={styles.quiet}>The case is well formed under its framework ({frameworkWords(framework)}).</p>;
  }
  return (
    <section id="form">
      <h2>
        Where the form fails <span className={listStyles.count}>{failures.length}</span>
      </h2>
      <p className={styles.sectionNote}>
        {framework === "none"
          ? "The case names no framework. These are failures of what any case's structure must be."
          : `Checked against the case's framework (${frameworkWords(framework)}).`}{" "}
        Form is checked; whether a step is sound or a doubt is answered is judged.
      </p>
      <ul className={styles.plain}>
        {failures.map((f, i) => (
          <li key={i}>
            {f.message}
            <ElementLink id={f.element} byId={byId} lead="At: " />
            {f.departure && <span className={styles.where}>The case&rsquo;s Steward states this as a departure from the framework: {f.departure}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotRaised({ c, byId }: { c: SafetyCaseDetail; byId: Map<string, CaseElement> }) {
  const added = c.not_raised_in_published.map((id) => byId.get(id)).filter((e): e is CaseElement => !!e);
  if (added.length === 0) return null;
  return (
    <section id="adds">
      <h2>
        What this structure adds <span className={listStyles.count}>{added.length}</span>
      </h2>
      <p className={styles.sectionNote}>Parts of the structure that the developer&rsquo;s published case never raises.</p>
      <ul className={styles.plain}>
        {added.map((e) => (
          <li key={e.id}>
            <a href={`#${anchorOf(e.id)}`}>{labelOf(e)}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The case in its framework's form, from the API. The API's public address is
 * read as the pages that tell people how to connect read it (lib/mcp-address.ts);
 * where it cannot be read there is no link to give.
 */
async function CaseExportLink({ claimId }: { claimId: string }) {
  const { apiBase } = await mcpAddress();
  if (!apiBase) return null;
  return (
    <p className={styles.quiet}>
      <a href={`${apiBase}/claims/${claimId}/cae`}>Export this case</a>: its structure in Claims, Arguments, Evidence form, as JSON, with each
      node&rsquo;s assessment as it stands when exported. See <Link href="/docs/citing#export">Export it</Link>.
    </p>
  );
}

export function CaseView({ detail, fixture = false }: { detail: ClaimDetail; fixture?: boolean }) {
  const { claim } = detail;
  const c = detail.safety_case!;
  const a = c.assessment;
  const byId = new Map(c.elements.map((e) => [e.id, e]));
  const texts = buildClaimTextMap(detail.tree);
  for (const e of c.elements) if (e.node) texts.set(e.node.id, e.node.text);

  return (
    <article className="col">
      <PageHead
        back={{ href: "/claims", label: "claims" }}
        kicker="Safety case"
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

      <Spec c={c} />
      <Judgments c={c} />

      <div className="claim-assess">
        <span className="verdict-pair">
          <span className="sc">How far the case can be relied on</span>
          <FidelityBadge fidelity={c.fidelity} size="lg" of="case" />
        </span>
        {a && (
          <span className="assess-when">
            last judged {fmtDate(a.assessed_at)}
            {a.model ? ` · ${modelDisplayName(a.model)}` : ""}
          </span>
        )}
      </div>

      {c.stale && (
        <p className={listStyles.stale} role="status">
          <span className="sc">Stale</span>{" "}
          {c.changed_nodes === 1
            ? "One node the case draws on has changed since this case was judged."
            : `${c.changed_nodes} nodes the case draws on have changed since this case was judged.`}{" "}
          The verdict and the judgment below were made against the graph as it was; the structure shows each node&rsquo;s assessment as it is
          now.
        </p>
      )}

      {a?.summary ? (
        <section>
          <h2>Assessment</h2>
          <div className="assessment-body">
            <AssessmentText content={a.summary} texts={texts} />
          </div>
          {a.gaps && (
            <p className={listStyles.gaps}>
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
        !a && <p className={listStyles.empty}>Not yet judged.</p>
      )}

      <Structure c={c} />
      <CountsAgainst c={c} byId={byId} />
      <ResidualDoubts c={c} byId={byId} />
      <Form c={c} byId={byId} />
      <NotRaised c={c} byId={byId} />

      <div className="page-exits">
        {!fixture && <CaseExportLink claimId={claim.id} />}
        <CiteClaim claimId={claim.id} />
      </div>
      <Contribute claimId={claim.id} />

      <hr className="thin" />
      <p className={listStyles.foot}>
        Created by {claim.created_by} · {fmtDate(claim.created_at)}.{" "}
        <Term
          gloss="A safety case argues one conclusion about one system in one deployment, to a stated standard, from nodes the graph holds. It is judged for how far it can be relied on and for whether it establishes its conclusion to that standard. Neither judgment changes the assessment of any claim it presents (constitution §7b)."
          href={DEFINED_IN.list}
        >
          What a safety case is
        </Term>
        .
      </p>
    </article>
  );
}

// The left margin of a case's page: its verdict and its fidelity, each named, and a jump-list.
export function CaseRail({ detail }: { detail: ClaimDetail }) {
  const c = detail.safety_case!;
  const f = isFidelity(c.fidelity) ? LIST_FIDELITY[c.fidelity] : null;
  const defeaters = c.elements.filter((e) => e.type === "defeater").length;
  const items: [string, string, number | null][] = [
    ["specification", "specification", null],
    ["judgments", "conclusion and verdict", null],
    ["structure", c.elements.length === 1 ? "element" : "elements", c.elements.length],
    ["counts-against", "against the case", c.counts_against.length],
    ["residual-doubts", c.residual_doubts.length === 1 ? "residual doubt" : "residual doubts", c.residual_doubts.length],
    ["form", c.form.failures.length === 1 ? "failure of form" : "failures of form", c.form.failures.length],
    ["adds", "not in the published case", c.not_raised_in_published.length],
  ];
  return (
    <aside className={listStyles.rail} aria-label="Safety case">
      <span className="sc">Safety case</span>
      <p className={listStyles.railFidelity}>
        {c.verdict === "established" ? "establishes its conclusion" : c.verdict === "not_established" ? "does not yet establish its conclusion" : "not yet judged"}
        {c.stale && <span className={listStyles.railStale}> · stale</span>}
      </p>
      <ul className={listStyles.railList}>
        <li>
          as a piece of work: {f ? <><span aria-hidden>{f.glyph}</span> {f.label.toLowerCase()}</> : "unjudged"}
        </li>
        {items
          .filter(([id, , n]) => n === null || n > 0 || id === "counts-against")
          .map(([id, label, n]) => (
            <li key={id}>
              <a href={`#${id}`}>
                {n !== null && <span className={listStyles.railN}>{n}</span>} {label}
              </a>
            </li>
          ))}
        {defeaters > 0 && (
          <li>
            {defeaters} {defeaters === 1 ? "doubt" : "doubts"} raised in the structure
          </li>
        )}
      </ul>
      <SeveralCounted n={c.elements.filter((e) => (e.node?.judgments_in_force ?? 0) > 1).length} of="elements" />
    </aside>
  );
}
