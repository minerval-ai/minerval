import Link from "next/link";
import type { StatedView } from "@/lib/types";
import { challengeLine, kindWord, standsLine, stanceWords } from "@/lib/stated-views";
import { StateView } from "./StateView";

// Views stated to the graph directly (constitution §4): what a person or an
// organisation has told the graph it holds about this node, in its own
// words. Each is an instance from that speaker as a source, so it is drawn
// as an instance is: the words in quotation, who said them and when, and
// the interest recorded. It has a place of its own because it reached the
// page by being stated to the graph, where every other instance is there by
// the Steward's judgment, and the section says that the place gives it no
// weight. Nothing here is on the graph's own scale: no status, no badge, and
// a probability only where the speaker gave one.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function recordPath(v: StatedView): string {
  return `/contributions/${v.contribution_id}`;
}

function StatedViewCard({ v }: { v: StatedView }) {
  const node = kindWord(v.node.kind);
  return (
    <div className="instance stated-view">
      {/* Who and when: the speaker's own account name, and whether anyone
          has checked who is behind it. */}
      <div className="stated-view-head">
        <Link href={`/contributors/${v.speaker.id}`}>{v.speaker.name}</Link>
        {v.speaker.verified ? (
          <span className="tag" title="Minerval has checked who is behind this account.">
            verified account
          </span>
        ) : (
          <span
            className="tag"
            title="The name is the account's own. Nobody has checked who is behind it."
          >
            account not verified
          </span>
        )}
        <span className="sc">stated {fmtDate(v.stated_at)}</span>
        {!v.current && <span className="tag">earlier statement</span>}
      </div>
      {/* How the speaker stands, in the terms it chose. */}
      <p className="stated-view-stands">
        <span className="sc">Stands</span> {standsLine(v)}
      </p>
      <blockquote>{v.statement}</blockquote>
      <div className="stated-view-facts">
        {/* The stake is the speaker's own declaration: a fact about the
            statement, never a finding against it. */}
        <p title="A stake is a fact about a source, not a finding against it. What the source says is still evidence.">
          <span className="sc">Stake, as declared</span>{" "}
          {v.stake ?? `Declares no stake in how this ${node} is answered.`}
        </p>
        <p>
          <span className="sc">Reasons</span> {challengeLine(v.challenge, v.gave_reasons, fmtDate)}{" "}
          {v.gave_reasons && (
            <Link href={recordPath(v)}>
              {v.challenge?.state === "answered" ? "Read the exchange" : "Read the reasons"}
            </Link>
          )}
        </p>
        {/* The page's own arithmetic on what each recorded, and nothing more. */}
        <p>
          <span className="sc">Beside the assessment</span> {v.comparison.summary}
          {v.stated === "before_current_assessment" && " Stated before the current assessment."}
          {v.stated === "after_current_assessment" && " Stated after the current assessment was made."}
        </p>
        {v.stance_as_stated && (
          <p>
            Stated as: {stanceWords(v.stance_as_stated, v.node.kind)}. Recorded against the {node} as it is
            now worded as: {stanceWords(v.stance, v.node.kind)}.
          </p>
        )}
        {v.detached && (
          <p>
            The Steward reads this statement as being about a different proposition
            {v.detached.reason ? `: ${v.detached.reason}` : "."}
          </p>
        )}
        <p className="stated-view-links">
          {v.source_id && <Link href={`/sources/${v.source_id}`}>the statement as a source</Link>}
          {v.source_id && " · "}
          <Link href={recordPath(v)}>its review record</Link>
        </p>
      </div>
    </div>
  );
}

export function StatedViews({
  claimId,
  kind,
  views,
}: {
  claimId: string;
  kind: "claim" | "quantity" | "question";
  views: StatedView[];
}) {
  const current = views.filter((v) => v.current);
  const earlier = views.filter((v) => !v.current);
  const node = kindWord(kind);
  // Most pages have none. Then there is no section to read, only an
  // invitation, so it is drawn as one: a quiet line at the foot of the
  // reading column (the callers place it there), not a heading in the middle
  // of the page announcing that it is empty.
  if (views.length === 0) {
    return (
      <div id="stated-views" className="stated-views-empty">
        <p>
          <span className="sc">Stated views</span> None yet. A view stated to the graph is shown on
          this page in its speaker&rsquo;s words, as a source like any other, and carries no weight
          in the assessment.
        </p>
        <StateView claimId={claimId} kind={kind} />
      </div>
    );
  }
  return (
    <section id="stated-views" className="stated-views">
      <h2>Stated views</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "36rem" }}>
        {`What people and organisations have told the graph they hold about this ${node}, in their own words. `}
        A stated view is a source like any other. It is shown here because it was stated to the graph
        directly, and its place on the page gives it no weight in the assessment. Nobody edits an
        assessment: reasons a statement gives are put to the Steward and answered.
      </p>
      {current.map((v) => (
        <StatedViewCard key={v.id} v={v} />
      ))}
      {earlier.length > 0 && (
        <details className="reasoning-detail">
          <summary>
            {earlier.length === 1 ? "1 earlier statement" : `${earlier.length} earlier statements`}
          </summary>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem" }}>
            Statements a speaker has since restated. A statement is never edited: the newer one is
            shown as current and the earlier one stays, dated.
          </p>
          {earlier.map((v) => (
            <StatedViewCard key={v.id} v={v} />
          ))}
        </details>
      )}
      <StateView claimId={claimId} kind={kind} />
    </section>
  );
}
