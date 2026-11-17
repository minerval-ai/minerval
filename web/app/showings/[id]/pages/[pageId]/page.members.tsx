import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArgumentText } from "@/components/ArgumentText";
import { viewer } from "@/components/admin/access";
import { CheckShownPage } from "@/components/claim/CheckShownPage";
import { Icon } from "@/components/work/icons";
import { Boundary, ButtonLink, Card, Empty, Kv, Pill, Tip, WorkHead, WorkPage, plural, shortDay, shortWhen, type Tone } from "@/components/work/ui";
import { auditPill, coverageWords, figure, headerOf, labelOf, verdictPill } from "@/lib/gate-review";
import { fetchShowing, fetchShowings, fetchShownPage, type ShowingAct, type ShownPage } from "@/lib/inside-api";
import { capital, kindWords, stateOfVersion } from "@/lib/inside-words";
import "./shown-page.css";

export const metadata: Metadata = { title: "A page as shown · Minerval" };
export const dynamic = "force-dynamic";

// One version of a node's page as the people it is shown to are given it
// (GET /showings/:id/pages/:page_id), part by part in the page's own order:
// each released part as written with its removals marked where they were
// made, each held part named in its place with who holds it; beside it what
// is always shown, the fingerprint and the check against it, Audit's check,
// and who released or held what. The node's own page draws the same page in
// the ordinary page's shape (components/claim/InsideVersions.tsx); this is
// the record's view of it.

const SUPPLIER: Record<string, { text: string; tone: Tone; title: string }> = {
  the_organization_itself: { text: "org", tone: "neu", title: "Supplied by the organisation itself" },
  an_outside_party: { text: "outside", tone: "info", title: "Supplied by an outside party" },
  not_recorded: { text: "not recorded", tone: "neu", title: "Its supplier is not on record" },
};

function stateTone(page: ShownPage): Tone {
  return page.state === "released_whole" ? "ok" : page.state === "released_in_part" ? "warn" : page.state === "held" ? "bad" : "neu";
}

function actLine(a: ShowingAct): string {
  return `${capital(a.by)} ${a.what}${a.on ? ` ${a.on}` : ""}${a.for_party ? ` for ${a.for_party}` : ""}${a.reason ? `: ${a.reason}` : ""}${a.rule_id ? ", under a setting of the gate" : ""}`;
}

export default async function ShownPagePage({ params }: { params: Promise<{ id: string; pageId: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { id, pageId } = await params;
  const [showing, page, showings] = await Promise.all([
    fetchShowing(who.externalId, id).catch(() => null),
    fetchShownPage(who.externalId, id, pageId).catch(() => null),
    fetchShowings(who.externalId).catch(() => null),
  ]);
  if (!showing || !page) notFound();
  const node = showing.nodes.find((n) => n.versions.some((v) => v.page_id === pageId));
  const header = headerOf(page.always_shown);
  const acts = showing.acts.filter((a) => a.page_id === pageId);
  const actsOn = (on: string) => acts.filter((a) => a.on === on);
  const removals = page.removals_under_the_policy ?? header.removals ?? {};
  const categories = Object.keys(removals);
  const from = showings?.asked.find((s) => s.showing_id === id)?.page_label ?? null;
  const to = labelOf(showing.shown_to);
  const shownTo = to === "outside" ? "outside readers" : `${to} readers`;
  const nodeText = node?.text ?? null;
  const crumb = nodeText ? (nodeText.length > 48 ? `${nodeText.slice(0, 46)}…` : nodeText) : "The showing";

  const head = (
    <WorkHead
      statement={!!nodeText}
      title={nodeText ?? "A node you do not read"}
      crumbs={[
        { href: "/showings", label: "Showings" },
        { href: `/showings/${id}`, label: crumb },
      ]}
      sub={
        <>
          Version of {shortDay(page.version_of)}
          {page.shown_at ? ` · shown ${shortWhen(page.shown_at)}` : ""} · {showing.form === "standing" ? "standing showing" : "shown once"}
        </>
      }
      tags={
        <>
          <Boundary from={from} to={to} />
          <Pill tone={stateTone(page)}>{stateOfVersion(page)}</Pill>
        </>
      }
      actions={
        nodeText && node ? (
          <ButtonLink href={`/claims/${node.node_id}?shown=${pageId}`} icon="external">
            Open on the node
          </ButtonLink>
        ) : undefined
      }
    />
  );

  if (!page.parts) {
    return (
      <WorkPage>
        {head}
        <div className="w-card">
          <Empty>
            <p style={{ margin: "0 0 6px", color: "var(--w-ink)", fontWeight: 500 }}>This page has not been shown.</p>
            <p style={{ margin: 0 }}>
              {stateOfVersion(page)}. Until it is, its parts wait at the gate for the people who hold release.
            </p>
          </Empty>
        </div>
      </WorkPage>
    );
  }

  const released = page.parts.filter((p) => typeof p.text === "string").length;
  const held = page.parts.length - released;
  const verdict = verdictPill(header.verdict);
  const v = header.verdict ?? {};
  const coverage = coverageWords(header.coverage, shownTo);
  const made = header.made ?? {};
  const runLog = (made.run_log ?? null) as { sealed?: boolean; steps?: number | null; chain_verifies?: boolean | null } | null;
  const paid = (made.paid_for ?? null) as { by?: string } | null;
  const requests = header.gaps?.requests ?? [];
  const audit = auditPill(page.audit);
  const pageActs = actsOn("the page");

  return (
    <WorkPage>
      {head}
      <div className="w-grid2">
        <div className="w-col">
          <article className="w-shown-doc" aria-label="The page as shown">
            <div className="w-shown-doc-h">
              <b>Page</b>
              <span>
                {plural(page.parts.length, "part")} · {released} released · {held} held
              </span>
              <span className="w-spacer">
                Version of {shortDay(page.version_of)} · redaction round {page.redaction_round}
              </span>
            </div>
            {page.parts.map((p) => {
              const on = actsOn(`part ${p.part}`);
              const last = on[on.length - 1];
              return (
                <div key={p.part} className={p.descriptor === "wording" ? "w-shown-part w-wording" : "w-shown-part"}>
                  <div className="w-shown-part-g">
                    <b>Part {p.part}</b>
                    {capital(kindWords(p.descriptor).replace(/^(a|an|the) /, ""))}
                    <details className="w-shown-more">
                      <summary title="The hash of this part as the Redactor left it">#{p.hash.slice(0, 4)}…{p.hash.slice(-4)}</summary>
                      <div className="w-shown-more-b">
                        <code className="w-mono">{p.hash}</code>
                        {on.length === 0 ? (
                          <span>Nobody has acted on this part.</span>
                        ) : (
                          on.map((a, i) => (
                            <span key={i}>
                              {shortWhen(a.at)} · {actLine(a)}
                            </span>
                          ))
                        )}
                      </div>
                    </details>
                  </div>
                  {typeof p.text === "string" ? (
                    <div className="w-shown-part-t">
                      {p.text.split(/\n{2,}/).map((para, i) => (
                        <p key={i}>
                          <ArgumentText content={para} categories={categories} />
                        </p>
                      ))}
                    </div>
                  ) : (
                    <div className="w-shown-held">
                      <Icon name="lock" size={14} />
                      <span>{(p.held ?? "").replace(/^\[|\]$/g, "")}</span>
                      {last && (
                        <span className="w-spacer">
                          {last.reason ? `${last.reason} · ` : ""}
                          {shortDay(last.at)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </article>

          <Card title="Acts on this version">
            {acts.length === 0 ? (
              <span className="w-muted w-small">Nobody has acted on this version.</span>
            ) : (
              <div>
                {acts.map((a, i) => (
                  <div className="w-line w-shown-line" key={i}>
                    <time dateTime={a.at}>{shortWhen(a.at)}</time>
                    <span>{actLine(a)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <aside className="w-col w-shown-rail">
          <Card
            title={
              <>
                Always shown <Tip>Goes with the page whatever is removed or held. Holding it holds the page.</Tip>
              </>
            }
          >
            <Kv
              rows={[
                verdict && ["Verdict", <Pill key="v" tone={verdict.tone} title={verdict.title}>{verdict.text}</Pill>],
                "estimate" in v && ["Estimate", verdict?.title ?? "—"],
                figure(v.confidence) !== null && ["Confidence", <span key="c" className="w-shown-num">{figure(v.confidence)}</span>],
                "status" in v && ["Credence", <span key="cr" className="w-shown-num">{figure(v.credence) ?? <span className="w-faint">not given</span>}</span>],
                [
                  "Evidence",
                  <span key="e">
                    {coverage.short} <Tip>{coverage.long}</Tip>
                  </span>,
                ],
                [
                  "Sources",
                  (header.sources ?? []).length === 0 ? (
                    <span className="w-muted">None recorded</span>
                  ) : (
                    <div className="w-shown-src">
                      {(header.sources ?? []).map((s) => {
                        const sup = SUPPLIER[s.supplied_by] ?? SUPPLIER.not_recorded!;
                        return (
                          <div key={s.source} className="w-shown-src-r">
                            <span className="w-shown-src-n">{s.source}</span>
                            <span title={s.fingerprint ? `Fingerprint ${s.fingerprint}` : undefined}>
                              {s.kind === "unknown" ? <span className="w-muted">Kind not recorded</span> : capital(s.kind.replace(/_/g, " "))}
                              {s.interest_recorded && <span className="w-faint w-shown-sub">interest recorded</span>}
                            </span>
                            <Pill tone={sup.tone} title={sup.title}>
                              {sup.text}
                            </Pill>
                          </div>
                        );
                      })}
                    </div>
                  ),
                ],
                [
                  "Gaps",
                  <span key="g">
                    {requests.length === 0
                      ? "No request recorded"
                      : `${plural(requests.length, "request")} (${[...new Set(requests.map((r) => r.state.replace(/_/g, " ")))].join(", ")})`}
                    {header.gaps?.names_what_remains_open ? " · says what remains open" : ""}
                  </span>,
                ],
                [
                  "How made",
                  <span key="m">
                    {typeof made.assessed_by_model === "string" ? <span className="w-mono">{made.assessed_by_model}</span> : <span className="w-muted">Model not recorded</span>}
                    {(runLog || paid?.by) && (
                      <span className="w-shown-sub w-muted">
                        {runLog
                          ? `Run log ${runLog.sealed ? "sealed" : "not sealed"}${runLog.steps != null ? ` · ${plural(runLog.steps, "step")}` : ""}${runLog.chain_verifies === true ? " · chain checks out" : runLog.chain_verifies === false ? " · chain does not check out" : ""}`
                          : "No run log"}
                        {paid?.by ? ` · ${paid.by}` : ""}
                      </span>
                    )}
                  </span>,
                ],
                [
                  "Removals",
                  categories.length === 0 ? (
                    <span className="w-muted">None</span>
                  ) : (
                    <span key="r">
                      {Object.entries(removals).map(([c, n]) => (
                        <span key={c} className="w-shown-sub" style={{ marginTop: 0 }}>
                          {c} {n}
                        </span>
                      ))}
                    </span>
                  ),
                ],
                pageActs.length > 0 && [
                  "Released by",
                  <span key="rb">
                    {pageActs.map((a, i) => (
                      <span key={i} className="w-shown-sub" style={{ marginTop: 0 }}>
                        {capital(a.by)} · {shortWhen(a.at)}
                        {a.for_party ? ` · for ${a.for_party}` : ""}
                      </span>
                    ))}
                  </span>,
                ],
              ]}
            />
          </Card>

          <Card
            title={
              <>
                Fingerprint{" "}
                <Tip>
                  Recorded when the redaction finished, before anyone decided what to release. A released part can be checked against it word for word, and a held part by its place and kind.
                </Tip>
              </>
            }
          >
            <div className="w-col" style={{ gap: 10 }}>
              <code className="w-shown-fp">{page.fingerprint ?? "not recorded"}</code>
              {(page.earlier_fingerprints ?? []).length > 1 && (
                <span className="w-help">An earlier round of redaction was returned by Audit&apos;s check; its fingerprint is kept as well.</span>
              )}
              <CheckShownPage showingId={id} pageId={pageId} arrivedOk={page.verification?.ok ?? false} work />
            </div>
          </Card>

          <Card title="Audit's check">
            <div className="w-col" style={{ gap: 6 }}>
              <span>
                <Pill tone={audit.tone} title={audit.title}>
                  {capital(audit.text.replace(/^Audit: /, ""))}
                </Pill>
              </span>
              {page.audit && page.audit !== audit.title.split(/(?<=\.)\s/)[0] && <span className="w-small w-muted">{page.audit}</span>}
              <span className="w-small w-muted">Round {page.redaction_round}</span>
            </div>
          </Card>

          {nodeText && node && (
            <Link className="w-small" href={`/claims/${node.node_id}?shown=${pageId}`}>
              The same page on the node&apos;s own tab
            </Link>
          )}
        </aside>
      </div>
    </WorkPage>
  );
}
