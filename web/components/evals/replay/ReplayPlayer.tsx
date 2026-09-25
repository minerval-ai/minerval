"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  REPLAY_VERSION,
  finalGraph,
  graphAt,
  isKnownVersion,
  isTraced,
  layoutGraph,
  lockedIndex,
  sourceOrderOfEvents,
  touchedClaimIds,
  type Replay,
  type ReplayArm,
} from "@/lib/replay-core";
import { ClaimLineage } from "./ClaimLineage";
import { ContributionStrip } from "./ContributionStrip";
import { Drawer, type Crumb } from "./Drawer";
import { EpisodeOverview } from "./EpisodeOverview";
import { GraphCanvas } from "./GraphCanvas";
import { NowPanel } from "./NowPanel";
import { PromptDrawer, StepDetail } from "./StepDetail";
import { TargetPin } from "./TargetPin";
import { TimelineStrip } from "./TimelineStrip";
import { Transport } from "./Transport";
import { buildHash, parseHash, type DrawerView, type Nav } from "./hash";
import { AGENTS, agentClass, agentMeta, fmtCost } from "./vocab";
import s from "./replay.module.css";

// The replay player (#334): plays one recorded eval episode back, event by
// event, rebuilding each arm's graph as the agents built it. Levels, each one
// click from the next: the episode (EpisodeOverview, in the drawer), the
// timeline and graph (this component), one event (NowPanel), one step
// verbatim (StepDetail, fetched from the detail file), one claim's lineage
// (ClaimLineage). The playhead, the drawer and the lock live in the URL hash.

export interface ReplayPlayerProps {
  replay: Replay;
  /** The stem the detail files are served under: /evals/replays/<name>/events/… */
  name?: string;
}

const BASE_MS = 1600;

export function ReplayPlayer({ replay, name }: ReplayPlayerProps) {
  const replayName = name ?? replay.name;
  const known = isKnownVersion(replay);
  const arms = known ? replay.arms : [];
  const multi = arms.length > 1;

  const [master, setMaster] = useState<string>(arms[0]?.key ?? "");
  const [index, setIndexRaw] = useState(0);
  const [lock, setLock] = useState<"index" | "source">("index");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<DrawerView | null>(null);
  const [hover, setHover] = useState<{ arm: string; id: string } | null>(null);
  const [selected, setSelected] = useState<{ arm: string; id: string } | null>(null);

  const masterArm = arms.find((a) => a.key === master) ?? arms[0] ?? null;
  const count = masterArm?.events.length ?? 0;
  const setIndex = useCallback((i: number) => setIndexRaw(Math.max(0, Math.min(Math.max(0, count - 1), i))), [count]);

  // The other arms follow the master by event index, or by same source.
  const indexOf = useCallback((arm: ReplayArm): number => {
    if (!masterArm || arm.key === masterArm.key) return Math.min(index, Math.max(0, arm.events.length - 1));
    if (lock === "source") return lockedIndex(masterArm, index, arm);
    return Math.min(index, Math.max(0, arm.events.length - 1));
  }, [index, lock, masterArm]);

  // Layouts from each arm's FINAL graph, once; interim graphs per playhead.
  const finals = useMemo(() => new Map(arms.map((a) => [a.key, finalGraph(a)])), [arms]);
  const layouts = useMemo(() => new Map(arms.map((a) => [a.key, layoutGraph(finals.get(a.key)!)])), [arms, finals]);
  const sourceOrders = useMemo(() => new Map(arms.map((a) => [a.key, sourceOrderOfEvents(a)])), [arms]);
  const interim = useMemo(() => new Map(arms.map((a) => {
    const i = indexOf(a);
    const seq = a.events[i]?.seq ?? -1;
    return [a.key, graphAt(a, seq)];
  })), [arms, indexOf]);

  // Agreement matching: pairs for hover, unmatched sets for flags.
  const pairs = useMemo(() => {
    const m = new Map<string, { arm: string; id: string }>();
    const un = new Map<string, Set<string>>();
    for (const x of replay.matching ?? []) {
      for (const p of x.pairs) {
        m.set(`${x.armA}:${p.a}`, { arm: x.armB, id: p.b });
        m.set(`${x.armB}:${p.b}`, { arm: x.armA, id: p.a });
      }
      un.set(x.armA, new Set([...(un.get(x.armA) ?? []), ...x.unmatchedA]));
      un.set(x.armB, new Set([...(un.get(x.armB) ?? []), ...x.unmatchedB]));
    }
    return { m, un };
  }, [replay.matching]);

  // ---- play ----
  useEffect(() => {
    if (!playing) return;
    if (index >= count - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setIndexRaw((i) => Math.min(count - 1, i + 1)), BASE_MS / speed);
    return () => clearTimeout(t);
  }, [playing, index, count, speed]);

  // ---- hash state ----
  const hydrated = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const h = parseHash(window.location.hash);
      if (h.arm && arms.some((a) => a.key === h.arm)) setMaster(h.arm);
      const arm = arms.find((a) => a.key === h.arm) ?? arms[0];
      if (h.seq != null && arm) {
        const i = arm.events.findIndex((e) => e.seq === h.seq);
        if (i >= 0) setIndexRaw(i);
      }
      if (h.lock) setLock(h.lock);
      setView(h.view);
    };
    if (!hydrated.current) {
      hydrated.current = true;
      apply();
    }
    // A link into another level of the same page (or the back button) is a
    // hash change, not a reload: follow it. replaceState below never fires this.
    const onHash = () => { setPlaying(false); apply(); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [arms]);
  useEffect(() => {
    if (!hydrated.current || typeof window === "undefined" || !masterArm) return;
    const hash = buildHash({ arm: masterArm.key, seq: masterArm.events[index]?.seq ?? null, lock, view });
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash || window.location.pathname + window.location.search);
  }, [masterArm, index, lock, view]);

  // ---- navigation ----
  const nav = useMemo<Nav>(() => ({
    goEvent(armKey, i) {
      const arm = arms.find((a) => a.key === armKey);
      if (!arm) return;
      setPlaying(false);
      if (masterArm && armKey !== masterArm.key) setMaster(armKey);
      setIndexRaw(Math.max(0, Math.min(arm.events.length - 1, i)));
      setView(null);
    },
    openStep(armKey, seq, step) { setPlaying(false); setView({ kind: "step", arm: armKey, seq, step }); },
    openClaim(armKey, claimId) { setPlaying(false); setSelected({ arm: armKey, id: claimId }); setView({ kind: "claim", arm: armKey, claimId }); },
    openPrompt(armKey, sha) { setPlaying(false); setView({ kind: "prompt", arm: armKey, sha }); },
    openEpisode() { setPlaying(false); setView({ kind: "episode" }); },
    close() { setView(null); },
  }), [arms, masterArm]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); setIndex(index + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); setIndex(index - 1); }
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
      else if (e.key === "End") { e.preventDefault(); setIndex(count - 1); }
      else if (e.key === "Escape") { setView(null); }
      else if ((e.key === "]" || e.key === "[") && view?.kind === "step") {
        const arm = arms.find((a) => a.key === view.arm);
        const ev = arm?.events.find((x) => x.seq === view.seq);
        if (!ev) return;
        const n = view.step + (e.key === "]" ? 1 : -1);
        if (n >= 0 && n < Math.max(ev.steps.length, 1)) setView({ ...view, step: n });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count, setIndex, view, arms]);

  if (!known) {
    return (
      <div className={s.refuse} role="alert">
        <p className="sc">Cannot play this recording</p>
        <p>It is schema version <code>{String((replay as { version?: unknown }).version)}</code>; this player knows version <code>{REPLAY_VERSION}</code>. Re-export it with the current driver, or update the player.</p>
      </div>
    );
  }
  if (!masterArm) return <p className={s.dim}>This recording has no arms.</p>;

  const traced = isTraced(replay);
  const isContrib = replay.kind === "adversarial" || replay.kind === "contributions";
  const targetsByArm = new Map((replay.scenario?.targets ?? []).map((t) => [t.key, t]));
  const highlight = (armKey: string): Set<string> => {
    const set = new Set<string>();
    const h = hover ?? selected;
    if (!h) return set;
    if (h.arm === armKey) set.add(h.id);
    const p = pairs.m.get(`${h.arm}:${h.id}`);
    if (p && p.arm === armKey) set.add(p.id);
    return set;
  };
  const currentSeqLabel = masterArm.events[index] ? `#${masterArm.events[index]!.seq}` : "";

  // ---- drawer ----
  let drawer: { crumbs: Crumb[]; title: string; body: React.ReactNode } | null = null;
  if (view) {
    const episode: Crumb = { label: "Episode", onClick: view.kind === "episode" ? undefined : () => setView({ kind: "episode" }) };
    if (view.kind === "episode") {
      drawer = { crumbs: [episode], title: replay.title, body: <EpisodeOverview replay={replay} nav={nav} /> };
    } else {
      const arm = arms.find((a) => a.key === view.arm);
      if (!arm) {
        drawer = { crumbs: [episode], title: "Unknown arm", body: <p className={s.dim}>No arm “{view.arm}” in this recording.</p> };
      } else {
        const armCrumb: Crumb = { label: arm.label, onClick: () => nav.goEvent(arm.key, indexOf(arm)) };
        const finalG = finals.get(arm.key)!;
        const texts = (id: string) => finalG.byId[id]?.text ?? null;
        if (view.kind === "step") {
          const ei = arm.events.findIndex((e) => e.seq === view.seq);
          const ev = arm.events[ei];
          if (!ev) drawer = { crumbs: [episode, armCrumb], title: "Unknown event", body: <p className={s.dim}>No event #{view.seq}.</p> };
          else {
            drawer = {
              crumbs: [episode, armCrumb, { label: `Event #${ev.seq}`, onClick: () => nav.goEvent(arm.key, ei) }, { label: `Step ${view.step + 1}` }],
              title: ev.title,
              body: <StepDetail replayName={replayName} arm={arm} event={ev} stepIndex={view.step} nav={nav} texts={texts} />,
            };
          }
        } else if (view.kind === "claim") {
          drawer = {
            crumbs: [episode, armCrumb, { label: "Claim" }],
            title: "Claim lineage",
            body: <ClaimLineage replay={replay} arm={arm} claimId={view.claimId} graph={finalG} nav={nav} index={indexOf(arm)} />,
          };
        } else if (view.kind === "prompt") {
          const p = arm.promptsUsed?.find((x) => x.sha256 === view.sha);
          const carrier = p ? (p.eventSeq != null ? arm.events.find((e) => e.seq === p.eventSeq) : null) ?? arm.events.find((e) => p.agents.includes(e.agent)) : null;
          drawer = {
            crumbs: [episode, armCrumb, { label: "Prompt" }],
            title: p ? `${p.agents.map((a) => agentMeta(a).label).join(", ")} system prompt` : "Prompt",
            body: p && carrier ? <PromptDrawer replayName={replayName} arm={arm} event={carrier} agent={p.agents[0] ?? carrier.agent} /> : <p className={s.dim}>No event in this arm carries that prompt.</p>,
          };
        }
      }
    }
  }

  const agentsPresent = [...new Set(arms.flatMap((a) => a.events.map((e) => e.agent)))];

  return (
    <div className={`${s.player}${drawer ? ` ${s.withDrawer}` : ""}`}>
      <div className={s.bar}>
        <button type="button" className={s.barBtn} onClick={nav.openEpisode} aria-pressed={view?.kind === "episode"}>Episode: commands, fingerprint, prompts</button>
        {multi ? (
          <span className={s.lockToggle} role="group" aria-label="Lockstep">
            <span className="sc">arms step by</span>
            <button type="button" className={`${s.speed}${lock === "index" ? ` ${s.speedOn}` : ""}`} onClick={() => setLock("index")} aria-pressed={lock === "index"}>event index</button>
            <button type="button" className={`${s.speed}${lock === "source" ? ` ${s.speedOn}` : ""}`} onClick={() => setLock("source")} aria-pressed={lock === "source"}>same source</button>
          </span>
        ) : null}
        {!traced ? <span className={s.flag}>Traced off: this run recorded no steps, only what changed. Set TRACE_LEVEL=full to record the agents&rsquo; work.</span> : null}
        <span className={s.keys}>← → step · space play · esc close</span>
      </div>

      <Transport index={index} count={count} playing={playing} speed={speed} onIndex={(i) => { setPlaying(false); setIndex(i); }} onPlaying={setPlaying} onSpeed={setSpeed} label={multi ? `${masterArm.label} leads` : currentSeqLabel} />

      {isContrib ? <ContributionStrip replay={replay} indexOf={indexOf} nav={nav} /> : null}

      <div className={`${s.arms} ${arms.length >= 3 ? s.arms3 : multi ? s.arms2 : ""}`}>
        {arms.map((arm) => {
          const i = indexOf(arm);
          const ev = arm.events[i];
          const g = interim.get(arm.key)!;
          const target = targetsByArm.get(arm.key);
          const isMaster = arm.key === masterArm.key;
          return (
            <section key={arm.key} className={`${s.arm}${isMaster && multi ? ` ${s.armLead}` : ""}`} aria-label={arm.label}>
              <header className={s.armHead}>
                {multi ? (
                  <button type="button" className={`${s.armName}${isMaster ? ` ${s.armNameOn}` : ""}`} onClick={() => { setMaster(arm.key); setIndexRaw(i); }} aria-pressed={isMaster} title="Lead with this arm">
                    {arm.label}
                  </button>
                ) : <span className={s.armName}>{arm.label}</span>}
                {arm.variation ? <span className={s.dim}>{arm.variation}</span> : null}
                <span className={s.armStat}>{g.claims.filter((c) => !c.merged).length} claims · {g.edges.length} edges · {fmtCost(arm.events.slice(0, i + 1).reduce((a, e) => a + (e.costMicroUsd ?? 0), 0))} so far</span>
              </header>
              {target?.claimId ? <TargetPin arm={arm} claimId={target.claimId} graph={g} index={i} nav={nav} direction={target.direction} /> : null}
              <TimelineStrip arm={arm} index={i} onIndex={(k) => nav.goEvent(arm.key, k)} sourceOrder={sourceOrders.get(arm.key)!} compact={multi} />
              <GraphCanvas
                arm={arm}
                layout={layouts.get(arm.key)!}
                graph={g}
                pulse={new Set(ev ? touchedClaimIds(ev) : [])}
                highlight={highlight(arm.key)}
                unmatched={pairs.un.get(arm.key) ?? new Set()}
                target={target?.claimId ?? null}
                selected={selected?.arm === arm.key ? selected.id : null}
                onHover={(id) => setHover(id ? { arm: arm.key, id } : null)}
                onSelect={(id) => nav.openClaim(arm.key, id)}
              />
              {!isMaster && ev ? (
                <p className={s.armNow}>
                  <span className={`${s.agentBadge} ${agentClass(ev.agent)}`}>{agentMeta(ev.agent).label}</span> #{ev.seq} {ev.title}
                </p>
              ) : null}
            </section>
          );
        })}
      </div>

      {replay.matching?.length ? (
        <p className={s.matchLine}>
          {replay.matching.map((m) => (
            <span key={`${m.armA}${m.armB}`}>
              Agreement {m.armA} ↔ {m.armB}: {m.pairs.length} claims paired, {m.unmatchedA.length + m.unmatchedB.length} unpaired
              {m.summary?.claimSetF1 != null ? <> · claim-set F1 {m.summary.claimSetF1.toFixed(2)}</> : null}
              {m.summary?.statusAgreement != null ? <> · status agreement {Math.round(m.summary.statusAgreement * 100)}%</> : null}
              {m.summary?.credenceMeanAbsDiff != null ? <> · mean credence gap {m.summary.credenceMeanAbsDiff.toFixed(2)}</> : null}
              {m.summary?.edgeEditDistance != null ? <> · edge edit distance {m.summary.edgeEditDistance}</> : null}
              <span className={s.dim}> · hover a claim to see its pair; “no pair” marks the rest</span>
            </span>
          ))}
        </p>
      ) : null}

      <NowPanel replayName={replayName} arm={masterArm} index={index} graph={interim.get(masterArm.key)!} nav={nav} />

      <details className={s.log}>
        <summary className="sc">Past events · {index}</summary>
        <ol className={s.logList}>
          {masterArm.events.slice(0, index).map((e, i) => (
            <li key={e.seq}>
              <button type="button" className={s.logRow} onClick={() => nav.goEvent(masterArm.key, i)}>
                <span className={`${s.agentDot} ${agentClass(e.agent)}`} aria-hidden />
                <span className={s.logSeq}>#{e.seq}</span>
                <span className={s.logTitle}>{e.title}</span>
                <span className={s.dim}>{fmtCost(e.costMicroUsd)}</span>
              </button>
            </li>
          ))}
        </ol>
      </details>

      <details className={s.legend}>
        <summary className="sc">Legend</summary>
        <div className={s.legendBody}>
          <p>
            {agentsPresent.map((a) => <span key={a} className={s.legendItem}><span className={`${s.agentDot} ${agentClass(a)}`} aria-hidden /> {agentMeta(a).label}{AGENTS[a]?.docs ? <a href={`/docs/agents/${AGENTS[a]!.docs}`}> ↗</a> : null}</span>)}
          </p>
          <p>
            {["verified", "supported", "contested", "unsupported", "contradicted", "unknown"].map((st) => <span key={st} className={s.legendItem}><span className={`swatch st-${st}`} /> {st}</span>)}
            <span className={s.legendItem}><span className="swatch st-unassessed" /> unassessed (hatched: pending, not a verdict)</span>
            <span className={s.legendItem}><span className={s.legendMerged} /> merged away</span>
            <span className={s.legendItem}><span className={s.legendPulse} /> touched by the current event</span>
          </p>
          <p className={s.dim}>Edges: requires grey, supports green, contradicts red dashed, assumes amber dotted. Gists in lists are derived by the exporter; anything marked verbatim is the model&rsquo;s own text. Attribution “run-window” means a change was credited to a run by time and claim, not by a tool call that names it.</p>
        </div>
      </details>

      {drawer ? <Drawer crumbs={drawer.crumbs} title={drawer.title} onClose={nav.close}>{drawer.body}</Drawer> : null}
    </div>
  );
}
