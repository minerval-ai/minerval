import Link from "next/link";
import { DocLayout } from "@/components/DocLayout";
import { Callout, Cmd, Fingerprint, Sparkline } from "@/components/evals/Bits";
import {
  HEADLINE_METRICS,
  bandStat,
  fmtDate,
  formatMetric,
  getContributionScenarios,
  getEvalsIndex,
  getGoldenPairs,
  getGoldenRuns,
  getPredictions,
  getReviews,
  getScorecards,
  lowestScoring,
  microToUsd,
  scorecardsFor,
} from "@/lib/evals";
import { Catalogue } from "./catalogue";
import s from "./evals.module.css";

// The public evals page (#368): what we measure about the administrators,
// how each measurement works, what it costs, what the numbers say so far,
// and what we do not measure. Rendered from the record vendored into
// web/content/evals/ by scripts/sync-frontend-content.ts; no database.

export const metadata = {
  title: "How we check the work · Minerval",
  description:
    "Every eval we run on the claim graph's administrators: what it measures, how, what it costs, what the numbers say so far, and what is not measured yet.",
};

const GH = "https://github.com/minerval-ai/minerval";
const PLAN = `${GH}/issues/334`;

// Things known about specific committed records that the files themselves
// do not say. Keyed by scorecard file name; remove the entry when the record
// is superseded.
const KNOWN: Record<string, { flagged?: Record<string, string>; ingestCost?: string; scope?: string }> = {
  "2026-08-09T15-47-32-753Z.json": {
    flagged: { matcher: "the ingest ran DeepSeek V4 Flash; Haiku is what config said when scored" },
    ingestCost:
      "Ingest metered at $11.29 over two capped Sonnet drains (STEWARD_MAX_RUNS 3 then 8, STEWARD_MAX_ITERATIONS 12, Curator off); the file carries only the judge's cost.",
    scope: "Two of the cluster's four sources, capped: a partial baseline, cut before the production profile existed.",
  },
};

// Why each cluster is in the corpus, in a line. The manifests carry the full
// rationale and the source list; both are rendered below.
const WHY: Record<string, string> = {
  lethalities: "dense claim overlap and head-to-head disagreement; the stress test for disambiguation",
  blackholes: "a near-settled but deeply argued question; the control for the contested cases",
  lableak: "maximally contested, both sides steelmanned; the hardest case for holding disagreement",
  eggs: "a mundane question that is really about ways of knowing; methodology-driven cruxes",
};

// Estimated cost of one full run on the production profile, before any has
// been metered. Steward runs ≈ 7 per source (the one production batch on
// record), $2–6 per Fable Steward run, Curator sweeps on. Replace with the
// metered figure once a production-profile run exists.
const ESTIMATE: Record<string, { stewardRuns: string; usd: string }> = {
  eggs: { stewardRuns: "≈20", usd: "$60 – 140" },
  blackholes: { stewardRuns: "≈28", usd: "$80 – 200" },
  lableak: { stewardRuns: "≈35", usd: "$100 – 250" },
  lethalities: { stewardRuns: "100 – 150", usd: "$400 – 900" },
};

const SUITES: Array<[string, string, string]> = [
  ["S1", "per-PR golden suite", "built: the Matcher pairs, gated in CI"],
  ["S2", "quality scorecard", "built: judged dimensions incl. sycophancy, hedging, form, bias; the newest four unreviewed"],
  ["S3", "properties and stability", "partly: idempotency, path independence and the §21 coherence rules; no adversarial arms, no cascade or paraphrase invariance"],
  ["S4", "adversarial robustness", "not built: needs the contribution driver, which exists, plus the attack fixtures and the adaptive attacker"],
  ["S5", "downstream-reasoner probe", "not built"],
  ["S6", "calibration track", "built: fixture, schema, scoring; not yet seeded into production, nothing resolved"],
  ["S7", "model economics and lifecycle", "partly: the model guard and the swap runner; discover and adopt stages not built"],
  ["S8", "persona simulation", "not built"],
  ["S9", "production monitors", "not built: the live graph's quality is unmeasured"],
];

const toc = [
  { depth: 2, text: "The problem", slug: "the-problem" },
  { depth: 2, text: "The rules every number obeys", slug: "the-rules" },
  { depth: 2, text: "The corpus", slug: "the-corpus" },
  { depth: 2, text: "What production runs on", slug: "the-models" },
  { depth: 2, text: "What a run costs", slug: "cost" },
  { depth: 2, text: "The evals", slug: "the-evals" },
  { depth: 3, text: "Corpus runs", slug: "eval-corpus-runs" },
  { depth: 3, text: "The structural scorecard", slug: "eval-structural" },
  { depth: 3, text: "The judged scorecard", slug: "eval-judged" },
  { depth: 3, text: "Judge review", slug: "eval-judge-review" },
  { depth: 3, text: "Comparison with a noise band", slug: "eval-noise-band" },
  { depth: 3, text: "Matcher golden pairs", slug: "eval-golden" },
  { depth: 3, text: "Graph agreement", slug: "eval-agreement" },
  { depth: 3, text: "Idempotency and path independence", slug: "eval-properties" },
  { depth: 3, text: "Model swap", slug: "eval-swap" },
  { depth: 3, text: "Contribution scenarios", slug: "eval-contributions" },
  { depth: 3, text: "Predictions", slug: "eval-predictions" },
  { depth: 3, text: "The record a run leaves", slug: "eval-record" },
  { depth: 2, text: "Results so far", slug: "results" },
  { depth: 3, text: "Golden pairs", slug: "results-golden" },
  { depth: 3, text: "Review status", slug: "results-review" },
  { depth: 3, text: "Predictions", slug: "results-predictions" },
  { depth: 2, text: "What we do not measure yet", slug: "not-yet" },
  { depth: 2, text: "Open questions about the design", slug: "open-questions" },
  { depth: 2, text: "Reproduce it", slug: "reproduce" },
];

export default function EvalsPage() {
  const index = getEvalsIndex();
  const scorecards = getScorecards();
  const goldenRuns = getGoldenRuns();
  const goldenFixture = getGoldenPairs();
  const reviews = getReviews(index);
  const predictions = getPredictions();
  const scenarios = getContributionScenarios();

  const showPairs = ["neg-01", "diff-01", "hard-01"]
    .map((id) => goldenFixture.pairs.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  const clustersWithCards = index.clusters.filter((c) => scorecardsFor(c.key, scorecards).length > 0);
  const latestReview = reviews[reviews.length - 1] ?? null;
  const reviewedOn = latestReview?.reviewedOn ?? null;
  const clusterToc = clustersWithCards.map((c) => ({ depth: 3, text: `${c.key}`, slug: `results-${c.key}` }));
  const fullToc = [...toc.slice(0, toc.findIndex((t) => t.slug === "results") + 1), ...clusterToc, ...toc.slice(toc.findIndex((t) => t.slug === "results") + 1)];
  const rate = (model: string) => index.rates[model];

  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs">← docs</Link>
      </p>
      <DocLayout
        toc={fullToc}
        aside={
          <aside className="rail-note">
            <span className="sc">From the record</span>
            Rendered from files committed to the repository: the scorecards, the golden runs,
            the filled review sheets, and the fixtures, synced from commit{" "}
            <code>{index.gitCommit ?? "unknown"}</code> on {fmtDate(index.syncedAt)}. Nothing on
            this page reads a live database. Publishing a result is a pull request.
          </aside>
        }
      >
        <div className="doc">
          <p className="sc" style={{ marginBottom: ".5rem" }}>Documentation</p>
          <h1>How we check the work</h1>
          <p className="lede">
            What we measure about the administrators, how each measurement works, what it
            costs, what the numbers say so far, and what we do not measure yet. Enough detail
            that a stranger with the repository can run any of it.
          </p>

          {/* ---------------------------------------------------------------- */}
          <h2 id="the-problem">The problem</h2>
          <p className="dropcap">
            The pipeline is the product, and it is built by nondeterministic agents whose
            output is a graph rather than a return value. A prompt edit, a model change, or a
            refactor can change what they build without any test noticing. So we measure the
            administrators more seriously than almost anything else in the project, and until
            this page none of it was visible to anyone who had not cloned the repository. That
            is a strange gap for a project whose whole pitch is that reasoning should be
            inspectable. The constitution&rsquo;s commitments, clarity over resolution, honest
            uncertainty, every judgment open to challenge, apply to our own quality claims too.
          </p>
          <p>
            The difficulty is that there is no ground truth for the contested core. Grading a
            verdict on whether SARS-CoV-2 came from a lab would require an already-correct
            Minerval to grade against. Two narrow exceptions exist and each has a track:
            predictions, where reality resolves the claim, and model agreement, where a cheaper
            model is measured against a stronger one. For everything else the standard is the
            constitution, and the method is comparison: the same graph built again under a
            change that should not matter, or measured against itself over time. What follows
            is that method, instrument by instrument.
          </p>

          {/* ---------------------------------------------------------------- */}
          <h2 id="the-rules">The rules every number obeys</h2>
          <p>
            Eight principles, settled across the plan&rsquo;s predecessors and treated as fixed.
            Every eval below is constrained by them.
          </p>
          <ol>
            <li><strong>No ground truth for the contested core.</strong> The judge&rsquo;s standard is the constitution, never the judge&rsquo;s intuition.</li>
            <li><strong>Exactly two correctness exceptions.</strong> Predictions, absolute but slow; model agreement, fast but relative. Neither generalizes into a truth score for the rest of the graph.</li>
            <li><strong>Expert consensus is never a referent.</strong> Divergence from consensus is measured as an output, never used as a gate.</li>
            <li><strong>Nondeterminism means noise bands.</strong> Stated below.</li>
            <li><strong>Every invariance is tested benign and adversarial.</strong> The adversarial case is the negative control proving the invariance is not vacuous. (Not yet met; see <a href="#not-yet">what we do not measure</a>.)</li>
            <li><strong>Judgment over mechanism.</strong> Metrics inform ordering, thresholds, and human decisions; they never decide a verdict, and money never touches a claim&rsquo;s importance. The eval system reports; it does not adjudicate.</li>
            <li><strong>The compounding argument.</strong> Internal uniformity plus calibration where reality is checkable together license extending trust to the unmeasurable core. Neither alone suffices.</li>
            <li><strong>Judges are reviewed before they are trusted.</strong> No judge&rsquo;s numbers feed a decision until a human has read its verdicts and reasoning against the pinned standards. No human-versus-judge agreement statistic is kept.</li>
          </ol>
          <Callout label="One run is one sample">
            <p>
              LLM output is nondeterministic. A configuration&rsquo;s value for a metric is the
              mean over its runs and its noise is their spread, so each side of a comparison is
              a group of about three runs, and a difference of means counts only when it
              exceeds the combined spread. A single run gets its numbers printed and no
              verdict. Every figure on this page that comes from one run is marked as a single
              sample, and none of them is yet a group.
            </p>
          </Callout>

          {/* ---------------------------------------------------------------- */}
          <h2 id="the-corpus">The corpus</h2>
          <p>
            Four pinned clusters of sources, committed to the repository so a run is
            reproducible offline. Three are the FLF Epistack case studies and the intended
            production seed set. Each was chosen to stress something different.
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead>
                <tr><th>cluster</th><th>sources</th><th className={s.num}>words</th><th>chosen for</th></tr>
              </thead>
              <tbody>
                {index.clusters.map((c) => (
                  <tr key={c.key}>
                    <td><code>{c.key}</code></td>
                    <td className={s.num}>{c.posts}</td>
                    <td className={s.num}>{c.words.toLocaleString()}</td>
                    <td>{WHY[c.key] ?? c.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {index.clusters.map((c) => (
            <details key={c.key} style={{ marginBottom: ".6rem" }}>
              <summary className={s.small} style={{ cursor: "pointer" }}>
                <code>{c.key}</code>: why, and the {c.posts} sources
              </summary>
              <p style={{ marginTop: ".6rem" }}>{c.description}</p>
              <p className={s.small}>{c.source}</p>
              <ul>
                {c.sources.map((src) => (
                  <li key={src.id}>
                    {src.url ? <a href={src.url}>{src.title}</a> : src.title}
                    {src.author ? <span className={s.small}> · {src.author}</span> : null}
                    {src.role ? <span className={s.small}> · {src.role}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          ))}
          <p>
            Every run happens against an isolated database, never the main graph, so a cluster
            can be wiped and rebuilt freely. The main database is refused by name by every
            tool in the harness. A consequence worth knowing: the claims a corpus run produces
            are not the claims on this site, so a low-scoring claim below cannot be linked to a
            live page.
          </p>

          {/* ---------------------------------------------------------------- */}
          <h2 id="the-models">What production runs on</h2>
          <p>
            An eval that says something about production has to run on what production runs
            on. The pins below are read from the deployment definition at sync time; a run
            started with <code>--profile=production</code> applies exactly these before config
            loads and records them in its fingerprint, and a scorecard shows which it ran on.
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead>
                <tr><th>agent</th><th>model</th><th className={s.num}>input $ / M tokens</th><th className={s.num}>output $ / M tokens</th></tr>
              </thead>
              <tbody>
                {index.pins.map((p) => {
                  const r = rate(p.model);
                  return (
                    <tr key={p.envVar}>
                      <td>{p.agent}</td>
                      <td>{p.label} <span className={s.dim}><code>{p.model}</code></span></td>
                      <td className={s.num}>{r ? r.inputPerMtok.toFixed(2) : "provider-priced"}</td>
                      <td className={s.num}>{r ? r.outputPerMtok.toFixed(2) : "provider-priced"}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td>judge <span className={s.dim}>(eval only)</span></td>
                  <td>{index.judge.label} <span className={s.dim}><code>{index.judge.model}</code></span></td>
                  <td className={s.num}>{rate(index.judge.model)?.inputPerMtok.toFixed(2) ?? "provider-priced"}</td>
                  <td className={s.num}>{rate(index.judge.model)?.outputPerMtok.toFixed(2) ?? "provider-priced"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={s.small}>
            List rates from the metering table the system bills through; cache reads are billed
            at a tenth of the input rate and cache writes at 1.25×. A provider-priced model
            reports its own cost per call, which the meter records instead. The judge runs a
            different model from the agents it grades, and the scorer refuses a judge that is
            the Steward model the graph was built with.
          </p>

          {/* ---------------------------------------------------------------- */}
          <h2 id="cost">What a run costs</h2>
          <p>
            Three cost points have been measured. None is on the production profile, which is
            why the second table is an estimate.
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>measured</th><th>setup</th><th className={s.num}>cost</th></tr></thead>
              <tbody>
                <tr><td>Golden Matcher suite, {index.golden.pairs} decisions</td><td>DeepSeek V4 Flash, the production pin</td><td className={s.num}>{goldenRuns[0]?.costMicroUsd != null ? `$${microToUsd(goldenRuns[0].costMicroUsd)!.toFixed(2)}` : "cents"}</td></tr>
                <tr><td>Blackholes ingest, 11 Steward runs, capped</td><td>Sonnet Steward, 12 iterations, Curator off</td><td className={s.num}>$11.29</td></tr>
                <tr><td>Judge, 13 verdicts</td><td>{index.judge.label}</td><td className={s.num}>{scorecards[0]?.card.cost ? `$${scorecards[0].card.cost.usd.toFixed(2)}` : "$0.60"}</td></tr>
              </tbody>
            </table>
          </div>
          <p>
            The Steward is the whole cost. One invocation is a tool-use loop with web search
            over a prompt that carries the entire constitution, and every extracted claim gets
            one; extraction, matching and embeddings are noise beside it. A Sonnet Steward at a
            twelve-iteration cap cost about a dollar a run. The production Steward runs on{" "}
            {index.pins.find((p) => p.agent === "steward")?.label}, at{" "}
            {(() => {
              const f = rate(index.pins.find((p) => p.agent === "steward")?.model ?? "");
              const j = rate(index.judge.model);
              return f && j ? `${(f.inputPerMtok / j.inputPerMtok).toFixed(1)}×` : "several times";
            })()}{" "}
            the Sonnet rate and a two-hundred-iteration budget, so the working figure is $2 to
            $6 per Steward run, and the Curator sweeps every new claim at perhaps a dollar each.
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>cluster</th><th className={s.num}>sources</th><th className={s.num}>Steward runs</th><th className={s.num}>estimated cost per run</th></tr></thead>
              <tbody>
                {index.clusters.map((c) => (
                  <tr key={c.key}>
                    <td><code>{c.key}</code></td>
                    <td className={s.num}>{c.posts}</td>
                    <td className={s.num}>{ESTIMATE[c.key]?.stewardRuns ?? "?"}</td>
                    <td className={s.num}>{ESTIMATE[c.key]?.usd ?? "?"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.small}>
            Estimates as of 2026-09-04, from the measured Sonnet run scaled by price and
            iteration budget, at about seven extracted claims per source. A fifteen-claim judge
            sample adds about a dollar. The first metered production-profile run replaces this
            table; every run prints its exact cost. The spend is bounded by <code>STEWARD_MAX_RUNS</code>{" "}
            and the token circuit breaker, which the profile does not set: choose them
            deliberately.
          </p>

          {/* ---------------------------------------------------------------- */}
          <h2 id="the-evals">The evals</h2>
          <p>
            Twelve instruments, each answering the same questions in the same order: what it
            measures, why that property is one we care about, how the measurement works, how to
            read a result, what it costs, what it cannot tell you, and the commands to run it.
            The tags under each heading are its standing as of the last sync.
          </p>
          <Catalogue
            index={index}
            scorecards={scorecards}
            goldenRuns={goldenRuns}
            goldenPairs={showPairs}
            reviews={reviews}
            scenarios={scenarios}
          />

          {/* ---------------------------------------------------------------- */}
          <h2 id="results">Results so far</h2>
          <p>
            Every number here carries three things: the date, the fingerprint of the run that
            produced it, and either a noise band or a single-sample mark. A page that
            published only its good numbers would not be an eval page; the weakest verdicts are
            shown with the judge&rsquo;s note.
          </p>
          <div className={s.clusterGrid}>
            {index.clusters.map((c) => {
              const cards = scorecardsFor(c.key, scorecards);
              const latest = cards[cards.length - 1];
              return (
                <div key={c.key} className={s.clusterCard}>
                  <p className={s.name}><code>{c.key}</code></p>
                  {latest ? (
                    <p className={s.meta}>
                      {cards.length} scored run{cards.length === 1 ? "" : "s"} · latest {fmtDate(latest.card.generatedAt)}
                      <br />epoch {latest.card.config.pipelineEpoch}
                      <br />Steward {latest.card.config.models.steward ?? "?"}{latest.card.config.profile ? ` · profile ${latest.card.config.profile}` : " · not the production profile"}
                      <br />{latest.card.judged ? `${latest.card.judged.sampleSize} claims judged by ${latest.card.judged.model}` : "structural only"}
                      <br /><a href={`#results-${c.key}`}>read</a>
                    </p>
                  ) : (
                    <p className={s.meta}>No scored run on record.<br />The next thing to cut, on the production profile, three times.</p>
                  )}
                </div>
              );
            })}
          </div>

          {clustersWithCards.map((c) => {
            const cards = scorecardsFor(c.key, scorecards);
            const latest = cards[cards.length - 1]!;
            const known = KNOWN[latest.file];
            const judged = latest.card.judged;
            const weakest = judged ? lowestScoring(judged.items, 5) : [];
            return (
              <div key={c.key}>
                <h3 id={`results-${c.key}`}>{c.key}</h3>
                {known?.scope ? <p>{known.scope}</p> : null}
                <Fingerprint config={latest.card.config} generatedAt={latest.card.generatedAt} judgeCost={latest.card.cost} flagged={known?.flagged} />
                {known?.ingestCost ? <p className={s.small}>{known.ingestCost}</p> : null}

                <div className={s.wrap}>
                  <table className={s.metrics}>
                    <thead>
                      <tr><th>headline metric</th><th className={s.num}>latest</th><th>band</th></tr>
                    </thead>
                    <tbody>
                      {HEADLINE_METRICS.map((m) => {
                        const v = m.get(latest.card);
                        const history = cards.map((r) => m.get(r.card)).filter((x): x is number => x != null && Number.isFinite(x));
                        const band = bandStat(history);
                        return (
                          <tr key={m.label}>
                            <td>{m.label}</td>
                            <td className={s.num}>{formatMetric(v, m.format)}</td>
                            <td>
                              {v == null ? (
                                <span className={s.sample}>not on this run</span>
                              ) : band.n < 2 ? (
                                <span className={s.sample}>single sample</span>
                              ) : (
                                <>
                                  <span className={s.sample}>n={band.n} · mean {formatMetric(band.mean, m.format)} ± {formatMetric(band.sd, m.format === "int" ? "num" : m.format)}</span>
                                  <Sparkline values={history} />
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className={s.small}>
                  Structural detail: {latest.card.structural.extraction.totalClaims} claims from{" "}
                  {latest.card.structural.extraction.instances} instances,{" "}
                  {latest.card.structural.extraction.topLevelClaims} top-level; statuses{" "}
                  {Object.entries(latest.card.structural.assessment.statusDistribution).map(([k, v]) => `${k} ${v}`).join(", ")};
                  mean reasoning trace {latest.card.structural.assessment.meanTraceLength.toLocaleString()} characters
                  {latest.card.structural.coherence ? `; §21 coherence: ${latest.card.structural.coherence.violations} violations, ${latest.card.structural.coherence.tensions} tensions` : ""}.
                </p>

                {judged ? (
                  <>
                    <h4>Judged ({judged.sampleSize} claims, {judged.model})</h4>
                    <div className={s.wrap}>
                      <table className={s.metrics}>
                        <tbody>
                          <tr><td>claim-bar pass rate</td><td className={s.num}>{formatMetric(judged.claimBarPassRate, "pct")}</td><td className={s.note}>reviewed {reviewedOn ?? "never"}; under the bar as amended in #372 the four misses flip</td></tr>
                          <tr><td>importance, stored vs judged</td><td className={s.num}>{judged.importanceAlignment.meanStored.toFixed(2)} vs {judged.importanceAlignment.meanJudged.toFixed(2)}</td><td className={s.note}>overrated by more than 0.2: {formatMetric(judged.importanceAlignment.overratedShare, "pct")}</td></tr>
                          <tr><td>readability / reasoning fit / impartiality</td><td className={s.num}>{judged.assessmentQuality.readability.toFixed(1)} / {judged.assessmentQuality.reasoningFit.toFixed(1)} / {judged.assessmentQuality.impartiality.toFixed(1)}</td><td className={s.note}>1–5; the first review found these carried little beyond the flags</td></tr>
                          <tr><td>granularity</td><td className={s.num}></td><td className={s.note}>{Object.entries(judged.granularity).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}</td></tr>
                          <tr><td>flags</td><td className={s.num}></td><td className={s.note}>{Object.entries(judged.flags).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}</td></tr>
                          {judged.dimensions ? (
                            Object.entries(judged.dimensions).map(([dim, dist]) => (
                              <tr key={dim}><td>{dim.replace(/([A-Z])/g, " $1").toLowerCase()}</td><td className={s.num}></td><td className={s.note}>{Object.entries(dist).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")} <span className={s.sample}>· unreviewed</span></td></tr>
                            ))
                          ) : (
                            <tr><td>sycophancy, hedging, canonical form, political bias</td><td className={s.num}>n/a</td><td className={s.note}>judged before these dimensions existed; the next scored run carries them</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <h4>The judge&rsquo;s weakest verdicts</h4>
                    <ul className={s.claims}>
                      {weakest.map((it) => (
                        <li key={it.id}>
                          <p className={s.ctext}>{it.text}</p>
                          <p className={s.cmeta}>
                            <span>status {it.status ?? "none"}</span>
                            <span>importance {it.importanceStored.toFixed(2)} stored · {it.importance_judged.toFixed(2)} judged</span>
                            <span>claim bar {it.claim_bar}</span>
                            <span>{it.readability}/{it.reasoning_fit}/{it.impartiality}</span>
                            {it.flags.length ? <span>{it.flags.map((f) => f.replace(/_/g, " ")).join(", ")}</span> : null}
                          </p>
                          <p className={s.cnote}>{it.note}</p>
                        </li>
                      ))}
                    </ul>
                    <p className={s.small}>
                      Corpus claims live in the isolated eval database, not on this site, so
                      they are quoted rather than linked. The full verdict on every sampled claim
                      is in the committed{" "}
                      <a href={`${GH}/blob/main/corpus/scorecards/${c.key}/${latest.file}`}>scorecard file</a>.
                    </p>
                  </>
                ) : null}
              </div>
            );
          })}

          <h3 id="results-golden">Golden pairs</h3>
          {goldenRuns.length === 0 ? (
            <p>No golden run on record.</p>
          ) : (
            <>
              <div className={s.wrap}>
                <table className={s.metrics}>
                  <thead>
                    <tr><th>run</th><th>Matcher</th><th className={s.num}>passed</th><th>by category</th><th className={s.num}>cost</th></tr>
                  </thead>
                  <tbody>
                    {goldenRuns.map((g) => (
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
              {goldenRuns[goldenRuns.length - 1]?.note ? <p className={s.small}>{goldenRuns[goldenRuns.length - 1]!.note}</p> : null}
              <p className={s.small}>
                The pass rate moves when the Matcher&rsquo;s model, prompt, retrieval or the
                constitution changes; the CI gate runs the suite on those pull requests and
                fails below 95%. Repository secrets for the providers are not yet configured,
                so at the time of sync the gate reports that it skipped.
              </p>
            </>
          )}

          <h3 id="results-review">Review status</h3>
          <p>
            Whether a human has read the judge&rsquo;s verdicts under the current standards, per
            dimension. There is no agreement number to show, by design; this table is the
            honest signal.
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>dimension</th><th>last reviewed</th><th>what the review changed</th></tr></thead>
              <tbody>
                <tr><td>claim bar</td><td>{reviewedOn ?? "never"}</td><td className={s.note}>the constitutional bar moved from contestation to reference (#372); four of thirteen verdicts flip under it</td></tr>
                <tr><td>importance alignment</td><td>{reviewedOn ?? "never"}</td><td className={s.note}>the judge was right: deflation on ten of thirteen matches a known Steward failure mode</td></tr>
                <tr><td>granularity, unassessed children</td><td>{reviewedOn ?? "never"}</td><td className={s.note}>a child at status none is an allocation outcome, not a defect; pinned into the judge prompt (#374)</td></tr>
                <tr><td>status calibration flags</td><td>{reviewedOn ?? "never"}</td><td className={s.note}>verified vs supported definitions pinned, and confidence vs credence semantics pinned (#374)</td></tr>
                <tr><td>readability, reasoning fit, impartiality</td><td>{reviewedOn ?? "never"}</td><td className={s.note}>sat in a 3–5 band and carried nothing the flags did not; left in place, on record for the next reviewer</td></tr>
                <tr><td>sycophancy</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04; feeds no decision until read</td></tr>
                <tr><td>hedging</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04</td></tr>
                <tr><td>canonical-form strength</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04, from the first review&rsquo;s &ldquo;not measured that should be&rdquo;</td></tr>
                <tr><td>political bias</td><td><span className={s.flag}>never</span></td><td className={s.note}>added 2026-09-04</td></tr>
              </tbody>
            </table>
          </div>
          {latestReview ? (
            <>
              <p>
                The Overall block of the latest sheet ({latestReview.cluster}, run{" "}
                <code>{latestReview.evalRun?.slice(0, 8)}</code>, reviewed {latestReview.reviewedOn}), which
                is the review&rsquo;s actual output. The{" "}
                <a href={`${GH}/blob/main/corpus/calibration/${latestReview.file}`}>full sheet</a> has
                every claim, every verdict, and the standards as pinned that day.
              </p>
              {latestReview.overall ? <pre className={s.overall}>{latestReview.overall}</pre> : null}
            </>
          ) : null}

          <h3 id="results-predictions">Predictions</h3>
          <p>
            The seeded set, with resolution dates. None has resolved; the first is due{" "}
            {index.predictions.firstResolution}. The calibration report replaces this table as
            questions settle.
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>domain</th><th>claim</th><th className={s.num}>resolves by</th></tr></thead>
              <tbody>
                {[...predictions.predictions].sort((a, b) => a.resolutionDate.localeCompare(b.resolutionDate)).map((p) => (
                  <tr key={p.id}>
                    <td>{p.domain}</td>
                    <td>{p.claim}</td>
                    <td className={s.num}>{p.resolutionDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.small}>
            Each entry&rsquo;s criterion and source of truth are in the{" "}
            <a href={`${GH}/blob/main/corpus/predictions/manifest.json`}>fixture</a>. No market
            baseline is attached yet, so the comparative against the crowd cannot be computed.
          </p>

          {/* ---------------------------------------------------------------- */}
          <h2 id="not-yet">What we do not measure yet</h2>
          <p>An honest inventory, current as of the last sync.</p>
          <ul>
            <li><strong>Nothing on the production profile.</strong> The one scored baseline ran on a Sonnet Steward, partially, capped, with a Haiku Matcher recorded and DeepSeek used. Production runs Fable. The production-profile baselines, three per cluster, are the next thing to cut, and until they exist no delta on this page has a band.</li>
            <li><strong>The noise floor.</strong> Idempotency has never been measured, so every band is hypothetical and every agreement number is without a scale.</li>
            <li><strong>Anything adversarial.</strong> No invariance has its negative control; the contribution driver exists but carries no attacks; no adaptive attacker, no campaigns.</li>
            <li><strong>Governance under load.</strong> The Reviewer and Arbitrator have never been read under controlled inputs. One scenario of ten contributions is written and unrun.</li>
            <li><strong>Model fidelity.</strong> The swap runner exists; no swap has run. The allocator&rsquo;s tiering rests on a prior.</li>
            <li><strong>The judge on its newest dimensions.</strong> Sycophancy, hedging, canonical-form strength and political bias have never been judged on a real run or reviewed.</li>
            <li><strong>Calibration.</strong> Twenty-two questions authored, none seeded into production, none resolved, no market baseline.</li>
            <li><strong>The live graph.</strong> Every instrument here runs on corpus graphs. Production monitors over the real graph, performed settling, empty chairs, overturn-rate discrimination, do not exist; the quality of what visitors read is inferred, not measured.</li>
            <li><strong>Several results have no home.</strong> Agreement, swap, property and contribution runs register locally and report into a directory git ignores. They reach this page by hand until an export lands.</li>
          </ul>
          <p>
            The roadmap is <a href={PLAN}>the master plan</a>; its nine suites and their standing:
          </p>
          <div className={s.wrap}>
            <table className={s.metrics}>
              <thead><tr><th>suite</th><th>what</th><th>standing</th></tr></thead>
              <tbody>
                {SUITES.map(([k, what, standing]) => (
                  <tr key={k}><td>{k}</td><td>{what}</td><td className={s.note}>{standing}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---------------------------------------------------------------- */}
          <h2 id="open-questions">Open questions about the design</h2>
          <p>
            Places where the design itself may be wrong, listed so a reader can disagree with
            them. Most were noticed while building; none is resolved.
          </p>
          <ul>
            <li><strong>The judge is weaker than the judged.</strong> Sonnet grades Fable&rsquo;s work, from one model family, with no second judge. The design accepts a weaker judge because it grades conformance to a pinned text rather than correctness, but a subtle reasoning error in an assessment may be one the judge cannot see. The plan&rsquo;s cross-family second judge on high-stakes verdicts would help and does not exist.</li>
            <li><strong>The reviewer of the judge wrote the prompts.</strong> Review is the check on the checker, and the one review so far was done by the same people who wrote the standards the judge is pinned to. An outside reader of a sheet would be a stronger check than another inside one.</li>
            <li><strong>Agreement is measured by another matcher.</strong> The graph-agreement metric matches claims by an embedding threshold chosen by hand and never validated against the golden pairs. Two graphs that word one claim differently can score as disagreement; a wrong merge can score as agreement.</li>
            <li><strong>The golden suite is small and at its ceiling.</strong> Thirty pairs, authored in-house, mostly on one cluster&rsquo;s subject matter, passed in full on the first run. It will catch a regression on those thirty and nothing else; growing it from real Matcher failures is the obvious next step.</li>
            <li><strong>Clusters are small and the judge sample is a fraction.</strong> The FLF clusters are three to five sources each; fifteen judged claims per run is the whole assessed set on a small cluster and a thin sample on a large one. The estimated cost of running the large cluster is the reason it has not been.</li>
            <li><strong>The cost model is extrapolated.</strong> Every production-profile figure above is scaled from one capped Sonnet run. It could be wrong by a factor of two in either direction, and the page will say so until a run is metered.</li>
            <li><strong>Predictions are in-house and correlated.</strong> Twenty-two questions written by us, five about the same US economy in the same year, with no crowd baseline. The calibration curve will be thin for a long time and its domain slices thinner.</li>
            <li><strong>Authorship measures rewrites, not improvements.</strong> The canonical-form authorship metric says how often and how much the Matcher rewrites the Extractor&rsquo;s proposal, not whether the rewrite was better. A blinded better-form verdict is judge work not yet built.</li>
            <li><strong>The 1–5 scales may be dead weight.</strong> Readability, reasoning fit and impartiality sat in a narrow band on the first review and carried nothing the flags and notes did not. They remain for now; a second review that says the same should retire them.</li>
            <li><strong>Everything is one sample.</strong> Not a design flaw but the state of things: the discipline is built and has never been exercised, and a page of single-sample numbers is exactly what the discipline exists to prevent reading too much into.</li>
          </ul>

          {/* ---------------------------------------------------------------- */}
          <h2 id="reproduce">Reproduce it</h2>
          <p>
            Everything above runs from a clone of <a href={GH}>the repository</a> with Node 22,
            Docker, and provider keys: an Anthropic key for the agents, an OpenAI key for
            embeddings, and an OpenRouter key for the Matcher. The harness refuses the main
            database by name, so the worst a mistake can do is cost money.
          </p>
          <Cmd>{`git clone https://github.com/minerval-ai/minerval && cd minerval && npm ci
docker compose up -d                                  # Postgres 16 + pgvector
cp .env.example .env                                  # add ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
npm run corpus:reset                                  # the isolated eval database

npm run corpus:golden -- --profile=production         # cents: the Matcher suite
npm run corpus:run -- blackholes --profile=production --limit=1   # read the meter first
npm run corpus:run -- blackholes --profile=production --score     # a baseline, three times
npm run corpus:calibrate -- review                    # then read the judge
npm run corpus:property -- idempotency blackholes --profile=production
npm run corpus:swap -- eggs --agent=steward --model=claude-sonnet-5 --profile=production
npm run corpus:contributions -- blackholes
npm run predictions -- seed --corpus --drain`}</Cmd>
          <p>
            Each command prints its exact metered cost when it finishes. The harness
            documentation is <a href={`${GH}/blob/main/corpus/README.md`}>corpus/README.md</a>; the
            rubric a report is read against is <a href={`${GH}/blob/main/corpus/RUBRIC.md`}>RUBRIC.md</a>;
            the scorecard design is <a href={`${GH}/blob/main/corpus/SCORING.md`}>SCORING.md</a>.
          </p>
          <h3>How this page is updated</h3>
          <p>
            Commit the result under <code>corpus/</code> (a scorecard, a golden run, a filled
            review sheet, a fixture change), run the content sync, and commit what it writes
            under <code>web/content/evals/</code>. The page renders from those files at build
            time; a new number reaches the world through a pull request a person has read.
          </p>
          <Cmd>{`npx tsx scripts/sync-frontend-content.ts     # corpus/ → web/content/evals/`}</Cmd>
        </div>
      </DocLayout>
    </div>
  );
}
