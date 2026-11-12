import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchClaimCards, fetchFindingsPage } from "../../lib/api";
import { FindingListItem } from "../../components/findings/FindingParts";
import { PageHead } from "@/components/PageHead";
import { statusMeta } from "@/lib/ontology";
import {
  FINDINGS_PER_PAGE,
  agentsOfRole,
  findingsHref,
  hasFilters,
  orderInForce,
  parseFindingsView,
  rolesOf,
  type FindingsOrder,
} from "@/lib/findings";

export const metadata: Metadata = {
  title: "Findings · Minerval",
  description: "What the graph's administrators found in the course of their work.",
};

export const revalidate = 60;

const DAY_MS = 86_400_000;

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseFindingsView(await searchParams);
  const order = orderInForce(view);

  if (!apiConfigured()) {
    return (
      <div className="col">
        <PageHead title="Findings" />
        <p>
          The frontend is not connected to a Minerval API (set <code>MINERVAL_API_URL</code>), so
          the findings feed is unavailable.
        </p>
      </div>
    );
  }

  // "Noted in the past week" is a date for the API. It is cut to the day so
  // the request is the same all day and the short cache can serve it.
  const since = view.days
    ? new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - view.days * DAY_MS).toISOString()
    : undefined;
  const { findings, total, facets } = await fetchFindingsPage({
    q: view.q ?? undefined,
    tag: view.tag ?? undefined,
    minImportance: view.min ?? undefined,
    agents: view.by ? agentsOfRole(view.by) : undefined,
    claimStatus: view.stands ?? undefined,
    since,
    order,
    limit: FINDINGS_PER_PAGE,
    offset: (view.page - 1) * FINDINGS_PER_PAGE,
  });
  const cards = await fetchClaimCards(findings.map((f) => f.claim_id));

  const roles = facets ? rolesOf(facets.agents) : [];
  const role = view.by ? roles.find((r) => r.slug === view.by) : undefined;
  const tagName =
    view.tag &&
    (facets?.tags.find((t) => t.slug === view.tag)?.name ??
      findings.flatMap((f) => f.tags ?? []).find((t) => t.slug === view.tag)?.name ??
      view.tag);
  const atLeast = (n: number) =>
    facets ? facets.importance.filter((i) => i.importance >= n).reduce((t, i) => t + i.count, 0) : null;

  const orders: Array<[FindingsOrder, string]> = [
    ...(view.q ? ([["relevance", "Best match"]] as Array<[FindingsOrder, string]>) : []),
    ["recent", "Newest"],
    ["importance", "Most important"],
  ];

  const active: Array<{ label: string; href: string }> = [];
  if (view.q) active.push({ label: `“${view.q}”`, href: findingsHref(view, { q: null, order: null }) });
  if (view.tag) active.push({ label: `Topic: ${tagName}`, href: findingsHref(view, { tag: null }) });
  if (view.stands) {
    active.push({
      label: `Claim is ${statusMeta(view.stands).label.toLowerCase()}`,
      href: findingsHref(view, { stands: null }),
    });
  }
  if (view.min) {
    active.push({ label: `Importance ${view.min} and up`, href: findingsHref(view, { min: null }) });
  }
  if (view.by) {
    active.push({
      label: `Noted by ${role?.label ?? view.by.replace(/-/g, " ")}`,
      href: findingsHref(view, { by: null }),
    });
  }
  if (view.days) {
    active.push({
      label: view.days === 7 ? "Past week" : "Past month",
      href: findingsHref(view, { days: null }),
    });
  }

  const shownTo = (view.page - 1) * FINDINGS_PER_PAGE + findings.length;
  const more = total !== null ? shownTo < total : findings.length === FINDINGS_PER_PAGE;

  return (
    <div className="fnd">
      <PageHead
        title="Findings"
        lede={<>What the graph&apos;s administrators found in the course of their work.</>}
      />

      <div className="fnd-cols">
        {/* First in the source so it sits above the list on a phone, where it
            folds behind a switch; at the right on a wide screen. */}
        <aside className="fnd-filters" aria-label="Filter the findings">
          <input type="checkbox" id="fnd-filters-open" className="fnd-filters-switch" />
          <label htmlFor="fnd-filters-open" className="fnd-filters-label">
            Filters{active.length > 0 ? ` · ${active.length} on` : ""}
          </label>
          <div className="fnd-filters-body">
            <div className="fnd-filters-head">
              <span className="sc">Filter</span>
              {hasFilters(view) && <Link href="/findings">Clear all</Link>}
            </div>

            {facets && facets.tags.length > 0 && (
              <div className="fnd-facet" role="group" aria-label="Topic">
                <div className="sc">Topic</div>
                {facets.tags.map((t) => (
                  <FacetLink
                    key={t.slug}
                    label={t.name}
                    count={t.count}
                    on={view.tag === t.slug}
                    href={findingsHref(view, { tag: view.tag === t.slug ? null : t.slug })}
                  />
                ))}
                <p className="fnd-facet-more">
                  <Link href="/tags">All topics →</Link>
                </p>
              </div>
            )}

            {facets && facets.claim_statuses.length > 0 && (
              <div className="fnd-facet" role="group" aria-label="Where the claim stands">
                <div className="sc">Where the claim stands</div>
                {facets.claim_statuses.map((s) => (
                  <FacetLink
                    key={s.status}
                    label={statusMeta(s.status).label}
                    count={s.count}
                    on={view.stands === s.status}
                    href={findingsHref(view, { stands: view.stands === s.status ? null : s.status })}
                  />
                ))}
              </div>
            )}

            <div className="fnd-facet" role="group" aria-label="Importance, at least">
              <div className="sc">Importance, at least</div>
              <div className="fnd-scale">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <Link
                    key={n}
                    href={findingsHref(view, { min: view.min === n ? null : n })}
                    className={view.min && n >= view.min ? "on" : undefined}
                    aria-current={view.min === n ? "true" : undefined}
                    aria-label={`Findings of importance ${n} and up`}
                  >
                    {n}
                  </Link>
                ))}
              </div>
              <p className="fnd-facet-note">
                {view.min ? (
                  <>
                    {view.min} and up
                    {atLeast(view.min) !== null && (
                      <>
                        : {atLeast(view.min)} finding{atLeast(view.min) === 1 ? "" : "s"}
                      </>
                    )}
                    . <Link href={findingsHref(view, { min: null })}>Any importance</Link>
                  </>
                ) : (
                  <>Any importance. Pick a number to set the least shown.</>
                )}
              </p>
            </div>

            {roles.length > 0 && (
              <div className="fnd-facet" role="group" aria-label="Noted by">
                <div className="sc">Noted by</div>
                {roles.map((r) => (
                  <FacetLink
                    key={r.slug}
                    label={r.label}
                    count={r.count}
                    on={view.by === r.slug}
                    href={findingsHref(view, { by: view.by === r.slug ? null : r.slug })}
                  />
                ))}
              </div>
            )}

            <div className="fnd-facet" role="group" aria-label="Noted">
              <div className="sc">Noted</div>
              {([7, 30] as const).map((d) => (
                <FacetLink
                  key={d}
                  label={d === 7 ? "In the past week" : "In the past month"}
                  count={null}
                  on={view.days === d}
                  href={findingsHref(view, { days: view.days === d ? null : d })}
                />
              ))}
            </div>
          </div>
        </aside>

        <div className="fnd-list">
          <div className="fnd-bar">
            <form action="/findings" method="get" role="search" className="fnd-search">
              {/* A search keeps the filters in force, and starts closest first. */}
              {view.tag && <input type="hidden" name="tag" value={view.tag} />}
              {view.min && <input type="hidden" name="min" value={view.min} />}
              {view.by && <input type="hidden" name="by" value={view.by} />}
              {view.stands && <input type="hidden" name="stands" value={view.stands} />}
              {view.days && <input type="hidden" name="days" value={view.days} />}
              <label htmlFor="fnd-q" className="visually-hidden">
                Search the findings
              </label>
              <input
                id="fnd-q"
                type="search"
                name="q"
                defaultValue={view.q ?? ""}
                placeholder="Search findings by what they say"
                maxLength={300}
                autoComplete="off"
              />
              <button type="submit">Search</button>
            </form>
            <nav className="acct-switch" aria-label="Order">
              {orders.map(([value, label]) => (
                <Link
                  key={value}
                  href={findingsHref(view, { order: value })}
                  aria-current={order === value ? "true" : undefined}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="fnd-active">
            <span className="fnd-count" role="status">
              {total !== null
                ? `${total.toLocaleString("en-US")} finding${total === 1 ? "" : "s"}`
                : `${findings.length} finding${findings.length === 1 ? "" : "s"}`}
            </span>
            {active.map((a) => (
              <Link key={a.label} href={a.href} className="fnd-chip" aria-label={`Remove: ${a.label}`}>
                {a.label}
                <span aria-hidden="true">×</span>
              </Link>
            ))}
          </div>

          {findings.length === 0 ? (
            hasFilters(view) ? (
              <div className="fnd-empty">
                <p>No finding matches all of that.</p>
                <p className="account-empty">
                  Remove a filter above, or <Link href="/findings">clear them all</Link>. A run
                  that notes nothing is the norm, so a narrow filter is often empty.
                </p>
              </div>
            ) : (
              <p className="account-empty fnd-empty">
                Nothing has been noted yet. A run that notes nothing is the norm; findings appear
                here as the administrators record them.
              </p>
            )
          ) : (
            findings.map((f) => (
              <FindingListItem key={f.id} finding={f} card={cards.get(f.claim_id)} view={view} />
            ))
          )}

          {(view.page > 1 || more) && (
            <nav className="fnd-pages" aria-label="More findings">
              {view.page > 1 ? (
                <Link href={findingsHref(view, { page: view.page - 1 })}>← Previous page</Link>
              ) : (
                <span />
              )}
              <span className="acct-note">
                {(view.page - 1) * FINDINGS_PER_PAGE + 1} to {shownTo}
                {total !== null && ` of ${total.toLocaleString("en-US")}`}
              </span>
              {more ? <Link href={findingsHref(view, { page: view.page + 1 })}>Next page →</Link> : <span />}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

/** One choice of a filter: a link that turns it on, or off when it is on. */
function FacetLink({
  label,
  count,
  on,
  href,
}: {
  label: string;
  count: number | null;
  on: boolean;
  href: string;
}) {
  return (
    <Link href={href} className={on ? "fnd-choice on" : "fnd-choice"} aria-current={on ? "true" : undefined}>
      <span className="fnd-choice-label">
        <span className="fnd-choice-mark" aria-hidden="true" />
        {label}
      </span>
      {count !== null && <span className="fnd-choice-count">{count.toLocaleString("en-US")}</span>}
    </Link>
  );
}
