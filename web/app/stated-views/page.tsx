import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchContributorProfile, fetchStatedViews } from "../../lib/api";
import type { StatedView, StatedViewRelation } from "../../lib/types";
import {
  DIRECTION_WORDS,
  RELATION_HEADING,
  RELATION_NOTE,
  challengeLine,
  judgmentWords,
  standsLine,
} from "../../lib/stated-views";
import { PageHead } from "@/components/PageHead";

// Where stated views and the graph's assessments differ (constitution §4).
// A person or an organisation may tell the graph what it holds about a
// claim, and the statement is shown beside the assessment in its own words.
// This page lists those statements, for one speaker or for all, each set
// beside the assessment in force: where they differ and which way, where the
// page has never been assessed (which is not agreement), where the two
// cannot be compared, and where they agree. The speaker gets no status on
// the graph's scale: the counts are counts of rows, not a verdict on anyone.

export const revalidate = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Differences first, then what was never examined, so that neither is
// mistaken for agreement; agreement sits folded at the foot.
const ORDER: StatedViewRelation[] = ["differs", "not_assessed", "not_comparable", "agrees"];

export const metadata: Metadata = {
  title: "Stated views · Minerval",
  description:
    "What people and organisations have told the graph they hold, each beside the graph's assessment: where they differ, and which way.",
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function Row({ v, showSpeaker }: { v: StatedView; showSpeaker: boolean }) {
  return (
    <li>
      <p className="stated-node">
        <span className="tag kind">{v.node.kind}</span>{" "}
        <Link href={`/claims/${v.node.id}#stated-views`}>{v.node.text}</Link>
      </p>
      <div className="stated-pair">
        <div>
          <span className="sc">
            {showSpeaker ? (
              <>
                <Link href={`/stated-views?speaker=${v.speaker.id}`}>{v.speaker.name}</Link>
                {v.speaker.verified ? "" : " (account not verified)"} ·{" "}
              </>
            ) : (
              "Stated view · "
            )}
            {fmtDate(v.stated_at)}
          </span>
          <div>{standsLine(v)}</div>
          <blockquote>{v.statement}</blockquote>
        </div>
        <div>
          <span className="sc">
            The graph&rsquo;s assessment
            {v.judgment ? ` · ${fmtDate(v.judgment.assessed_at)}` : ""}
          </span>
          <div>{judgmentWords(v)}</div>
        </div>
      </div>
      <p className="stated-summary">
        {v.comparison.summary}
        {v.stated === "before_current_assessment" && " Stated before the current assessment."}
        {v.stated === "after_current_assessment" && " Stated after the current assessment was made."}{" "}
        {v.gave_reasons && (
          <>
            {challengeLine(v.challenge, true, fmtDate)}{" "}
            <Link href={`/contributions/${v.contribution_id}`}>
              {v.challenge?.state === "answered" ? "Read the exchange" : "Read the reasons"}
            </Link>
          </>
        )}
      </p>
    </li>
  );
}

export default async function StatedViewsPage({
  searchParams,
}: {
  searchParams: Promise<{ speaker?: string | string[] }>;
}) {
  const raw = (await searchParams).speaker;
  const speakerId = typeof raw === "string" && UUID_RE.test(raw) ? raw : undefined;

  if (!apiConfigured()) {
    return (
      <div className="col">
        <PageHead title="Stated views" />
        <p>
          The frontend is not connected to a Minerval API (set <code>MINERVAL_API_URL</code>), so
          stated views are unavailable.
        </p>
      </div>
    );
  }

  const [list, profile] = await Promise.all([
    fetchStatedViews({ speakerId, limit: 100 }),
    speakerId ? fetchContributorProfile(speakerId) : Promise.resolve(null),
  ]);
  const views = list?.stated_views ?? [];
  const summary = list?.summary;
  const speakerName = profile?.contributor.display_name ?? views[0]?.speaker.name ?? null;
  const groups = new Map<StatedViewRelation, StatedView[]>(ORDER.map((r) => [r, []]));
  for (const v of views) groups.get(v.comparison.relation)?.push(v);
  const directions = Object.entries(summary?.by_direction ?? {});

  return (
    <div className="col-wide">
      <PageHead
        back={speakerId ? { href: "/stated-views", label: "all stated views" } : undefined}
        kicker="Stated views"
        title={
          speakerId
            ? `Where ${speakerName ?? "this account"}’s stated views and the assessments differ`
            : "Where stated views and the assessments differ"
        }
      />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".88rem", color: "var(--ink-soft)", maxWidth: "40rem" }}>
        A person or an organisation may tell the graph what it holds about a claim, a quantity or a
        question. Nobody edits an assessment: the statement is recorded as a source, in the
        speaker&rsquo;s own words and with its stake, and shown beside the assessment. This page sets{" "}
        {speakerId ? "this account’s statements" : "every such statement"} beside the assessment in
        force and says where the two differ and which way. The statements are the speakers&rsquo;;
        the assessments are the graph&rsquo;s. Neither is corrected to match the other.
      </p>
      {speakerId && (
        <p style={{ fontFamily: "var(--sans)", fontSize: ".8rem", color: "var(--muted)" }}>
          <Link href={`/contributors/${speakerId}`}>{speakerName ?? "The account"}</Link>
          {views[0] && !views[0].speaker.verified
            ? " is the account’s own name. Nobody has checked who is behind it."
            : ""}
        </p>
      )}

      {!list ? (
        <p style={{ color: "var(--muted)", fontStyle: "italic" }}>Stated views could not be loaded.</p>
      ) : summary && summary.total === 0 ? (
        <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
          {speakerId
            ? "This account has not stated a view that has been admitted."
            : "No stated view has been admitted yet. A view is stated from the page of the claim, quantity or question it is about."}
        </p>
      ) : (
        summary && (
          <>
            {/* The pattern, stated once: counts from the list below, and
                not a verdict on any claim or on the speaker. */}
            <p className="stated-counts" style={{ fontFamily: "var(--sans)", fontSize: ".9rem", maxWidth: "40rem" }}>
              Of {plural(summary.total, "current stated view", "current stated views")},{" "}
              {summary.by_relation.differs} {summary.by_relation.differs === 1 ? "differs" : "differ"} from
              the assessment, {summary.by_relation.agrees} {summary.by_relation.agrees === 1 ? "is" : "are"} in
              line with it, {summary.by_relation.not_assessed}{" "}
              {summary.by_relation.not_assessed === 1 ? "is" : "are"} on a page nobody has assessed, and{" "}
              {summary.by_relation.not_comparable} cannot be compared.
            </p>
            {directions.length > 0 && (
              <ul style={{ fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--ink-soft)", marginTop: "-.3rem" }}>
                {directions.map(([d, n]) => (
                  <li key={d}>
                    {n} {DIRECTION_WORDS[d] ?? d.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
            )}
            <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--muted)", maxWidth: "40rem" }}>
              These are counts of rows. The comparison reads only what each side recorded: a stance
              beside a status, a probability beside a credence (differing when 0.20 or more apart), a
              figure beside an estimate&rsquo;s range. It does not read a statement&rsquo;s words or
              weigh its reasons, and it does not say which side is right.
              {list.total > views.length ? ` Showing the newest ${views.length} of ${list.total}.` : ""}
            </p>

            {ORDER.map((relation) => {
              const rows = groups.get(relation) ?? [];
              if (rows.length === 0) return null;
              const body = (
                <>
                  <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
                    {RELATION_NOTE[relation]}
                  </p>
                  <ul className="stated-rows">
                    {rows.map((v) => (
                      <Row key={v.id} v={v} showSpeaker={!speakerId} />
                    ))}
                  </ul>
                </>
              );
              // Agreement is folded away: it is the least a reader comes here for.
              return relation === "agrees" ? (
                <details className="reasoning-detail" key={relation} style={{ marginTop: "1.2rem" }}>
                  <summary>
                    {RELATION_HEADING[relation]} ({rows.length})
                  </summary>
                  {body}
                </details>
              ) : (
                <section key={relation}>
                  <h2>
                    {RELATION_HEADING[relation]} ({rows.length})
                  </h2>
                  {body}
                </section>
              );
            })}
          </>
        )
      )}
    </div>
  );
}
