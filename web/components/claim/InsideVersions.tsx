import Link from "next/link";
import type { InsideNode, ShownTab } from "@/lib/inside-node";
import { modelDisplayName } from "@/lib/model-names";
import { isStatus } from "@/lib/ontology";
import { day, stateWords, type PublishedPageView } from "@/lib/published";
import type { ClaimDetail, NodeVersion } from "@/lib/types";
import { Credence, StatusBadge, VerdictConfidence } from "../Assessment";
import { AssessmentText } from "../AssessmentText";
import { CheckShownPage } from "./CheckShownPage";

// A node's page inside a private deployment (lib/inside-node.ts). The page
// is the ordinary one. A deployment that holds material at more than one
// label adds three things, and this file draws them:
//
//   - tabs, one for each assessment of the node the reader may read and one
//     for each page of it shown to a label they read;
//   - under the tabs, what the assessment in front of the reader was made
//     on, what it was made beside, and whether that has changed since;
//   - where a reader holds two labels that do not read each other, both
//     assessments in full, with nothing choosing between them.
//
// Every sentence here is read by a member who may be new to all of it, so
// none of them leans on a word the page has not explained.

const quiet = { color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", margin: ".35rem 0 0" } as const;

/** What a tab is called. Outside, the second tab is "Redacted assessment on sealed evidence"; inside, the evidence is open to colleagues at another label, so it is named by what it is to this reader. */
export const SHOWN_TAB_INSIDE = "Redacted assessment on evidence you cannot read";
export const SHOWN_TAB_OUTSIDE = "Redacted assessment, as shown outside";

export function versionTabName(label: string): string {
  return label === "public" ? "Public assessment" : `Assessment at ${label}`;
}

function shownTabName(tab: ShownTab): string {
  if (tab.outside) return SHOWN_TAB_OUTSIDE;
  // A reader of the label the page was written at can read the evidence: to them it is the page as others are shown it.
  return tab.from_label ? `Redacted assessment, as shown to ${tab.shown_to}` : SHOWN_TAB_INSIDE;
}

/** An assessment named in the middle of a sentence. */
function versionRef(label: string): string {
  return label === "public" ? "the public assessment" : `the assessment at ${label}`;
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function VersionTabs({ claimId, inside }: { claimId: string; inside: InsideNode }) {
  const { versions, shown, open } = inside;
  if (versions.length + shown.length < 2 && open.kind !== "shown") return null;
  const here = (on: boolean) => ({ className: on ? "on" : undefined, "aria-current": on ? ("page" as const) : undefined });
  const several = open.kind === "several";
  return (
    <nav className="claim-tabs" aria-label="Assessments of this node">
      {several && (
        <Link href={`/claims/${claimId}`} {...here(true)}>
          {open.versions.length === 2 ? "Both assessments" : `All ${open.versions.length} assessments`}
        </Link>
      )}
      {versions.map((v) => (
        <Link key={v.id} href={`/claims/${claimId}?at=${encodeURIComponent(v.label)}`} {...here(open.kind === "version" && open.version.id === v.id)}>
          {versionTabName(v.label)}
        </Link>
      ))}
      {shown.map((t) => (
        <Link key={t.page_id} href={`/claims/${claimId}?shown=${t.page_id}`} {...here(open.kind === "shown" && open.tab.page_id === t.page_id)}>
          {shownTabName(t)}
        </Link>
      ))}
    </nav>
  );
}

/** What an assessment was made on, in a sentence: the label it was made at, said in ordinary words. */
function madeOn(version: NodeVersion, detail: ClaimDetail): string {
  if (version.label === "public") {
    return detail.mirrored
      ? `This is the public graph's own assessment, read from the copy of the public graph this deployment keeps${detail.mirrored.public_graph_as_of ? `, as it stood on ${day(detail.mirrored.public_graph_as_of)}` : ""}. Nothing held in this deployment went into it.`
      : "This assessment was made on what every member of this deployment may read, and on nothing filed more narrowly.";
  }
  return `This assessment was made by this node's Steward working at the label ${version.label}: on what is filed at ${version.label} and at the labels ${version.label} reads, and on nothing else.`;
}

/** What it was made beside, and whether that has since changed. */
function madeBeside(version: NodeVersion): string[] {
  const lines: string[] = [];
  for (const b of version.made_beside) {
    const other = b.label === "public" ? "the public assessment" : `the assessment at ${b.label}`;
    lines.push(
      b.replaced
        ? `When it was made, ${other} was in front of it. That one has been replaced since, so this assessment has not taken the newer one into account. The deployment opens a fresh assessment at ${version.label} when that happens, and it runs when someone pays for it.`
        : `When it was made, ${other} was in front of it, and that one still stands.`,
    );
  }
  for (const label of version.versions_since) {
    lines.push(`${label === "public" ? "A public assessment" : `An assessment at ${label}`} has been made since. This one was made without it.`);
  }
  return lines;
}

/**
 * Under the tabs, for one assessment: what it was made on, why it is the
 * one shown first or that it is not, and what it was made beside.
 */
export function VersionNote({ claimId, detail, inside, version }: { claimId: string; detail: ClaimDetail; inside: InsideNode; version: NodeVersion }) {
  const others = inside.versions.filter((v) => v.id !== version.id);
  const first = inside.versions.filter((v) => v.in_force);
  return (
    <div className="version-note">
      <p style={{ ...quiet, margin: 0 }}>
        {madeOn(version, detail)}{" "}
        {others.length > 0 &&
          (version.in_force ? (
            first.length === 1 ? (
              <>
                It is shown first because it was made on the most that you may read. {numberWord(others.length)} other assessment
                {others.length === 1 ? " of this node is" : "s of this node are"} a tab away, each made on less and each kept as current as this one.
              </>
            ) : (
              <>
                You also read <Link href={`/claims/${claimId}`}>{listOf(first.filter((v) => v.id !== version.id).map((v) => versionRef(v.label)))}</Link>, made on
                evidence this one did not see. Neither replaces the other.
              </>
            )
          ) : (
            <>
              It is not the one shown first:{" "}
              {listOf(first.map((v) => versionRef(v.label)))} {first.length === 1 ? "was" : "were"} made on more that you may read.
            </>
          ))}
      </p>
      {madeBeside(version).map((line, i) => (
        <p key={i} style={quiet}>
          {line}
        </p>
      ))}
    </div>
  );
}

/** A version's verdict in the fields its kind has, drawn with the claim page's own badge and meters. */
function VersionBand({ version }: { version: NodeVersion }) {
  return (
    <div className="claim-assess">
      {typeof version.status === "string" && isStatus(version.status) ? (
        <>
          <StatusBadge status={version.status} size="lg" />
          <Credence value={version.claim_credence} />
          <VerdictConfidence value={version.confidence} />
        </>
      ) : "estimate" in version ? (
        <span>Estimate: {JSON.stringify(version.estimate)}</span>
      ) : (
        <span>Standing: {String(version.standing ?? "not recorded").replace(/_/g, " ")}</span>
      )}
      <span className="assess-when">
        last assessed {day(version.assessed_at)}
        {version.model ? ` · ${modelDisplayName(version.model)}` : ""}
        {version.run_id ? (
          <>
            {" · "}
            <a href={`/runs/${version.run_id}`}>the run</a>
          </>
        ) : null}
      </span>
    </div>
  );
}

/** Each of the given assessments in full: the verdict, what it was made on and beside, the summary and the reasoning. */
export function VersionsInFull({ claimId, detail, versions, texts }: { claimId: string; detail: ClaimDetail; versions: NodeVersion[]; texts?: Map<string, string> }) {
  return (
    <div className="versions-columns">
        {versions.map((v) => {
          const summary = v.summary ?? v.reasoning_trace ?? "";
          const more = v.reasoning_trace ?? v.work ?? "";
          return (
            <article key={v.id} className="version-column">
              <h2 className="version-head">
                <Link href={`/claims/${claimId}?at=${encodeURIComponent(v.label)}`}>{versionTabName(v.label)}</Link>
              </h2>
              <VersionBand version={v} />
              <p style={quiet}>{madeOn(v, detail)}</p>
              {madeBeside(v).map((line, i) => (
                <p key={i} style={quiet}>
                  {line}
                </p>
              ))}
              <div className="assessment-body">
                <AssessmentText content={summary} texts={texts} />
              </div>
              {more && more !== summary && (
                <details className="reasoning-detail">
                  <summary>Full reasoning: the evidence and decisions behind this verdict</summary>
                  <div className="reasoning">
                    <AssessmentText content={more} texts={texts} />
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>
  );
}

/**
 * Two or more assessments in force for one reader, at labels that do not
 * read each other: each in full, one beside the other where the
 * column has room and one after the other where it has not, in the order of
 * the labels' names.
 */
export function SeveralInForce({ claimId, detail, versions, texts }: { claimId: string; detail: ClaimDetail; versions: NodeVersion[]; texts?: Map<string, string> }) {
  const labels = versions.map((v) => v.label);
  return (
    <section className="versions-several" aria-label="The assessments that stand for you">
      <p style={{ ...quiet, margin: "0 0 .9rem" }}>
        You read at {listOf(labels)}, and {labels.length === 2 ? "neither of those labels reads the other" : "none of those labels reads another"}. So each of
        these assessments was made without sight of the evidence behind the {labels.length === 2 ? "other" : "others"}, and neither replaces the other.
        Nothing here combines them or puts one first for being newer: they are in the order of the labels&rsquo; names.
      </p>
      <VersionsInFull claimId={claimId} detail={detail} versions={versions} texts={texts} />
      <p style={{ ...quiet, margin: "1rem 0 0" }}>
        What follows is everything else on this node that you may read, at every label you read. Each argument is shown there with one
        evaluation; where an argument has been evaluated at more than one of your labels, the others are not shown on this page.
      </p>
    </section>
  );
}

/** A line for whoever may ask for the page to be shown, on the tab of an assessment that some members cannot read. */
export function AskToShow({ claimId, version }: { claimId: string; version: NodeVersion }) {
  if (version.label === "public") return null;
  return (
    <p style={quiet}>
      People who do not read at {version.label} cannot read this assessment.{" "}
      <Link href={`/showings/new?node=${claimId}&at=${encodeURIComponent(version.label)}`}>Ask for this page to be shown to them</Link>, with what
      a redaction policy covers removed and marked.
    </p>
  );
}

/** Under the title on the tab of a page shown from a label the reader does not read. */
export function ShownIntro({ view }: { view: PublishedPageView }) {
  const inside = view.inside!;
  const shape = view.page;
  return (
    <div className="published-intro">
      <p className="sc" style={{ color: "var(--muted)", margin: "0 0 .3rem" }}>{shownTabName(inside.tab)}</p>
      <p style={{ ...quiet, margin: 0 }}>
        {inside.tab.outside ? (
          <>
            This is the page as people outside this deployment are shown it. It is this node&rsquo;s Steward&rsquo;s page as written at one of this
            deployment&rsquo;s labels, after redaction under the policy for showing pages outside: each passage removed is marked where it stood, and
            each part held back is named in its place. On the public graph it is a source that the node&rsquo;s Steward there weighs.
          </>
        ) : inside.tab.from_label ? (
          <>
            This is the page written at {inside.tab.from_label} as {inside.tab.shown_to} are shown it: this node&rsquo;s Steward&rsquo;s page as
            written, after redaction under the policy for that boundary. Each passage removed is marked where it stood, and each part held
            back is named in its place. You read at {inside.tab.from_label}, so the page without marks is on its own tab.
          </>
        ) : (
          <>
            This page was written by this node&rsquo;s Steward working at a label you do not read, on evidence filed there. It is that
            Steward&rsquo;s page as written, shown to {inside.tab.shown_to} after redaction under the policy for that boundary: each passage removed is
            marked where it stood, and each part held back is named in its place. The assessment made at your own label weighs it as a source
            and is not bound by it.
          </>
        )}
      </p>
      {shape?.wording && !shape.wording.held && (
        <div className="published-wording">
          <span className="sc">Assessed there in these words</span>
          <p>{shape.wording.text}</p>
        </div>
      )}
      {!shape && <p style={quiet}>No page has been released. {stateWords(view)}.</p>}
    </div>
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

/** How the page was shown, closed to one line at the foot like Full reasoning, opening to the record and the check. */
export function ShownRecord({ view }: { view: PublishedPageView }) {
  const { showing, page, tab } = view.inside!;
  const shape = view.page;
  const node = showing.nodes.find((n) => n.versions.some((v) => v.page_id === tab.page_id));
  const acts = showing.acts.filter((a) => !a.page_id || a.page_id === tab.page_id);
  return (
    <details className="reasoning-detail publication-record">
      <summary>
        How this page was shown: asked for on {day(showing.asked_at)}
        {showing.asked_by ? ` by ${showing.asked_by}` : ""};{" "}
        {shape ? (shape.held_parts === 0 ? `all ${shape.parts} parts released` : `${shape.held_parts} of ${shape.parts} parts held`) : "nothing released"}; the
        fingerprint {page.verification?.ok ? "matched" : "did not match"} when the page was read for you
      </summary>
      <dl className="record-rows">
        <Row label="Shown to">{showing.shown_to === "outside this deployment" ? "People outside this deployment." : `${showing.shown_to.charAt(0).toUpperCase()}${showing.shown_to.slice(1)}.`}</Row>
        <Row label="Asked for">
          On {day(showing.asked_at)}
          {showing.asked_by ? ` by ${showing.asked_by}` : ""}, who then held: {showing.asked_holding.join(", ") || "nothing recorded"}.{" "}
          {showing.form === "standing"
            ? "It is a standing showing: each later assessment follows, and one that is not released shows as held."
            : "The page was shown once, as it stood, and nothing is undertaken about later assessments."}{" "}
          It covers {showing.scope}.{node ? ` The showing began ${node.showing_began}.` : ""}
          {showing.ended_at ? ` It ended on ${day(showing.ended_at)}: ${showing.ended_because}. What was shown stays shown.` : ""}
        </Row>
        {showing.policy && (
          <Row label="Redaction policy">
            <Link href={`/redaction-policies/${showing.policy.policy_id}`}>Version {showing.policy.version}</Link> (
            <span className="mono">{showing.policy.hash.slice(0, 16)}</span>), which everyone this page is shown to can read in full.
          </Row>
        )}
        <Row label="Audit's check">{page.audit ?? "Not recorded."} It was made of the redaction, before anyone decided what to release.</Row>
        <Row label="Fingerprint">
          <span className="mono">{page.fingerprint?.slice(0, 16)}</span>, recorded when the redaction finished and before anyone decided what to
          release.
          {(page.earlier_fingerprints ?? []).length > 1 ? ` An earlier round of redaction was returned by the check; its fingerprint is kept too.` : ""}
        </Row>
        <Row label="Who acted">
          <ul>
            {acts.map((a, i) => (
              <li key={i}>
                {day(a.at)}: {a.by} {a.what}
                {a.on ? ` ${a.on}` : ""}
                {a.for_party ? ` for ${a.for_party}` : ""}
                {a.reason ? ` (${a.reason})` : ""}
                {a.holding.length > 0 ? `, holding ${a.holding.join(", ")}` : ""}.
              </li>
            ))}
          </ul>
          Where one person holds both direct and release, whoever directed the work also released it.
        </Row>
        {node && (
          <Row label="Assessments">
            <ul>
              {node.versions.map((v) => (
                <li key={v.page_id}>
                  The assessment of {day(v.version_of)}: {stateWords({ state: v.state, parts: v.of_parts, parts_held: v.parts_held, held_kinds: v.held_kinds, held: v.held_because ? { because: `${v.held_because}, for ${v.held_for}`, since: null } : undefined }).toLowerCase()}.
                </li>
              ))}
            </ul>
            Every assessment made while the showing stood is listed, the held ones as held.
          </Row>
        )}
        <Row label="Check">
          <CheckShownPage showingId={showing.showing_id} pageId={tab.page_id} arrivedOk={page.verification?.ok ?? false} />
        </Row>
      </dl>
      <p style={quiet}>
        The whole record, with each part&rsquo;s place and who released it, is on <Link href={`/showings/${showing.showing_id}`}>the showing&rsquo;s own page</Link>.
      </p>
    </details>
  );
}
