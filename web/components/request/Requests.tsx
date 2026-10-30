import Link from "next/link";
import type { RequestItem } from "@/lib/types";
import { DEFINED_IN, REQUEST_OUTCOME, REQUEST_STATE } from "@/lib/ontology";
import { Term } from "@/components/Term";
import styles from "./request.module.css";

// Requests (Part VIII, Requests): something someone could do that would
// improve what the graph knows. Shown in a node's right margin, on a page of
// their own, and in an index that includes requests no node holds yet.

function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function RequestState({ r }: { r: RequestItem }) {
  const m = REQUEST_STATE[r.state];
  return (
    <Term gloss={m.def} href={DEFINED_IN.request} className={`${styles.state} ${styles[`state_${r.state}`] ?? ""}`}>
      {m.label}
    </Term>
  );
}

/** The right-margin list on a claim, quantity or question page. */
export function RequestsRail({ requests }: { requests: RequestItem[] }) {
  const live = requests.filter((r) => ["open", "addressed", "in_progress"].includes(r.state));
  const closed = requests.length - live.length;
  return (
    <aside className={styles.rail} aria-label="Requests">
      <div className={styles.railHead}>
        <span className="sc">Requests</span>
        <span className={styles.railCount}>
          {live.length}<span className={styles.railCountUnit}>open</span>
        </span>
      </div>
      {requests.length === 0 ? (
        <p className={styles.empty}>Nothing has been asked for on this page yet.</p>
      ) : (
        <ul className={styles.railList}>
          {[...live, ...requests.filter((r) => !live.includes(r))].map((r) => (
            <li key={r.id}>
              <Link href={`/requests/${r.id}`} className={styles.railAsk}>{r.ask}</Link>
              <span className={styles.railMeta}>
                <RequestState r={r} />
                {r.addressed_to && <> · to {r.addressed_to}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.railFoot}>
        {closed > 0 && <>{closed} met or closed · </>}
        <Link href="/requests">all requests →</Link>
      </p>
    </aside>
  );
}

/** One request in full. */
export function RequestView({ r }: { r: RequestItem }) {
  return (
    <article className="col">
      <p className="sc" style={{ marginBottom: "1.2rem" }}>
        <Link href="/requests">← requests</Link>
      </p>
      <div className="claim-eyebrow">
        <span className="sc">Request</span>
        <RequestState r={r} />
        {r.addressed_to && <span className={styles.addressed}>addressed to {r.addressed_to}</span>}
      </div>
      <h1 className={styles.ask}>{r.ask}</h1>
      {r.state_note && <p className={styles.stateNote}>{r.state_note}</p>}

      <dl className={styles.facts}>
        <dt>Why</dt>
        <dd>{r.why}</dd>
        <dt>What would satisfy it</dt>
        <dd>{r.satisfied_by}</dd>
        {r.who_could && (
          <>
            <dt>Who could do it</dt>
            <dd>{r.who_could}</dd>
          </>
        )}
        <dt>Bears on</dt>
        <dd>
          {r.bears_on.length > 0 ? (
            <ul className={styles.bears}>
              {r.bears_on.map((b) => (
                <li key={b.id}>
                  <span className={styles.kind}>{b.kind}</span>
                  <Link href={`/claims/${b.id}`}>{b.text}</Link>
                </li>
              ))}
            </ul>
          ) : null}
          {r.bears_on_sources && r.bears_on_sources.length > 0 && (
            <ul className={styles.bears}>
              {r.bears_on_sources.map((s) => (
                <li key={s.id}>
                  <span className={styles.kind}>source</span>
                  <Link href={`/sources/${s.id}`}>{s.title}</Link>
                </li>
              ))}
            </ul>
          )}
          {r.bears_on_text && <p className={styles.bearsText}>{r.bears_on_text}</p>}
        </dd>
        <dt>Kept by</dt>
        <dd>
          {r.keeper.label.charAt(0).toUpperCase() + r.keeper.label.slice(1)}, who decides when it has been met
          {r.bears_on.length > 0 && <>; the Steward of each page it bears on weighs what the work finds for that page</>}.
        </dd>
        <dt>Filed</dt>
        <dd>by {r.filed_by.label} ({r.filed_by.kind === "admin" ? "an agent of the graph" : r.filed_by.kind === "mandate" ? "a mandate, through the Contribution Reviewer" : "a contributor, through the Contribution Reviewer"}) · {fmtDate(r.filed_at)}</dd>
      </dl>

      {r.work && r.work.length > 0 && (
        <section>
          <h2>Work on it</h2>
          <p className={styles.intro}>
            Every outcome is a complete one, paid for alike: met, partly met, a negative result,
            cannot be met, declined, or a recommendation to revise the request.
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
                {w.funded_by && (
                  <p className={styles.funded}>
                    Funded by {w.funded_by}. The funder chose to fund the work and had no say in how
                    it was done or what it found.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}

/** The index: every request, including those that bear on nothing the graph holds yet. */
// A search over what requests ask and why (API `q`), as a plain GET form:
// the index is server-rendered, so it needs no client script. With a query
// the groups keep the API's rank order within each.
export function RequestIndex({ requests, q = "" }: { requests: RequestItem[]; q?: string }) {
  const groups: [string, RequestItem[]][] = [
    ["Open", requests.filter((r) => r.state === "open" || r.state === "addressed")],
    ["In progress", requests.filter((r) => r.state === "in_progress")],
    ["Met or closed", requests.filter((r) => ["met", "declined", "withdrawn", "moot"].includes(r.state))],
  ];
  return (
    <article className="col">
      <h1>Requests</h1>
      <p className={styles.lede}>
        Things someone could do that would improve what the graph knows: a measurement, a
        dataset, a replication, an evaluation built to a specification, access to evidence, or a
        programme of research. Each says why it matters and what would satisfy it. A request asks
        for what would decide the matter either way, not for a particular result.
      </p>
      <form role="search" action="/requests" className={styles.search}>
        <input
          className="claims-search"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search requests by what they ask, why, or what would satisfy them"
          aria-label="Search requests"
        />
      </form>
      {q && (
        <p className={styles.searchMeta}>
          {requests.length} {requests.length === 1 ? "request matches" : "requests match"} “{q}”
          {" · "}
          <Link href="/requests">clear</Link>
        </p>
      )}
      {q && requests.length === 0 && (
        <p className={styles.lede}>
          Nothing matches that search. Requests are searched by the words of what they ask, why it
          matters, and what would satisfy them.
        </p>
      )}
      {groups.filter(([, rs]) => rs.length > 0).map(([label, rs]) => (
        <section key={label}>
          <h2>{label}</h2>
          <ul className={styles.index}>
            {rs.map((r) => (
              <li key={r.id}>
                <Link href={`/requests/${r.id}`} className={styles.indexAsk}>{r.ask}</Link>
                <span className={styles.indexMeta}>
                  <RequestState r={r} />
                  {" · "}
                  {r.bears_on.length > 0
                    ? `bears on ${r.bears_on.map((b) => `“${b.text}”`).join(", ")}`
                    : "bears on nothing the graph holds yet"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
