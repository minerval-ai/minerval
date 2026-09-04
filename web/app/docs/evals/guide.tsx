import Link from "next/link";
import type { ReactNode } from "react";
import { Term } from "@/components/Term";
import { Cmd, Fingerprint, G, GoldenPairFigure, Sparkline, type Tag } from "@/components/evals/Bits";
import { ContributionDiagram, NoiseBandDiagram, PredictionTimeline, RunDiagram, ScoreDiagram, TwoArmDiagram } from "@/components/evals/Diagrams";
import {
  HEADLINE_METRICS,
  bandStat,
  fmtDate,
  formatMetric,
  lowestScoring,
  microToUsd,
  scorecardsFor,
  type EvalsData,
  type RubricSection,
} from "@/lib/evals";
import s from "./evals.module.css";

// The guide's topics (#368). Each is a short page of collapsed sections. The
// rule for the copy: show the artifact (a prompt, a fixture, a standard, a
// number) and say the least needed to place it. Terms a reader may not know
// are glossed with <G>, which defines them on hover.

const GH = "https://github.com/minerval-ai/minerval/blob/main";
const PLAN = "https://github.com/minerval-ai/minerval/issues/334";

/** Constitution sections, linked by number (anchors from the rendered headings). */
const CON: Record<string, string> = {
  "2": "/docs/constitution#2-what-a-claim-is",
  "3": "/docs/constitution#3-canonical-forms",
  "4": "/docs/constitution#4-instances",
  "6": "/docs/constitution#6-decomposition",
  "9": "/docs/constitution#9-direct-assessment",
  "10": "/docs/constitution#10-explicit-uncertainty",
  "11": "/docs/constitution#11-transparency-of-reasoning",
  "12": "/docs/constitution#12-the-voice-of-the-graph",
  "17": "/docs/constitution#17-political-and-ideological-neutrality",
  "18": "/docs/constitution#18-representing-disagreement-fairly",
  "19": "/docs/constitution#19-contextual-awareness-and-graph-level-thinking",
  "21": "/docs/constitution#21-coherence-across-the-graph",
  judgment: "/docs/constitution#judgment-over-mechanism",
};
const C = ({ n, children }: { n: string; children?: ReactNode }) => <Link href={CON[n] ?? "/docs/constitution"}>{children ?? `§${n}`}</Link>;

// Things known about specific committed records that the files do not say.
const KNOWN: Record<string, { flagged?: Record<string, string>; ingestCost?: string; scope?: string }> = {
  "2026-08-09T15-47-32-753Z.json": {
    flagged: { matcher: "the ingest actually ran DeepSeek V4 Flash" },
    ingestCost: "The ingest itself metered $11.29 over two capped drains (Steward runs capped at 3 then 8, 12 iterations each, Curator off). The scorecard file carries only the judge's cost.",
    scope: "Two of the cluster's four documents, with spending caps: a partial run, made before the production profile existed.",
  },
};

const WHY: Record<string, string> = {
  lethalities: "dense overlap between documents that argue with each other",
  blackholes: "a settled question with a deep argument: the control case",
  lableak: "the most contested case, both sides steelmanned",
  eggs: "a mundane question where the dispute is about methods, not facts",
};

// Estimated cost of one full run on the production models, until one is metered.
const ESTIMATE: Record<string, { stewardRuns: string; usd: string }> = {
  eggs: { stewardRuns: "≈20", usd: "$60 – 140" },
  blackholes: { stewardRuns: "≈28", usd: "$80 – 200" },
  lableak: { stewardRuns: "≈35", usd: "$100 – 250" },
  lethalities: { stewardRuns: "100 – 150", usd: "$400 – 900" },
};

export interface Section {
  title: string;
  hint?: string;
  open?: boolean;
  body: ReactNode;
}

export interface Topic {
  slug: string;
  kind: "eval" | "background";
  group: string;
  title: string;
  /** One line for the card. */
  line: string;
  tags?: (d: EvalsData) => Tag[];
  sections: (d: EvalsData) => Section[];
}

export const GROUPS: Array<{ key: string; title: string; note?: string }> = [
  { key: "graph", title: "Is a graph well built?", note: "Build one from fixed documents, then measure it." },
  { key: "stable", title: "Is the pipeline stable?", note: "Build it twice and measure the difference." },
  { key: "governance", title: "Does governance work?" },
  { key: "reality", title: "Where can reality check it?" },
  { key: "background", title: "Background" },
];

// ---- helpers shared by topics ----------------------------------------------

function firstSentences(text: string, n = 2): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  return parts.slice(0, n).join("").trim();
}

/** A metric label that carries its rubric standard on hover and links to the section. */
function RubricTerm({ letter, rubric, children }: { letter: string; rubric: RubricSection[]; children: ReactNode }) {
  const r = rubric.find((x) => x.letter === letter);
  if (!r) return <>{children}</>;
  return (
    <Term gloss={firstSentences(r.standard)} href={`/docs/evals/rubric#${r.slug}`} source="rubric" align="start">
      {children}
    </Term>
  );
}

const METRIC_RUBRIC: Record<string, string> = { A: "A", B: "B", C: "C", D: "D", E: "E", F: "F" };

function MetricsTable({ d, cluster }: { d: EvalsData; cluster: string }) {
  const cards = scorecardsFor(cluster, d.scorecards);
  const latest = cards[cards.length - 1];
  return (
    <div className={s.wrapOpen}>
      <table className={s.metrics}>
        <thead>
          <tr><th>metric</th><th className={s.num}>{latest ? `latest (${fmtDate(latest.card.generatedAt)})` : "latest"}</th><th>across runs</th></tr>
        </thead>
        <tbody>
          {HEADLINE_METRICS.map((m) => {
            const letter = m.label.split(" · ")[0]!;
            const name = m.label.split(" · ").slice(1).join(" · ");
            const v = latest ? m.get(latest.card) : null;
            const history = cards.map((r) => m.get(r.card)).filter((x): x is number => x != null && Number.isFinite(x));
            const band = bandStat(history);
            const label = METRIC_RUBRIC[letter] ? (
              <RubricTerm letter={METRIC_RUBRIC[letter]!} rubric={d.index.rubric}>{name}</RubricTerm>
            ) : letter === "§21" ? (
              <C n="21">{name}</C>
            ) : letter === "judge" ? (
              <Link href="/docs/evals/judged-scorecard">{name}</Link>
            ) : (
              <RubricTerm letter="F" rubric={d.index.rubric}>{name}</RubricTerm>
            );
            return (
              <tr key={m.label}>
                <td><span className={s.dim}>{letter} ·</span> {label}</td>
                <td className={s.num}>{formatMetric(v, m.format)}</td>
                <td>
                  {v == null ? <span className={s.sample}>{latest ? "not on this run" : "no run"}</span>
                    : band.n < 2 ? <span className={s.sample}>single sample</span>
                    : <><span className={s.sample}>n={band.n} · {formatMetric(band.mean, m.format)} ± {formatMetric(band.sd, m.format === "int" ? "num" : m.format)}</span><Sparkline values={history} /></>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function runTags(d: EvalsData): Tag[] {
  const n = d.scorecards.length;
  const latest = d.scorecards[n - 1];
  const prod = d.scorecards.filter((r) => r.card.config.profile === "production").length;
  if (n === 0) return [{ text: "no scored run on record", kind: "notyet" }];
  return [
    { text: `${n} scored run${n === 1 ? "" : "s"} · latest ${fmtDate(latest!.card.generatedAt)}, ${latest!.cluster}` },
    prod === 0 ? { text: "none yet on the production models", kind: "notyet" } : { text: `${prod} on the production models` },
  ];
}

// ---- the topics --------------------------------------------------------------

export const TOPICS: Topic[] = [
  // ------------------------------------------------------------------ graph
  {
    slug: "corpus-runs",
    kind: "eval",
    group: "graph",
    title: "Corpus runs",
    line: "Build a claim graph from a fixed set of documents, with the live pipeline, in a separate database.",
    tags: (d) => [...runTags(d), { text: "$80 – 200 per run, estimated", kind: "cost" }],
    sections: (d) => {
      const latest = d.scorecards[d.scorecards.length - 1];
      const known = latest ? KNOWN[latest.file] : undefined;
      return [
        {
          title: "What happens in a run",
          open: true,
          body: (
            <>
              <RunDiagram />
              <p>
                The <G t="cluster" />&rsquo;s documents go through the same route the live site uses. The <G t="Extractor" /> lists each document&rsquo;s claims.
                The <G t="Matcher" /> checks whether each is already in the graph. A <G t="Steward" /> takes each new claim, breaks it into the claims it depends on, and records a <G t="verdict" />.
                The <G t="Curator" /> tends the links. The run ends when no work is queued.
              </p>
              <p>
                Everything else in this guide measures the graph a run produces. The agents&rsquo; full instructions are under <Link href="/docs/agents">agents</Link>.
              </p>
            </>
          ),
        },
        {
          title: "What a run records",
          body: (
            <>
              <p>Before its first model call, the run writes its <G t="fingerprint" />: code version, the model each agent is set to, spending caps. Afterwards it adds the models actually seen in the usage log and the metered cost.</p>
              <p>With <code>--profile=production</code> the agents run on the models the live site uses ({d.index.pins.map((p) => `${p.agent}: ${p.label}`).join(", ")}). Without it, cheaper development defaults.</p>
              <p>Output: a report to read against the <Link href="/docs/evals/rubric">rubric</Link>, the graph as JSON, and the fingerprint. See <Link href="/docs/evals/run-record">what a run leaves behind</Link>.</p>
            </>
          ),
        },
        {
          title: "Cost",
          body: (
            <>
              <p>Almost all of it is Stewards: one per extracted claim, each a long tool-using loop with web search. Measured once: $11.29 for a capped run with eleven Steward runs on Sonnet.</p>
              <p>On the production models, an estimated $80 – 200 for a small cluster and $400 – 900 for the large one. Details and the estimate&rsquo;s basis: <Link href="/docs/evals/models-and-cost">models and cost</Link>.</p>
            </>
          ),
        },
        {
          title: "What it cannot show",
          body: (
            <>
              <p>Whether the graph is right. There is no answer key for a contested question. And one run is one sample: nothing seen once is a property of the pipeline (<Link href="/docs/evals/noise-band">noise band</Link>).</p>
            </>
          ),
        },
        ...(latest
          ? [{
              title: "Results",
              hint: `${d.scorecards.length} run${d.scorecards.length === 1 ? "" : "s"} on record`,
              body: (
                <>
                  {known?.scope ? <p>{known.scope}</p> : null}
                  <Fingerprint config={latest.card.config} generatedAt={latest.card.generatedAt} judgeCost={latest.card.cost} flagged={known?.flagged} />
                  {known?.ingestCost ? <p className={s.small}>{known.ingestCost}</p> : null}
                  <p className={s.small}>The file: <a href={`${GH}/corpus/scorecards/${latest.cluster}/${latest.file}`}>{latest.cluster}/{latest.file}</a>. Its numbers are on the <Link href="/docs/evals/structural-scorecard">structural</Link> and <Link href="/docs/evals/judged-scorecard">judged</Link> pages.</p>
                </>
              ),
            }]
          : []),
        {
          title: "Run it",
          body: (
            <Cmd>{`docker compose up -d                       # Postgres 16 + pgvector
npm run corpus:reset                       # the separate database
npm run corpus:run -- blackholes --profile=production --limit=1   # read the printed cost first
npm run corpus:run -- blackholes --profile=production --score`}</Cmd>
          ),
        },
      ];
    },
  },
  {
    slug: "structural-scorecard",
    kind: "eval",
    group: "graph",
    title: "Structural scorecard",
    line: "Counts taken from a run's graph, no model involved. Each one serves a section of the rubric.",
    tags: (d) => [d.scorecards.length ? { text: `on every scored run (${d.scorecards.length})` } : { text: "no scored run on record", kind: "notyet" }, { text: "free", kind: "cost" }],
    sections: (d) => {
      const clusters = d.index.clusters.filter((c) => scorecardsFor(c.key, d.scorecards).length > 0);
      return [
        {
          title: "What it checks",
          open: true,
          body: (
            <>
              <p>Counts a program takes from a run&rsquo;s graph, with no model involved: how many claims came out of how many words, how long their wording is, how often the Matcher merged, how deep the decomposition goes, how many verdicts have reasoning behind them. Each count serves one section of the <Link href="/docs/evals/rubric">rubric</Link> and is a symptom of a failure that section names.</p>
              <p>The numbers only mean something against earlier runs: a count that moves beyond the <G t="noise band" /> after a change is a lead, and its direction says which agent to look at.</p>
            </>
          ),
        },
        {
          title: "The metrics",
          hint: "hover a name for its standard",
          body: (
            <>
              <p className={s.small}>Letters are <Link href="/docs/evals/rubric">rubric</Link> sections. Hover a metric for the standard it serves; click for the section. Judge rows come from the <Link href="/docs/evals/judged-scorecard">judged scorecard</Link>.</p>
              {clusters.length === 0 ? <MetricsTable d={d} cluster="none" /> : clusters.map((c) => (
                <div key={c.key}>
                  {clusters.length > 1 ? <p className={s.small}><code>{c.key}</code></p> : null}
                  <MetricsTable d={d} cluster={c.key} />
                </div>
              ))}
            </>
          ),
        },
        {
          title: "How the numbers are computed",
          body: (
            <>
              <p>A pure function over the graph, unit tested: <a href={`${GH}/scripts/corpus/metrics.ts`}>metrics.ts</a>. Shared subclaims are counted once. The two <C n="21">coherence rules</C> are checked mechanically: a claim cannot be verified while a claim it requires is contradicted, and two claims joined by a contradiction edge cannot both be verified.</p>
              <p>Authorship metrics (how often the Matcher reworded the Extractor&rsquo;s proposed <G t="canonical form" />) need the proposal stored on the instance, which graphs built before September 2026 lack: those rows read n/a.</p>
            </>
          ),
        },
        {
          title: "What it cannot show",
          body: <p>Whether any claim is well stated, well decomposed, or fairly judged. The counts say where to look; a wording of fifteen words can still be wrong in every way <C n="3" /> cares about.</p>,
        },
        { title: "Run it", body: <Cmd>{`npm run corpus:score -- blackholes --no-judge     # after a run; writes scorecard.json`}</Cmd> },
      ];
    },
  },
  {
    slug: "judged-scorecard",
    kind: "eval",
    group: "graph",
    title: "Judged scorecard",
    line: "A second model grades a sample of the graph's claims against the constitution's text.",
    tags: (d) => {
      const judged = d.scorecards.filter((r) => r.card.judged);
      return [
        judged.length ? { text: `${judged.length} judged run${judged.length === 1 ? "" : "s"} · judge ${d.index.judge.label}` } : { text: "no judged run on record", kind: "notyet" },
        { text: "about $1 per run", kind: "cost" },
      ];
    },
    sections: (d) => {
      const judgedCards = d.scorecards.filter((r) => r.card.judged);
      const latest = judgedCards[judgedCards.length - 1];
      const j = latest?.card.judged ?? null;
      const review = d.reviews[d.reviews.length - 1];
      return [
        {
          title: "How it is run",
          open: true,
          body: (
            <>
              <ScoreDiagram />
              <p>Up to fifteen assessed claims per run, picked the same way each time so a re-score judges the same ones. The judge sees the claim, its subclaims, the Steward&rsquo;s reasoning, and what the sources said.</p>
              <p>The judge runs on {d.index.judge.label}; the Stewards it grades run on {d.index.pins.find((p) => p.agent === "steward")?.label} in production. Scoring refuses a judge that is the same model the graph was built with.</p>
              <p>No number from the judge feeds a decision until a person has read its verdicts: <Link href="/docs/evals/judge-review">judge review</Link>.</p>
            </>
          ),
        },
        {
          title: "The prompt",
          hint: "verbatim",
          body: (
            <>
              <p className={s.small}>What the judge is sent for each sampled claim, with placeholders where the claim&rsquo;s own fields go. Source: <a href={`${GH}/scripts/corpus/judge.ts`}>judge.ts</a>.</p>
              <pre>{d.artifacts.judgePrompt}</pre>
            </>
          ),
        },
        {
          title: "The questions it must answer",
          hint: "the response schema",
          body: (
            <>
              <p className={s.small}>The judge replies in this exact shape. Each description is the question as the model sees it.</p>
              <div className={s.wrap}>
                <table className={s.metrics}>
                  <thead><tr><th>field</th><th>answers</th><th>question</th></tr></thead>
                  <tbody>
                    {Object.entries(d.artifacts.judgeSchema.properties).map(([k, v]) => (
                      <tr key={k}>
                        <td><code>{k}</code></td>
                        <td className={s.note}>{"enum" in v ? v.enum!.join(" / ") : "items" in v ? (v.items!.enum ?? []).join(", ") : v.type}</td>
                        <td>{v.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ),
        },
        ...(j
          ? [{
              title: "Results",
              hint: `${j.sampleSize} claims, ${latest!.cluster}, ${fmtDate(latest!.card.generatedAt)}`,
              body: (
                <>
                  <div className={s.wrap}>
                    <table className={s.metrics}>
                      <tbody>
                        <tr><td>claim bar passed</td><td className={s.num}>{formatMetric(j.claimBarPassRate, "pct")}</td><td className={s.note}>reviewed {review?.reviewedOn ?? "never"}; the bar itself changed after the review (#372)</td></tr>
                        <tr><td>importance, stored vs judged</td><td className={s.num}>{j.importanceAlignment.meanStored.toFixed(2)} vs {j.importanceAlignment.meanJudged.toFixed(2)}</td><td className={s.note}>overrated by more than 0.2: {formatMetric(j.importanceAlignment.overratedShare, "pct")}</td></tr>
                        <tr><td>readability / reasoning fit / impartiality</td><td className={s.num}>{j.assessmentQuality.readability.toFixed(1)} / {j.assessmentQuality.reasoningFit.toFixed(1)} / {j.assessmentQuality.impartiality.toFixed(1)}</td><td className={s.note}>out of 5</td></tr>
                        <tr><td>granularity</td><td className={s.num}></td><td className={s.note}>{Object.entries(j.granularity).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}</td></tr>
                        <tr><td>flags</td><td className={s.num}></td><td className={s.note}>{Object.entries(j.flags).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}</td></tr>
                        {j.dimensions
                          ? Object.entries(j.dimensions).map(([dim, dist]) => (
                              <tr key={dim}><td>{dim.replace(/([A-Z])/g, " $1").toLowerCase()}</td><td className={s.num}></td><td className={s.note}>{Object.entries(dist).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")} <span className={s.sample}>· unreviewed</span></td></tr>
                            ))
                          : <tr><td>sycophancy, hedging, canonical form, political bias</td><td className={s.num}>n/a</td><td className={s.note}>added to the judge after this run</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <p className={s.small}>The judge&rsquo;s weakest verdicts, with its note. Claims live in the test database, so they are quoted, not linked. Every verdict: <a href={`${GH}/corpus/scorecards/${latest!.cluster}/${latest!.file}`}>the scorecard file</a>.</p>
                  <ul className={s.claims}>
                    {lowestScoring(j.items, 4).map((it) => (
                      <li key={it.id}>
                        <p className={s.ctext}>{it.text}</p>
                        <p className={s.cmeta}>
                          <span>{it.status ?? "no status"}</span>
                          <span>importance {it.importanceStored.toFixed(2)} stored · {it.importance_judged.toFixed(2)} judged</span>
                          <span>claim bar {it.claim_bar}</span>
                          <span>{it.readability}/{it.reasoning_fit}/{it.impartiality}</span>
                          {it.flags.length ? <span>{it.flags.map((f) => f.replace(/_/g, " ")).join(", ")}</span> : null}
                        </p>
                        <p className={s.cnote}>{it.note}</p>
                      </li>
                    ))}
                  </ul>
                </>
              ),
            }]
          : []),
        {
          title: "Cost and limits",
          body: (
            <>
              <p>About $0.05 a verdict on {d.index.judge.label}: {latest?.card.cost ? `$${latest.card.cost.usd.toFixed(2)} for ${latest.card.cost.calls}` : "about a dollar for fifteen"}.</p>
              <p>It grades conformance to the rules, not truth, with a weaker model than the one it grades, from one model family. Its numbers are used as differences between runs, where a stable bias cancels.</p>
            </>
          ),
        },
        { title: "Run it", body: <Cmd>{`npm run corpus:score -- blackholes --sample=15      # JUDGE_MODEL defaults to Sonnet`}</Cmd> },
      ];
    },
  },
  {
    slug: "judge-review",
    kind: "eval",
    group: "graph",
    title: "Judge review",
    line: "A person reads the judge's verdicts and reports where the task it was given misses.",
    tags: (d) => {
      const r = d.reviews[d.reviews.length - 1];
      return r ? [{ text: `reviewed once · ${r.reviewedOn ?? "?"} · ${r.cluster ?? ""}` }, { text: "4 newest dimensions unreviewed", kind: "notyet" }, { text: "a person's time", kind: "cost" }] : [{ text: "never reviewed", kind: "notyet" }];
    },
    sections: (d) => {
      const r = d.reviews[d.reviews.length - 1];
      return [
        {
          title: "The procedure",
          open: true,
          body: (
            <>
              <p><code>corpus:calibrate review</code> writes a sheet from a scored run: each claim in context, the judge&rsquo;s full verdict, the standards as they were pasted into the judge, and an Overall block to fill in.</p>
              <p>The reviewer does not re-grade the claims. They write where the task misses: a standard that gets at the wrong thing, a dimension that should exist, a better design. Wording fixes go into the judge&rsquo;s prompt and the run is re-judged; what-to-measure fixes go into <a href={PLAN}>the plan</a>. No agreement statistic is kept.</p>
              <p>An earlier design had a person grade the same claims blind and measured concordance. It was dropped: the judge&rsquo;s numbers are only used as differences between runs, so a stable bias does not matter, and what a person can catch is a wrong task.</p>
            </>
          ),
        },
        ...(r
          ? [
              {
                title: "The first review",
                hint: `${r.cluster}, ${r.reviewedOn}`,
                body: (
                  <>
                    <p className={s.small}>The Overall block, which is the review&rsquo;s output. What it changed: the claim bar in the constitution (#372) and three pins in the judge&rsquo;s prompt (#374).</p>
                    {r.overall ? <pre className={s.overall}>{r.overall}</pre> : null}
                  </>
                ),
              },
              {
                title: "The full sheet",
                hint: "every claim and verdict",
                body: (
                  <>
                    <p className={s.small}>As committed: <a href={`${GH}/corpus/calibration/${r.file}`}>{r.file}</a>.</p>
                    <pre style={{ maxHeight: "36rem", overflow: "auto" }}>{d.artifacts.reviewSheets[r.file]}</pre>
                  </>
                ),
              },
            ]
          : []),
        {
          title: "Status per dimension",
          body: (
            <div className={s.wrap}>
              <table className={s.metrics}>
                <thead><tr><th>dimension</th><th>reviewed</th><th>what changed</th></tr></thead>
                <tbody>
                  <tr><td>claim bar</td><td>{r?.reviewedOn ?? "never"}</td><td className={s.note}>the bar moved from &ldquo;contested&rdquo; to &ldquo;referred to&rdquo; (#372); four of thirteen verdicts flip</td></tr>
                  <tr><td>importance</td><td>{r?.reviewedOn ?? "never"}</td><td className={s.note}>judge was right: Steward inflates importance</td></tr>
                  <tr><td>granularity</td><td>{r?.reviewedOn ?? "never"}</td><td className={s.note}>unassessed children are not defects; pinned (#374)</td></tr>
                  <tr><td>status flags</td><td>{r?.reviewedOn ?? "never"}</td><td className={s.note}>verified vs supported, confidence vs credence: definitions pinned (#374)</td></tr>
                  <tr><td>readability, reasoning fit, impartiality</td><td>{r?.reviewedOn ?? "never"}</td><td className={s.note}>carried little beyond the flags; kept for now</td></tr>
                  <tr><td>sycophancy</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04</td></tr>
                  <tr><td>hedging</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04</td></tr>
                  <tr><td>canonical-form strength</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04, from the first review</td></tr>
                  <tr><td>political bias</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04</td></tr>
                </tbody>
              </table>
            </div>
          ),
        },
        { title: "Run it", body: <Cmd>{`npm run corpus:calibrate -- review     # from the latest scored run, before resetting the graph
# read, fill the Overall block, commit corpus/calibration/<sheet>.md`}</Cmd> },
      ];
    },
  },
  {
    slug: "noise-band",
    kind: "eval",
    group: "graph",
    title: "Comparing runs",
    line: "One run is one sample. A change counts only when it is larger than the spread between runs that changed nothing.",
    tags: () => [{ text: "no group of runs exists yet; no verdict ever issued", kind: "notyet" }, { text: "three runs per side", kind: "cost" }],
    sections: () => [
      {
        title: "The rule",
        open: true,
        body: (
          <>
            <NoiseBandDiagram />
            <p>Each side of a comparison is a group of about three runs. A metric&rsquo;s value is the group mean; its noise is the sample spread. The difference of means counts only when it exceeds spread A plus spread B.</p>
            <p>A side with one run gets its difference printed and no verdict. A verdict against one side&rsquo;s spread alone is marked one-sided. Code: <a href={`${GH}/scripts/corpus/band.ts`}>band.ts</a>.</p>
          </>
        ),
      },
      {
        title: "What it cannot show",
        body: <p>Which side is better. Only whether the difference is real. Better is the judge&rsquo;s and the reviewer&rsquo;s question.</p>,
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:compare -- A1.json,A2.json,A3.json B1.json,B2.json,B3.json
npm run corpus:compare -- db:<idA> db:<idB>         # single runs: deltas, no verdict`}</Cmd> },
    ],
  },
  // ------------------------------------------------------------------ stable
  {
    slug: "golden-pairs",
    kind: "eval",
    group: "stable",
    title: "Golden pairs",
    line: "Thirty fixed cases for the Matcher: is this new sentence a claim already in the graph, its denial, a narrower version, or something else?",
    tags: (d) => {
      const g = d.goldenRuns[d.goldenRuns.length - 1];
      return g ? [{ text: `${g.summary.passed}/${g.summary.total} on ${fmtDate(g.generatedAt)}` }, { text: "in CI, waiting on repository secrets", kind: "ci" }, { text: `$${g.costMicroUsd != null ? microToUsd(g.costMicroUsd)!.toFixed(2) : "0.06"} per run`, kind: "cost" }] : [{ text: "never run", kind: "notyet" }];
    },
    sections: (d) => {
      const cats = Object.keys(d.index.golden.byCategory);
      return [
        {
          title: "What it checks",
          open: true,
          body: (
            <>
              <p>Whether two sentences are the same claim is the central judgment in the system: a claim and its denial are one node (<C n="2" />), a narrower claim is a different one, and a sentence that only resembles a claim is new. The <G t="Matcher" /> makes that call for every claim that enters the graph.</p>
              <p>Thirty cases are fixed in a file. Each seeds the &ldquo;already in the graph&rdquo; claims into the test database and asks the real Matcher about a new sentence; a case passes when the decision, the matched claim, and the stance are all as expected. The suite runs in CI on any change that could move a decision.</p>
            </>
          ),
        },
        {
          title: "The 30 pairs",
          hint: "the fixture, verbatim",
          body: (
            <>
              <p className={s.small}>File: <a href={`${GH}/corpus/golden/matcher-pairs.json`}>matcher-pairs.json</a>.</p>
              {cats.map((cat) => (
                <details key={cat} style={{ margin: "0.4rem 0" }}>
                  <summary className={s.small} style={{ cursor: "pointer" }}>{cat.replace(/_/g, " ")} · {d.index.golden.byCategory[cat]} pairs</summary>
                  {d.goldenPairs.filter((p) => p.category === cat).map((p) => <GoldenPairFigure key={p.id} pair={p} />)}
                </details>
              ))}
            </>
          ),
        },
        {
          title: "Results",
          body: d.goldenRuns.length === 0 ? <p>No run on record.</p> : (
            <>
              <div className={s.wrap}>
                <table className={s.metrics}>
                  <thead><tr><th>run</th><th>Matcher</th><th className={s.num}>passed</th><th>by category</th><th className={s.num}>cost</th></tr></thead>
                  <tbody>
                    {d.goldenRuns.map((g) => (
                      <tr key={g.file}>
                        <td>{fmtDate(g.generatedAt)}</td>
                        <td><code>{g.matcherModel}</code></td>
                        <td className={s.num}>{g.summary.passed}/{g.summary.total}</td>
                        <td className={s.note}>{Object.entries(g.summary.byCategory).map(([k, v]) => `${k.replace(/_/g, " ")} ${v.passed}/${v.total}`).join(", ")}</td>
                        <td className={s.num}>{g.costMicroUsd != null ? `$${microToUsd(g.costMicroUsd)!.toFixed(2)}` : "n/a"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={s.small}>Each run&rsquo;s decisions and reasoning: <a href={`${GH}/corpus/scorecards/golden-matcher/`}>the committed run files</a>.</p>
            </>
          ),
        },
        {
          title: "In CI",
          body: <p>Every pull request that touches the Matcher, its prompt, the constitution, retrieval, a provider adapter, or the fixture runs the suite on the production Matcher and fails below 95% (29 of 30). Without the provider secrets it reports that it skipped. Workflow: <a href={`${GH}/.github/workflows/golden-matcher.yml`}>golden-matcher.yml</a>.</p>,
        },
        {
          title: "What it cannot show",
          body: <p>How the Matcher does on cases we did not write. Thirty pairs, mostly from one cluster&rsquo;s subject, passed in full on the first run. It catches a regression on those thirty.</p>,
        },
        { title: "Run it", body: <Cmd>{`npm run corpus:golden -- --profile=production
npm run corpus:golden -- --category=negation --model=claude-haiku-4-5-20251001
npm run corpus:golden -- --min-pass=0.95              # the CI gate`}</Cmd> },
      ];
    },
  },
  {
    slug: "graph-agreement",
    kind: "eval",
    group: "stable",
    title: "Graph agreement",
    line: "How different are two graphs built from the same documents? The measurement the next three evals use.",
    tags: () => [{ text: "built and tested; no committed run", kind: "notyet" }, { text: "free; cents with --confirm", kind: "cost" }],
    sections: (d) => [
      {
        title: "Three numbers",
        open: true,
        body: (
          <>
            <ul>
              <li><strong>Claims:</strong> precision, recall and F1 over a one-to-one matching of the two graphs&rsquo; claims. Unmatched claims are attributed to the agent that created them.</li>
              <li><strong>Verdicts:</strong> on matched claims, how far apart the <G t="credence">credences</G> are, and how often the status agrees.</li>
              <li><strong>Edges:</strong> mapped through the matching, edge precision and recall, and the edit distance between the two <G t="decomposition">decompositions</G>.</li>
            </ul>
            <p>Code, pure and unit tested: <a href={`${GH}/scripts/corpus/graph-agreement.ts`}>graph-agreement.ts</a>.</p>
          </>
        ),
      },
      {
        title: "How claims are matched",
        hint: "and the pair judge's prompt",
        body: (
          <>
            <p>Exact text first, then stored embeddings above 0.85 cosine, greedily one-to-one. Pairs between 0.85 and 0.95 are the ambiguous band: kept and reported, or, with <code>--confirm</code>, sent to a judge on {d.index.judge.label} with this prompt:</p>
            <pre>{d.artifacts.pairJudge.prompt}</pre>
            <p className={s.small}>It answers <code>same_proposition</code> (true/false) and a one-line reason.</p>
          </>
        ),
      },
      {
        title: "What it cannot show",
        body: <p>Which graph is better. And the matching is itself a matcher, with a threshold chosen by hand and never checked against the <Link href="/docs/evals/golden-pairs">golden pairs</Link>: two wordings of one claim can read as disagreement.</p>,
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:snapshot -- save run1          # after one run
npm run corpus:run -- blackholes              # run again
npm run corpus:agreement -- snap:run1 db --confirm`}</Cmd> },
    ],
  },
  {
    slug: "properties",
    kind: "eval",
    group: "stable",
    title: "Same graph twice",
    line: "Build the graph twice with nothing changed (the noise floor), or with the documents in a different order (which should not matter).",
    tags: () => [{ text: "built; never run", kind: "notyet" }, { text: "two runs", kind: "cost" }],
    sections: () => [
      {
        title: "Two arms",
        open: true,
        body: (
          <>
            <TwoArmDiagram change="same, or shuffled order" />
            <p><strong>Idempotency:</strong> the same setup twice. The disagreement between the arms is the pipeline&rsquo;s own noise, and the floor every other comparison is read against.</p>
            <p><strong>Path independence:</strong> arm B reads the documents in a seeded random order. The <G t="Matcher" /> is stateful, since the first wording it sees becomes the claim, so order can change the graph; <C n="2" /> and <C n="3" /> say it should not.</p>
            <p>Both arms are child runs, saved as <G t="snapshot">snapshots</G>, and compared by <Link href="/docs/evals/graph-agreement">graph agreement</Link>. One pair of arms is one sample.</p>
          </>
        ),
      },
      {
        title: "What it cannot show",
        body: <p>Anything under hostile input. The rule is that every invariance is tested benign and adversarial; the adversarial arms (a hostile order, a hostile rewording) are not built. Nor are the other invariances in the plan: paraphrase, cascade stability, granularity.</p>,
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:property -- idempotency blackholes --profile=production
npm run corpus:property -- path-independence blackholes --seed=3 --baseline=<snapshot>`}</Cmd> },
    ],
  },
  {
    slug: "model-swap",
    kind: "eval",
    group: "stable",
    title: "Model swap",
    line: "The same cluster twice with one agent on a different model. Is the cheaper model faithful to the stronger one, and at what price?",
    tags: () => [{ text: "built; never run", kind: "notyet" }, { text: "two runs, arm B at its model's price", kind: "cost" }],
    sections: () => [
      {
        title: "Two arms",
        open: true,
        body: (
          <>
            <TwoArmDiagram change="one agent on another model" />
            <p>Arm A is the reference, normally the production models. Arm B is identical except for <code>--swap=&lt;agent&gt;:&lt;model&gt;</code>. The report is the agreement on every axis, with each arm&rsquo;s metered cost beside it.</p>
            <p>The allocator decides which model works on which claim, and today that rests on a guess. Where a cheap model agrees with the strong one it is safe to save money; where it does not is where not to.</p>
          </>
        ),
      },
      {
        title: "What it cannot show",
        body: <p>That the strong model is right. Fidelity is relative: where both are wrong together, it reads as agreement.</p>,
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:swap -- eggs --agent=steward --model=claude-sonnet-5 --profile=production --baseline=<snapshot>
npm run corpus:swap -- lableak --agent=matcher --model=claude-haiku-4-5-20251001 --profile=production`}</Cmd> },
    ],
  },
  // ------------------------------------------------------------------ governance
  {
    slug: "contribution-scenarios",
    kind: "eval",
    group: "governance",
    title: "Contribution scenarios",
    line: "Four made-up users submit scripted contributions against a graph. The report shows what the Reviewer and Arbitrator did and why.",
    tags: (d) => [{ text: "built; never run", kind: "notyet" }, ...(d.scenarios[0] ? [{ text: `1 scenario · ${d.scenarios[0].contributions.length} contributions` }] : []), { text: "$10 – 30, estimated", kind: "cost" }],
    sections: (d) => {
      const sc = d.scenarios[0];
      return [
        {
          title: "The path",
          open: true,
          body: (
            <>
              <ContributionDiagram />
              <p>Ingesting documents never exercises reviews, escalations or appeals. This does: each contribution goes through the same service the public route uses, the queues are drained so the real <G t="Reviewer" /> and <G t="Arbitrator" /> run, then appeals are filed for the rejections the script says to appeal, and the queues are drained again.</p>
            </>
          ),
        },
        ...(sc
          ? [{
              title: "The scenario",
              hint: `${sc.contributors.length} personas, ${sc.contributions.length} contributions`,
              body: (
                <>
                  <p className={s.small}>Verbatim from <a href={`${GH}/corpus/contributions/${sc.scenario}.json`}>{sc.scenario}.json</a>. The <em>expect</em> note says what a reviewer honouring the policies would plausibly do; no gate reads it.</p>
                  <ul>
                    {sc.contributors.map((c) => <li key={c.key}><strong>{c.displayName.replace(" (corpus persona)", "")}</strong> <span className={s.note}>({c.key})</span>: {c.note}</li>)}
                  </ul>
                  {sc.contributions.map((c) => (
                    <details key={c.id} style={{ margin: "0.4rem 0" }}>
                      <summary className={s.small} style={{ cursor: "pointer" }}>{c.type.replace(/_/g, " ")} · {c.contributor} · <code>{c.id}</code>{c.appealIfRejected ? " · appeals if rejected" : ""}</summary>
                      <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(c, null, 2)}</pre>
                    </details>
                  ))}
                </>
              ),
            }]
          : []),
        {
          title: "What the report contains",
          body: <p>Per contribution: the decision, its reasoning, confidence and policy citations, any bad-faith finding, the appeal and the arbitration outcome, and what changed on the claim. Then decisions by type, escalation and overturn rates, reputation changes per persona, and the cost. Read the reasoning; a decision that differs from the note is a reason to read closely, not a failure.</p>,
        },
        {
          title: "What it cannot show",
          body: <p>Robustness. Ten contributions written by the people who wrote the policies is a smoke test of the path. The adaptive attacker in the plan is not built.</p>,
        },
        { title: "Run it", body: <Cmd>{`npm run corpus:run -- blackholes --profile=production    # the graph to contribute against
npm run corpus:contributions -- blackholes --dry-run      # resolve targets, print the plan
npm run corpus:contributions -- blackholes                # submit, drain, appeal, drain, report`}</Cmd> },
      ];
    },
  },
  // ------------------------------------------------------------------ reality
  {
    slug: "predictions",
    kind: "eval",
    group: "reality",
    title: "Predictions",
    line: "Twenty-two questions the world will settle, seeded as claims. When they resolve, the Steward's probabilities are scored against what happened.",
    tags: (d) => [{ text: `${d.index.predictions.count} questions, authored ${d.index.predictions.authoredAt ?? ""}` }, { text: "not yet seeded into production", kind: "notyet" }, { text: `first resolutions ${d.index.predictions.firstResolution ?? ""}`, kind: "notyet" }, { text: "≈22 Steward runs to seed", kind: "cost" }],
    sections: (d) => [
      {
        title: "How it works",
        open: true,
        body: (
          <>
            <PredictionTimeline />
            <p>Each question is seeded as an ordinary claim that its <G t="Steward" /> assesses like any other. The <G t="credence" /> that is scored is the last one recorded at or before the cutoff: the actual resolution, or the scheduled date if that came first. A question with no credence in time counts as declined, not scored.</p>
            <p>Scores: Brier, log score, a calibration curve with expected calibration error, per domain, and against market forecasts once those are attached (none yet). Code: <a href={`${GH}/scripts/corpus/prediction-score.ts`}>prediction-score.ts</a>.</p>
          </>
        ),
      },
      {
        title: `The ${d.index.predictions.count} questions`,
        hint: "the fixture, verbatim",
        body: (
          <>
            <p className={s.small}>Open a row for what counts as yes and where to look. File: <a href={`${GH}/corpus/predictions/manifest.json`}>manifest.json</a>.</p>
            {[...d.predictions].sort((a, b) => a.resolutionDate.localeCompare(b.resolutionDate)).map((p) => (
              <details key={p.id} style={{ margin: "0.3rem 0" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.92rem" }}><span className={s.small}>{p.resolutionDate} · {p.domain} · </span>{p.claim}</summary>
                <div style={{ padding: "0.3rem 0 0.6rem 1rem" }}>
                  <p className={s.small}><strong>Resolves yes if:</strong> {p.resolutionCriterion}</p>
                  <p className={s.small}><strong>Where to look:</strong> {p.operationalization}</p>
                  {p.notes ? <p className={s.small}><strong>Note:</strong> {p.notes}</p> : null}
                </div>
              </details>
            ))}
          </>
        ),
      },
      {
        title: "What it cannot show",
        body: <p>Anything about claims that never resolve, which is most of the graph. The questions are in-house, several are correlated, and no market baseline is attached, so the curve will be thin for a long time.</p>,
      },
      { title: "Run it", body: <Cmd>{`npm run predictions -- list
npm run predictions -- seed --corpus --drain        # assess the seeds now (LLM spend)
npm run predictions -- resolve <id> yes|no --note="how"
npm run predictions -- score`}</Cmd> },
    ],
  },
  // ------------------------------------------------------------------ background
  {
    slug: "corpus",
    kind: "background",
    group: "background",
    title: "The documents",
    line: "Four fixed sets of documents, each chosen to stress something different.",
    sections: (d) => [
      {
        title: "The four clusters",
        open: true,
        body: (
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>cluster</th><th className={s.num}>documents</th><th className={s.num}>words</th><th>chosen for</th></tr></thead>
              <tbody>
                {d.index.clusters.map((c) => (
                  <tr key={c.key}><td><code>{c.key}</code></td><td className={s.num}>{c.posts}</td><td className={s.num}>{c.words.toLocaleString()}</td><td>{WHY[c.key] ?? c.kind}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      },
      ...d.index.clusters.map((c) => ({
        title: c.key,
        hint: `${c.posts} documents`,
        body: (
          <>
            <p>{c.description}</p>
            <p className={s.small}>{c.source}</p>
            <ul>
              {c.sources.map((src) => (
                <li key={src.id}>{src.url ? <a href={src.url}>{src.title}</a> : src.title}{src.author ? <span className={s.small}> · {src.author}</span> : null}{src.role ? <span className={s.small}> · {src.role}</span> : null}</li>
              ))}
            </ul>
          </>
        ),
      })),
      {
        title: "Isolation",
        body: <p>Runs use a separate database. Every harness tool refuses the live database by name. So the claims a run produces are not the claims on this site, and cannot be linked from here.</p>,
      },
    ],
  },
  {
    slug: "models-and-cost",
    kind: "background",
    group: "background",
    title: "Models and cost",
    line: "What each agent runs on in production, what has been measured, and what a run should cost.",
    sections: (d) => {
      const rate = (m: string) => d.index.rates[m];
      const steward = d.index.pins.find((p) => p.agent === "steward");
      const f = steward ? rate(steward.model) : null;
      const j = rate(d.index.judge.model);
      return [
        {
          title: "What the agents run on",
          hint: "read from the deployment at sync",
          open: true,
          body: (
            <>
              <div className={s.wrap}>
                <table className={s.metrics}>
                  <thead><tr><th>agent</th><th>model</th><th className={s.num}>$ / M input</th><th className={s.num}>$ / M output</th></tr></thead>
                  <tbody>
                    {d.index.pins.map((p) => { const r = rate(p.model); return (
                      <tr key={p.envVar}><td>{p.agent}</td><td>{p.label} <span className={s.dim}><code>{p.model}</code></span></td><td className={s.num}>{r ? r.inputPerMtok.toFixed(2) : "provider-priced"}</td><td className={s.num}>{r ? r.outputPerMtok.toFixed(2) : "provider-priced"}</td></tr>
                    ); })}
                    <tr><td>judge <span className={s.dim}>(evals only)</span></td><td>{d.index.judge.label} <span className={s.dim}><code>{d.index.judge.model}</code></span></td><td className={s.num}>{j?.inputPerMtok.toFixed(2) ?? "provider-priced"}</td><td className={s.num}>{j?.outputPerMtok.toFixed(2) ?? "provider-priced"}</td></tr>
                  </tbody>
                </table>
              </div>
              <p className={s.small}>List rates from <a href={`${GH}/src/llm/pricing.ts`}>pricing.ts</a>, the table the system bills through. Pins from <a href={`${GH}/infra/lib/api-stack.ts`}>api-stack.ts</a>. <code>--profile=production</code> applies exactly these.</p>
            </>
          ),
        },
        {
          title: "What has been measured",
          body: (
            <div className={s.wrap}>
              <table className={s.metrics}>
                <thead><tr><th>what</th><th>setup</th><th className={s.num}>cost</th></tr></thead>
                <tbody>
                  <tr><td>golden pairs, 30 decisions</td><td>DeepSeek V4 Flash</td><td className={s.num}>{d.goldenRuns[0]?.costMicroUsd != null ? `$${microToUsd(d.goldenRuns[0].costMicroUsd)!.toFixed(2)}` : "cents"}</td></tr>
                  <tr><td>blackholes ingest, 11 Steward runs, capped</td><td>Sonnet Steward, 12 iterations, Curator off</td><td className={s.num}>$11.29</td></tr>
                  <tr><td>judge, 13 verdicts</td><td>{d.index.judge.label}</td><td className={s.num}>{d.scorecards[0]?.card.cost ? `$${d.scorecards[0].card.cost.usd.toFixed(2)}` : "$0.60"}</td></tr>
                </tbody>
              </table>
            </div>
          ),
        },
        {
          title: "What a run should cost",
          hint: "estimate",
          body: (
            <>
              <div className={s.wrap}>
                <table className={s.metrics}>
                  <thead><tr><th>cluster</th><th className={s.num}>documents</th><th className={s.num}>Steward runs</th><th className={s.num}>per run</th></tr></thead>
                  <tbody>
                    {d.index.clusters.map((c) => <tr key={c.key}><td><code>{c.key}</code></td><td className={s.num}>{c.posts}</td><td className={s.num}>{ESTIMATE[c.key]?.stewardRuns ?? "?"}</td><td className={s.num}>{ESTIMATE[c.key]?.usd ?? "?"}</td></tr>)}
                  </tbody>
                </table>
              </div>
              <p className={s.small}>Basis, as of 2026-09-04: the Steward is nearly the whole cost, one per extracted claim (about seven per document), each a tool-using loop over a prompt that carries the entire constitution. A Sonnet Steward capped at twelve iterations cost about $1 a run; production uses {steward?.label} at {f && j ? `${(f.inputPerMtok / j.inputPerMtok).toFixed(1)}×` : "several times"} the rate with a 200-iteration budget, so $2 – 6 per Steward run, plus Curator sweeps. The first metered production run replaces this table.</p>
            </>
          ),
        },
        {
          title: "Spending limits",
          body: (
            <>
              <p>Set in <code>.env</code>; 0 means unlimited. The production profile sets models only, not these.</p>
              <ul>
                <li><code>STEWARD_MAX_RUNS</code>: total Steward runs in a run. The main cap.</li>
                <li><code>STEWARD_MAX_ITERATIONS</code>: tool calls within one Steward run. 200 by default; lower it only for smoke tests.</li>
                <li><code>CURATOR_MAX_RUNS</code>, <code>CURATOR_SWEEP_RATE</code>: Curator sweeps; rate 0 disables.</li>
                <li><code>LLM_DAILY_TOKEN_LIMIT</code>, <code>LLM_HOURLY_TOKEN_LIMIT</code>: the circuit breaker; the run stops cleanly when hit.</li>
              </ul>
              <p>Every run prints its exact metered cost at the end.</p>
            </>
          ),
        },
      ];
    },
  },
  {
    slug: "ground-rules",
    kind: "background",
    group: "background",
    title: "Ground rules",
    line: "The rules every eval is held to. They come from the master plan, issue #334.",
    sections: () => [
      {
        title: "The rules",
        open: true,
        body: (
          <ol>
            <li><strong>No answer key for contested questions.</strong> The judge&rsquo;s standard is the <G t="constitution" />, never its own opinion.</li>
            <li><strong>Two places reality can check the graph:</strong> <Link href="/docs/evals/predictions">predictions</Link>, which resolve slowly, and <Link href="/docs/evals/model-swap">agreement between models</Link>, which is fast but relative. Neither becomes a truth score for the rest.</li>
            <li><strong>Expert consensus is never the referent.</strong> Distance from consensus is reported, never used as a gate.</li>
            <li><strong>One run is one sample.</strong> Groups of about three, and a change must clear the spread (<Link href="/docs/evals/noise-band">comparing runs</Link>).</li>
            <li><strong>Every invariance is tested benign and adversarial.</strong> The adversarial case shows the invariance is not empty. Not yet met.</li>
            <li><strong>Numbers inform; they never decide.</strong> No eval score changes a verdict or a claim&rsquo;s importance (<C n="judgment">judgment over mechanism</C>).</li>
            <li><strong>Stability plus calibration is the argument.</strong> A graph that is stable under changes that should not matter, and calibrated where it can be checked, has earned some trust where it cannot be.</li>
            <li><strong>Judges are reviewed before they are trusted.</strong> No judge number feeds a decision until a person has read its verdicts (<Link href="/docs/evals/judge-review">judge review</Link>).</li>
          </ol>
        ),
      },
      { title: "The plan", body: <p>The full plan, with the nine suites it lays out and their reasoning: <a href={PLAN}>issue #334</a>. Standing per suite: <Link href="/docs/evals/not-yet">not measured yet</Link>.</p> },
    ],
  },
  {
    slug: "rubric",
    kind: "background",
    group: "background",
    title: "The rubric",
    line: "The standards a run's report is read against, section by section, with the failure modes to look for.",
    sections: () => [],
  },
  {
    slug: "run-record",
    kind: "background",
    group: "background",
    title: "What a run leaves behind",
    line: "Every model call, every agent's transcript, every enqueue, and a registry of eval runs. The committed files are the record.",
    sections: () => [
      {
        title: "What is kept",
        open: true,
        body: (
          <ul>
            <li><strong>Every model call:</strong> agent, model, tokens, cost at the price then in effect, the claim it served, the run it belonged to. Kept indefinitely.</li>
            <li><strong>Every agent run and step:</strong> the full tool-use transcript. On in production since 2026-09-02, kept 30 days.</li>
            <li><strong>Every enqueue:</strong> which run triggered which, so cascades can be traced.</li>
            <li><strong>Every eval run</strong>, in a registry with its <G t="fingerprint" /> and result.</li>
          </ul>
        ),
      },
      {
        title: "Where it lives",
        body: (
          <>
            <p>The registry is in each developer&rsquo;s test database, so it is a per-machine index, not shared history. The committed files are the record: <a href={`${GH}/corpus/scorecards`}>scorecards</a>, golden runs beside them, <a href={`${GH}/corpus/calibration`}>review sheets</a>. This guide renders only from those files.</p>
            <p>Agreement, swap, property and contribution runs have no committed home yet: they register locally and report into a directory git ignores. Until an export exists they reach this guide by hand.</p>
          </>
        ),
      },
    ],
  },
  {
    slug: "not-yet",
    kind: "background",
    group: "background",
    title: "Not measured yet",
    line: "What no eval covers, and where the design itself may be wrong.",
    sections: () => [
      {
        title: "Not measured",
        open: true,
        body: (
          <ul>
            <li><strong>Anything on the production models.</strong> The one scored run used a Sonnet Steward, capped, with the Matcher mis-recorded. The next thing to do is three production-profile runs of one cluster.</li>
            <li><strong>The noise floor.</strong> Idempotency has never been run, so no comparison has a scale.</li>
            <li><strong>Anything adversarial.</strong> No hostile inputs, no attacker, no campaigns.</li>
            <li><strong>Governance.</strong> The Reviewer and Arbitrator have never been read under controlled input.</li>
            <li><strong>Model fidelity.</strong> No swap has run; the allocator&rsquo;s tiering rests on a guess.</li>
            <li><strong>The judge&rsquo;s newest dimensions.</strong> Sycophancy, hedging, canonical-form strength and political bias: never judged on a real run, never reviewed.</li>
            <li><strong>Calibration.</strong> Nothing seeded into production, nothing resolved, no market baseline.</li>
            <li><strong>The live graph.</strong> Every eval runs on test graphs. Nothing measures the quality of what visitors read.</li>
          </ul>
        ),
      },
      {
        title: "Where the design may be wrong",
        body: (
          <ul>
            <li><strong>The judge is weaker than the judged.</strong> Sonnet grades Fable, one model family, no second judge.</li>
            <li><strong>The judge&rsquo;s reviewer wrote its prompt.</strong> An outside reader would be a stronger check.</li>
            <li><strong>Agreement is measured by another matcher</strong>, with a hand-picked embedding threshold never checked against the golden pairs.</li>
            <li><strong>The golden suite is thirty in-house pairs at its ceiling.</strong> It will catch regressions on those thirty.</li>
            <li><strong>Clusters are small; the judge sample is a fraction</strong> of a large one and the whole of a small one.</li>
            <li><strong>The cost model is extrapolated</strong> from one capped Sonnet run.</li>
            <li><strong>Predictions are in-house and correlated</strong>, with no crowd baseline.</li>
            <li><strong>Authorship counts rewrites, not improvements.</strong> Whether the Matcher&rsquo;s rewording was better is not judged.</li>
            <li><strong>The 1–5 scales may be dead weight.</strong> The first review found they carried nothing the flags did not.</li>
          </ul>
        ),
      },
      {
        title: "The plan's nine suites",
        body: (
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>suite</th><th>what</th><th>standing</th></tr></thead>
              <tbody>
                {([
                  ["S1", "per-PR golden suite", "built, in CI"],
                  ["S2", "quality scorecard", "built; newest four dimensions unreviewed"],
                  ["S3", "properties and stability", "idempotency, path independence, coherence rules; no adversarial arms"],
                  ["S4", "adversarial robustness", "not built"],
                  ["S5", "downstream-reasoner probe", "not built"],
                  ["S6", "calibration track", "built; not seeded into production"],
                  ["S7", "model economics and lifecycle", "guard and swap runner; discover and adopt not built"],
                  ["S8", "persona simulation", "not built"],
                  ["S9", "production monitors", "not built"],
                ] as const).map(([k, what, standing]) => <tr key={k}><td>{k}</td><td>{what}</td><td className={s.note}>{standing}</td></tr>)}
              </tbody>
            </table>
          </div>
        ),
      },
    ],
  },
  {
    slug: "reproduce",
    kind: "background",
    group: "background",
    title: "Run it yourself",
    line: "A clone, Docker, three provider keys, and the commands in order.",
    sections: () => [
      {
        title: "Setup",
        open: true,
        body: (
          <>
            <p>Node 22, Docker, and keys: Anthropic for the agents, OpenAI for embeddings, OpenRouter for the Matcher. Every harness tool refuses the live database by name; the worst a mistake can do is cost money.</p>
            <Cmd>{`git clone https://github.com/minerval-ai/minerval && cd minerval && npm ci
docker compose up -d                     # Postgres 16 + pgvector
cp .env.example .env                     # add ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
npm run corpus:reset                     # the separate database`}</Cmd>
          </>
        ),
      },
      {
        title: "The evals, in a sensible order",
        body: (
          <Cmd>{`npm run corpus:golden -- --profile=production                    # cents
npm run corpus:run -- blackholes --profile=production --limit=1   # read the meter
npm run corpus:run -- blackholes --profile=production --score     # a baseline; three times
npm run corpus:calibrate -- review                               # then read the judge
npm run corpus:property -- idempotency blackholes --profile=production
npm run corpus:swap -- eggs --agent=steward --model=claude-sonnet-5 --profile=production
npm run corpus:contributions -- blackholes
npm run predictions -- seed --corpus --drain`}</Cmd>
        ),
      },
      {
        title: "How this guide is updated",
        body: (
          <>
            <p>Commit the result under <code>corpus/</code>, run the sync, commit what it writes under <code>web/content/evals/</code>. The guide renders from those files at build time.</p>
            <Cmd>{`npx tsx scripts/sync-frontend-content.ts     # corpus/ → web/content/evals/`}</Cmd>
            <p className={s.small}>Harness docs: <a href={`${GH}/corpus/README.md`}>corpus/README.md</a> · <Link href="/docs/evals/rubric">the rubric</Link> · <a href={`${GH}/corpus/SCORING.md`}>SCORING.md</a>.</p>
          </>
        ),
      },
    ],
  },
];

export function topicBySlug(slug: string): Topic | undefined {
  return TOPICS.find((t) => t.slug === slug);
}

/** One row of the index table per eval: what would a visitor asking "does it work?" want to know at a glance. */
export interface IndexRow {
  property: string;
  status: string;
  statusKind?: "run" | "notyet" | "ci";
  lastRun: string;
  result: string;
  cost: string;
}

export function indexRow(slug: string, d: EvalsData): IndexRow | null {
  const latest = d.scorecards[d.scorecards.length - 1];
  const judged = d.scorecards.filter((r) => r.card.judged);
  const lj = judged[judged.length - 1];
  const golden = d.goldenRuns[d.goldenRuns.length - 1];
  const review = d.reviews[d.reviews.length - 1];
  const none = "not yet";
  switch (slug) {
    case "corpus-runs":
      return { property: "the pipeline builds a graph from fixed documents, on record", status: latest ? "run" : "not run", statusKind: latest ? "run" : "notyet", lastRun: latest ? fmtDate(latest.card.generatedAt) : none, result: latest ? `${d.scorecards.length} run${d.scorecards.length === 1 ? "" : "s"}, capped, dev models` : none, cost: "$80 – 200 est." };
    case "structural-scorecard":
      return { property: "extraction, wording, merging, depth and verdicts look sane", status: latest ? "run" : "not run", statusKind: latest ? "run" : "notyet", lastRun: latest ? fmtDate(latest.card.generatedAt) : none, result: latest ? `${latest.card.structural.extraction.totalClaims} claims, dedup ${formatMetric(latest.card.structural.matching.dedupRatio)}, single sample` : none, cost: "free" };
    case "judged-scorecard":
      return { property: "claims and verdicts meet the constitution's standards", status: lj ? "run" : "not run", statusKind: lj ? "run" : "notyet", lastRun: lj ? fmtDate(lj.card.generatedAt) : none, result: lj ? `claim bar ${formatMetric(lj.card.judged!.claimBarPassRate, "pct")} of ${lj.card.judged!.sampleSize}, single sample` : none, cost: "≈ $1" };
    case "judge-review":
      return { property: "the judge's task is one a person agrees with", status: review ? "done once" : "never", statusKind: review ? "run" : "notyet", lastRun: review?.reviewedOn ?? none, result: review ? "4 task fixes; 4 new dimensions unreviewed" : none, cost: "a person's hour" };
    case "noise-band":
      return { property: "a change is larger than run-to-run noise", status: "no group of runs", statusKind: "notyet", lastRun: none, result: "no verdict ever issued", cost: "3 runs per side" };
    case "golden-pairs":
      return { property: "the Matcher tells same, denial, narrower and different apart", status: golden ? "run · in CI" : "not run", statusKind: golden ? "ci" : "notyet", lastRun: golden ? fmtDate(golden.generatedAt) : none, result: golden ? `${golden.summary.passed}/${golden.summary.total}` : none, cost: golden?.costMicroUsd != null ? `$${microToUsd(golden.costMicroUsd)!.toFixed(2)}` : "cents" };
    case "graph-agreement":
      return { property: "two graphs from the same documents can be compared", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "free" };
    case "properties":
      return { property: "the graph is stable under a repeat and a shuffled order", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "2 runs" };
    case "model-swap":
      return { property: "a cheaper model builds the same graph as the strong one", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "2 runs" };
    case "contribution-scenarios":
      return { property: "reviews, escalations and appeals behave under scripted input", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "$10 – 30 est." };
    case "predictions":
      return { property: "the Steward's probabilities are calibrated against outcomes", status: "seeded", statusKind: "notyet", lastRun: none, result: `${d.index.predictions.count} questions, 0 resolved`, cost: "≈ 22 Steward runs" };
    default:
      return null;
  }
}
