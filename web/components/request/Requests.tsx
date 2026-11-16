import Link from "next/link";
import type { ClaimCard, RequestFacets, RequestItem } from "@/lib/types";
import { DEFINED_IN, REQUEST_OUTCOME, REQUEST_STATE } from "@/lib/ontology";
import { Term } from "@/components/Term";
import { PageHead } from "@/components/PageHead";
import { ImportanceTicks, Standing } from "@/components/findings/FindingParts";
import {
  askHeadline,
  fundingWords,
  hasRequestFilters,
  importanceOutOfTen,
  isLive,
  requestsHref,
  requestsOrderInForce,
  splitAsk,
  REQUESTS_PER_PAGE,
  type RequestsOrder,
  type RequestsStands,
  type RequestsView,
} from "@/lib/requests";
import { RequestFunding } from "./RequestFunding";
import { TakeUp } from "./TakeUp";
import styles from "./request.module.css";

// Requests (constitution Part VIII, Requests): something someone could do
// that would improve what the graph knows. Shown in a node's right margin,
// on a page of their own, and in an index that includes requests no node
// holds yet.
//
// Who reads these pages, and what each needs first:
//   - a researcher looking for the problems most worth working on: the
//     most important first, by topic, with who could do it and what would
//     satisfy it, and a way to say "I'm on it";
//   - a funder: what waits for money, what it costs, and a way to pay;
//   - the party a request is put to (an author, a lab, a press office, an
//     agency): the requests put to someone, and how to answer one;
//   - the curious reader: a plain headline, what it would settle and where
//     that stands now, browsable by topic;
//   - an agent: the same view, by URL, and the API and MCP calls behind it.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function RequestState({ r }: { r: Pick<RequestItem, "state"> }) {
  const m = REQUEST_STATE[r.state];
  return (
    <Term gloss={m.def} href={DEFINED_IN.request} className={`${styles.state} ${styles[`state_${r.state}`] ?? ""}`}>
      {m.label}
    </Term>
  );
}

/** The right-margin list on a claim, quantity or question page. */
export function RequestsRail({ requests }: { requests: RequestItem[] }) {
  const live = requests.filter(isLive);
  const closed = requests.length - live.length;
  // None on this page: one quiet line, not a heading, a zero and a sentence
  // saying the zero again. The link stays, as the index's way in.
  if (requests.length === 0) {
    return (
      <p className={styles.railFoot} style={{ marginTop: 0 }}>
        No requests on this page · <Link href="/requests">all requests →</Link>
      </p>
    );
  }
  return (
    <aside className={styles.rail} aria-label="Requests">
      <div className={styles.railHead}>
        <span className="sc">Requests</span>
        <span className={styles.railCount}>
          {live.length}<span className={styles.railCountUnit}>open</span>
        </span>
      </div>
      <ul className={styles.railList}>
        {[...live, ...requests.filter((r) => !live.includes(r))].map((r) => (
          <li key={r.id}>
            <Link href={`/requests/${r.id}`} className={styles.railAsk}>{askHeadline(r.ask)}</Link>
            <span className={styles.railMeta}>
              <RequestState r={r} />
              {r.addressed_to && <> · to {r.addressed_to}</>}
              {fundingWords(r)?.waiting && <> · waiting for a funder</>}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.railFoot}>
        {closed > 0 && <>{closed} met or closed · </>}
        <Link href="/requests">all requests →</Link>
      </p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** The importance of what a request bears on, drawn as the findings index draws a finding's. */
function ImportanceRail({ r }: { r: RequestItem }) {
  const n = importanceOutOfTen(r.importance);
  if (n === null) {
    return (
      <div className="fnd-rail" title="It bears on nothing the graph holds yet, so it has no importance of its own.">
        <div className={`fnd-rail-n ${styles.railNone}`}>–</div>
      </div>
    );
  }
  return (
    <div
      className="fnd-rail"
      title={`Importance ${n} of 10: how much it matters to get right the most important page this request bears on.`}
    >
      <div className="fnd-rail-n">
        {n}
        <span> / 10</span>
      </div>
      <ImportanceTicks value={n} />
    </div>
  );
}

/** What a request bears on, in one line: the first node with where it stands now, and how many more. */
function BearsOnLine({ r, cards }: { r: RequestItem; cards: Map<string, ClaimCard> }) {
  const first = r.bears_on[0];
  const more = r.bears_on.length - 1 + (r.bears_on_sources?.length ?? 0);
  if (first) {
    return (
      <p className="fnd-on">
        <span className="sc">Would settle</span>
        <Link href={`/claims/${first.id}`}>{first.text}</Link>
        <Standing card={cards.get(first.id)} />
        {more > 0 && <span className={styles.more}>and {more} more</span>}
      </p>
    );
  }
  const source = r.bears_on_sources?.[0];
  if (source) {
    return (
      <p className="fnd-on">
        <span className="sc">On the document</span>
        <Link href={`/sources/${source.id}`}>{source.title}</Link>
      </p>
    );
  }
  return r.bears_on_text ? (
    <p className="fnd-on">
      <span className="sc">Bears on</span>
      <span>{r.bears_on_text}</span>
      <span className={styles.more}>not yet on the graph</span>
    </p>
  ) : null;
}

export function RequestListItem({
  r,
  cards,
  view,
}: {
  r: RequestItem;
  cards: Map<string, ClaimCard>;
  view: RequestsView;
}) {
  const money = fundingWords(r);
  return (
    <article className="fnd-item" id={r.id}>
      <ImportanceRail r={r} />
      <div className="fnd-body">
        <h2 className={`fnd-headline ${styles.headline}`}>
          <Link href={`/requests/${r.id}`} className="plain">
            {askHeadline(r.ask)}
          </Link>
        </h2>
        <BearsOnLine r={r} cards={cards} />
        {r.who_could && (
          <p className={styles.who}>
            <span className="sc">Who could</span> {r.who_could}
          </p>
        )}
        <p className="fnd-foot">
          <span>
            <RequestState r={r} />
            {r.addressed_to && (
              <>
                {" "}
                <strong className={styles.askedOf}>asked of {r.addressed_to}</strong>
              </>
            )}
            {money && <> · {money.words}</>}
            {r.taken_up && r.taken_up.length > 0 && (
              <> · taken up by {r.taken_up.length === 1 ? r.taken_up[0]!.by : `${r.taken_up.length} accounts`}</>
            )}
            {" · "}
            {fmtDate(r.filed_at)}
          </span>
          {(r.tags ?? []).map((t) => (
            <Link
              key={t.slug}
              href={requestsHref(view, { tag: t.slug })}
              className="tag topic"
              aria-label={`Only requests on ${t.name}`}
            >
              {t.name}
            </Link>
          ))}
        </p>
      </div>
    </article>
  );
}

/** One choice of a filter: a link that turns it on, or off when it is on. */
function FacetLink({ label, count, on, href }: { label: string; count: number | null; on: boolean; href: string }) {
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

const STANDS_LABEL: Record<RequestsStands, string> = {
  live: "Still open to work",
  any: "In any state",
  open: "Open",
  addressed: "Addressed",
  in_progress: "Being worked on",
  met: "Met",
  declined: "Declined",
  withdrawn: "Withdrawn",
  moot: "Moot",
};

/**
 * The ways in, on the plain index: each a view the filters can also reach,
 * named for what a reader came to do.
 */
function WaysIn({ view, facets }: { view: RequestsView; facets: RequestFacets }) {
  const state = (s: string) => facets.states.find((x) => x.state === s)?.count ?? 0;
  const ways: Array<{ href: string; label: string; count: number; line: string }> = [
    {
      href: requestsHref(view, { waiting: true }),
      label: "Waiting for a funder",
      count: facets.waiting,
      line: "Priced or ready to price. Anyone can commission the work; it starts at once.",
    },
    {
      href: requestsHref(view, { asked: "named" }),
      label: "Put to a particular party",
      count: facets.asked.named,
      line: "Asked of whoever holds the evidence: an author, a lab, an agency, a company.",
    },
    {
      href: requestsHref(view, { stands: "in_progress" }),
      label: "Being worked on",
      count: state("in_progress"),
      line: "Someone has taken these up. Their work is on each request's record.",
    },
    {
      href: requestsHref(view, { stands: "met" }),
      label: "Met",
      count: state("met"),
      line: "What the work found, and what it changed on the graph.",
    },
  ];
  return (
    <nav className={styles.ways} aria-label="Ways in">
      {ways.map((w) => (
        <Link key={w.label} href={w.href} className={styles.way}>
          <span className={styles.wayHead}>
            <span>{w.label}</span>
            <span className={styles.wayCount}>{w.count.toLocaleString("en-US")}</span>
          </span>
          <span className={styles.wayLine}>{w.line}</span>
        </Link>
      ))}
    </nav>
  );
}

/** The index: every request, including those that bear on nothing the graph holds yet. */
export function RequestIndex({
  view,
  requests,
  total,
  facets,
  cards,
  failed,
}: {
  view: RequestsView;
  requests: RequestItem[];
  total: number;
  facets: RequestFacets | null;
  cards: Map<string, ClaimCard>;
  failed: boolean;
}) {
  const order = requestsOrderInForce(view);
  const orders: Array<[RequestsOrder, string]> = [
    ...(view.q ? ([["relevance", "Best match"]] as Array<[RequestsOrder, string]>) : []),
    ["importance", "Most important"],
    ["recent", "Newest"],
  ];
  const tagName =
    view.tag &&
    (facets?.tags.find((t) => t.slug === view.tag)?.name ??
      requests.flatMap((r) => r.tags ?? []).find((t) => t.slug === view.tag)?.name ??
      view.tag);
  const active: Array<{ label: string; href: string }> = [];
  if (view.q) active.push({ label: `“${view.q}”`, href: requestsHref(view, { q: null, order: null }) });
  if (view.stands !== "live") active.push({ label: STANDS_LABEL[view.stands], href: requestsHref(view, { stands: "live" }) });
  if (view.tag) active.push({ label: `Topic: ${tagName}`, href: requestsHref(view, { tag: null }) });
  if (view.asked) {
    active.push({
      label: view.asked === "named" ? "Put to a particular party" : "Open to anyone",
      href: requestsHref(view, { asked: null }),
    });
  }
  if (view.waiting) active.push({ label: "Waiting for a funder", href: requestsHref(view, { waiting: false }) });

  const shownTo = (view.page - 1) * REQUESTS_PER_PAGE + requests.length;
  const more = shownTo < total;
  const plain = !hasRequestFilters(view) && view.page === 1;
  const stateTotal = (s: string) => facets?.states.find((x) => x.state === s)?.count ?? 0;
  const liveTotal = stateTotal("open") + stateTotal("addressed") + stateTotal("in_progress");
  const anyTotal = facets?.states.reduce((t, s) => t + s.count, 0) ?? null;

  return (
    <div className="fnd req">
      <PageHead
        title="Requests"
        lede={
          <>
            Work that would improve what the graph knows: a measurement, a replication, a dataset, a document, a
            reading of a literature, a programme of research. Each says what it asks, why the answer matters, and what
            would satisfy it, and asks for what would decide the matter either way, never for a particular result.
            Anyone may take one up, fund it, or bring what it asks for. The most important come first.
          </>
        }
      />

      {plain && facets && <WaysIn view={view} facets={facets} />}

      <div className="fnd-cols">
        <aside className="fnd-filters" aria-label="Filter the requests">
          <input type="checkbox" id="req-filters-open" className="fnd-filters-switch" />
          <label htmlFor="req-filters-open" className="fnd-filters-label">
            Filters{active.length > 0 ? ` · ${active.length} on` : ""}
          </label>
          <div className="fnd-filters-body">
            <div className="fnd-filters-head">
              <span className="sc">Filter</span>
              {hasRequestFilters(view) && <Link href="/requests">Clear all</Link>}
            </div>

            <div className="fnd-facet" role="group" aria-label="Where it stands">
              <div className="sc">Where it stands</div>
              <FacetLink
                label={STANDS_LABEL.live}
                count={facets ? liveTotal : null}
                on={view.stands === "live"}
                href={requestsHref(view, { stands: "live" })}
              />
              {(facets?.states ?? []).map((s) => (
                <FacetLink
                  key={s.state}
                  label={STANDS_LABEL[s.state]}
                  count={s.count}
                  on={view.stands === s.state}
                  href={requestsHref(view, { stands: view.stands === s.state ? "live" : s.state })}
                />
              ))}
              <FacetLink
                label={STANDS_LABEL.any}
                count={anyTotal}
                on={view.stands === "any"}
                href={requestsHref(view, { stands: view.stands === "any" ? "live" : "any" })}
              />
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
                    href={requestsHref(view, { tag: view.tag === t.slug ? null : t.slug })}
                  />
                ))}
                <p className="fnd-facet-more">
                  <Link href="/tags">All topics →</Link>
                </p>
              </div>
            )}

            <div className="fnd-facet" role="group" aria-label="Asked of">
              <div className="sc">Asked of</div>
              <FacetLink
                label="Anyone who can do it"
                count={facets?.asked.anyone ?? null}
                on={view.asked === "anyone"}
                href={requestsHref(view, { asked: view.asked === "anyone" ? null : "anyone" })}
              />
              <FacetLink
                label="A particular party"
                count={facets?.asked.named ?? null}
                on={view.asked === "named"}
                href={requestsHref(view, { asked: view.asked === "named" ? null : "named" })}
              />
            </div>

            <div className="fnd-facet" role="group" aria-label="Funding">
              <div className="sc">Funding</div>
              <FacetLink
                label="Waiting for a funder"
                count={facets?.waiting ?? null}
                on={view.waiting}
                href={requestsHref(view, { waiting: !view.waiting })}
              />
              <p className="fnd-facet-note">
                Its work is on the ledger and nobody has commissioned it yet.
              </p>
            </div>
          </div>
        </aside>

        <div className="fnd-list">
          <div className="fnd-bar">
            <form action="/requests" method="get" role="search" className="fnd-search">
              {/* A search keeps the filters in force, and starts closest first. */}
              {view.tag && <input type="hidden" name="tag" value={view.tag} />}
              {view.stands !== "live" && <input type="hidden" name="stands" value={view.stands} />}
              {view.asked && <input type="hidden" name="asked" value={view.asked} />}
              {view.waiting && <input type="hidden" name="waiting" value="1" />}
              <label htmlFor="req-q" className="visually-hidden">
                Search the requests
              </label>
              <input
                id="req-q"
                type="search"
                name="q"
                defaultValue={view.q ?? ""}
                placeholder="Search by what they ask, why, or what would satisfy them"
                maxLength={300}
                autoComplete="off"
              />
              <button type="submit">Search</button>
            </form>
            <nav className="acct-switch" aria-label="Order">
              {orders.map(([value, label]) => (
                <Link
                  key={value}
                  href={requestsHref(view, { order: value })}
                  aria-current={order === value ? "true" : undefined}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="fnd-active">
            <span className="fnd-count" role="status">
              {`${total.toLocaleString("en-US")} request${total === 1 ? "" : "s"}`}
            </span>
            {active.map((a) => (
              <Link key={a.label} href={a.href} className="fnd-chip" aria-label={`Remove: ${a.label}`}>
                {a.label}
                <span aria-hidden="true">×</span>
              </Link>
            ))}
          </div>

          {requests.length === 0 ? (
            failed ? (
              <p className="account-empty fnd-empty">The requests could not be read just now.</p>
            ) : hasRequestFilters(view) ? (
              <div className="fnd-empty">
                <p>No request matches all of that.</p>
                <p className="account-empty">
                  Remove a filter above, or <Link href="/requests">clear them all</Link>. Requests are searched by
                  the meaning of what they ask and why it matters, and by the words of what would satisfy them.
                </p>
              </div>
            ) : (
              <p className="account-empty fnd-empty">
                No request is open. The graph&apos;s agents file one where their work shows that something would
                improve what it knows, and anyone may propose one.
              </p>
            )
          ) : (
            requests.map((r) => <RequestListItem key={r.id} r={r} cards={cards} view={view} />)
          )}

          {(view.page > 1 || more) && (
            <nav className="fnd-pages" aria-label="More requests">
              {view.page > 1 ? (
                <Link href={requestsHref(view, { page: view.page - 1 })}>← Previous page</Link>
              ) : (
                <span />
              )}
              <span className="acct-note">
                {(view.page - 1) * REQUESTS_PER_PAGE + 1} to {shownTo} of {total.toLocaleString("en-US")}
              </span>
              {more ? <Link href={requestsHref(view, { page: view.page + 1 })}>Next page →</Link> : <span />}
            </nav>
          )}

          <ForAgents
            lines={[
              ["This view", <code key="v">GET /requests?{indexQueryForAgents(view)}</code>],
              ["Over MCP", <><code>list_requests</code>, with the same filters</>],
              ["To bring what one asks for", <><code>submit_contribution</code> of the type <code>answer_request</code></>],
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/** The API query an agent would send for the view, shown as it would type it. */
function indexQueryForAgents(view: RequestsView): string {
  const p = new URLSearchParams();
  if (view.stands !== "any") p.set("state", view.stands);
  p.set("order", requestsOrderInForce(view));
  if (view.q) p.set("q", view.q);
  if (view.tag) p.set("tag", view.tag);
  if (view.asked) p.set("asked", view.asked);
  if (view.waiting) p.set("waiting", "true");
  return p.toString();
}

function ForAgents({ lines }: { lines: Array<[string, React.ReactNode]> }) {
  return (
    <section className={styles.agents} aria-label="For agents and scripts">
      <div className="sc">For agents and scripts</div>
      <p>
        Every request is public to read and needs no key. The same lists and records are served by the API and the
        MCP server (<Link href="/docs/setup">setting up</Link>); taking a request up, funding it, or contributing to
        it is done as an account.
      </p>
      <dl>
        {lines.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/** The ask past its headline: the rest of its opening, its parts as a list, and what is said of them all. */
function AskBody({ ask }: { ask: string }) {
  const p = splitAsk(ask);
  if (!p.rest && p.parts.length === 0 && !p.tail) return null;
  return (
    <div className={styles.askBody}>
      {p.rest && <p>{p.rest}</p>}
      {p.parts.length > 0 && (
        <ol type={p.marker === "a" ? "a" : "1"} className={styles.parts}>
          {p.parts.map((part, i) => (
            <li key={i}>{part}</li>
          ))}
        </ol>
      )}
      {p.tail && <p>{p.tail}</p>}
    </div>
  );
}

/** One request in full. `cards` says where each node it bears on stands now. */
export function RequestView({ r, cards }: { r: RequestItem; cards: Map<string, ClaimCard> }) {
  const live = isLive(r);
  const n = importanceOutOfTen(r.importance);
  const takenUp = (r.taken_up ?? []).filter((t) => t.account_id !== r.addressed_to_mandate?.publisher.account_id);
  const firstNode = r.bears_on[0];
  return (
    <div className={`fnd fnd-one ${styles.one}`}>
      <PageHead
        back={{ href: "/requests", label: "requests" }}
        kicker="Request"
        tags={
          <>
            <RequestState r={r} />
            {r.addressed_to && <span className={styles.addressed}>asked of {r.addressed_to}</span>}
          </>
        }
        variant="statement"
        title={askHeadline(r.ask)}
        meta={
          <>
            filed by {r.filed_by.label} · {fmtDate(r.filed_at)}
            {n !== null && (
              <>
                {" · "}
                <span title="How much it matters to get right the most important page it bears on.">
                  bears on a page of importance {n} of 10
                </span>
              </>
            )}
          </>
        }
      />
      {r.state_note && <p className={styles.stateNote}>{r.state_note}</p>}

      <div className={styles.cols}>
        <div className={styles.main}>
          <AskBody ask={r.ask} />

          <section>
            <h2>What it would settle</h2>
            {r.bears_on.length > 0 && (
              <ul className={styles.nodes}>
                {r.bears_on.map((b) => {
                  const imp = importanceOutOfTen(b.importance);
                  return (
                    <li key={b.id}>
                      <span className={styles.kind}>{b.kind}</span>
                      <Link href={`/claims/${b.id}`}>{b.text}</Link>
                      <span className={styles.nodeMeta}>
                        <Standing card={cards.get(b.id)} />
                        {imp !== null && (
                          <span title={`Importance ${imp} of 10`}>
                            <ImportanceTicks value={imp} />
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {r.bears_on_sources && r.bears_on_sources.length > 0 && (
              <ul className={styles.nodes}>
                {r.bears_on_sources.map((s) => (
                  <li key={s.id}>
                    <span className={styles.kind}>document</span>
                    <Link href={`/sources/${s.id}`}>{s.title}</Link>
                  </li>
                ))}
              </ul>
            )}
            {r.bears_on_text && (
              <p className={styles.bearsText}>
                {r.bears_on_text}
                <span className={styles.more}>not yet on the graph</span>
              </p>
            )}
            {r.bears_on.length === 0 && r.bears_on_sources?.length === 1 && (
              <p className={styles.intro}>
                It bears on one document alone, so it asks for a review of that document for its own sake: what the
                work finds is recorded on the document&rsquo;s page, for whoever reads it next.
              </p>
            )}
            <h3 className={styles.sub}>Why it matters</h3>
            <p>{r.why}</p>
          </section>

          <section>
            <h2>What would satisfy it</h2>
            <p>{r.satisfied_by}</p>
            {r.who_could && (
              <>
                <h3 className={styles.sub}>Who could do it</h3>
                <p>{r.who_could}</p>
              </>
            )}
          </section>

          {r.addressed_to_mandate && (
            <section>
              <h2>Addressed to a published mandate</h2>
              <p className={styles.intro}>
                A graph that keeps its evidence private published this mandate here, with its terms and how its gate
                to outside is set for the mandate&rsquo;s work. Whether it takes a request up is its own decision.
                What followed is read from this graph&rsquo;s record.
              </p>
              <p>
                {r.addressed_to_mandate.in_words.replace(/\borganiz/g, "organis")}{" "}
                <a href={`/contributors/${r.addressed_to_mandate.publisher.account_id}`}>The publisher&rsquo;s record</a>
              </p>
            </section>
          )}

          {takenUp.length > 0 && (
            <section>
              <h2>Taken up</h2>
              <p className={styles.intro}>
                An account may say that it is taking a request up. That commits it to doing the work well, not to a
                result, and funds nothing. What followed is read from this graph&rsquo;s record, not from the account.
              </p>
              <ul>
                {takenUp.map((t) => (
                  <li key={`${t.account_id}-${t.at}`}>
                    {t.in_words}{" "}
                    {t.published_page_id && t.node_id && t.followed === "a_page_shown" && (
                      <a href={`/claims/${t.node_id}?published=${t.published_page_id}`}>Read the page</a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {r.work && r.work.length > 0 && (
            <section>
              <h2>Work on it</h2>
              <p className={styles.intro}>
                Every outcome is a complete one, paid for alike: met, partly met, a negative result, cannot be met,
                declined, or a recommendation to revise the request.
              </p>
              <ol className={styles.work}>
                {r.work.map((w, i) => (
                  <li key={i}>
                    <div className={styles.workHead}>
                      <span>{w.by}</span>
                      {w.outcome && (
                        <Term gloss={REQUEST_OUTCOME[w.outcome].def} href={DEFINED_IN.request} className={styles.outcome}>
                          {REQUEST_OUTCOME[w.outcome].label}
                        </Term>
                      )}
                      <span className={styles.workWhen}>{fmtDate(w.at)}</span>
                    </div>
                    <p>{w.summary}</p>
                    {w.funding && (
                      <p className={styles.funded}>This run was {w.funding}, so it could do only part of the work.</p>
                    )}
                    {w.funded_by && (
                      <p className={styles.funded}>
                        Funded by {w.funded_by}. The funder chose to fund the work and had no say in how it was done or
                        what it found.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <ForAgents
            lines={[
              ["This request", <code key="g">GET /requests/{r.id}</code>],
              ["Over MCP", <><code>get_request</code>, <code>take_up_request</code>, <code>fund_request_work</code></>],
              [
                "Bringing what it asks for",
                <>
                  <code>submit_contribution</code> of the type <code>answer_request</code>, with this request&rsquo;s id
                </>,
              ],
            ]}
          />
        </div>

        <aside className={styles.side} aria-label="What you can do">
          {live ? (
            <div className={styles.box}>
              <div className="sc">Can you do this?</div>
              <p>
                Say so on its record. Your account&rsquo;s name and the date are shown here at once. It commits you to
                doing the work well, not to a result: a negative result, or a finding that it cannot be done, is a
                complete answer. It funds nothing.
              </p>
              {r.addressed_to && (
                <p>
                  It was put to <strong>{r.addressed_to}</strong>, who may hold what it asks for. Anyone may still take
                  it up, and what they say, a refusal included, is part of the record.
                </p>
              )}
              <TakeUp requestId={r.id} />
            </div>
          ) : (
            <div className={styles.box}>
              <div className="sc">{REQUEST_STATE[r.state].label}</div>
              <p>{REQUEST_STATE[r.state].def} There is nothing left to take up.</p>
            </div>
          )}

          <RequestFunding r={r} />

          {live && (
            <div className={styles.box}>
              <div className="sc">Have what it asks for?</div>
              <p>
                A result, a dataset, a document or a reading the request wants is brought as a contribution and reviewed
                like any other. The Steward of each page it bears on weighs it there.
              </p>
              {firstNode ? (
                <p>
                  <Link href={`/claims/${firstNode.id}?contribute=support#contribute`}>Contribute it on the page →</Link>
                </p>
              ) : (
                <p className={styles.sideNote}>
                  Through the API or MCP: <code>answer_request</code>.
                </p>
              )}
            </div>
          )}

          <div className={`${styles.box} ${styles.record}`}>
            <div className="sc">On the record</div>
            <dl>
              <dt>Filed</dt>
              <dd>
                {fmtDate(r.filed_at)}, by {r.filed_by.label} (
                {r.filed_by.kind === "admin"
                  ? "an agent of the graph"
                  : r.filed_by.kind === "mandate"
                    ? "a mandate, through the Contribution Reviewer"
                    : "a contributor, through the Contribution Reviewer"}
                )
              </dd>
              <dt>Kept by</dt>
              <dd>
                {r.keeper.label.charAt(0).toUpperCase() + r.keeper.label.slice(1)}, who decides when it has been met
              </dd>
              {r.budget_usd != null && (
                <>
                  <dt>Budget</dt>
                  <dd>${r.budget_usd.toFixed(2)}, what doing it should cost</dd>
                </>
              )}
              {(r.tags ?? []).length > 0 && (
                <>
                  <dt>Topics</dt>
                  <dd className={styles.tagList}>
                    {(r.tags ?? []).map((t) => (
                      <Link key={t.slug} href={`/requests?tag=${encodeURIComponent(t.slug)}`} className="tag topic">
                        {t.name}
                      </Link>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
