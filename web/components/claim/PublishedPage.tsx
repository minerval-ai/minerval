import Link from "next/link";
import type { ClaimDetail, Assessment, Stance } from "@/lib/types";
import type { ArgumentGroup } from "@/lib/ontology";
import { RELATION, DEFINED_IN } from "@/lib/ontology";
import type { PublishedPageSummary, PublishedPageView } from "@/lib/published";
import { SEALED_TAB, day, showingWords, stateWords } from "@/lib/published";
import type { Block, PublishedPageShape } from "@/lib/published-page/shape";
import { GIVEN_SOURCE_TEXT_WORDS } from "@/lib/published-page/verify";
import { modelDisplayName } from "@/lib/model-names";
import { ArgumentBlock } from "../DecompositionTree";
import { ArgumentText } from "../ArgumentText";
import { AssessmentText } from "../AssessmentText";
import { Term } from "../Term";
import { HeldPart } from "./HeldPart";
import { CheckPublishedPage } from "./CheckPublishedPage";

// A page another graph publishes of this node, on this node's page
// (docs/published-pages.md). The public assessment stays the default and
// stays the one assessment of everything public. The published page is a
// second tab, in the form every claim page has: what differs is that a
// removal is marked where it was made and a held part stands in its place.

const quiet = { color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", margin: ".35rem 0 0" } as const;

/** The published pages that are on this node's page: one tab each. */
export function onThePage(published: PublishedPageSummary[]): PublishedPageSummary[] {
  return published.filter((p) => p.on_the_node.on_the_nodes_page);
}

export function ClaimTabs({ claimId, published, current }: { claimId: string; published: PublishedPageSummary[]; current: string | null }) {
  const tabs = onThePage(published);
  if (tabs.length === 0) return null;
  return (
    <nav className="claim-tabs" aria-label="Assessments of this claim">
      <Link href={`/claims/${claimId}`} className={current === null ? "on" : undefined} aria-current={current === null ? "page" : undefined}>
        Public assessment
      </Link>
      {tabs.map((p) => (
        <Link
          key={p.published_page_id}
          href={`/claims/${claimId}?published=${p.published_page_id}`}
          className={current === p.published_page_id ? "on" : undefined}
          aria-current={current === p.published_page_id ? "page" : undefined}
        >
          {SEALED_TAB}
          {tabs.length > 1 ? ` · ${p.publisher.name}` : ""}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Under the public verdict: what other graphs publish of this node, and
 * whether this assessment has weighed it. One quiet line for each, and none
 * for a submission no reviewer has admitted.
 */
export function PublishedNotes({ claimId, published }: { claimId: string; published: PublishedPageSummary[] }) {
  const admitted = published.filter((p) => p.on_the_node.review === "admitted" && !p.on_the_node.taken_off_by_the_nodes_steward);
  if (admitted.length === 0) return null;
  return (
    <>
      {admitted.map((p) => {
        const weighed = p.on_the_node.weighed_in_the_nodes_assessment;
        const tab = <Link href={`/claims/${claimId}?published=${p.published_page_id}`}>its redacted assessment on sealed evidence</Link>;
        return (
          <p key={p.published_page_id} className="assess-published" style={quiet}>
            {p.on_the_node.on_the_nodes_page ? (
              weighed ? (
                <>
                  This assessment takes in everything public, including the assessment made in {p.publisher.name}&rsquo;s graph on
                  evidence that is not public, as it stood in package {weighed.package}: {tab}.
                </>
              ) : (
                <>
                  {p.publisher.name}&rsquo;s graph has published {tab} of this claim. It is among this claim&rsquo;s sources. The
                  assessment above was made before it arrived and has not weighed it; it will at its next funded pass.
                </>
              )
            ) : (
              <>
                {p.publisher.name}&rsquo;s graph shows its page of this claim. {showingWords(p)} No page has been released.
              </>
            )}{" "}
            {p.state === "held" || p.state === "not_yet_assessed" ? <>Its latest version there: {stateWords(p).toLowerCase()}.</> : null}
            {p.said_back && p.said_back.admitted > 0 ? (
              <>
                {" "}
                Readers have made {p.said_back.admitted} contribution{p.said_back.admitted === 1 ? "" : "s"} through that page
                {p.said_back.unanswered > 0 ? `, of which ${p.said_back.unanswered} ${p.said_back.unanswered === 1 ? "stands" : "stand"} unanswered by that graph` : ""}.
              </>
            ) : null}
          </p>
        );
      })}
    </>
  );
}

/** The node's detail as the claim page takes it, carrying the published page's verdict in place of the public one. */
export function publishedDetail(detail: ClaimDetail, view: PublishedPageView): ClaimDetail {
  const v = (view.page?.verdict ?? {}) as { status?: string; confidence?: number; credence?: number | null };
  const assessment: Assessment | null =
    view.page && typeof v.status === "string"
      ? ({
          id: view.published_page_id,
          status: v.status,
          confidence: v.confidence ?? 0,
          claim_credence: v.credence ?? null,
          summary: "",
          reasoning_trace: "",
          subclaim_summary: {},
          assessed_at: view.page.version_of ?? "",
          model: view.page.assessed_by_model,
        } as Assessment)
      : null;
  return {
    claim: { ...detail.claim, kind: "claim" },
    assessment,
    subclaim_count: 0,
    tags: detail.tags,
    formalization: null,
    verification: null,
    bounty: null,
    attempts: [],
    prize_claims: [],
  };
}

/** Under the title on the second tab: whose page this is, and how it stands. */
export function PublishedIntro({ view }: { view: PublishedPageView }) {
  const shape = view.page;
  return (
    <div className="published-intro">
      <p className="sc" style={{ color: "var(--muted)", margin: "0 0 .3rem" }}>{SEALED_TAB}</p>
      <p style={{ ...quiet, margin: 0 }}>
        Made in <Link href={`/contributors/${view.publisher.account_id}`}>{view.publisher.name}</Link>&rsquo;s graph, on evidence that is not
        public. It is the page this claim&rsquo;s Steward there wrote, under the same constitution as the public graph&rsquo;s, shown after
        redaction under that graph&rsquo;s published policy. The public assessment of this claim weighs it as a source and is not bound by it.
      </p>
      {shape?.wording && (
        <div className="published-wording">
          <span className="sc">Assessed there in these words</span>
          {shape.wording.held ? <HeldPart held={shape.wording.held} /> : <p>{shape.wording.text}</p>}
        </div>
      )}
      {!shape && <p style={quiet}>No page has been released. {stateWords(view)}.</p>}
    </div>
  );
}

/** What was taken out, in one line, and a later version that is not shown. */
export function TakenOut({ view }: { view: PublishedPageView }) {
  const shape = view.page;
  if (!shape) return null;
  const removals = Object.entries(shape.removals);
  const removed = removals.reduce((n, [, c]) => n + c, 0);
  return (
    <>
      <p className="published-taken-out" style={quiet}>
        Taken out:{" "}
        {removed === 0
          ? "nothing removed under the policy"
          : `${removed} passage${removed === 1 ? "" : "s"} removed under the policy (${removals.map(([c, n]) => `${c}: ${n}`).join(", ")})`}
        ;{" "}
        {shape.held_parts === 0
          ? `all ${shape.parts} parts released.`
          : `${shape.held_parts} of ${shape.parts} parts held: ${shape.held_kinds}.`}{" "}
        {view.audit && <>Audit&rsquo;s check {view.inside ? "of the redaction" : "there"}: {view.audit}</>}
      </p>
      {view.state === "held" && (
        <p className="published-later" style={quiet}>
          <span className="held-mark" aria-hidden /> A later version, of {day(view.version_of)}, exists and is not shown
          {view.held?.because ? `: ${view.held.because}` : ""}
          {view.held?.since ? `, since ${day(view.held.since)}` : ""}. What follows is the version of {day(view.shown_version_of)}.
        </p>
      )}
      {view.ended && (
        <p style={quiet}>
          The showing ended on {day(view.ended.at)}: {view.ended.because}. What was shown stays shown.
        </p>
      )}
    </>
  );
}

/** A verdict that is not a status: a quantity's estimate or a question's standing, as recorded. */
export function OtherVerdict({ view }: { view: PublishedPageView }) {
  const v = (view.page?.verdict ?? null) as Record<string, unknown> | null;
  if (!v || "status" in v) return null;
  return (
    <div className="claim-assess">
      <span>{"estimate" in v ? `Estimate: ${JSON.stringify(v.estimate)}` : `Standing: ${String(v.standing).replace(/_/g, " ")}`}</span>
      <span className="assess-when">
        version of {day(view.shown_version_of)}
        {view.page?.assessed_by_model ? ` · ${modelDisplayName(view.page.assessed_by_model)}` : ""}
      </span>
    </div>
  );
}

const RATING: Record<string, string> = { certain: "certain", likely: "likely", slight: "slight", "no support": "none" };

function groupOf(a: PublishedPageShape["arguments"][number]): ArgumentGroup {
  const rating = a.rating ? (Object.entries(RATING).find(([words]) => a.rating!.startsWith(words))?.[1] ?? null) : null;
  return {
    id: null,
    name: a.name ?? (a.content === null ? "An argument recorded elsewhere, as evaluated here" : "Argument"),
    stance: (["for", "against", "neutral"].includes(a.stance ?? "") ? a.stance : null) as Stance | null,
    content: a.content ?? "",
    verdict: rating,
    decisive: a.decisive,
    evaluation: a.evaluation,
    shows: null,
    leanCheck: null,
    named: true,
    nodes: [],
    net: "unassessed",
    counts: {} as ArgumentGroup["counts"],
  };
}

export function PublishedAssessment({ view }: { view: PublishedPageView }) {
  const shape = view.page!;
  const categories = Object.keys(shape.removals);
  return (
    <>
      <div className="assessment-body">
        <AssessmentText content="" blocks={shape.summary} categories={categories} />
      </div>
      {shape.reasoning.length > 0 && (
        <details className="reasoning-detail" open>
          <summary>Full reasoning: the evidence and decisions behind this verdict</summary>
          <div className="reasoning">
            <AssessmentText content="" blocks={shape.reasoning} categories={categories} />
          </div>
        </details>
      )}
    </>
  );
}

function Blocks({ blocks, categories }: { blocks: Block[]; categories: string[] }) {
  return <AssessmentText content="" blocks={blocks} categories={categories} />;
}

export function PublishedDecomposition({ view }: { view: PublishedPageView }) {
  const shape = view.page!;
  const categories = Object.keys(shape.removals);
  if (shape.arguments.length === 0 && shape.subclaims.length === 0) {
    return <p style={{ color: "var(--muted)", fontStyle: "italic" }}>This page records no arguments or subclaims of its own.</p>;
  }
  return (
    <div className="tree">
      {shape.arguments.map((a) =>
        a.held ? <HeldPart key={a.part} held={a.held} /> : <ArgumentBlock key={a.part} group={groupOf(a)} check={null} published={{ categories }} />,
      )}
      {shape.subclaims.length > 0 && (
        <section className="argblock">
          <div className="arghead basis-head">
            <span className="argname">Subclaims</span>
          </div>
          <ul className="basis-list">
            {shape.subclaims.map((s) =>
              s.held ? (
                <li key={s.part} className="basis-item"><HeldPart held={s.held} /></li>
              ) : (
                <li key={s.part} className="basis-item">
                  <div className="basis-row">
                    {s.relation && RELATION[s.relation.replace(/ /g, "_") as keyof typeof RELATION] ? (
                      <Term gloss={RELATION[s.relation.replace(/ /g, "_") as keyof typeof RELATION].gloss} href={DEFINED_IN.relation} className={`relation ${RELATION[s.relation.replace(/ /g, "_") as keyof typeof RELATION].cls} node-relation`}>
                        {s.relation}
                      </Term>
                    ) : (
                      s.relation && <span className="relation node-relation">{s.relation}</span>
                    )}{" "}
                    <span className="basis-text">
                      {s.wording ? <ArgumentText content={s.wording} categories={categories} /> : <em>a node the page does not name, which this graph already holds</em>}
                    </span>
                  </div>
                  {s.reasoning && (
                    <div className="node-reasoning">
                      <span className="sc">Why this edge</span>
                      <ArgumentText content={s.reasoning} categories={categories} />
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

const SUPPLIED: Record<string, string> = {
  the_organization_itself: "supplied by the publishing organisation itself",
  an_outside_party: "supplied by an outside party",
  not_recorded: "its supplier is not on record",
};

export function PublishedProvenance({ view }: { view: PublishedPageView }) {
  const shape = view.page!;
  const categories = Object.keys(shape.removals);
  return (
    <>
      {shape.sources.length > 0 && (
        <ul className="published-sources">
          {shape.sources.map((s) => (
            <li key={s.source}>
              Source {s.source}: {s.kind === "unknown" ? "a document of a kind not recorded" : s.kind.replace(/_/g, " ")},{" "}
              {view.inside && s.supplied_by === "the_organization_itself" ? "supplied by the organisation itself" : (SUPPLIED[s.supplied_by] ?? SUPPLIED.not_recorded)};{" "}
              {s.interest_recorded ? "an interest in this claim is recorded for it" : "no interest in this claim is recorded for it"}. Content not shown.
              {s.fingerprint && <span className="mono"> fingerprint {s.fingerprint.slice(0, 16)}</span>}
              {s.supplier && (s.supplier.held ? <HeldPart held={s.supplier.held} /> : <div className="published-supplier"><Blocks blocks={[s.supplier]} categories={categories} /></div>)}
            </li>
          ))}
        </ul>
      )}
      {shape.readings.map((r) =>
        r.held ? (
          <HeldPart key={r.part} held={r.held} />
        ) : (
          <div className="instance" key={r.part}>
            {r.passage !== null ? (
              <blockquote><ArgumentText content={r.passage} categories={categories} /></blockquote>
            ) : (
              <Blocks blocks={[{ part: r.part, text: r.text ?? "", marks: [] }]} categories={categories} />
            )}
            <div className="instance-cite">
              <span>{view.inside ? "a source read at the label the page was written at" : "a source read in the publishing graph"}</span>
              {r.stance && <span className="tag">{r.stance}</span>}
            </div>
            {r.context && (
              <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--muted)", margin: ".35rem 0 0" }}>
                <ArgumentText content={r.context} categories={categories} />
              </p>
            )}
            {r.how_read && <p className="instance-reading"><ArgumentText content={r.how_read} categories={categories} /></p>}
          </div>
        ),
      )}
      {shape.stated_views.length > 0 && (
        <>
          <h3 style={{ fontSize: "1rem", margin: "1rem 0 .2rem" }}>Stated views</h3>
          <Blocks blocks={shape.stated_views} categories={categories} />
        </>
      )}
    </>
  );
}

export function PublishedGaps({ view }: { view: PublishedPageView }) {
  const shape = view.page!;
  if (shape.gaps.length === 0) return null;
  return (
    <section>
      <h2>What the page records as missing</h2>
      <p style={{ ...quiet, marginTop: "-.3rem", marginBottom: ".6rem" }}>
        {view.inside
          ? "Requests kept on this node at the label the page was written at, and what the assessment says remains open."
          : "Requests the publishing graph keeps on this node, and what its assessment says remains open."}
      </p>
      <Blocks blocks={shape.gaps} categories={Object.keys(shape.removals)} />
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Whether the publishing deployment asks this graph for a fresh public assessment when its own version of a public node changes, as its package states it. */
function keepsCurrentWords(k: PublishedPageView["keeps_public_versions_current"]): string {
  if (!k) return "The package does not say whether the publishing deployment asks this graph for a fresh public assessment when its own version of a public node changes.";
  if (k.setting === "off") {
    return "The publishing deployment has turned off asking this graph for a fresh public assessment when its own version of a public node changes.";
  }
  return k.a_public_mandate_pays_for_it
    ? "When its own version of a public node changes, the publishing deployment asks a public mandate it funds for a fresh public assessment of that node here."
    : "The publishing deployment's setting for asking this graph for a fresh public assessment when its own version of a public node changes is on, and no public mandate of its own pays for it, so nothing is asked.";
}

/**
 * What readers have said back through this page, and what became of each
 * (docs/outward-acts.md). A contribution made through the page is an
 * ordinary contribution on the claim; what is added here is whether the
 * publishing graph has said it received it, and whether a version made
 * since is published or held.
 */
export function PublishedSaidBack({ view, claimId }: { view: PublishedPageView; claimId: string }) {
  const said = view.said_back ?? [];
  return (
    <section className="section" id="said-back">
      <h2>What readers have said back</h2>
      <p className="section-note">
        Anyone may challenge this page, or propose to the claim through it. A contribution made that way is reviewed here like any other, and{" "}
        {view.publisher.name}&rsquo;s graph reads it from this graph&rsquo;s public record. Below is each one with what that graph has said became of
        it. A contribution with no reassessment paid for there stands unanswered.{" "}
        <Link href={`/claims/${claimId}?contribute=challenge&through=${view.published_page_id}#contribute`}>Challenge this page, or propose through it</Link>.
      </p>
      {said.length === 0 ? (
        <p className="section-note">Nothing has been contributed through this page yet.</p>
      ) : (
        <ul className="record-list" style={{ fontFamily: "var(--sans)", fontSize: ".86rem" }}>
          {said.map((s) => (
            <li key={s.contribution_id} style={{ marginBottom: ".6rem" }}>
              <Link href={`/contributions/${s.contribution_id}`}>
                {s.type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} of {day(s.submitted_at)}
              </Link>
              {s.review !== "admitted" && <> ({s.review} here)</>}
              <br />
              <span className="held-mark" aria-hidden /> {s.in_words}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How this page was published: fields stamped when each thing happened. They are a record, not claims, and carry no status. */
export function PublicationRecord({ view }: { view: PublishedPageView }) {
  const made = view.record.made;
  const shape = view.page;
  const log = made?.run_log ?? null;
  return (
    <details className="reasoning-detail publication-record">
      <summary>
        How this page was published: by {view.publisher.name}, from a deployment on {view.publisher.runs_on};{" "}
        {shape ? `${shape.held_parts} of ${shape.parts} parts held` : stateWords(view).toLowerCase()}; the release check
        {view.check.ok ? " matched" : " did not match"} when it arrived
      </summary>
      <dl className="record-rows">
        <Row label="Publisher">
          <Link href={`/contributors/${view.publisher.account_id}`}>{view.publisher.name}</Link>, the account that registered the deployment&rsquo;s
          signing key (<span className="mono">{view.publisher.key_id.slice(0, 16)}</span>) on {day(view.publisher.registered_at)}.{" "}
          {view.publisher.declared_interest ? <>It says of its own interest: {view.publisher.declared_interest}</> : "It has said nothing of its own interest."}
        </Row>
        <Row label="Where it was made">
          {view.publisher.runs_on.charAt(0).toUpperCase() + view.publisher.runs_on.slice(1)}, by the publisher&rsquo;s own statement. {view.publisher.attested_by.charAt(0).toUpperCase() + view.publisher.attested_by.slice(1)}.
        </Row>
        <Row label="Published">{showingWords(view)}</Row>
        <Row label="Public versions">{keepsCurrentWords(view.keeps_public_versions_current)}</Row>
        <Row label="Sent">{view.record.sent.charAt(0).toUpperCase() + view.record.sent.slice(1)}. Package {view.package} of {view.packages.length}, received {day(view.received_at)}.</Row>
        {made && (
          <>
            <Row label="Prompts">
              Prompt set <span className="mono">{(made.prompt_set ?? "not recorded").slice(0, 16)}</span>
              {view.record.prompt_set_is_this_graphs === true && ", the set this graph's agents work under now"}
              {view.record.prompt_set_is_this_graphs === false && ", which is not the set this graph's agents work under now"}.{" "}
              {made.role_additions.length === 0 ? "No addition by the deployment to any role's prompt." : `${made.role_additions.length} addition(s) by the deployment to a role's prompt.`}
            </Row>
            <Row label="Model">
              Assessed by {made.assessed_by_model ? modelDisplayName(made.assessed_by_model) : "a model not recorded"}; redacted by{" "}
              {made.redacted_by_model ? modelDisplayName(made.redacted_by_model) : "a model not recorded"}.
            </Row>
            <Row label="Run log">
              {!log
                ? "The version names no assessing run."
                : !log.sealed
                  ? "Not sealed."
                  : `Sealed, ${log.steps ?? "an unrecorded number of"} steps. ${log.chain_verifies === true ? "The deployment found its chain intact when it recorded the page." : log.chain_verifies === false ? "The deployment found its chain broken when it recorded the page." : "The deployment did not say whether its chain is intact."} The log itself stays in the deployment.`}
            </Row>
            <Row label="What its writer was given">
              {GIVEN_SOURCE_TEXT_WORDS[made.given_source_text ?? "not_recorded"]} The deployment states this from that run&rsquo;s own record.
            </Row>
            <Row label="Paid for by">
              {made.paid_for ? `${made.paid_for.by.charAt(0).toUpperCase() + made.paid_for.by.slice(1)}${made.paid_for.stake !== "not recorded" ? `; ${made.paid_for.stake}` : ""}.` : "Not recorded."}
            </Row>
          </>
        )}
        {view.policy && (
          <Row label="Redaction policy">
            Version {view.policy.version} (<span className="mono">{view.policy.hash.slice(0, 16)}</span>).
            <details className="record-policy">
              <summary>Read the policy</summary>
              <pre>{view.policy.text}</pre>
            </details>
          </Row>
        )}
        {view.audit && <Row label="Audit's check">{view.audit}</Row>}
        <Row label="Who acted">
          <ul className="record-list">
            {view.record.acts.map((a, i) => (
              <li key={i}>
                {day(a.at)}: {a.by}
                {a.holding.length > 0 ? `, holding ${a.holding.join(" and ")},` : ""} {a.what}
                {a.on ? ` ${a.on}` : ""}
                {a.for_party ? ` for ${a.for_party}` : ""}
                {a.reason ? ` (${a.reason})` : ""}
              </li>
            ))}
          </ul>
          People are numbered in the order they first acted. Where one person holds both direct and release, whoever directed the work also released it.
        </Row>
        <Row label="Versions">
          <ul className="record-list">
            {view.versions.map((v) => (
              <li key={v.page_id}>
                <span className="held-mark" aria-hidden /> Version of {day(v.version_of)}:{" "}
                {stateWords({ state: v.state, parts: v.of_parts, parts_held: v.parts_held, held_kinds: v.held_kinds, held: { because: v.held_because ?? null, since: v.held_since ?? null } })}
                {v.shown_at ? `; shown ${day(v.shown_at)}` : ""}
              </li>
            ))}
          </ul>
          Every version made while the showing stood is listed, the held ones as held.
        </Row>
        <Row label="Release check">
          <CheckPublishedPage publishedPageId={view.published_page_id} pkg={view.package} arrived={view.check} />
        </Row>
      </dl>
      <p style={quiet}>
        These are records the publishing deployment stamped and signed, and this graph kept as it received them. Any of them can be challenged like
        anything else on the graph.
      </p>
    </details>
  );
}
