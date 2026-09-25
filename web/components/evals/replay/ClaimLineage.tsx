"use client";

import { credenceSeries, touchedClaimIds, type InterimGraph, type Replay, type ReplayArm } from "@/lib/replay-core";
import { nodeStatusMeta } from "@/lib/ontology";
import { Swatch } from "@/components/Assessment";
import { CredenceSpark } from "./TargetPin";
import { agentClass, agentMeta, describeDelta, fmtTime, stepGist, triggerPhrase } from "./vocab";
import type { Nav } from "./hash";
import s from "./replay.module.css";

// Level (e): one claim's lineage in one arm. Which source said it and in what
// words, the Extractor's proposed form, the Matcher's decision and the search
// results it saw, the Steward's edges and assessments, every event that
// touched it, and its credence over the arm. Across arms, its counterpart.

export function ClaimLineage({
  replay, arm, claimId, graph, nav, index,
}: {
  replay: Replay;
  arm: ReplayArm;
  claimId: string;
  /** The FINAL interim graph of the arm, for texts and edges. */
  graph: InterimGraph;
  nav: Nav;
  /** The playhead, so the reader can see which touches are still ahead. */
  index: number;
}) {
  const c = graph.byId[claimId];
  const text = (id: string) => graph.byId[id]?.text ?? null;
  if (!c) return <p className={s.dim}>No claim {claimId} in {arm.label}.</p>;
  const meta = nodeStatusMeta(c.status);
  const touches = arm.events.map((e, i) => ({ e, i })).filter(({ e }) => touchedClaimIds(e).includes(claimId));
  const created = arm.events.flatMap((e, i) => e.deltas.flatMap((d) => (d.op === "claim_created" && d.claimId === claimId ? [{ d, e, i }] : [])))[0];
  const instances = arm.events.flatMap((e, i) => e.deltas.flatMap((d) => ((d.op === "claim_matched" || d.op === "instance_added") && d.claimId === claimId ? [{ d, e, i }] : [])));
  const matcherRuns = touches.filter(({ e }) => e.agent === "matcher");
  const edgesUp = graph.edges.filter((e) => e.childId === claimId);
  const edgesDown = graph.edges.filter((e) => e.parentId === claimId);
  const series = credenceSeries(arm, claimId);
  const src = (id: string | null | undefined) => (id ? arm.sources.find((x) => x.id === id)?.title ?? id : null);

  // The counterpart in the other arm, from the agreement matching.
  const pair = (replay.matching ?? []).flatMap((m) => {
    if (m.armA === arm.key) return m.pairs.filter((p) => p.a === claimId).map((p) => ({ arm: m.armB, id: p.b, method: p.method, similarity: p.similarity }));
    if (m.armB === arm.key) return m.pairs.filter((p) => p.b === claimId).map((p) => ({ arm: m.armA, id: p.a, method: p.method, similarity: p.similarity }));
    return [];
  })[0];
  const unmatched = (replay.matching ?? []).some((m) => (m.armA === arm.key && m.unmatchedA.includes(claimId)) || (m.armB === arm.key && m.unmatchedB.includes(claimId)));

  return (
    <div className={s.lineage}>
      <p className={s.lineageText}>{c.text}</p>
      <p className={s.nowMeta}>
        <Swatch status={c.status} /> {meta.label}
        {c.credence != null ? <> · credence {c.credence.toFixed(2)}</> : null}
        {c.confidence != null ? <> · verdict confidence {c.confidence.toFixed(2)}</> : null}
        {c.claimType ? <> · {c.claimType}</> : null}
        {c.importance != null ? <> · importance {c.importance.toFixed(2)}</> : null}
        {c.merged ? <> · <span className={s.flag}>merged into</span> <button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, c.merged!)}>{text(c.merged) ?? c.merged}</button></> : null}
        {" · "}<code>{claimId}</code>
      </p>

      {pair ? (
        <p className={s.nowMeta}>
          Paired with{" "}
          <button type="button" className={s.linklike} onClick={() => nav.openClaim(pair.arm, pair.id)}>
            {replay.arms.find((a) => a.key === pair.arm)?.label ?? pair.arm}: {graphTextAcross(replay, pair.arm, pair.id) ?? pair.id}
          </button>
          {" "}({pair.method}{pair.similarity != null ? `, ${pair.similarity.toFixed(2)}` : ""})
        </p>
      ) : unmatched ? <p className={`${s.nowMeta} ${s.flag}`}>The agreement metric found no counterpart in the other arm.</p> : null}

      <p className={`sc ${s.stepsLabel}`}>Where it came from</p>
      {created ? (
        <p className={s.deltaProse}>
          Created in <EventLink arm={arm} i={created.i} nav={nav} /> by the {agentMeta(created.d.createdBy ?? created.e.agent).label}
          {created.d.op === "claim_created" && created.d.sourceId ? <> from source {quoteSrc(src(created.d.sourceId))}</> : null}
          {created.d.op === "claim_created" && !created.d.topLevel ? " as a subclaim" : null}.
        </p>
      ) : <p className={s.dim}>Its creation is not in this recording (it predates the window).</p>}
      {instances.length > 0 ? (
        <ul className={s.deltaList}>
          {instances.map(({ d, i }, k) => (
            <li key={k}>
              <EventLink arm={arm} i={i} nav={nav} />: {d.op === "claim_matched" ? "matched" : "instance added"} from {quoteSrc(src(d.sourceId))}, stance <strong>{d.stance}</strong>
              {d.op === "claim_matched" && d.verbatim ? <span className={s.quote}>the source said: “{d.verbatim}”</span> : null}
              {d.op === "claim_matched" && d.proposed ? <span className={s.quote}>the Extractor proposed: “{d.proposed}”</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {matcherRuns.length > 0 ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>The Matcher&rsquo;s decisions</p>
          <ul className={s.deltaList}>
            {matcherRuns.map(({ e, i }) => (
              <li key={e.seq}>
                <EventLink arm={arm} i={i} nav={nav} /> {e.title}
                {e.steps.filter((st) => st.kind === "tool_result" || st.kind === "decision").map((st, k) => (
                  <span key={k} className={s.quote}>
                    <button type="button" className={s.linklike} onClick={() => nav.openStep(arm.key, e.seq, e.steps.indexOf(st))}>{st.kind === "decision" ? "decided" : `saw (${st.tool ?? "result"})`}</button>: {stepGist(st)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {(edgesUp.length > 0 || edgesDown.length > 0) ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>Structure</p>
          <ul className={s.deltaList}>
            {edgesUp.map((e) => <li key={e.id}><button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, e.parentId)}>{text(e.parentId) ?? e.parentId}</button> <span className={s.dim}>—{e.relation}→ this</span>{e.seq ? <> <EventLink arm={arm} i={arm.events.findIndex((x) => x.seq === e.seq)} nav={nav} /></> : null}</li>)}
            {edgesDown.map((e) => <li key={e.id}><span className={s.dim}>this —{e.relation}→</span> <button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, e.childId)}>{text(e.childId) ?? e.childId}</button>{e.seq ? <> <EventLink arm={arm} i={arm.events.findIndex((x) => x.seq === e.seq)} nav={nav} /></> : null}</li>)}
          </ul>
        </>
      ) : null}

      <p className={`sc ${s.stepsLabel}`}>Assessments{series.length ? <span className={s.dim}> · credence over the arm</span> : null}</p>
      {series.length > 0 ? (
        <>
          <CredenceSpark series={series} count={arm.events.length} index={index} width={240} height={40} />
          <ul className={s.deltaList}>
            {series.map((pt, k) => (
              <li key={k}>
                <Swatch status={pt.status} /> <EventLink arm={arm} i={pt.index} nav={nav} /> {pt.status}
                {pt.credence != null ? <>, credence {pt.credence.toFixed(2)}</> : null}, confidence {pt.confidence.toFixed(2)}
                {pt.trigger ? <span className={s.dim}> · after {triggerPhrase(pt.trigger)}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : <p className={s.dim}>Not assessed in this recording.</p>}

      <p className={`sc ${s.stepsLabel}`}>Every event that touched it <span className={s.dim}>· {touches.length}</span></p>
      <ol className={s.touchList}>
        {touches.map(({ e, i }) => (
          <li key={e.seq} className={i > index ? s.ahead : undefined}>
            <span className={`${s.agentDot} ${agentClass(e.agent)}`} aria-hidden />
            <EventLink arm={arm} i={i} nav={nav} /> <span className={s.dim}>{fmtTime(e.at)}</span> {e.title}
            {e.deltas.filter((d) => touchedClaimIds({ ...e, claimId: null, deltas: [d] }).includes(claimId)).map((d, k) => <span key={k} className={s.quote}>{describeDelta(d, text)}</span>)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function EventLink({ arm, i, nav }: { arm: ReplayArm; i: number; nav: Nav }) {
  const e = arm.events[i];
  if (!e) return null;
  return <button type="button" className={`${s.linklike} ${s.evLink}`} onClick={() => nav.goEvent(arm.key, i)}>#{e.seq} {agentMeta(e.agent).label}</button>;
}

function quoteSrc(t: string | null) {
  return t ? `“${t}”` : "an unknown source";
}

function graphTextAcross(replay: Replay, armKey: string, id: string): string | null {
  const arm = replay.arms.find((a) => a.key === armKey);
  return arm?.final.claims.find((c) => c.id === id)?.text ?? null;
}
