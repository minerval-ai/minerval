"use client";

import { causeChain, causedIndexes, type InterimGraph, type ReplayArm, type ReplayEvent } from "@/lib/replay-core";
import { Swatch } from "@/components/Assessment";
import { agentClass, agentMeta, decisionLabel, describeDelta, fmtCost, fmtDuration, fmtTime, outcomeLabel, stepGist, stepKindLabel, triggerPhrase, typeLabel } from "./vocab";
import type { Nav } from "./hash";
import s from "./replay.module.css";

// Level (c): one event. Agent badge, title, trigger, cost, duration; the
// cause chain both ways; what it read and wrote; its steps as gists (each
// opens level (d), the verbatim step); its deltas in words with attribution.
// Review and arbitration deltas render in the claim timeline's vocabulary.

export function NowPanel({
  replayName, arm, index, graph, nav, past,
}: {
  replayName: string;
  arm: ReplayArm;
  index: number;
  graph: InterimGraph;
  nav: Nav;
  /** Rendered in the collapsed log rather than as the live panel: quieter. */
  past?: boolean;
}) {
  const e = arm.events[index];
  if (!e) return <p className={s.dim}>No events in this arm.</p>;
  const text = (id: string) => graph.byId[id]?.text ?? arm.final.claims.find((c) => c.id === id)?.text ?? null;
  const causes = causeChain(arm, index);
  const effects = causedIndexes(arm, e.seq);
  const meta = agentMeta(e.agent);
  const reads = e.dataFlow?.read ?? [];
  const wrote = e.dataFlow?.wrote?.length ? e.dataFlow.wrote : e.deltas;

  return (
    <div className={`${s.now}${past ? ` ${s.nowPast}` : ""}`} aria-live={past ? undefined : "polite"}>
      <div className={s.nowHead}>
        <span className={`${s.agentBadge} ${agentClass(e.agent)}`}>{meta.label}</span>
        <span className={s.nowSeq}>#{e.seq}</span>
        <span className={s.nowMeta}>
          {fmtTime(e.at)}
          {e.trigger ? <> · after {triggerPhrase(e.trigger)}</> : null}
          {e.costMicroUsd != null ? <> · {fmtCost(e.costMicroUsd)}</> : null}
          {e.durationMs != null ? <> · {fmtDuration(e.durationMs)}</> : null}
          {e.outcome && e.outcome !== "ok" ? <> · <span className={s.flag}>{e.outcome}</span></> : null}
        </span>
      </div>
      <p className={s.nowTitle}>
        {e.claimId ? (
          <button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, e.claimId!)} title="Open this claim's lineage">{e.title}</button>
        ) : e.title}
      </p>
      {e.error ? <p className={s.flag}>{e.error}</p> : null}

      {(causes.length > 0 || effects.length > 0) && (
        <p className={s.chain}>
          {causes.length > 0 ? (
            <>
              <span className={s.k}>caused by</span>{" "}
              {causes.map((ci, i) => (
                <span key={ci}>
                  {i > 0 ? " ← " : ""}
                  <button type="button" className={s.linklike} onClick={() => nav.goEvent(arm.key, ci)}>
                    #{arm.events[ci]!.seq} {agentMeta(arm.events[ci]!.agent).label}
                  </button>
                </span>
              ))}
            </>
          ) : null}
          {effects.length > 0 ? (
            <>
              {causes.length > 0 ? <span className={s.dim}> · </span> : null}
              <span className={s.k}>led to</span>{" "}
              {effects.map((ei, i) => (
                <span key={ei}>
                  {i > 0 ? ", " : ""}
                  <button type="button" className={s.linklike} onClick={() => nav.goEvent(arm.key, ei)}>
                    #{arm.events[ei]!.seq} {agentMeta(arm.events[ei]!.agent).label}
                  </button>
                </span>
              ))}
            </>
          ) : null}
        </p>
      )}

      {reads.length > 0 ? (
        <p className={s.flow}>
          <span className={s.k}>read</span>{" "}
          {reads.map((r, i) => (
            <span key={i} className={s.flowItem}>
              <code>{r.tool}</code>
              {r.claimIds?.length ? <> → {r.claimIds.map((id, j) => <span key={id}>{j > 0 ? ", " : ""}<button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, id)}>{text(id) ? `“${text(id)!.slice(0, 40)}…”` : id}</button></span>)}</> : null}
              {r.sourceIds?.length ? <> → {r.sourceIds.map((id) => arm.sources.find((x) => x.id === id)?.title ?? id).join(", ")}</> : null}
            </span>
          ))}
        </p>
      ) : null}

      <div className={s.steps}>
        <p className={`sc ${s.stepsLabel}`}>
          Steps
          {e.steps.length === 0 ? <span className={s.dim}> · none recorded{e.runId ? " (traced off)" : ""}</span> : <span className={s.dim}> · {e.steps.length}, gists; open one for the verbatim record</span>}
        </p>
        {e.steps.length > 0 ? (
          <ol className={s.stepList}>
            {e.steps.map((st, i) => (
              <li key={st.seq} className={`${s.step} ${s[`k_${st.kind}`] ?? ""}`}>
                <button type="button" className={s.stepBtn} onClick={() => nav.openStep(arm.key, e.seq, i)} title="Open the verbatim step">
                  <span className={s.stepKind}>{stepKindLabel(st.kind)}{st.tool ? <code> {st.tool}</code> : null}</span>
                  <span className={s.stepText}>{stepGist(st)}</span>
                  {st.truncated ? <span className={s.trunc} title="trimmed in the index; the detail file has the whole text">trimmed</span> : null}
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {wrote.length > 0 ? (
        <div className={s.deltas}>
          <p className={`sc ${s.stepsLabel}`}>
            Changed the graph
            <span className={s.dim} title={ATTRIBUTION_GLOSS[e.attribution] ?? e.attribution}> · attribution: {e.attribution}</span>
          </p>
          <ul className={s.deltaList}>
            {wrote.map((d, i) => <li key={i}><DeltaLine d={d} text={text} arm={arm} nav={nav} /></li>)}
          </ul>
        </div>
      ) : (
        <p className={`${s.dim} ${s.small}`}>No change to the graph.</p>
      )}
    </div>
  );
}

const ATTRIBUTION_GLOSS: Record<string, string> = {
  exact: "a tool call in this run names these changes",
  "run-window": "credited by time window and claim: the change fell inside this run and touched its claim",
  harness: "written by the harness, not an agent",
};

function DeltaLine({ d, text, arm, nav }: { d: ReplayEvent["deltas"][number]; text: (id: string) => string | null; arm: ReplayArm; nav: Nav }) {
  // Assessment, review and arbitration deltas echo the claim timeline's entry anatomy.
  if (d.op === "assessment_recorded") {
    return (
      <span className={s.deltaAssess}>
        <Swatch status={d.status} />{" "}
        <button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, d.claimId)}>{describeDelta(d, text)}</button>
        {d.summary ? <span className={s.deltaProse}>{d.summary}</span> : null}
      </span>
    );
  }
  if (d.op === "review_decided") {
    return (
      <span>
        <span className={s.mDecision} /> {typeLabel(null)} <strong>{decisionLabel(d.decision)}</strong>
        {d.confidence != null ? <span className={s.dim}> · confidence {d.confidence.toFixed(2)}</span> : null}
        {d.badFaith ? <span className={s.badFaith}> Flagged as suspected bad faith.</span> : null}
        {d.reasoning ? <span className={s.deltaProse}>{d.reasoning}</span> : null}
      </span>
    );
  }
  if (d.op === "arbitration_decided") {
    return (
      <span>
        <span className={s.mDecision} /> Arbitration: <strong>{outcomeLabel(d.outcome)}</strong>
        {d.reasoning ? <span className={s.deltaProse}>{d.reasoning}</span> : null}
      </span>
    );
  }
  if (d.op === "contribution_submitted" || d.op === "appeal_filed") {
    return <span><span className={s.mActor} /> {describeDelta(d, text)}</span>;
  }
  const ids = "claimId" in d && d.claimId ? d.claimId : d.op === "edge_added" ? d.childId : null;
  return ids ? (
    <button type="button" className={s.linklike} onClick={() => nav.openClaim(arm.key, ids)}>{describeDelta(d, text)}</button>
  ) : <span>{describeDelta(d, text)}</span>;
}
