import type { ReactNode } from "react";
import s from "@/app/docs/evals/evals.module.css";
import type { GoldenPair, ScorecardConfig } from "@/lib/evals";

// Small building blocks for the evals page (#368). Server components; the
// page is static, rendered from the vendored record in web/content/evals/.

/** The fixed template every eval section answers, as labelled rows. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className={s.rows}>{children}</div>;
}

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.k}>{k}</div>
      <div className={s.v}>{children}</div>
    </div>
  );
}

export type StatusKind = "run" | "notyet" | "ci";

/** A section's standing, as tags: what has run, what is wired, what has not. */
export function Status({ items }: { items: Array<{ text: string; kind?: StatusKind }> }) {
  return (
    <div className={s.status}>
      {items.map((it, i) => (
        <span key={i} className={`tag${it.kind === "notyet" ? ` ${s.notyet}` : ""}`}>
          {it.text}
        </span>
      ))}
    </div>
  );
}

export function Callout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.callout}>
      <span className={`sc ${s.label}`}>{label}</span>
      {children}
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

/** A run's fingerprint, rendered as the record it is: what built the graph. */
export function Fingerprint({
  config,
  generatedAt,
  judgeCost,
  flagged,
}: {
  config: ScorecardConfig;
  generatedAt: string;
  judgeCost: { calls: number; usd: number } | null;
  /** Agent → reason its recorded model is known to be wrong. */
  flagged?: Record<string, string>;
}) {
  const agents = Object.keys(config.models).sort(
    (a, b) => (AGENT_ORDER.indexOf(a) + 99) % 100 - (AGENT_ORDER.indexOf(b) + 99) % 100
  );
  const source = config.modelsSource ?? "score-time";
  const caps = config.caps && Object.keys(config.caps).length > 0
    ? Object.entries(config.caps).map(([k, v]) => `${k}=${v}`).join(" ")
    : null;
  return (
    <pre className={s.fp}>
      <b>epoch</b>       {config.pipelineEpoch}
      {"\n"}<b>commit</b>      {config.gitCommit ?? "unknown"}
      {"\n"}<b>profile</b>     {config.profile ?? <span className={s.dim}>none (config defaults, not production)</span>}
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
      {config.observed ? <>{"\n"}<b>observed</b>    {Object.entries(config.observed).map(([a, m]) => `${a}: ${m.join(" | ")}`).join("; ")}</> : null}
      {"\n"}<b>caps</b>        {caps ?? <span className={s.dim}>not recorded</span>}
      {"\n"}<b>scored</b>      {generatedAt.slice(0, 10)}
      {"\n"}<b>judge cost</b>  {judgeCost ? `$${judgeCost.usd.toFixed(2)} metered over ${judgeCost.calls} verdicts` : "none (structural only)"}
    </pre>
  );
}

/** One ink line over a cluster's committed scorecards; the table beside it is the data. */
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
      <polyline
        points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill="currentColor" />
    </svg>
  );
}

/** A golden pair as the Matcher sees it, with the pinned expectation. */
export function GoldenPairFigure({ pair }: { pair: GoldenPair }) {
  const distractors = pair.existing.length - 1;
  const verdict = pair.expect.isMatch
    ? `match existing claim${pair.expect.stance ? `, stance ${pair.expect.stance}` : ""}`
    : "no match: a new claim";
  return (
    <div className={s.pair}>
      <div className={s.who}>In the graph already</div>
      <p>{pair.existing[0]}{distractors > 0 ? <span className={s.small}> {` + ${distractors} distractor${distractors > 1 ? "s" : ""}`}</span> : null}</p>
      <div className={s.who}>The source says</div>
      <p>&ldquo;{pair.candidate.extractedText}&rdquo;</p>
      <div className={s.who}>Extractor&rsquo;s proposed form</div>
      <p>{pair.candidate.proposedCanonical}</p>
      <div className={s.expect}>
        <strong>Expected:</strong> {verdict}. {pair.note} <span className={s.dim}>({pair.id}, {pair.category.replace(/_/g, " ")})</span>
      </div>
    </div>
  );
}
