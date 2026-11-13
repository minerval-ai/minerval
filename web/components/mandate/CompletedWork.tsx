import Link from "next/link";
import {
  fetchMandateWork,
  type MandateAssessedNode,
  type MandateDetailView,
  type MandatePipelineRow,
  type MandateProposalRow,
  type MandateRequestWork,
  type MandateResearchRun,
} from "@/lib/account-api";
import { dateish, owls, words } from "@/lib/account-format";
import {
  WORK_FIRST,
  WORK_PAGE,
  mandateHref,
  workKindTabs,
  type MandatePageView,
  type NodeFilter,
} from "@/lib/mandate-page";
import { StatusBadge, StandingBadge } from "../Assessment";

// Everything a mandate has paid for that is finished, one kind at a time,
// each counted whole. The list opens short ("Show more" opens it to pages of
// a hundred), because a mandate that has run for months has hundreds of
// results and the page is for finding one's way, not for reading them all.

function Histogram({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  const labels = ["0–.25", ".25–.5", ".5–.75", ".75–1"];
  return (
    <span
      className="pipeline-hist"
      role="img"
      aria-label={buckets.map((n, i) => `importance ${labels[i]}: ${n}`).join(", ")}
    >
      {buckets.map((n, i) => (
        <span
          key={i}
          className="pipeline-hist-bar"
          style={{ height: `${4 + Math.round((n / max) * 14)}px` }}
          data-empty={n === 0 ? "" : undefined}
        />
      ))}
    </span>
  );
}

function Verdict({ row }: { row: MandateAssessedNode }) {
  if (row.node_kind === "question") return <StandingBadge standing={row.verdict} />;
  if (row.node_kind === "quantity") return <span className="tag">estimated</span>;
  return <StatusBadge status={row.verdict} />;
}

/** The foot of a list: how much is shown, the way to more, and the pages. */
function Foot({
  id,
  view,
  shown,
  total,
  noun,
}: {
  id: string;
  view: MandatePageView;
  shown: number;
  total: number;
  noun: string;
}) {
  if (total === 0) return null;
  const pages = Math.ceil(total / WORK_PAGE);
  const from = view.full ? (view.page - 1) * WORK_PAGE + 1 : 1;
  return (
    <div className="acct-pager mnd-foot">
      <span className="acct-num">
        {from === 1 && shown >= total
          ? `All ${total.toLocaleString("en-US")} ${noun}`
          : `${from.toLocaleString("en-US")}–${(from + shown - 1).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun}`}
      </span>
      {!view.full && total > shown && (
        <Link className="mnd-button" href={mandateHref(id, view, { full: true }, "completed")} scroll={false}>
          Show more
        </Link>
      )}
      {view.full && pages > 1 && (
        <nav className="mnd-pages" aria-label={`Pages of ${noun}`}>
          {view.page > 1 && (
            <Link href={mandateHref(id, view, { page: view.page - 1, full: true }, "completed")}>← Previous</Link>
          )}
          <span>
            Page {view.page} of {pages}
          </span>
          {view.page < pages && (
            <Link href={mandateHref(id, view, { page: view.page + 1, full: true }, "completed")}>
              Next {Math.min(WORK_PAGE, total - view.page * WORK_PAGE)} →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

const NODE_FILTERS: Array<[NodeFilter | null, string, keyof NonNullable<MandateDetailView["work_counts"]>["assessments"]]> = [
  [null, "All", "nodes"],
  ["claim", "Claims", "claims"],
  ["question", "Questions", "questions"],
  ["quantity", "Quantities", "quantities"],
];

export async function CompletedWork({
  mandate,
  view,
  viewer,
}: {
  mandate: MandateDetailView;
  view: MandatePageView;
  viewer: string | null;
}) {
  const id = mandate.id;
  const tabs = workKindTabs(mandate.work_counts, mandate.regrants_out.length);
  const kind = tabs.some((t) => t.key === view.work) ? view.work : "assessments";
  const limit = view.full ? WORK_PAGE : WORK_FIRST;
  const offset = view.full ? (view.page - 1) * WORK_PAGE : 0;
  const counts = mandate.work_counts?.assessments;
  const findings = mandate.findings ?? [];

  const page =
    kind === "regrants"
      ? null
      : await fetchMandateWork(
          id,
          { kind, node: view.node ?? undefined, order: view.order, offset, limit },
          viewer
        );

  return (
    <section className="acct-section" id="completed">
      <div className="acct-head">
        <h2>Completed work</h2>
      </div>

      <nav className="mnd-kinds" aria-label="Which kind of work">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={mandateHref(id, view, { work: t.key }, "completed")}
            aria-current={t.key === kind ? "true" : undefined}
            scroll={false}
          >
            {t.label} <span className="acct-num">{t.count.toLocaleString("en-US")}</span>
          </Link>
        ))}
      </nav>

      <div className="acct-cols">
        <div className="acct-main">
          {kind === "assessments" && (
            <>
              <div className="mnd-controls">
                <nav className="mnd-quiet" aria-label="Which kind of node">
                  {NODE_FILTERS.filter(([key, , field]) => key === null || (counts?.[field] ?? 0) > 0).map(
                    ([key, label, field]) => (
                      <Link
                        key={label}
                        href={mandateHref(id, view, { node: key }, "completed")}
                        aria-current={view.node === key ? "true" : undefined}
                        scroll={false}
                      >
                        {label} <span className="acct-num">{(counts?.[field] ?? 0).toLocaleString("en-US")}</span>
                      </Link>
                    )
                  )}
                </nav>
                <nav className="mnd-quiet" aria-label="Order">
                  <Link
                    href={mandateHref(id, view, { order: "recent" }, "completed")}
                    aria-current={view.order === "recent" ? "true" : undefined}
                    scroll={false}
                  >
                    Newest
                  </Link>
                  <Link
                    href={mandateHref(id, view, { order: "importance" }, "completed")}
                    aria-current={view.order === "importance" ? "true" : undefined}
                    scroll={false}
                  >
                    Most important
                  </Link>
                </nav>
              </div>
              {!page ? (
                <p className="acct-note">The assessments could not be read just now.</p>
              ) : page.total === 0 ? (
                <p className="acct-note">
                  {mandate.status === "active"
                    ? "No pass this mandate paid for has finished yet."
                    : "This mandate paid for no assessments."}
                </p>
              ) : (
                (page.items as MandateAssessedNode[]).map((a) => (
                  <div className="acct-line mnd-work" key={a.claim_id}>
                    <div>
                      {a.node_kind !== "claim" && <span className="tag">{a.node_kind}</span>}{" "}
                      <Link href={`/claims/${a.claim_id}`}>{a.text}</Link>
                      {a.passes > 1 && <span className="acct-detail">{a.passes} passes</span>}
                    </div>
                    <div className="mnd-verdict">
                      <Verdict row={a} />
                      <span className="acct-detail acct-num">{dateish(a.assessed_at)}</span>
                    </div>
                  </div>
                ))
              )}
              {page && <Foot id={id} view={view} shown={page.items.length} total={page.total} noun="nodes assessed" />}
            </>
          )}

          {kind === "sources" && (
            <>
              <p className="acct-note mnd-lede">
                Sources read into the graph, with what became of their claims: how many were linked to claims
                already held or minted new, how many have been assessed, and how their importance runs, peripheral
                to central.
              </p>
              {page && page.items.length > 0 && (
                <div className="mnd-scroll">
                  <table className="account-table pipeline-table">
                    <thead>
                      <tr>
                        <th>source</th>
                        <th>read</th>
                        <th>claims</th>
                        <th>assessed</th>
                        <th>importance</th>
                        <th title="claims with contestation at or above 0.5">disputed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(page.items as MandatePipelineRow[]).map((s) => (
                        <tr key={s.source_id}>
                          <td className="pipeline-source">
                            <Link href={`/sources/${s.source_id}`}>{s.title ?? s.url}</Link>
                            {s.extraction_status && s.extraction_status !== "extracted" && (
                              <span className="acct-detail">{words(s.extraction_status)}</span>
                            )}
                          </td>
                          <td className="acct-num">{dateish(s.ingested_at, "·")}</td>
                          <td className="acct-num">{s.claims_linked}</td>
                          <td className="acct-num">{s.claims_assessed}</td>
                          <td>
                            <Histogram buckets={s.importance_histogram} />
                            {s.avg_importance != null && <span className="acct-detail">{s.avg_importance}</span>}
                          </td>
                          <td className="acct-num">{s.contested_claims > 0 ? s.contested_claims : "·"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {page && <Foot id={id} view={view} shown={page.items.length} total={page.total} noun="sources" />}
            </>
          )}

          {kind === "requests" && (
            <>
              <p className="acct-note mnd-lede">
                Requests people made of the graph that this mandate paid for work on.
              </p>
              {page &&
                (page.items as MandateRequestWork[]).map((r) => (
                  <div className="acct-line mnd-work" key={r.request_id}>
                    <div>
                      <Link href={`/requests/${r.request_id}`}>{r.ask}</Link>
                      <span className="acct-detail">
                        {words(r.state)}
                        {r.runs > 1 ? ` · ${r.runs} runs` : ""}
                      </span>
                      {r.summary && <div className="acct-line-under acct-note">{r.summary}</div>}
                    </div>
                    <div className="acct-detail acct-num">{dateish(r.at)}</div>
                  </div>
                ))}
              {page && <Foot id={id} view={view} shown={page.items.length} total={page.total} noun="requests" />}
            </>
          )}

          {kind === "research" && (
            <>
              <p className="acct-note mnd-lede">
                Research its agents commissioned: a Researcher sent to find something out, with a ceiling on what
                it may spend.
              </p>
              {page &&
                (page.items as MandateResearchRun[]).map((r) => (
                  <div className="acct-line mnd-work" key={r.id}>
                    <div>
                      {r.run_id ? <Link href={`/runs/${r.run_id}`}>{r.task}</Link> : r.task}
                      <span className="acct-detail">
                        {words(r.status)}
                        {r.spent_owls != null ? ` · ${owls(r.spent_owls)} owls` : ""}
                      </span>
                      {r.claim_id && (
                        <span className="acct-detail">
                          <Link href={`/claims/${r.claim_id}`}>the node it was for</Link>
                        </span>
                      )}
                    </div>
                    <div className="acct-detail acct-num">{dateish(r.finished_at ?? r.started_at)}</div>
                  </div>
                ))}
              {page && <Foot id={id} view={view} shown={page.items.length} total={page.total} noun="research runs" />}
            </>
          )}

          {kind === "proposals" && (
            <>
              <p className="acct-note mnd-lede">
                Claims, questions and quantities this mandate put to the graph. Each went through the
                Contribution Reviewer, like anyone&rsquo;s.
              </p>
              {page &&
                (page.items as MandateProposalRow[]).map((p) => (
                  <div className="acct-line mnd-work" key={p.contribution_id}>
                    <div>
                      <span className="tag">{words(p.type.replace(/^propose_/, ""))}</span>{" "}
                      {p.claim_id ? <Link href={`/claims/${p.claim_id}`}>{p.text}</Link> : p.text}
                      <span className="acct-detail">
                        <Link href={`/contributions/${p.contribution_id}`}>{words(p.review_status)}</Link>
                      </span>
                    </div>
                    <div className="acct-detail acct-num">{dateish(p.submitted_at)}</div>
                  </div>
                ))}
              {page && <Foot id={id} view={view} shown={page.items.length} total={page.total} noun="proposals" />}
            </>
          )}

          {kind === "regrants" && (
            <>
              <p className="acct-note mnd-lede">
                Mandates this one has put owls behind. Money moves between mandates; judgment never does.
              </p>
              {mandate.regrants_out.map((m) => (
                <div className="acct-line mnd-work" key={m.grant_id}>
                  <div>
                    <Link href={`/mandates/${m.grant_id}`}>{m.title}</Link>
                    {m.note && <div className="acct-line-under acct-note">{m.note}</div>}
                  </div>
                  <div className="acct-num">{owls(m.owls)} owls</div>
                </div>
              ))}
            </>
          )}
        </div>

        <aside className="acct-side acct-side-wide">
          <h3 className="mnd-h3">
            Findings{" "}
            {mandate.work_counts && <span className="acct-detail acct-num">{mandate.work_counts.findings}</span>}
          </h3>
          {findings.length === 0 ? (
            <p className="acct-note">Its agents have noted none.</p>
          ) : (
            findings.map((f) => (
              <div className="mnd-finding" key={f.id}>
                <Link href={`/findings/${f.id}`}>{f.headline}</Link>
                <div className="acct-detail">
                  importance {f.importance} of 10
                  {f.first_noted_at ? ` · ${dateish(f.first_noted_at)}` : ""}
                </div>
              </div>
            ))
          )}
          {(mandate.work_counts?.findings ?? 0) > findings.length && (
            <p className="acct-note">
              <Link href="/findings">All findings →</Link>
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
