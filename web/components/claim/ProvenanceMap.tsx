"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProvenanceStory, StoryNode } from "@/lib/types";
import {
  DIVERGENT, edgeLabel, layoutFocus, layoutStory, storyCounts, upstreamOf,
  type CardItem, type Item, type ItemEdge,
} from "@/lib/provenance-layout";
import styles from "./provenanceMap.module.css";

// The claim's provenance, origins first (#507): every card a source, read top
// to bottom as the claim's story. Confirmed origins head it; untraced sources
// sit in their own lane so a source nobody followed upstream never passes for
// a beginning. Two layers show; deeper ones fold into counts that open in
// place. Clicking a card recentres on it, its lineage above and what draws
// on it below, as on the claim map. Divergence is the one flag; nothing here
// is a score.

const fidOf = (e: ItemEdge | null): string =>
  !e ? "plain" : e.relation === "responds_to" && e.fidelity === "faithful" ? "response" : e.fidelity;

const typeLabel = (t: string) => (t && t !== "unknown" ? t.replace(/_/g, " ") : "");

function divergentEdge(n: StoryNode, own: ItemEdge | null): ItemEdge | null {
  if (!n.diverges) return null;
  if (own && DIVERGENT.has(own.fidelity)) return own;
  for (const e of upstreamOf(n).values()) if (DIVERGENT.has(e.fidelity)) return e;
  return null;
}

function standingLine(n: StoryNode): { text: string; kind: "origin" | "untraced" } | null {
  if (n.standing === "origin") {
    return { kind: "origin", text: n.basis === "steward" ? "Origin · recorded by the Steward" : "Origin · primary source" };
  }
  if (n.standing === "untraced") {
    return { kind: "untraced", text: n.basis === "steward" ? "Untraced · recorded by the Steward" : "Untraced · nothing upstream recorded" };
  }
  return null;
}

function OriginIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.6 8.1l1.7 1.6 3.2-3.3" />
    </svg>
  );
}
function UntracedIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2 2.2" />
    </svg>
  );
}

interface Handlers {
  /** Null when the story is one source: there is nothing to centre on. */
  recentre: ((id: string) => void) | null;
  toggle: (key: string) => void;
}

function Card({ item, h, focus = false, edgeInside = false }: { item: CardItem; h: Handlers; focus?: boolean; edgeInside?: boolean }) {
  const n = item.members[0];
  const stack = item.members.length > 1;
  const tier = focus ? "focus" : item.level === 0 ? "t0" : item.level === 1 ? "t1" : "t2";
  const top = n.depth === 0 && !stack;
  const standing = top ? standingLine(n) : null;
  const div = stack ? (item.edge && DIVERGENT.has(item.edge.fidelity) ? item.edge : null) : divergentEdge(n, item.edge);
  const types = new Set(item.members.map((m) => typeLabel(m.source.source_type)));
  const type = types.size === 1 ? [...types][0] : "";

  const head = stack
    ? `${item.members.length} sources`
    : n.underlying ? "Underlying" : div ? "Diverges" : "";
  const eyebrow = [focus ? "Centre" : "", head, type].filter(Boolean).join(" · ");

  const facts: string[] = [];
  if (!stack && n.underlying) facts.push("does not state the claim");
  if (!stack && n.downstream_total > 0) facts.push(`${n.downstream_total} downstream`);
  if (!stack && n.copies > 0) facts.push(`${n.copies} ${n.copies === 1 ? "copy" : "copies"}`);

  const cls = [
    styles.card, styles[tier],
    top && n.standing === "origin" ? styles.origin : "",
    top && n.standing !== "origin" ? styles.untracedCard : "",
    n.underlying && !stack ? styles.underlying : "",
    stack ? styles.stack : "",
    div ? styles.divergent : "",
  ].filter(Boolean).join(" ");

  const showEdgeInside = (tier === "t2" || edgeInside) && item.edge;

  return (
    <div className={cls}>
      {!focus && (stack || h.recentre) && (
        <button
          type="button"
          className={styles.hit}
          onClick={() => (stack ? h.toggle(item.key) : h.recentre?.(n.source.id))}
          aria-label={stack ? `List the ${item.members.length} sources` : `Centre the map on ${n.source.title}`}
        />
      )}
      <div className={styles.cardBody}>
        {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
        <Link href={`/sources/${encodeURIComponent(n.source.id)}`} className={styles.title}>
          {n.source.title}
        </Link>
        {stack && (
          <span className={styles.line}>and {item.members.length - 1} more like it</span>
        )}
        {showEdgeInside && (
          <span className={styles.line} data-fid={fidOf(item.edge)}>
            {edgeLabel(item.edge!)}
          </span>
        )}
        {facts.length > 0 && tier !== "t2" && <span className={styles.line}>{facts.join(" · ")}</span>}
        {standing && (
          <span className={styles.standing} data-kind={standing.kind}>
            {standing.kind === "origin" ? <OriginIcon /> : <UntracedIcon />} {standing.text}
          </span>
        )}
        {standing && n.root?.basis && tier !== "t2" && <span className={styles.note}>{n.root.basis}</span>}
        {div && tier !== "t2" && !stack && (
          <span className={styles.diverges}>Diverges · {div.fidelity}</span>
        )}
        {item.also.length > 0 && tier !== "t2" && (
          <span className={styles.line}>
            Also draws on {item.also.length === 1 ? item.also[0].source.title : `${item.also.length} other sources`}
          </span>
        )}
        {focus && (
          <span className={styles.focusLinks}>
            <Link href={`/sources/${encodeURIComponent(n.source.id)}`}>Source page →</Link>
            {n.source.url && <a href={n.source.url}>Original ↗&#xFE0E;</a>}
          </span>
        )}
      </div>
    </div>
  );
}

function Fold({ item, h }: { item: Extract<Item, { kind: "fold" }>; h: Handlers }) {
  const shown = Math.min(item.count, 60);
  const squares = Array.from({ length: shown }, (_, i) => i < Math.min(item.diverging, shown));
  return (
    <button type="button" className={styles.fold} onClick={() => h.toggle(item.key)}>
      <span className={styles.foldCaption}>+{item.count} further {item.noun}</span>
      <span className={styles.squares} aria-hidden="true">
        {squares.map((d, i) => <i key={i} data-div={d ? "1" : undefined} />)}
      </span>
      {item.diverging > 0 && <span className={styles.foldNote}>{item.diverging} diverging</span>}
    </button>
  );
}

function More({ item, h }: { item: Extract<Item, { kind: "more" }>; h: Handlers }) {
  return (
    <button type="button" className={styles.more} onClick={() => h.toggle(item.key)}>
      +{item.count} more
    </button>
  );
}

function Node({ item, h }: { item: Item; h: Handlers }) {
  if (item.kind === "fold") return <Fold item={item} h={h} />;
  if (item.kind === "more") return <More item={item} h={h} />;
  return <Card item={item} h={h} />;
}

/** A card and everything hung beneath it: a fanned row under a top card, a column under the rest. */
function Subtree({ item, h, focus = false }: { item: CardItem; h: Handlers; focus?: boolean }) {
  const top = item.level === 0;
  return (
    <div className={top ? styles.tree : styles.branchTree}>
      <Card item={item} h={h} focus={focus} />
      {item.children.length > 0 && (top ? <Row items={item.children} h={h} /> : <Column items={item.children} h={h} />)}
    </div>
  );
}

/** The first layer: fanned across, each card on its own drop coloured by fidelity. */
function Row({ items, h }: { items: Item[]; h: Handlers }) {
  const cards = items.filter((k): k is CardItem => k.kind === "card");
  const rest = items.filter((k) => k.kind !== "card");
  return (
    <>
      {cards.length > 0 && (
        <>
          <div className={styles.stem} />
          <ul className={styles.row}>
            {cards.map((k) => (
              <li key={k.key} className={styles.branch}>
                <span className={styles.drop} data-fid={fidOf(k.edge)} />
                {k.edge && <span className={styles.dropLabel} data-fid={fidOf(k.edge)}>{edgeLabel(k.edge)}</span>}
                <Subtree item={k} h={h} />
              </li>
            ))}
          </ul>
        </>
      )}
      {rest.map((k) => <div key={k.key} className={styles.rowRest}><Node item={k} h={h} /></div>)}
    </>
  );
}

/** Deeper layers: a column under the card, indented a step per layer, so width never runs away. */
function Column({ items, h }: { items: Item[]; h: Handlers }) {
  return (
    <ul className={styles.column}>
      {items.map((k) => (
        <li key={k.key} className={styles.colItem}>
          <span className={styles.tick} data-fid={fidOf(k.kind === "card" ? k.edge : null)} />
          {k.kind === "card" ? <Subtree item={k} h={h} /> : <Node item={k} h={h} />}
        </li>
      ))}
    </ul>
  );
}

function Lane({ label, items, h, kind }: { label: string; items: Item[]; h: Handlers; kind: string }) {
  if (!items.length) return null;
  const count = items.reduce((s, i) => s + (i.kind === "card" ? i.members.length : i.kind === "more" ? i.count : 0), 0);
  return (
    <section className={styles.lane} data-lane={kind} aria-label={label}>
      <h3 className={styles.laneHead}><span className={styles.laneCount}>{count}</span> {label}</h3>
      <div className={styles.laneTrees}>
        {items.map((i) => (i.kind === "card" ? <Subtree key={i.key} item={i} h={h} /> : <Node key={i.key} item={i} h={h} />))}
      </div>
    </section>
  );
}

function FocusView({ story, focusId, open, slots, h }: {
  story: ProvenanceStory; focusId: string; open: ReadonlySet<string>; slots: number; h: Handlers;
}) {
  const layout = useMemo(() => layoutFocus(story, focusId, open, slots), [story, focusId, open, slots]);
  if (!layout) return null;
  const { focus, upstream, upMore } = layout;
  const f = focus.members[0];
  const single = upstream.length === 1 && !upMore ? upstream[0].card.edge : null;
  return (
    <div className={styles.focusView}>
      {upstream.length > 0 ? (
        <>
          <div className={styles.upHead}>
            <h3 className={styles.sectionHead}>Upstream</h3>
            {upMore > 0 && <More item={{ kind: "more", key: "more:up", count: upMore }} h={h} />}
          </div>
          <ul className={styles.row}>
            {upstream.map((u) => (
              <li key={u.card.key} className={`${styles.branch} ${styles.up} ${single ? styles.upSingle : ""}`}>
                <div className={styles.upTree}>
                  {u.further > 0 && <span className={styles.further}>+{u.further} further upstream</span>}
                  {u.parents.length > 0 && (
                    <>
                      <ul className={styles.upColumn}>
                        {u.parents.map((p) => (
                          <li key={p.key}><Card item={p} h={h} /></li>
                        ))}
                      </ul>
                      <div className={styles.stemIn} />
                    </>
                  )}
                  <Card item={u.card} h={h} edgeInside={!single} />
                </div>
                {!single && <span className={styles.drop} data-fid={fidOf(u.card.edge)} />}
              </li>
            ))}
          </ul>
          <div className={`${styles.stemIn} ${styles.stemFocus}`} data-fid={fidOf(single)}>
            {single && <span className={styles.dropLabel} data-fid={fidOf(single)}>{edgeLabel(single)}</span>}
          </div>
        </>
      ) : (
        <div className={styles.plinth} data-kind={f.standing === "origin" ? "origin" : "untraced"}>
          {f.standing === "origin" ? "Origin" : f.standing === "untraced" ? "Untraced" : "Unanchored"}
        </div>
      )}
      <div className={styles.tree}>
        <Card item={focus} h={h} focus />
        {focus.children.length > 0 ? (
          <>
            <div className={styles.headRail}><h3 className={styles.sectionHead}>Downstream</h3></div>
            <Row items={focus.children} h={h} />
          </>
        ) : (
          <p className={styles.none}>No downstream recorded</p>
        )}
      </div>
    </div>
  );
}

function Legend({ story }: { story: ProvenanceStory }) {
  const fids = new Set<string>();
  for (const n of story.nodes) for (const e of upstreamOf(n).values()) fids.add(fidOf(e));
  const order = ["faithful", "strengthened", "weakened", "distorted", "misattributed", "unclear", "response"];
  const names: Record<string, string> = { response: "responds to" };
  const hasUntraced = story.nodes.some((n) => n.standing === "untraced");
  const hasUnderlying = story.nodes.some((n) => n.underlying);
  return (
    <div className={styles.legend}>
      {order.filter((f) => fids.has(f)).map((f) => (
        <span key={f} className={styles.legendItem}>
          <i className={styles.legendEdge} data-fid={f} />{names[f] ?? f}
        </span>
      ))}
      <span className={styles.legendRule} />
      <span className={styles.legendItem}><i className={`${styles.legendBox} ${styles.origin}`} />origin</span>
      {hasUnderlying && <span className={styles.legendItem}><i className={`${styles.legendBox} ${styles.origin} ${styles.underlying}`} />underlying</span>}
      {hasUntraced && <span className={styles.legendItem}><i className={`${styles.legendBox} ${styles.untracedCard}`} />untraced</span>}
    </div>
  );
}

export function ProvenanceMap({ story }: { story: ProvenanceStory | null | undefined }) {
  const [trail, setTrail] = useState<string[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [slots, setSlots] = useState(3);
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  // How many first-layer cards fit across: read from the stylesheet's own
  // card width, so the layout and the CSS can never disagree.
  useEffect(() => {
    const el = viewport.current, map = ref.current;
    if (!el || !map) return;
    const measure = () => {
      const cs = getComputedStyle(map);
      const w = parseFloat(cs.getPropertyValue("--w1")) || 224;
      const g = parseFloat(cs.getPropertyValue("--gap1")) || 22;
      setSlots(Math.max(1, Math.floor((el.clientWidth + g) / (w + g))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const focusId = trail.length ? trail[trail.length - 1] : null;
  const byId = useMemo(() => new Map((story?.nodes ?? []).map((n) => [n.source.id, n])), [story]);

  const keepInView = () => {
    const el = ref.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const recentre = useCallback((id: string) => {
    setTrail((t) => (t.includes(id) ? t.slice(0, t.indexOf(id) + 1) : [...t, id]));
    setOpen(new Set());
    keepInView();
  }, []);
  const toggle = useCallback((key: string) => {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const back = () => { setTrail([]); setOpen(new Set()); keepInView(); };
  const h: Handlers = { recentre: story && story.nodes.length > 1 ? recentre : null, toggle };

  const layout = useMemo(
    () => (story && !focusId ? layoutStory(story, open, slots) : null),
    [story, focusId, open, slots],
  );
  if (!story || story.nodes.length === 0) return null;
  const c = storyCounts(story);
  const tally = [
    `${c.sources} ${c.sources === 1 ? "source" : "sources"}`,
    c.origins ? `${c.origins} ${c.origins === 1 ? "origin" : "origins"}` : "no origin",
    c.untraced ? `${c.untraced} untraced` : "",
    c.underlying ? `${c.underlying} underlying` : "",
    c.diverging ? `${c.diverging} diverging` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className={styles.map} ref={ref}>
      <div className={styles.bar}>
        {focusId ? (
          <nav className={styles.trail} aria-label="Recentred path">
            <button type="button" className={styles.trailLink} onClick={back}>← Origins</button>
            {trail.map((id, i) => (
              <span key={id} className={styles.trailStep}>
                <span className={styles.trailSep}>/</span>
                {i === trail.length - 1 ? (
                  <span className={styles.trailHere}>{byId.get(id)?.source.title}</span>
                ) : (
                  <button type="button" className={styles.trailLink} onClick={() => recentre(id)}>
                    {byId.get(id)?.source.title}
                  </button>
                )}
              </span>
            ))}
          </nav>
        ) : (
          <span className={styles.tally}>{tally}</span>
        )}
        {open.size > 0 && (
          <button type="button" className={styles.collapse} onClick={() => setOpen(new Set())}>
            Collapse
          </button>
        )}
      </div>
      <div className={styles.viewport} ref={viewport}>
        {focusId ? (
          <FocusView story={story} focusId={focusId} open={open} slots={slots} h={h} />
        ) : layout && (
          <div className={styles.lanes}>
            <Lane label="Origins" kind="origin" items={layout.origins} h={h} />
            <Lane label="Untraced" kind="untraced" items={layout.untraced} h={h} />
            <Lane label="Unanchored" kind="unanchored" items={layout.unanchored} h={h} />
          </div>
        )}
      </div>
      {story.nodes.length > 1 && <Legend story={story} />}
    </div>
  );
}
