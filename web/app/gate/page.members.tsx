import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { Icon } from "@/components/work/icons";
import {
  Boundary,
  ButtonLink,
  Dot,
  Empty,
  Party,
  Pill,
  Seg,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  age,
  plural,
  shortDay,
  shortWhen,
} from "@/components/work/ui";
import {
  KIND_ONE,
  KIND_PLURALS,
  SETTING_WORDS,
  auditPill,
  figure,
  headerOf,
  splitMarks,
  totalRemovals,
  verdictPill,
} from "@/lib/gate-review";
import { fetchGateQueue, fetchShowing, type QueueItem, type ShownShowing } from "@/lib/inside-api";
import { capital } from "@/lib/inside-words";
import { decideAction } from "../showings/actions";
import { QueueForm } from "./QueueForm";
import "./review.css";

export const metadata: Metadata = { title: "Review · Minerval" };
export const dynamic = "force-dynamic";

// What waits on a person at a gate (GET /gate/queue; docs/the-gate.md): for
// a person who holds release for a party, the parts of items that rest on
// that party's material and have not gone through. These are the items
// whose gate is set to a person's decision, and those the Redactor or a
// person holds or has delayed; everything else went as the Redactor left it.
//
// One party at a time (`?party=`), narrowed by kind (`?kind=`). On the left
// the queue, one row per item, oldest first; in the centre the item chosen
// (`?item=`) as a document, each part as it would be shown with a box to
// tick and the acts beneath; on the right what it belongs to and rests on.
// Where the person reads at the label the page was written at, the
// Redactor's removals are a difference against what the Steward wrote, with
// its notes. Where they do not, they see the marks and not what was removed,
// except in a part that rests only on the material of an outside party they
// release for, and the API's sentence says so once.

type Search = { party?: string; kind?: string; item?: string };

interface Entry {
  id: string;
  rows: QueueItem[];
  first: QueueItem;
}

function href(party: string, kind: string | undefined, item?: string): string {
  const q = new URLSearchParams({ party });
  if (kind) q.set("kind", kind);
  if (item) q.set("item", item);
  return `/gate?${q.toString()}`;
}

/** What an item is called in the queue and at the head of the document: the node's words, or the kind's. */
function titleOf(item: QueueItem): { text: string; serif: boolean; faint?: boolean } {
  if (item.node) return { text: item.node, serif: true };
  if (item.wording_as_it_would_be_shown) return { text: item.wording_as_it_would_be_shown, serif: true };
  if (item.kind_of_thing !== "page") return { text: capital(item.kind_of_thing_in_words), serif: false };
  return { text: "A page of a node you do not read", serif: false, faint: true };
}

/**
 * Where an item crosses, as the queue says it: the label it was written at
 * (by its name, or the face it shows here, or not at all where the person
 * may not be told it) and the label it goes to, or outside.
 */
function crossingOf(item: QueueItem): { from: string | null; to: string } {
  return { from: item.from ?? null, to: item.to_outside ? "outside" : item.to };
}

/** A part as it would be shown: each removed passage struck through in front of the mark that replaces it, where the person may see it. */
function Shown({ item }: { item: QueueItem }) {
  const shown = item.as_it_would_be_shown ?? "";
  const removals = item.removals ?? [];
  if (removals.length === 0) {
    return (
      <>
        {splitMarks(shown, Object.keys(item.removals_by_category ?? {})).map((run, i) =>
          run.mark ? (
            <span key={i} className="w-redacted" title={`A passage removed under the policy, in the category "${run.mark}"`}>
              {run.text}
            </span>
          ) : (
            <span key={i}>{run.text}</span>
          )
        )}
      </>
    );
  }
  const out: ReactNode[] = [];
  let at = 0;
  removals.forEach((r, i) => {
    const mark = `[redacted: ${r.category}]`;
    const found = shown.indexOf(mark, at);
    if (found === -1) return;
    out.push(shown.slice(at, found));
    out.push(
      <del key={`d${i}`} className="w-removed" title={r.redactor_note ? `The Redactor's note: ${r.redactor_note}` : undefined}>
        {r.passage}
      </del>,
      " ",
      <span key={`m${i}`} className="w-redacted">
        {mark}
      </span>
    );
    at = found + mark.length;
  });
  out.push(shown.slice(at));
  return <>{out}</>;
}

const STANDING: Record<"released" | "held" | "waiting", string> = { released: "released", held: "holding", waiting: "not decided" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "release")) return <NeedsPermission title="Review" permission="release" />;
  const params = await searchParams;
  const queue = await fetchGateQueue(who.externalId);

  // The parties the person releases for: from their grants, and any the queue names besides.
  const partyMap = new Map<string, { id: string; name: string }>();
  for (const g of who.mine.grants) if (g.permission === "release" && g.party) partyMap.set(g.party.id, { id: g.party.id, name: g.party.name });
  for (const i of queue.items) for (const p of i.decide_for) if (!partyMap.has(p.id)) partyMap.set(p.id, { id: p.id, name: p.name });
  const parties = [...partyMap.values()];
  const entriesFor = (partyId: string, kind?: string): Entry[] => {
    const byItem = new Map<string, QueueItem[]>();
    for (const i of queue.items) {
      if (!i.decide_for.some((p) => p.id === partyId)) continue;
      if (kind && i.kind_of_thing !== kind) continue;
      byItem.set(i.item_id, [...(byItem.get(i.item_id) ?? []), i]);
    }
    return [...byItem.entries()].map(([id, rows]) => ({
      id,
      rows: [...rows].sort((a, b) => (a.part ?? -1) - (b.part ?? -1)),
      first: rows[0]!,
    }));
  };
  const party = parties.find((p) => p.id === params.party) ?? parties.find((p) => entriesFor(p.id).length > 0) ?? parties[0];
  const allItems = new Set(queue.items.map((i) => i.item_id)).size;

  const head = (
    <WorkHead
      title="Review"
      sub={allItems === 0 ? "Nothing waits on you" : `${plural(allItems, "item")} ${allItems === 1 ? "waits" : "wait"} on you`}
      actions={
        <ButtonLink href="/gates" icon="boundaries">
          Gate settings
        </ButtonLink>
      }
    />
  );

  if (!party) {
    return (
      <WorkPage wide>
        {head}
        <div className="w-card">
          <Empty>Nothing waits on you.</Empty>
        </div>
        <Rules queue={queue} />
      </WorkPage>
    );
  }

  const ofParty = entriesFor(party.id);
  const kinds = [...new Set(ofParty.map((e) => e.first.kind_of_thing))];
  const kind = params.kind && kinds.includes(params.kind) ? params.kind : undefined;
  const entries = kind ? ofParty.filter((e) => e.first.kind_of_thing === kind) : ofParty;
  const selected = entries.find((e) => e.id === params.item || e.first.page_id === params.item) ?? entries[0];

  // For the item chosen: its showing (who asked, and its acts). The categories a passage can be removed
  // under are those of the policy the item was redacted under, which the queue gives with each item.
  const showing: ShownShowing | null = selected ? await fetchShowing(who.externalId, selected.first.showing_id).catch(() => null) : null;
  const categories = selected?.first.policy?.categories ?? [];

  const tabs = parties.map((p) => ({
    key: p.id,
    label: <Party name={p.name} />,
    href: href(p.id, undefined),
    count: entriesFor(p.id).length,
  }));

  return (
    <WorkPage wide>
      {head}
      <Tabs tabs={tabs} current={party.id} />

      {ofParty.length > 0 && (
        <div className="w-toolbar">
          {kinds.length > 1 && (
            <Seg
              current={kind ?? "all"}
              options={[
                { key: "all", href: href(party.id, undefined), label: `All ${ofParty.length}` },
                ...kinds.map((k) => ({
                  key: k,
                  href: href(party.id, k),
                  label: `${KIND_PLURALS[k] ?? capital(k.replace(/_/g, " "))} ${ofParty.filter((e) => e.first.kind_of_thing === k).length}`,
                })),
              ]}
            />
          )}
          <span className="w-review-legend w-spacer">
            <Dot tone="warn" /> least sure <Dot tone="bad" /> Redactor holds <span className="w-dot w-review-info" /> delayed
          </span>
        </div>
      )}

      {entries.length === 0 || !selected ? (
        <div className="w-card">
          <Empty>Nothing waits on you for {party.name}.</Empty>
        </div>
      ) : (
        <div className="w-review">
          <QueueList entries={entries} selected={selected.id} party={party.id} kind={kind} />
          <QueueForm
            key={party.id}
            action={decideAction}
            partyId={party.id}
            itemKey={selected.id}
            reasons={queue.hold_reasons}
            anyHeld={selected.rows.some(
              (r) => r.held_by_the_redactor || r.delayed_until || r.rests_on.some((s) => s.party.id === party.id && s.standing === "held")
            )}
            categories={categories}
            acts={queue.acts}
          >
            <Document entry={selected} party={party} />
          </QueueForm>
          <Context entry={selected} party={party} showing={showing} />
        </div>
      )}

      {queue.more_waiting && <p className="w-help">More items wait than are listed here. They appear as these are decided.</p>}
      <Rules queue={queue} />
    </WorkPage>
  );
}

function QueueList({
  entries,
  selected,
  party,
  kind,
}: {
  entries: Entry[];
  selected: string;
  party: string;
  kind: string | undefined;
}) {
  const parts = entries.reduce((n, e) => n + e.rows.length, 0);
  return (
    <section className="w-review-list" aria-label="Queue">
      <div className="w-review-list-h">
        <span>
          {plural(entries.length, "item")} · {plural(parts, "part")}
        </span>
        <span className="w-spacer">oldest first</span>
      </div>
      <div className="w-review-rows">
        {entries.map((e) => {
          const t = titleOf(e.first);
          const unsure = e.rows.filter((r) => r.redactor_least_sure).length;
          const holds = e.rows.filter((r) => r.held_by_the_redactor);
          const delayed = e.rows.find((r) => r.delayed_until);
          const b = crossingOf(e.first);
          const waitingParts = e.rows.filter((r) => r.part !== null).length;
          const tone = holds.length > 0 ? "bad" : unsure > 0 ? "warn" : delayed ? "info" : null;
          return (
            <Link
              key={e.id}
              className="w-review-row"
              href={href(party, kind, e.id)}
              aria-current={e.id === selected ? "true" : undefined}
              scroll={false}
            >
              <span className="w-review-row-t">
                <span className={t.serif ? "w-review-row-node" : t.faint ? "w-review-row-sans w-faint" : "w-review-row-sans"}>{t.text}</span>
                {tone && (tone === "info" ? <span className="w-dot w-review-info" title="Delayed" /> : <Dot tone={tone} title={tone === "bad" ? "The Redactor holds a part" : "The Redactor was least sure of a part"} />)}
              </span>
              <span className="w-review-row-m">
                <Boundary from={b.from} to={b.to} />
                <span>{KIND_ONE[e.first.kind_of_thing] ?? capital(e.first.kind_of_thing.replace(/_/g, " "))}</span>
              </span>
              <span className="w-review-row-m">
                <span title={waitingParts < e.rows.length ? "Counting the item itself, with what is always shown of it" : undefined}>{plural(e.rows.length, "part")}</span>
                {unsure > 0 && <span className="w-review-flag w-warn">{unsure} least sure</span>}
                {holds.length > 0 && (
                  <span className="w-review-flag w-bad" title={holds.map((h) => h.held_by_the_redactor!.reason).join("; ")}>
                    Redactor holds {holds.length}
                  </span>
                )}
                {delayed && <span className="w-review-flag w-info">Delayed to {shortWhen(delayed.delayed_until)}</span>}
                <span className="w-age w-spacer">{age(e.first.waiting_since)}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Document({ entry, party }: { entry: Entry; party: { id: string; name: string } }) {
  const first = entry.first;
  const t = titleOf(first);
  const header = headerOf(first.always_shown);
  const verdict = verdictPill(header.verdict);
  const v = header.verdict ?? {};
  const confidence = figure(v.confidence);
  const credence = figure(v.credence);
  const sources = (header.sources ?? []).length;
  const removals = totalRemovals(header.removals);
  const audit = auditPill(first.audit);
  const unread = entry.rows.find((r) => r.shown_as_released)?.shown_as_released;
  const isPage = first.kind_of_thing === "page";

  return (
    <>
      <div className="w-review-doc-k">
        <span>{KIND_ONE[first.kind_of_thing] ?? capital(first.kind_of_thing.replace(/_/g, " "))}</span>
        {first.waiting_since && (
          <>
            <span>·</span>
            <span title={`Its redaction was checked on ${shortWhen(first.waiting_since)}`}>waiting {age(first.waiting_since)}</span>
          </>
        )}
        {first.node && first.node_id && (
          <Link className="w-spacer" href={`/claims/${first.node_id}`}>
            Open on the node
          </Link>
        )}
      </div>
      <h2 className={t.serif ? "w-review-doc-t" : t.faint ? "w-review-doc-t w-sans w-faint" : "w-review-doc-t w-sans"}>{t.text}</h2>
      <div className="w-review-facts">
        {verdict && (
          <Pill tone={verdict.tone} title={verdict.title}>
            {verdict.text}
          </Pill>
        )}
        {confidence && <span>confidence {confidence}</span>}
        {credence && (
          <>
            <span className="w-faint">·</span>
            <span>credence {credence}</span>
          </>
        )}
        {header.sources && (
          <>
            {(verdict || confidence) && <span className="w-faint">·</span>}
            <span>{plural(sources, "source")}</span>
          </>
        )}
        {header.removals && (
          <>
            <span className="w-faint">·</span>
            <span>{plural(removals, "removal")}</span>
          </>
        )}
      </div>
      <div className="w-review-facts">
        <Pill tone={audit.tone} title={audit.title}>
          {audit.text}
        </Pill>
        <Tip>Audit checks the Redactor&apos;s work: that what it removed follows the policy and that the reasoning left still supports the verdict.</Tip>
      </div>
      {unread && <div className="w-review-unread">{unread}</div>}

      {entry.rows.map((row) => {
        const key = `${row.item_id}:${row.part ?? "page"}`;
        const others = row.rests_on.filter((r) => r.party.id !== party.id);
        const mine = row.held?.find((h) => h.party.id === party.id);
        const proposes = row.the_redactor_proposes;
        const cls = ["w-review-part", row.redactor_least_sure && "w-unsure"].filter(Boolean).join(" ");
        return (
          <div className={cls} key={key}>
            <div className="w-review-part-h">
              <input type="checkbox" name="item" value={key} id={`tick-${key}`} />
              <label htmlFor={`tick-${key}`}>
                {row.part === null ? (
                  <>
                    <b>{isPage ? "Page" : "Item"}</b>
                    <span>· {isPage ? "verdict and always-shown facts" : "what is always shown of it"}</span>
                  </>
                ) : (
                  <>
                    <b>Part {row.part}</b>
                    <span>· {capital(row.kind)}</span>
                  </>
                )}
              </label>
              {row.part === null && (
                <Tip>
                  {`Releasing this releases what is shown whenever the ${isPage ? "page" : "item"} is shown${isPage ? ": its verdict" : ""}. Holding it holds the whole item, whatever is decided about its parts.`}
                </Tip>
              )}
              <span className="w-spacer w-row" style={{ gap: 6 }}>
                {row.redactor_least_sure && <Pill tone="warn">Least sure</Pill>}
                {mine && (
                  <Pill tone="bad" title={mine.since ? `Since ${shortWhen(mine.since)}` : undefined}>
                    Held for {mine.party.name}
                    {mine.reason ? `: ${mine.reason}` : ""}
                  </Pill>
                )}
                {row.held_by_the_redactor ? (
                  <Pill tone="bad" title={`Since ${shortWhen(row.held_by_the_redactor.since)}`}>
                    Redactor: hold · {row.held_by_the_redactor.reason}
                  </Pill>
                ) : row.delayed_until ? (
                  <Pill tone="info">Redactor: delay to {shortWhen(row.delayed_until)}</Pill>
                ) : (
                  <Pill tone={proposes === "let through" ? "neu" : proposes === "hold" ? "bad" : "info"}>Redactor: {proposes}</Pill>
                )}
              </span>
            </div>
            {row.part === null ? (
              <details className="w-review-part-n">
                <summary>Everything always shown, as recorded</summary>
                <pre className="w-code">{JSON.stringify(row.always_shown ?? {}, null, 2)}</pre>
              </details>
            ) : (
              <div className="w-review-part-b">
                <Shown item={row} />
              </div>
            )}
            {(row.removals ?? [])
              .filter((r) => r.redactor_note)
              .map((r, i) => (
                <div className="w-review-part-n" key={`n${i}`}>
                  Redactor&apos;s note on &ldquo;{r.passage}&rdquo; ({r.category}): {r.redactor_note}
                </div>
              ))}
            {(row.why_least_sure ?? []).map((why, i) => (
              <div className="w-review-part-n w-warn" key={`w${i}`}>
                <Icon name="warn" size={13} />
                Least sure: {why}
              </div>
            ))}
            {row.redactor_least_sure && (row.why_least_sure ?? []).length === 0 && (
              <div className="w-review-part-n w-warn">
                <Icon name="warn" size={13} />
                Least sure. Why is written at the label the page was written at.
              </div>
            )}
            {others.length > 0 && (
              <div className="w-review-part-n">
                Also rests on
                {others.map((o, i) => (
                  <span key={o.party.id} className="w-row" style={{ gap: 4 }}>
                    <Party name={o.party.name} />
                    <span className={o.standing === "released" ? "w-ok-ink" : o.standing === "held" ? "w-bad-ink" : undefined}>{STANDING[o.standing]}</span>
                    {i < others.length - 1 && <span className="w-faint">·</span>}
                  </span>
                ))}
                <span className="w-faint">· shown once every party releases</span>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function Context({
  entry,
  party,
  showing,
}: {
  entry: Entry;
  party: { id: string; name: string };
  showing: ShownShowing | null;
}) {
  const first = entry.first;
  const boundary = crossingOf(first);
  const header = headerOf(first.always_shown);
  const setting = first.decide_for.find((p) => p.id === party.id)?.setting;

  // Where each party the item rests on stands, over all of its parts here.
  const standings = new Map<string, { name: string; held: number; waiting: number; released: number }>();
  for (const r of entry.rows) {
    for (const s of r.rests_on) {
      const e = standings.get(s.party.id) ?? { name: s.party.name, held: 0, waiting: 0, released: 0 };
      e[s.standing === "held" ? "held" : s.standing === "waiting" ? "waiting" : "released"] += 1;
      standings.set(s.party.id, e);
    }
  }
  const removals: Record<string, number> = header.removals ?? {};
  if (!header.removals) {
    for (const r of entry.rows) for (const [c, n] of Object.entries(r.removals_by_category ?? {})) removals[c] = (removals[c] ?? 0) + n;
  }
  const place = (r: QueueItem) => (r.part === null ? "The item" : `Part ${r.part}`);
  const holds = entry.rows.filter((r) => r.held_by_the_redactor || r.delayed_until || (r.held ?? []).length > 0);
  const acts = (showing?.acts ?? []).filter((a) => a.page_id === first.page_id);

  return (
    <aside className="w-review-ctx" aria-label="Context">
      <div className="w-review-ctx-s">
        <h3>Showing</h3>
        <Link href={`/showings/${first.showing_id}`} style={{ fontWeight: 500 }}>
          {showing ? `Shown to ${showing.shown_to}` : "The showing it belongs to"}
        </Link>
        {showing && (
          <div className="w-small w-muted" style={{ marginTop: 3 }}>
            {showing.form} · asked{showing.asked_by ? ` by ${showing.asked_by}` : ""} · {shortDay(showing.asked_at)}
          </div>
        )}
      </div>
      <div className="w-review-ctx-s">
        <h3>Boundary</h3>
        <div className="w-review-ctx-r">
          <Link href={`/gates/${first.gate_id}`}>
            <Boundary from={boundary.from} to={boundary.to} />
          </Link>
        </div>
        {setting && (
          <div className="w-review-ctx-r">
            <span className="w-muted">Gate</span>
            <span className="w-spacer">{SETTING_WORDS[setting] ?? setting}</span>
          </div>
        )}
        {first.policy && (
          <div className="w-review-ctx-r">
            <span className="w-muted">Policy</span>
            <span className="w-spacer">
              v{first.policy.version} · <span className="w-mono w-faint" title={first.policy.hash}>{first.policy.hash.slice(0, 6)}</span>
            </span>
          </div>
        )}
        {first.waiting_since && (
          <div className="w-review-ctx-r">
            <span className="w-muted">Checked</span>
            <span className="w-spacer">{shortWhen(first.waiting_since)}</span>
          </div>
        )}
      </div>
      <div className="w-review-ctx-s">
        <h3>Rests on</h3>
        {[...standings.entries()].map(([id, s]) => (
          <div className="w-review-ctx-r" key={id}>
            <Party name={s.name} />
            <span className="w-spacer">
              {id === party.id ? (
                <Pill tone="info">waits on you</Pill>
              ) : s.held > 0 ? (
                <Pill tone="bad">holding</Pill>
              ) : s.waiting > 0 ? (
                <Pill tone="neu">not decided</Pill>
              ) : (
                <Pill tone="ok">released</Pill>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="w-review-ctx-s">
        <h3>Removals</h3>
        {Object.keys(removals).length === 0 ? (
          <span className="w-small w-muted">Nothing removed</span>
        ) : (
          Object.entries(removals).map(([c, n]) => (
            <div className="w-review-ctx-r" key={c}>
              <span>{c}</span>
              <span className="w-spacer w-num">{n}</span>
            </div>
          ))
        )}
      </div>
      {holds.length > 0 && (
        <div className="w-review-ctx-s">
          <h3>Holds and delays</h3>
          {holds.map((r) => (
            <div key={`${r.part}`} className="w-small" style={{ padding: "3px 0" }}>
              <b style={{ fontWeight: 500 }}>{place(r)}</b>
              {r.held_by_the_redactor && (
                <div className="w-muted">
                  Held by the Redactor · {r.held_by_the_redactor.reason} · {shortDay(r.held_by_the_redactor.since)}
                </div>
              )}
              {r.delayed_until && <div className="w-muted">Delayed to {shortWhen(r.delayed_until)}</div>}
              {(r.held ?? []).map((h) => (
                <div className="w-muted" key={h.party.id}>
                  Held for {h.party.name}
                  {h.reason ? ` · ${h.reason}` : ""}
                  {h.since ? ` · ${shortDay(h.since)}` : ""}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {acts.length > 0 && (
        <div className="w-review-ctx-s">
          <h3>History</h3>
          {acts.slice(-6).map((a, i) => (
            <div className="w-line" key={i}>
              <time dateTime={a.at}>{shortDay(a.at)}</time>
              <span>
                {capital(a.by)} {a.what}
                {a.on ? ` ${a.on}` : ""}
                {a.for_party ? ` for ${a.for_party}` : ""}
                {a.reason ? `: ${a.reason}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function Rules({ queue }: { queue: { acts: Record<string, string>; note: string; not_reading_the_label?: string } }) {
  return (
    <details className="w-review-rules">
      <summary>What you can do here, and what nobody can</summary>
      <ul>
        {Object.entries(queue.acts).map(([act, words]) => (
          <li key={act}>
            <b>{capital(act)}.</b> {words}
          </li>
        ))}
        <li>
          <b>No text is edited.</b> Each part is hashed as it stands, and the people it is shown to check what they read against that hash.
          A passage can be removed and marked, and a part can be held; no word can be changed.
        </li>
        <li>
          <b>A release is not taken back.</b> Once a part is shown, people have read it. A hold or a delay can be lifted later; a release
          cannot be undone.
        </li>
        <li>
          <b>A hold gives a reason from a fixed list.</b> It is all the other side is told, beside who holds the part and since when. Nobody
          checks it.
        </li>
        <li>
          <b>The other side sees how much waits.</b> Not what it says: how many items, of what kinds, for how long, and whether on the
          Redactor or on a person. How each gate is set is on <Link href="/gates">Boundaries</Link>.
        </li>
      </ul>
      {queue.not_reading_the_label && <p className="w-help">{queue.not_reading_the_label}</p>}
      <p className="w-help">{queue.note}</p>
    </details>
  );
}
