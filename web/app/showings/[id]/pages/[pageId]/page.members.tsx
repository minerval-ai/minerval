import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArgumentText } from "@/components/ArgumentText";
import { PageHead } from "@/components/PageHead";
import { viewer } from "@/components/admin/access";
import { CheckShownPage } from "@/components/claim/CheckShownPage";
import { Hash, WorkNav, day } from "@/components/inside/nav";
import { fetchShowing, fetchShownPage, type ShowingAct } from "@/lib/inside-api";
import { capital, kindWords, removalsInWords, stateOfVersion } from "@/lib/inside-words";

export const metadata: Metadata = { title: "A page as shown · Minerval" };
export const dynamic = "force-dynamic";

// One version of a node's page as the people it is shown to are given it
// (GET /showings/:id/pages/:page_id), part by part in the page's own order:
// what is always shown, each released part as written with its removals
// marked where they were made, each held part named in its place, who
// released or held each, the fingerprint, and the check against it. The
// node's own page draws the same page in the ordinary page's shape
// (components/claim/InsideVersions.tsx); this is the record's view of it.

const SUPPLIED: Record<string, string> = {
  the_organization_itself: "supplied by the organisation itself",
  an_outside_party: "supplied by an outside party",
  not_recorded: "its supplier is not on record",
};

function verdictWords(v: Record<string, unknown>): string {
  if ("status" in v) {
    return `${capital(String(v.status))}, with confidence ${String(v.confidence)}${v.credence !== null && v.credence !== undefined ? ` and credence ${String(v.credence)}` : "; no credence was given"}.`;
  }
  if ("estimate" in v) return `Estimate: ${JSON.stringify(v.estimate)}.`;
  return `Standing: ${String(v.standing).replace(/_/g, " ")}.`;
}

function coverageWords(c: { examined?: boolean; on?: string[] } | undefined): string {
  const on = c?.on ?? [];
  const can = on.includes("evidence_this_reader_can_read");
  const cannot = on.includes("evidence_this_reader_cannot_read");
  const base = can && cannot
    ? "Made partly on evidence the people it is shown to can read and partly on evidence they cannot."
    : cannot
      ? "Made on evidence the people it is shown to cannot read."
      : can
        ? "Made on evidence the people it is shown to can read."
        : "What it was made on is not recorded.";
  return on.includes("evidence_not_shown") ? `${base} At least one of its sources reports a result from data it has not published.` : base;
}

export default async function ShownPagePage({ params }: { params: Promise<{ id: string; pageId: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { id, pageId } = await params;
  const [showing, page] = await Promise.all([
    fetchShowing(who.externalId, id).catch(() => null),
    fetchShownPage(who.externalId, id, pageId).catch(() => null),
  ]);
  if (!showing || !page) notFound();
  const node = showing.nodes.find((n) => n.versions.some((v) => v.page_id === pageId));
  const header = (page.always_shown ?? {}) as {
    verdict?: Record<string, unknown>;
    coverage?: { examined?: boolean; on?: string[] };
    sources?: Array<{ source: number; kind: string; fingerprint: string | null; supplied_by: string; interest_recorded: boolean }>;
    gaps?: { requests?: Array<{ state: string; addressed_to_someone: boolean; filed: string }>; names_what_remains_open?: boolean };
    made?: Record<string, unknown>;
    removals?: Record<string, number>;
  };
  const actsOn = (on: string): ShowingAct[] => showing.acts.filter((a) => a.page_id === pageId && a.on === on);
  const said = (acts: ShowingAct[]) =>
    acts.map((a, i) => (
      <span className="acct-detail" key={i}>
        {day(a.at)}: {a.by} {a.what}
        {a.for_party ? ` for ${a.for_party}` : ""}
        {a.reason ? ` (${a.reason})` : ""}
        {a.rule_id ? ", under a standing rule" : ""}.
      </span>
    ));
  const categories = Object.keys(header.removals ?? {});
  const made = header.made ?? {};

  return (
    <div className="admin-page">
      <PageHead
        back={{ href: `/showings/${id}`, label: "the showing" }}
        kicker="A page as shown"
        title={node?.text ?? "A node you do not read"}
        lede={
          <>
            The assessment of {day(page.version_of)}, as {showing.shown_to === "outside this deployment" ? "people outside this deployment" : showing.shown_to} are given it.{" "}
            {stateOfVersion(page)}; {removalsInWords(page.removals_under_the_policy ?? header.removals)}.
          </>
        }
      />
      <WorkNav who={who} current="" />

      {!page.parts ? (
        <p className="account-empty admin-first">
          This page has not been shown, so none of it is here. {stateOfVersion(page)}. The parts of a page, and who must release each, are
          listed to the people who hold release in the release queue until the page is shown.
        </p>
      ) : (
        <>
          <section className="acct-section admin-first" id="always">
            <div className="acct-head">
              <h2>Shown whenever the page is shown</h2>
            </div>
            <p className="acct-prose acct-measure">
              These go with the page whatever is removed or held. Holding them holds the page.
            </p>
            <div className="acct-scroll">
              <table className="account-table acct-table admin-facts">
                <tbody>
                  <tr>
                    <td>verdict</td>
                    <td>{verdictWords(header.verdict ?? {})}</td>
                  </tr>
                  <tr>
                    <td>what it was made on</td>
                    <td>{coverageWords(header.coverage)}</td>
                  </tr>
                  <tr>
                    <td>sources</td>
                    <td>
                      {(header.sources ?? []).length === 0
                        ? "None recorded at the label the page was written at."
                        : (header.sources ?? []).map((s) => (
                            <span key={s.source} className="inside-line">
                              Source {s.source}: {s.kind === "unknown" ? "a document of a kind not recorded" : s.kind.replace(/_/g, " ")}, {SUPPLIED[s.supplied_by] ?? SUPPLIED.not_recorded};{" "}
                              {s.interest_recorded ? "an interest in this node is recorded for it" : "no interest in this node is recorded for it"}
                              {s.fingerprint ? <>; fingerprint <Hash value={s.fingerprint} /></> : null}.
                            </span>
                          ))}
                    </td>
                  </tr>
                  <tr>
                    <td>gaps the page records</td>
                    <td>
                      {(header.gaps?.requests ?? []).length === 0 ? "No request is recorded on the node at this label." : `${header.gaps!.requests!.length} request${header.gaps!.requests!.length === 1 ? "" : "s"} recorded on the node (${header.gaps!.requests!.map((r) => r.state.replace(/_/g, " ")).join(", ")}).`}{" "}
                      {header.gaps?.names_what_remains_open ? "The assessment says what remains open." : ""}
                    </td>
                  </tr>
                  <tr>
                    <td>how it was made</td>
                    <td>
                      {Object.entries(made)
                        .filter(([, v]) => v !== null && typeof v !== "object")
                        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v).length > 40 ? `${String(v).slice(0, 16)}…` : String(v)}`)
                        .join(" · ") || "Not recorded."}
                    </td>
                  </tr>
                  <tr>
                    <td>removals</td>
                    <td>{capital(removalsInWords(header.removals))}.</td>
                  </tr>
                  <tr>
                    <td>released by</td>
                    <td>{said(actsOn("the page"))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="acct-section" id="parts">
            <div className="acct-head">
              <h2>The page, part by part</h2>
            </div>
            <p className="acct-prose acct-measure">
              The page is divided by its own structure: a paragraph, an argument with its evaluation, a source&rsquo;s reading, a subclaim.
              A part is released or held whole, by each party whose material it rests on. A released part is its author&rsquo;s text word for
              word, with <span className="redaction">[redacted: category]</span> where the Redactor removed a passage under the policy. A
              held part shows what kind of part it is and who holds it, and none of its text.
            </p>
            <ol className="inside-parts">
              {page.parts.map((p) => {
                const acts = actsOn(`part ${p.part}`);
                return (
                  <li key={p.part} className={typeof p.text === "string" ? "inside-part" : "inside-part inside-part-held"}>
                    <div className="inside-part-head">
                      <span className="sc">Part {p.part}</span> {capital(kindWords(p.descriptor))}
                      <span className="acct-detail">
                        {typeof p.text === "string" ? "released" : "held"} · hash <Hash value={p.hash} />
                      </span>
                    </div>
                    {typeof p.text === "string" ? (
                      <div className="inside-part-text">
                        {p.text.split(/\n{2,}/).map((para, i) => (
                          <p key={i}>
                            <ArgumentText content={para} categories={categories} />
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="inside-part-held-words">
                        <span className="held-mark" aria-hidden /> {(p.held ?? "").replace(/^\[|\]$/g, "")}.
                      </p>
                    )}
                    {acts.length > 0 ? said(acts) : <span className="acct-detail">Nobody has acted on this part.</span>}
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="acct-section" id="check">
            <div className="acct-head">
              <h2>Fingerprint and check</h2>
            </div>
            <p className="acct-prose acct-measure">
              When the redaction finished, each part as the Redactor left it was hashed, and one fingerprint over all of them was recorded
              where the people the page is shown to can read it, before anyone decided what to release:{" "}
              <code className="inside-hash-whole">{page.fingerprint}</code>. A released part can be checked against it word for word, and a
              held part by its place and kind.{" "}
              {(page.earlier_fingerprints ?? []).length > 1 && "An earlier round of redaction was returned by Audit's check; its fingerprint is kept as well. "}
              Audit&rsquo;s check of the redaction: {page.audit ?? "not recorded"}
            </p>
            <CheckShownPage showingId={id} pageId={pageId} arrivedOk={page.verification?.ok ?? false} />
          </section>
        </>
      )}
      {node?.text && (
        <p className="acct-prose acct-measure">
          The same page in the shape of the node&rsquo;s own page is a tab on <Link href={`/claims/${node.node_id}?shown=${pageId}`}>the node</Link>.
        </p>
      )}
    </div>
  );
}
