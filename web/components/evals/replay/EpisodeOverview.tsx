"use client";

import { promptCarrier, type Replay } from "@/lib/replay-core";
import { modelDisplayName } from "@/lib/model-names";
import { JsonTree } from "./JsonTree";
import { agentMeta, fmtChars, fmtCost } from "./vocab";
import type { Nav } from "./hash";
import s from "./replay.module.css";

// Level (a): the episode. What it tests, the exact commands, each arm's
// fingerprint, the scenario, the costs, and the distinct system prompts used
// (agent, size, count; a link opens the full text; a link to the vendored
// agent prompt page for comparison). The headline summary as the driver
// wrote it, verbatim as JSON.

export function EpisodeOverview({ replay, nav }: { replay: Replay; nav: Nav }) {
  const commands = replay.commands ?? [];
  return (
    <div className={s.episode}>
      <p className={s.deltaProse}>{replay.about}</p>
      <p className={s.nowMeta}>
        {replay.kind} · {replay.cluster ?? "no cluster"} · generated {replay.generatedAt.slice(0, 10)}
        {replay.evalRunId ? <> · eval run <code>{replay.evalRunId}</code></> : null}
        {" · "}total cost {fmtCost(replay.costMicroUsd)}
      </p>

      <p className={`sc ${s.stepsLabel}`}>Commands</p>
      {commands.length ? <pre className={s.verbatim}>{commands.join("\n")}</pre> : <p className={s.dim}>The driver did not record its command line.</p>}

      {replay.scenario ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>Scenario · {replay.scenario.name}</p>
          {replay.scenario.description ? <p className={s.deltaProse}>{replay.scenario.description}</p> : null}
          <ul className={s.deltaList}>
            {replay.scenario.actors.map((a) => (
              <li key={a.key}><strong>{a.displayName}</strong> <code>{a.key}</code>{a.role ? <span className={s.dim}> · {a.role}</span> : null}{a.tier ? <span className={s.dim}> · tier {a.tier}</span> : null}{a.note ? <span className={s.quote}>{a.note}</span> : null}</li>
            ))}
          </ul>
          {replay.scenario.targets?.length ? (
            <ul className={s.deltaList}>
              {replay.scenario.targets.map((t) => (
                <li key={t.key}>
                  <span className={s.dim}>{t.key}: </span>
                  {t.claimId ? <button type="button" className={s.linklike} onClick={() => nav.openClaim(t.key, t.claimId!)}>{t.text ?? t.claimId}</button> : t.text}
                  {t.direction ? <span className={s.dim}> · pushed {t.direction}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {replay.arms.map((arm) => (
        <div key={arm.key} className={s.armBlock}>
          <p className={`sc ${s.stepsLabel}`}>{arm.label}{arm.variation ? <span className={s.dim}> · {arm.variation}</span> : null}</p>
          <p className={s.nowMeta}>
            {arm.events.length} events · {arm.sources.length} sources · {arm.final.claims.length} claims · {arm.final.edges.length} edges · cost {fmtCost(arm.costMicroUsd)}{arm.capped ? <span className={s.flag}> · capped</span> : null}
            {arm.database ? <> · <code>{arm.database}</code></> : null}
          </p>
          {arm.commands?.length ? <pre className={s.verbatim}>{arm.commands.join("\n")}</pre> : null}
          <pre className={s.fp}>
            <b>epoch</b>    {arm.fingerprint.pipelineEpoch ?? "unknown"}
            {"\n"}<b>commit</b>   {arm.fingerprint.gitCommit ?? "unknown"}
            {"\n"}<b>profile</b>  {arm.fingerprint.profile ?? "none"}
            {arm.fingerprint.swap ? <>{"\n"}<b>swap</b>     {arm.fingerprint.swap.agent} → {arm.fingerprint.swap.model}</> : null}
            {arm.fingerprint.order ? <>{"\n"}<b>order</b>    {arm.fingerprint.order}</> : null}
            {Object.entries(arm.fingerprint.models).filter(([, m]) => m).map(([a, m]) => (
              <span key={a}>{"\n"}<b>{a.padEnd(8)}</b> {modelDisplayName(m!)} <span className={s.dim}>{m}</span></span>
            ))}
            {"\n"}<b>caps</b>     {Object.keys(arm.fingerprint.caps ?? {}).length ? Object.entries(arm.fingerprint.caps).map(([k, v]) => `${k}=${v}`).join(" ") : "none recorded"}
          </pre>
          <p className={`sc ${s.stepsLabel}`}>System prompts used{arm.promptsUsed?.length ? <span className={s.dim}> · {arm.promptsUsed.length} distinct</span> : null}</p>
          {arm.promptsUsed?.length ? (
            <ul className={s.deltaList}>
              {arm.promptsUsed.map((p) => {
                const carrier = promptCarrier(replay, arm.key, p);
                return (
                  <li key={p.sha256}>
                    {p.agents.map((a) => agentMeta(a).label).join(", ")} · {fmtChars(p.chars)} · used {p.count}× · <code title={p.sha256}>{p.sha256.slice(0, 12)}</code>
                    {" · "}
                    {carrier ? <button type="button" className={s.linklike} onClick={() => nav.openPrompt(arm.key, p.sha256)}>full text</button> : <span className={s.dim}>no event carries it</span>}
                    {p.agents.map((a) => agentMeta(a).docs).filter(Boolean).map((d) => <span key={d}> · <a href={`/docs/agents/${d}`}>vendored prompt</a></span>)}
                  </li>
                );
              })}
            </ul>
          ) : <p className={s.dim}>Not recorded in this export; the prompt step of any event shows what was sent.</p>}
        </div>
      ))}

      {replay.matching?.length ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>Agreement between arms</p>
          {replay.matching.map((m) => (
            <p key={`${m.armA}-${m.armB}`} className={s.nowMeta}>
              {m.armA} ↔ {m.armB}: {m.pairs.length} pairs, {m.unmatchedA.length} unmatched in {m.armA}, {m.unmatchedB.length} in {m.armB}
              {m.summary ? <> · F1 {fmtNum(m.summary.claimSetF1)} · status agreement {fmtNum(m.summary.statusAgreement)} · credence Δ {fmtNum(m.summary.credenceMeanAbsDiff)} · edge edit distance {fmtNum(m.summary.edgeEditDistance)}</> : null}
            </p>
          ))}
        </>
      ) : null}

      {replay.summary ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>The driver&rsquo;s summary <span className={s.dim}>· verbatim</span></p>
          <JsonTree value={replay.summary} />
        </>
      ) : null}
    </div>
  );
}

function fmtNum(v: number | null | undefined): string {
  return v == null ? "n/a" : (Math.round(v * 100) / 100).toString();
}
