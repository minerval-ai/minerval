import Link from "next/link";
import s from "./evals.module.css";
import { Callout, Cmd, GoldenPairFigure, Row, Rows, Status } from "@/components/evals/Bits";
import {
  fmtDate,
  microToUsd,
  type ContributionScenario,
  type EvalsIndex,
  type GoldenPair,
  type GoldenRun,
  type ReviewSheet,
  type ScorecardRecord,
} from "@/lib/evals";

// One section per eval, each answering the same questions in the same order:
// what it measures, why that property matters, how the measurement works,
// how to read a result, what it costs, what it cannot tell you, and how to
// run it yourself. The status line at the top of each is derived from the
// committed record where a record exists.

const GH = "https://github.com/minerval-ai/minerval/blob/main";

export function Catalogue({
  index,
  scorecards,
  goldenRuns,
  goldenPairs,
  reviews,
  scenarios,
}: {
  index: EvalsIndex;
  scorecards: ScorecardRecord[];
  goldenRuns: GoldenRun[];
  goldenPairs: GoldenPair[];
  reviews: ReviewSheet[];
  scenarios: ContributionScenario[];
}) {
  const latestCard = scorecards[scorecards.length - 1] ?? null;
  const productionRuns = scorecards.filter((r) => r.card.config.profile === "production").length;
  const latestGolden = goldenRuns[goldenRuns.length - 1] ?? null;
  const latestReview = reviews[reviews.length - 1] ?? null;
  const judgedCards = scorecards.filter((r) => r.card.judged);
  const s2Judged = judgedCards.filter((r) => r.card.judged?.dimensions).length;
  const scenario = scenarios[0] ?? null;
  const pin = (agent: string) => index.pins.find((p) => p.agent === agent)?.label ?? "unpinned";
  const sonnetRate = index.rates[index.judge.model];
  const fableRate = index.rates[index.pins.find((p) => p.agent === "steward")?.model ?? ""];
  const ratio = sonnetRate && fableRate ? (fableRate.inputPerMtok / sonnetRate.inputPerMtok).toFixed(1) : null;

  const runStatus = scorecards.length === 0
    ? [{ text: "no scored run on record", kind: "notyet" as const }]
    : [
        { text: `${scorecards.length} scored run${scorecards.length === 1 ? "" : "s"} on record`, kind: "run" as const },
        { text: `latest ${fmtDate(latestCard!.card.generatedAt)} · ${latestCard!.cluster}`, kind: "run" as const },
        productionRuns === 0
          ? { text: "none on the production profile yet", kind: "notyet" as const }
          : { text: `${productionRuns} on the production profile`, kind: "run" as const },
      ];

  return (
    <>
      {/* ------------------------------------------------------------ 1 */}
      <h3 id="eval-corpus-runs">Corpus runs</h3>
      <Status items={runStatus} />
      <p>
        The base eval, and the thing every other one reads. A run resets an isolated database,
        submits a cluster&rsquo;s sources through the real ingestion route, and drives the real
        workers to quiescence: the Extractor pulls claims from each source, the Matcher decides
        for each whether it already exists, and a Claim Steward takes every new claim, decomposes
        it, and assesses it, with the Curator sweeping the structure around it. What comes out is
        a claim graph built from a pinned set of documents, which is the object all the
        measurements below are taken on.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            Nothing by itself. It produces the graph; the structural scorecard, the judged
            scorecard and the agreement metric measure it. What the run records on its own is
            its <strong>fingerprint</strong> and its <strong>exact cost</strong>.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            The pipeline is the product. A prompt edit, a model change, or a refactor can
            change what the agents build without any test noticing, because the agents are
            nondeterministic and their output is a graph, not a return value. The only way to
            see the effect of a change is to build the same graph again and compare.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>scripts/corpus/run.ts</code> builds the actual Fastify application in-process,
            points <code>DATABASE_URL</code> at the corpus database (never the main graph), and
            posts each source through the same route the public API uses. The workers are the
            production workers; only the queue is in-memory, drained by
            <code> src/workers/local-runner.ts</code> until nothing is pending. Every LLM call goes
            through the one metering chokepoint production bills through, so the cost printed at
            the end is what the run cost at each model&rsquo;s list rate.
          </p>
          <p>
            Before its first LLM call the run registers a row in the eval-run registry with the
            pipeline epoch, git commit, profile, the model each agent is configured with, and the
            spend caps in force. When the drain finishes it adds the models actually observed
            per agent in the usage log (a second model under one agent means a fallback fired)
            and writes the same record to <code>runs/&lt;run&gt;/run.json</code>. A scorecard
            reads that row back rather than re-deriving the models at score time.
          </p>
          <p>
            <code>--profile=production</code> applies the model pins from the deployment
            definition before config loads, so a baseline that is meant to say something about
            production runs on what production runs on:{" "}
            {index.pins.map((p) => `${p.agent} on ${p.label}`).join(", ")}. The defaults without
            it are the cheap development tiers.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            The run writes <code>report.md</code>, a legibility surface to read against the{" "}
            <a href={`${GH}/corpus/RUBRIC.md`}>rubric</a>, and <code>graph.json</code>, the
            machine-readable dump. A good run settles: the queues drain without hitting a cap,
            every claim reaches an assessment, and the report&rsquo;s failure modes are the ones
            the rubric names rather than new ones. <code>CAPPED</code> in the log means the
            graph is partial and the scorecard is a partial baseline.
          </p>
        </Row>
        <Row k="Cost">
          <p>
            The Steward is the cost: one invocation is a whole tool-use loop with web search,
            and each extracted claim gets one. Measured so far: the one committed baseline
            (blackholes, two of four sources, eleven Steward runs capped at twelve iterations,
            Curator off, Sonnet Steward) metered at $11.29 for the ingest. On the production
            profile the Steward runs on {pin("steward")}, which is {ratio ?? "several"}× the
            Sonnet input rate, at the production iteration budget. The per-cluster estimates
            are in <a href="#cost">what a run costs</a>; every run prints the real number.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Whether the graph is <em>right</em>. There is no answer key for a contested
            question, by design (<a href="#the-rules">rule 1</a>); a run yields a graph to be
            judged against the constitution and compared with other graphs, not a score.
            One run is also one sample of a nondeterministic process, so nothing read off a
            single run is a property of the pipeline until it has been seen to repeat.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`docker compose up -d                  # Postgres 16 with pgvector
npm run corpus:reset                  # create + migrate + truncate the corpus DB
npm run corpus:run -- blackholes --profile=production --score
# cheaper first: --limit=1 STEWARD_MAX_RUNS=5, then read the printed cost`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 2 */}
      <h3 id="eval-structural">The structural scorecard</h3>
      <Status items={scorecards.length ? [{ text: `on every scored run (${scorecards.length} on record)` }] : [{ text: "no scored run on record", kind: "notyet" }]} />
      <p>
        Free numbers, computed from the graph alone, one for each dimension of the rubric.
        They are the metrics <code>corpus:compare</code> bands, so a prompt change is measured
        rather than eyeballed.
      </p>
      <Rows>
        <Row k="Measures">
          <ul>
            <li><strong>A, extraction:</strong> top-level claims, instances, claims per thousand source words, the mix of claim types. Density that jumps or collapses means the Extractor&rsquo;s bar moved.</li>
            <li><strong>B, canonical form:</strong> word-count median, 90th percentile and maximum, and the share over twenty-five words, against §3&rsquo;s &ldquo;about fifteen words&rdquo;. Also <strong>authorship</strong>: how often the Matcher rewrote the form the Extractor proposed, how large those rewrites were, and whether they lengthened or shortened it. Two agents author every claim&rsquo;s wording; this is the first measurement of the second author&rsquo;s hand.</li>
            <li><strong>C, matching:</strong> the dedup ratio (instances per top-level claim, the whole point of a claim graph) and, on the match path, the share of instances recorded as <em>denying</em> the claim they joined, since a claim and its denial are one node.</li>
            <li><strong>D, decomposition:</strong> maximum depth, the depth histogram, the atomic share, children per parent. Depth is an effort decision, so the interesting movement is a jump, not a level.</li>
            <li><strong>E, cross-document structure:</strong> subclaims with more than one parent, the scaling test: recurring premises should collapse into shared nodes.</li>
            <li><strong>F, assessment:</strong> the status distribution, the share of assessments with a substantive reasoning trace, mean trace length.</li>
            <li><strong>Importance:</strong> mean, histogram, and the gap between atomic and compound claims, which catches importance tracking logical necessity instead of what is worth attention.</li>
            <li><strong>§21 coherence:</strong> the constitution&rsquo;s mechanical rules: a claim cannot stand verified while a premise it requires stands contradicted, and two claims joined by a contradiction edge cannot both be verified. Violations are the letter of the rule; tensions are the supported-grade near misses.</li>
          </ul>
        </Row>
        <Row k="Why it matters">
          <p>
            Each is a symptom of a named failure mode in the rubric: over-extraction, bloated
            canonical forms, a Matcher that stops merging or starts over-merging, decomposition
            that unfolds settled facts into proof steps, a Steward that rounds contested claims
            up. None is a quality score. They are the instruments a reviewer looks at first.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>scripts/corpus/metrics.ts</code> is a pure function over a graph snapshot, unit
            tested on fixtures. The depth walk memoizes and cycle-guards, so a shared subclaim is
            counted once. Authorship needs the Extractor&rsquo;s proposal persisted on the
            instance, which graphs built before September 2026 lack: those rates are null, not
            zero.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            Against a baseline group, never alone. The values that matter are the ones that
            move beyond the noise band when something changed, and the direction of the move
            is what tells you which agent to look at.
          </p>
        </Row>
        <Row k="Cost">
          <p>Nothing. <code>corpus:score --no-judge</code> on an existing graph is free.</p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Whether any claim is well stated, well decomposed, or fairly assessed. A canonical
            form of fifteen words can be wrong in every way §3 cares about. The counts locate
            where to read; the judge and the human read.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:score -- blackholes --no-judge     # after a run; writes scorecard.json`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 3 */}
      <h3 id="eval-judged">The judged scorecard</h3>
      <Status
        items={
          judgedCards.length
            ? [
                { text: `${judgedCards.length} judged run${judgedCards.length === 1 ? "" : "s"} on record` },
                { text: `judge: ${index.judge.label}` },
                s2Judged === 0 ? { text: "sycophancy, hedging, form, bias: never judged yet", kind: "notyet" } : { text: `${s2Judged} with the S2 dimensions` },
              ]
            : [{ text: "no judged run on record", kind: "notyet" }]
        }
      />
      <p>
        A bounded sample of assessed claims graded by a second model against the pinned text of
        the constitution, on the dimensions the counts above cannot see.
      </p>
      <Rows>
        <Row k="Measures">
          <ul>
            <li><strong>Claim-bar pass rate:</strong> the share of sampled claims that are single, reusable propositions serving as units of reference, rather than arguments, glosses, or derivation steps. Low means over-decomposition.</li>
            <li><strong>Importance alignment:</strong> the Steward&rsquo;s stored importance against the judge&rsquo;s independent one on §19&rsquo;s anchors, and the share overrated by more than 0.2.</li>
            <li><strong>Readability, reasoning fit, impartiality</strong> on 1–5 scales, plus a granularity verdict and quality flags (false precision, status miscalibration, opaque ids, hallucination risk).</li>
            <li><strong>Sycophancy:</strong> independent, leans toward the source, or defers to it. The judge is shown what the sources actually said, their stances, and the Extractor&rsquo;s proposed wording, which is what makes this judgeable at all.</li>
            <li><strong>Hedging:</strong> calibrated, overhedged, or overconfident: does the prose&rsquo;s certainty match the verdict?</li>
            <li><strong>Canonical-form strength:</strong> good, overstated, understated, or bound to one side&rsquo;s frame. The first review found a verified claim whose wording ruled out more than its assessment defended.</li>
            <li><strong>Political bias:</strong> none, slight, marked. Siding with the evidence is not bias.</li>
          </ul>
        </Row>
        <Row k="Why it matters">
          <p>
            These are the constitution&rsquo;s actual commitments: the claim bar (§2), neutral
            canonical form (§3), honest statuses (§10), reasoning that shows its work (§11,
            §12), independence from the ingesting source (§4, §17, §18), importance as
            consequence times liveness (§19). Counting cannot check any of them. The failure
            we most want to catch early is a model or prompt change that starts deferring to
            sources or hedging verified claims into mush, which is invisible structurally and
            obvious to a reader.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>scripts/corpus/judge.ts</code> samples up to fifteen assessed claims per run
            (interleaving compound and atomic, in a deterministic order so a re-score judges the
            same sample), shows the judge each claim with its subclaims, assessment, reasoning
            trace and source instances, and requires a structured verdict with a one-line note.
            The standards are pinned into the prompt verbatim, cited by constitution section, so
            the bar is explicit and stable rather than the judge&rsquo;s intuition. The judge runs
            on {index.judge.label} by default; the agents it grades run on {pin("steward")} in
            production. <code>corpus:score</code> refuses a judge that is the Steward model the
            graph was built with, as recorded at run time, unless overridden.
          </p>
          <p>
            Each dimension is aggregated as a distribution plus one headline miss share, so the
            comparison tool can band it. Every verdict keeps its note and its claim, so a low
            number is traceable to specific claims, and the scorecard lists the weakest.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            As a delta against a baseline group, on a dimension whose task a human has
            reviewed. Absolute levels are the judge&rsquo;s bias as much as the Steward&rsquo;s
            quality; a stable bias cancels in a comparison. The notes are the part to read
            first: the first review found that most of what looked like Steward error was the
            task the judge had been given.
          </p>
        </Row>
        <Row k="Cost">
          <p>
            Measured: {latestCard?.card.cost ? `$${latestCard.card.cost.usd.toFixed(2)} for ${latestCard.card.cost.calls} verdicts` : "about $0.60 for thirteen verdicts"} on {index.judge.label}, so roughly a dollar for the default fifteen-claim sample, somewhat more now that the judge also sees the source passages.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Truth. The judge grades conformance to the constitution, not correctness, and it is
            a weaker model than the one it grades. It is also one model family; the plan calls
            for a cross-family second judge on high-stakes verdicts, which does not exist yet.
            Numbers from a dimension whose task has not been reviewed are marked as such in{" "}
            <a href="#results">the results</a> and feed no decision.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:score -- blackholes --sample=15         # JUDGE_MODEL defaults to Sonnet
# refuses if the judge is the Steward model the graph was built with`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 4 */}
      <h3 id="eval-judge-review">Judge review</h3>
      <Status
        items={
          latestReview
            ? [
                { text: `reviewed once · ${latestReview.reviewedOn ?? "date unknown"} · ${latestReview.cluster ?? ""}` },
                { text: "the four newest dimensions are unreviewed", kind: "notyet" },
              ]
            : [{ text: "never reviewed", kind: "notyet" }]
        }
      />
      <p>
        No judge number feeds a gate until a human has read the judge&rsquo;s verdicts and
        reasoning against the standards it was given. This is the check on the checker, and
        it is deliberately not a calibration exercise.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            Nothing numeric, by design. The output is feedback on the <em>task</em>: a
            standard that does not get at the right thing, a dimension that should exist and
            does not, a better design. No human-versus-judge agreement statistic is kept.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            An earlier design asked a human to blind-label the same claims and measured
            concordance. That measures the wrong thing for how the numbers are used: the gates
            are delta gates, where a stable judge bias cancels, and a concordance number
            invites optimizing for it. The judge is presumed competent at its assigned task; the
            question a human can actually answer is whether the task was the right one. The
            first review answered no on four counts and fixed them.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>corpus:calibrate review</code> generates a sheet from a scored run: each judged
            claim in full context, the judge&rsquo;s complete verdict on it (every dimension,
            flags, note), the standards reproduced verbatim, a notes line used only where a
            verdict misses, and a closing <em>Overall</em> block. The reviewer fills the block
            and commits the sheet as the record. Wording fixes go into the judge prompt and the
            run is re-judged; what-is-measured fixes go into the plan. Judge-side blinding, order
            randomization and withheld provenance, is unchanged: it guards the judge, not the
            reviewer.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            The Overall block of the latest sheet is quoted in full under{" "}
            <a href="#results-review">review status</a>. What to look for is the pattern the
            first one showed: verdicts that were consistent and defensible on their own terms,
            whose apparent errors traced to the task, not the judge.
          </p>
        </Row>
        <Row k="Cost">
          <p>Human time: an hour or two for a sheet of thirteen claims. No compute.</p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Whether the judge is right on a claim the reviewer did not read, and it has been
            done once, on the easiest cluster, by the people who wrote the prompts. The standing
            rule is what carries the weight: a dimension added since the last review is
            unreviewed until someone reads a sample.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:calibrate -- review      # sheet from the latest scored run, before resetting the graph
# read, fill the Overall block, commit corpus/calibration/<sheet>.md`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 5 */}
      <h3 id="eval-noise-band">Comparison with a noise band</h3>
      <Status items={[{ text: "built; no group of three runs exists yet, so no verdict has ever been issued", kind: "notyet" }]} />
      <p>
        The rule that governs every number on this page, made into arithmetic. It is stated
        prominently in <a href="#the-rules">the rules</a> because it is the caveat on
        everything above it.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            For each headline metric, the mean and sample spread over a <em>group</em> of runs
            per side, and whether the difference of means clears the combined spread.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            Two runs of the same configuration differ. Without knowing by how much, every
            observed change is uninterpretable, and the temptation to read a favorable single
            diff as an improvement is exactly the failure a measurement system exists to
            prevent.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>scripts/corpus/band.ts</code>: a delta counts only when
            |Δ mean| exceeds sd<sub>A</sub> + sd<sub>B</sub>, with about three runs per side.
            A side with one run gets its delta printed and <strong>no verdict</strong>; the tool
            refuses to call a single diff significant. A verdict computed against one
            side&rsquo;s spread alone is marked one-sided and is weaker evidence.
            <code> corpus:compare</code> takes groups as comma-separated scorecard files or
            registry ids.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            Three verdicts: clears the band, within the band, or single sample. Only the first
            is evidence of a change; the third is an instruction to run again.
          </p>
        </Row>
        <Row k="Cost">
          <p>Nothing itself; three runs per side is three times the run cost.</p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Which side is better. It tells you whether the difference is real. Better is the
            judge&rsquo;s and the reviewer&rsquo;s question.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:compare -- A1.json,A2.json,A3.json B1.json,B2.json,B3.json
npm run corpus:compare -- db:<idA> db:<idB>          # single runs: deltas, no verdict`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 6 */}
      <h3 id="eval-golden">Matcher golden pairs</h3>
      <Status
        items={
          latestGolden
            ? [
                { text: `${latestGolden.summary.passed}/${latestGolden.summary.total} on ${fmtDate(latestGolden.generatedAt)}` },
                { text: `on ${index.pins.find((p) => p.agent === "matcher")?.label ?? latestGolden.matcherModel}` },
                { text: "wired into CI, gated on repository secrets", kind: "ci" },
              ]
            : [{ text: "never run", kind: "notyet" }]
        }
      />
      <p>
        The one agent whose task saturates enough for exact-match grading, pinned as a
        regression net: {index.golden.pairs} pairs, each an existing claim and a new source
        that either restates it, denies it, specifies it, or merely resembles it.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            Pass rate by category: {Object.entries(index.golden.byCategory).map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`).join(", ")}.
            A pair passes only when the match decision, the matched claim, and the stance are
            all as pinned.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            Claim identity is the whole idea. Two formulations are the same claim exactly when
            they turn on the same considerations, and a claim and its denial are one node
            (§2). Over-merging destroys distinctions the graph exists to keep; under-merging
            fragments the record. The Matcher runs on a small model, and its prompt, the
            constitution, retrieval, and the provider adapter can each move a decision.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>corpus:golden</code> seeds each pair&rsquo;s existing claims into the corpus
            database and runs the real agentic Matcher, which retrieves its own candidates
            (top twenty above a deliberately low 0.4 cosine floor, across several framings
            including the negation) and decides. Later entries in <code>existing</code> are
            distractors. The CI workflow runs the suite on every pull request that touches
            anything that can move a match decision, on the production Matcher, against a
            throwaway database, and fails below 95% (29 of 30). Without the provider secrets it
            reports that it skipped rather than passing.
          </p>
          <p>Three of the pairs, as the Matcher sees them:</p>
          {goldenPairs.map((p) => <GoldenPairFigure key={p.id} pair={p} />)}
        </Row>
        <Row k="Reading it">
          <p>
            A failure names the pair and the decision the Matcher made, with its reasoning. A
            genuinely arguable pin gets corrected once, with a documented reason; the rest are
            regressions.
          </p>
        </Row>
        <Row k="Cost">
          <p>
            Measured: {latestGolden?.costMicroUsd != null ? `$${microToUsd(latestGolden.costMicroUsd)!.toFixed(2)}` : "cents"} for {index.golden.pairs} decisions on DeepSeek V4 Flash. Cents per pull request.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            How the Matcher behaves on the long tail: {index.golden.pairs} pairs written by the
            people who wrote the prompt, mostly from one cluster&rsquo;s subject matter, and a
            suite that has passed in full once is at its ceiling. It says a change did not break
            the pinned cases; it does not say the Matcher is good.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:golden -- --profile=production          # all pairs on the production Matcher
npm run corpus:golden -- --category=negation --model=claude-haiku-4-5-20251001
npm run corpus:golden -- --min-pass=0.95                # exit 1 below the bar (the CI gate)`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 7 */}
      <h3 id="eval-agreement">Graph agreement</h3>
      <Status items={[{ text: "built and unit tested; no committed run yet", kind: "notyet" }]} />
      <p>
        How far apart are two graphs built from the same sources? The single most load-bearing
        instrument in the plan, because every property that matters is a comparison of graphs.
      </p>
      <Rows>
        <Row k="Measures">
          <ul>
            <li><strong>Claim-set agreement:</strong> precision, recall and F1 over a one-to-one matching of claims, with the unmatched claims attributed to the agent that minted them, so a divergence is actionable.</li>
            <li><strong>Credence agreement:</strong> over matched claims, the divergence of credences and the share with the same status.</li>
            <li><strong>Structural agreement:</strong> mapped through the matching, edge precision and recall and the edit distance between the decomposition graphs, plus dangling edges.</li>
          </ul>
        </Row>
        <Row k="Why it matters">
          <p>
            Idempotency, path independence, fidelity of a cheaper model to a stronger one, and
            displacement under attack are all the same question with different arms. Build the
            instrument once and read it four ways.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>scripts/corpus/graph-agreement.ts</code> is pure and unit tested. Claims match
            by exact normalized text first, then greedily by stored embedding above a threshold
            (0.85). Pairs between the threshold and a sure line (0.95) are the ambiguous band:
            kept and reported, or, with <code>--confirm</code>, sent to a pair judge on the judge
            model under §2&rsquo;s same-considerations test. <code>corpus:agreement</code> loads
            two graphs from the live corpus database, a snapshot, or any disposable database
            (the main graph is refused by name) and registers the result.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            F1 near 1 and a small edit distance mean the two arms built the same graph. The
            first number to establish is the idempotency floor below; until it exists, no
            agreement number has a scale.
          </p>
        </Row>
        <Row k="Cost">
          <p>Free on stored embeddings; <code>--confirm</code> is cents per ambiguous pair on {index.judge.label}.</p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Which graph is better, and its matching is itself a matcher: an embedding threshold
            chosen by hand and never validated against the golden pairs. Two graphs that word
            the same claim differently can score as disagreement.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:snapshot -- save run1              # after one drained run
npm run corpus:run -- blackholes                  # run it again
npm run corpus:agreement -- snap:run1 db --confirm`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 8 */}
      <h3 id="eval-properties">Idempotency and path independence</h3>
      <Status items={[{ text: "built; never run", kind: "notyet" }]} />
      <p>
        Invariances that need no referent: the constitution says these things should not
        matter, so build the graph twice with only that thing changed and measure the agreement.
      </p>
      <Rows>
        <Row k="Measures">
          <ul>
            <li><strong>Idempotency:</strong> the same configuration twice. This is the pipeline&rsquo;s own noise floor, the band every other comparison has to clear.</li>
            <li><strong>Path independence:</strong> the same sources in a shuffled order. Matching is stateful (the first phrasing ingested becomes the node), so order can change the graph, and §2 and §3 say it should not.</li>
          </ul>
        </Row>
        <Row k="Why it matters">
          <p>
            Rule 7 in <a href="#the-rules">the rules</a>: internal uniformity plus calibration
            where reality is checkable is what licenses trusting the unmeasurable core. A graph
            that depends on the order its sources arrived in is not describing the discourse; it
            is describing its own history.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>corpus:property</code> runs two arms as child processes (config caches on
            first read, so each arm is its own process), snapshots each, and hands them to the
            agreement metric. Path independence uses <code>corpus:run --order=shuffle:&lt;seed&gt;</code>,
            a seeded permutation recorded in the fingerprint. <code>--baseline</code> reuses a
            drained arm A. The summary reads the F1 and edit distance in plain language and
            attributes unmatched claims by minting agent.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            One pair of arms is one sample of the property; repeat before reading a number as
            the pipeline&rsquo;s. Path independence is read against the idempotency floor: a
            divergence no larger than the floor is not an order effect.
          </p>
        </Row>
        <Row k="Cost">
          <p>Two full drains of the cluster, or one with a reused baseline. See <a href="#cost">what a run costs</a>.</p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Anything under adversarial conditions. Rule 5 says every invariance is tested benign
            and adversarial, and the adversarial arms (a hostile permutation, a hostile
            rewording) do not exist yet. The remaining tier-one properties from the plan
            (paraphrase and frame invariance, cascade stability, granularity) are also not built.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:property -- idempotency blackholes --profile=production
npm run corpus:property -- path-independence blackholes --seed=3 --baseline=<snapshot>`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 9 */}
      <h3 id="eval-swap">Model swap</h3>
      <Status items={[{ text: "built; never run", kind: "notyet" }]} />
      <p>
        The same cluster twice with one agent&rsquo;s model changed, and the two graphs
        compared. The relative eval: a cheaper model measured against a stronger reference,
        under the prior that frontier generations improve at epistemics.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            Fidelity of arm B to arm A on every agreement axis, with each arm&rsquo;s exact
            metered cost beside it. Quality per dollar in one line.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            Allocation decides which model stewards which claim. Where the cheap model
            converges with the strong one it is safe to economize; where it does not is exactly
            where not to. That is per-claim-kind data the allocator currently substitutes with a
            prior. It is also the guard against silent drift when a provider changes a model
            under the same name.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>corpus:swap &lt;cluster&gt; --agent=&lt;extractor|matcher|steward|curator&gt; --model=&lt;id&gt;</code>.
            Arm A is the reference, normally the production profile; arm B is identical except
            for <code>--swap</code>, which the run honours after the profile and records. Both
            arms are snapshotted and kept as the evidence.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            Against the idempotency floor, and repeated: a single pair of arms cannot separate
            the model&rsquo;s effect from the run&rsquo;s. A swap that stays within the floor at a
            third of the cost is a tiering result; one that leaves it is a list of the claims it
            left it on.
          </p>
        </Row>
        <Row k="Cost">
          <p>
            Two drains, arm B at the swapped model&rsquo;s price; reuse a baseline for one. A
            Steward swap to Sonnet is the cheapest informative one.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            That the strong model is right. Fidelity to a reference is relative by construction;
            where both models are wrong together it reads as agreement.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:swap -- eggs --agent=steward --model=claude-sonnet-5 --profile=production --baseline=<snapshot>
npm run corpus:swap -- lableak --agent=matcher --model=claude-haiku-4-5-20251001 --profile=production`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 10 */}
      <h3 id="eval-contributions">Contribution scenarios</h3>
      <Status items={[{ text: "built; never run", kind: "notyet" }, ...(scenario ? [{ text: `1 scenario: ${scenario.contributions.length} contributions, ${scenario.contributors.length} personas` }] : [])]} />
      <p>
        The half of the organization an ingest never reaches. Contributions, review, escalation
        and arbitration start with a submission against an existing claim, which no ingest
        produces; this driver produces them.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            Nothing numeric is gated. The report lists, per contribution, the Reviewer&rsquo;s
            decision with its reasoning, confidence and policy citations, any bad-faith finding,
            the appeal and the Arbitrator&rsquo;s outcome, and what changed on the claim; then
            decisions by type, escalation and overturn rates, reputation deltas per persona, and
            the cost.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            Governance is the layer described on the FLF page as built but not proven. Until a
            reviewer&rsquo;s reasoning has been read under controlled inputs, nothing is known
            about it. It is also the prerequisite for the adversarial suite and the persona
            simulation, both of which need contributions to flow.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            A scenario is a JSON file per cluster:{" "}
            {scenario ? scenario.contributors.map((c) => `${c.displayName.replace(" (corpus persona)", "")} (${c.note.toLowerCase().replace(/\.$/, "")})` ).join("; ") : "personas"}; and contributions of every type
            ({scenario ? Object.keys(index.contributions[0]?.byType ?? {}).map((t) => t.replace(/_/g, " ")).join(", ") : ""}), each targeting a claim by a search
            query resolved at submit time, with appeal reasoning on the rejections that carry
            one. The driver mints the personas fresh, submits through the same service path
            the public route uses, drains the queues so the real Reviewer (on the governance model, which production does not pin, so Sonnet) and Arbitrator ({pin("arbitration")}) run, files the appeals, drains again, and reports.
            The <code>expect</code> notes beside each outcome orient a reader; no gate reads them.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            Read the reasoning, not the decision. A decision that differs from the note is a
            reason to read closely, not a failure. What to look for: a reject of good-faith
            support, an accept of invented specificity, an arbitrator that engages a conspiracy
            on its own terms.
          </p>
        </Row>
        <Row k="Cost">
          <p>
            Estimated $10 to $30 for the scenario: ten Reviewer calls, a few escalations and two
            appeals on the Arbitrator, and re-stewarding of any accepted change. Runs on the
            graph of a prior corpus run, so that run&rsquo;s cost comes first.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Robustness. One scenario of ten contributions written by the same people who wrote
            the policies is a smoke test of the path, not a measurement of it. The adaptive
            attacker and the graph-level campaigns in the plan are not built.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run corpus:run -- blackholes --profile=production    # the graph to contribute against
npm run corpus:contributions -- blackholes --dry-run      # resolve targets, print the plan
npm run corpus:contributions -- blackholes                # submit, drain, appeal, drain, report`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 11 */}
      <h3 id="eval-predictions">Predictions</h3>
      <Status items={[{ text: `${index.predictions.count} questions authored ${index.predictions.authoredAt ?? ""}` }, { text: "not yet seeded into production", kind: "notyet" }, { text: `first resolutions from ${index.predictions.firstResolution ?? "n/a"}`, kind: "notyet" }]} />
      <p>
        The one class of claim reality grades. A claim with a resolution criterion, a date, and
        a source of truth is eventually settled by the world, and the credence the Steward held
        before that is scored against the outcome.
      </p>
      <Rows>
        <Row k="Measures">
          <p>
            Brier score and log score; a calibration curve (realized frequency per credence
            bucket) and expected calibration error; per-domain slices, where a domain whose
            calibration breaks from the rest is the most valuable result; and, once market
            baselines are attached, the comparative against the crowd on the subset that has
            them.
          </p>
        </Row>
        <Row k="Why it matters">
          <p>
            Rule 2 and rule 7: this is the absolute-but-slow signal, and with internal
            uniformity it is what licenses extending trust to the contested core. A reasoning
            faculty that is calibrated where it can be checked has earned some credit where it
            cannot.
          </p>
        </Row>
        <Row k="How it works">
          <p>
            <code>corpus/predictions/manifest.json</code> holds {index.predictions.count} questions
            across {Object.keys(index.predictions.byDomain).length} domains
            ({Object.entries(index.predictions.byDomain).map(([d, n]) => `${d} ${n}`).join(", ")}),
            each written so a human can settle it without judgment: what counts as yes, by when,
            and where to look. Two are there by construction, a low-probability sports question
            and a near-certain mission-status question, so the curve has both ends populated.
            Seeding creates each as an ordinary claim that its Steward assesses like any other.
            The credence graded is the last one stated at or before the cutoff: the actual
            resolution, or the scheduled date if that came first. Assessment history is
            immutable, so this is a read, never a snapshot. A resolved question with no credence
            stated in time is reported as declined, not scored.
          </p>
        </Row>
        <Row k="Reading it">
          <p>
            Each line is a small number on a small set for a long time. The curve is worth
            nothing before a dozen resolutions and worth reading per domain after that.
          </p>
        </Row>
        <Row k="Cost">
          <p>
            Seeding into production is one Steward run per question, roughly $50 to $130 for
            the set on {pin("steward")}. Resolution is manual and scoring is free.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            Anything about claims that do not resolve, which is most of the graph, and the set
            is in-house: authored, not drawn from a forecasting platform, with no market
            baseline attached yet. Several questions are correlated (five on the US economy in
            the same year), so the effective sample is smaller than {index.predictions.count}.
          </p>
        </Row>
        <Row k="Reproduce">
          <Cmd>{`npm run predictions -- list
npm run predictions -- seed --corpus --drain        # assess the seeds now (LLM spend)
npm run predictions -- resolve <id> yes|no --note="how"
npm run predictions -- score`}</Cmd>
        </Row>
      </Rows>

      {/* ------------------------------------------------------------ 12 */}
      <h3 id="eval-record">The record a run leaves</h3>
      <Status items={[{ text: "traces on in production since 2026-09-02, kept 30 days" }, { text: "usage and cost kept indefinitely" }]} />
      <p>
        Not an eval, but what every eval reads. Three layers, each with one chokepoint.
      </p>
      <Rows>
        <Row k="What is kept">
          <ul>
            <li><strong>Every LLM call</strong>, in the usage table: agent, model, provider, tokens by kind, the cost derived at insert time from the price then in effect, the claim it served, and the run it belonged to.</li>
            <li><strong>Every agent run and step</strong>: the full tool-use transcript of each Steward, Curator, Matcher, Reviewer and Arbitrator invocation, and single-shot completions such as the Extractor and the judge. On in production, kept thirty days; a Steward run is tens of kilobytes.</li>
            <li><strong>Every enqueue</strong>: which run triggered which, so cascades can be reconstructed and fan-out measured.</li>
            <li><strong>Every eval run</strong>, in a registry keyed by kind (ingest, score, golden, agreement, swap, property, contributions) with its fingerprint and result.</li>
          </ul>
        </Row>
        <Row k="Where it lives">
          <p>
            The registry lives in each developer&rsquo;s corpus database, so it is a per-machine
            index, not shared history. The <strong>committed files are the record</strong>:
            scorecards under <code>corpus/scorecards/</code>, golden runs beside them, filled
            review sheets under <code>corpus/calibration/</code>. This page renders only from
            those files; nothing on the public site reads a corpus database.
          </p>
        </Row>
        <Row k="Cannot tell you">
          <p>
            The results of an agreement, swap, property, or contribution run have no committed
            home yet: they register locally and write a report into a directory git ignores.
            Until an export lands, those results reach this page by being written up by hand.
          </p>
        </Row>
      </Rows>
      <Callout label="A note on what &ldquo;never run&rdquo; means">
        <p>
          Several sections above say built but never run. Each has unit tests and a dry run
          against a local database, and none has produced a number on real LLM output. They
          are listed because the page should show the instrument before the reading, and so
          the reading, when it comes, has something to be compared against: what we said the
          instrument would measure before we saw what it measured.
        </p>
      </Callout>
    </>
  );
}
