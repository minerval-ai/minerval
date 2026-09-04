import type { ReactNode } from "react";
import { Term } from "@/components/Term";
import s from "@/app/docs/evals/evals.module.css";
import type { GoldenPair, ScorecardConfig } from "@/lib/evals";

// Building blocks for the evals guide (#368). Server components except Term,
// which the site already uses for hover definitions of claim vocabulary.

// Words a reader may not know, defined on hover or tap. Keep each under thirty
// words: it is a gloss, not a paragraph.
const GLOSS: Record<string, { gloss: string; href?: string }> = {
  "claim graph": { gloss: "Minerval's database: each claim is a proposition, linked to the claims it depends on, with a verdict on how well the evidence supports it.", href: "/docs" },
  cluster: { gloss: "A fixed set of documents on one topic, committed to the repository, that a test run reads. There are four.", href: "/docs/evals/corpus" },
  run: { gloss: "One build of a claim graph from a cluster, with the same code as the live site, in a separate database.", href: "/docs/evals/corpus-runs" },
  Extractor: { gloss: "The agent that reads a document and lists the claims it makes.", href: "/docs/agents/extractor" },
  Matcher: { gloss: "The agent that decides whether a claim is already in the graph, possibly worded differently or as its denial.", href: "/docs/agents/matcher" },
  Steward: { gloss: "The agent that owns a claim: breaks it into the claims it depends on, weighs the evidence, and records a verdict.", href: "/docs/agents/claim-steward" },
  Curator: { gloss: "The agent that tends the links between claims: merges duplicates, splits conflations.", href: "/docs/agents/curator" },
  Reviewer: { gloss: "The agent that accepts, rejects, or escalates a contribution someone submits against a claim.", href: "/docs/agents/contribution-reviewer" },
  Arbitrator: { gloss: "The agent that decides escalations and appeals.", href: "/docs/agents/dispute-arbitrator" },
  judge: { gloss: "A separate model, not one of the agents, that grades a sample of a graph against the constitution's text.", href: "/docs/evals/judged-scorecard" },
  scorecard: { gloss: "A file of numbers computed from one run's graph, plus the judge's verdicts if the run was judged.", href: "/docs/evals/structural-scorecard" },
  fingerprint: { gloss: "The record of what built a graph: the code version, which model each agent ran on, and the spending limits in force.", href: "/docs/evals/run-record" },
  "noise band": { gloss: "How much a number varies between runs when nothing changed. A difference smaller than that is not a result.", href: "/docs/evals/noise-band" },
  "canonical form": { gloss: "The one neutral wording of a claim that every source's version maps to. About fifteen words.", href: "/docs/constitution" },
  credence: { gloss: "The Steward's probability that a claim is true.", href: "/docs/constitution" },
  verdict: { gloss: "One of six statuses: verified, supported, contested, unsupported, contradicted, unknown.", href: "/docs/constitution" },
  constitution: { gloss: "The public rules every agent is given as the first part of its instructions.", href: "/docs/constitution" },
  production: { gloss: "The live site's configuration, in particular which model each agent runs on.", href: "/docs/evals/models-and-cost" },
  snapshot: { gloss: "A saved copy of a run's database, kept so two runs can be compared later." },
  decomposition: { gloss: "Breaking a claim into the claims it depends on: what would have to be true for it to be true.", href: "/docs" },
  importance: { gloss: "A 0 to 1 number the Steward records: how much depends on the claim, times how actively it is disputed.", href: "/docs/constitution" },
};

/** A glossed word: hover or tap shows the definition. Falls back to plain text. */
export function G({ t, children }: { t: keyof typeof GLOSS | string; children?: ReactNode }) {
  const g = GLOSS[t];
  if (!g) return <>{children ?? t}</>;
  return (
    <Term gloss={g.gloss} href={g.href} source={g.href?.startsWith("/docs/evals") ? "evals guide" : g.href?.startsWith("/docs/agents") ? "agent" : "constitution"}>
      {children ?? t}
    </Term>
  );
}

/** One collapsible section of a topic page. */
export function Section({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className={s.section} open={open}>
      <summary>
        {title}
        {hint ? <span className={s.hint}>{hint}</span> : null}
      </summary>
      <div className={s.body}>{children}</div>
    </details>
  );
}

export type Tag = { text: string; kind?: "run" | "notyet" | "ci" | "cost" };

export function Tags({ items }: { items: Tag[] }) {
  return (
    <div className={s.tags}>
      {items.map((it, i) => (
        <span key={i} className={`tag${it.kind === "notyet" ? ` ${s.notyet}` : ""}`}>{it.text}</span>
      ))}
    </div>
  );
}

export function Cmd({ children }: { children: string }) {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}

const AGENT_ORDER = ["extractor", "matcher", "steward", "curator", "judge"];

/** A run's fingerprint, as the record it is. */
export function Fingerprint({
  config,
  generatedAt,
  judgeCost,
  flagged,
}: {
  config: ScorecardConfig;
  generatedAt: string;
  judgeCost: { calls: number; usd: number } | null;
  flagged?: Record<string, string>;
}) {
  const agents = Object.keys(config.models).sort(
    (a, b) => ((AGENT_ORDER.indexOf(a) + 99) % 100) - ((AGENT_ORDER.indexOf(b) + 99) % 100)
  );
  const source = config.modelsSource ?? "score-time";
  const caps = config.caps && Object.keys(config.caps).length > 0
    ? Object.entries(config.caps).map(([k, v]) => `${k}=${v}`).join(" ")
    : null;
  return (
    <pre className={s.fp}>
      <b>epoch</b>       {config.pipelineEpoch}
      {"\n"}<b>commit</b>      {config.gitCommit ?? "unknown"}
      {"\n"}<b>profile</b>     {config.profile ?? <span className={s.dim}>none: development defaults, not production</span>}
      {config.swap ? <>{"\n"}<b>swap</b>        {config.swap.agent} → {config.swap.model}</> : null}
      {config.order ? <>{"\n"}<b>order</b>       {config.order}</> : null}
      {agents.map((a) => (
        <span key={a}>
          {"\n"}<b>{a.padEnd(11)}</b> {config.models[a]}
          {flagged?.[a] ? <span className={s.flag}>  ← {flagged[a]}</span> : null}
        </span>
      ))}
      {"\n"}<b>models from</b> {source}
      {source === "score-time" ? <span className={s.flag}>  ← read from config when scored, not recorded when the graph was built</span> : null}
      {"\n"}<b>caps</b>        {caps ?? <span className={s.dim}>not recorded</span>}
      {"\n"}<b>scored</b>      {generatedAt.slice(0, 10)}
      {"\n"}<b>judge cost</b>  {judgeCost ? `$${judgeCost.usd.toFixed(2)} over ${judgeCost.calls} verdicts` : "none"}
    </pre>
  );
}

/** One ink line over a cluster's scorecards; the table beside it is the data. */
export function Sparkline({ values, width = 72, height = 18 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => [
    pad + (i * (width - 2 * pad)) / (values.length - 1),
    height - pad - ((v - min) / span) * (height - 2 * pad),
  ]);
  const last = pts[pts.length - 1]!;
  const label = values.map((v) => (Math.round(v * 100) / 100).toString()).join(" → ");
  return (
    <svg className={s.spark} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${values.length} runs: ${label}`}>
      <title>{label}</title>
      <polyline points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill="currentColor" />
    </svg>
  );
}

/** A golden pair as the Matcher sees it, with the expected answer. */
export function GoldenPairFigure({ pair }: { pair: GoldenPair }) {
  const distractors = pair.existing.length - 1;
  const verdict = pair.expect.isMatch
    ? `same claim${pair.expect.stance ? `, stance ${pair.expect.stance}` : ""}`
    : "a different claim";
  return (
    <div className={s.pair}>
      <div className={s.who}>Already in the graph</div>
      <p>{pair.existing[0]}{distractors > 0 ? <span className={s.small}>{` + ${distractors} distractor${distractors > 1 ? "s" : ""}`}</span> : null}</p>
      <div className={s.who}>A new source says</div>
      <p>&ldquo;{pair.candidate.extractedText}&rdquo;</p>
      <div className={s.expect}>
        <strong>Expected:</strong> {verdict}. {pair.note} <span className={s.dim}>({pair.id})</span>
      </div>
    </div>
  );
}
