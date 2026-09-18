import Link from "next/link";
import { Cmd, G, type Tag } from "@/components/evals/Bits";
import { Markdown } from "@/components/Markdown";
import { fmtDate, microToUsd, type EvalsData } from "@/lib/evals";
import s from "./evals.module.css";
import type { Topic } from "./guide";

// The topics added with the second half of the plan (#334 S3 tier 1 and 2,
// S5, S7 discover/adopt, L4, the S1 canonical-form addendum). Same rule as
// guide.tsx: show the artifact, say the least needed to place it, and leave
// nothing about how the eval is run unsaid. Every prompt is rendered
// verbatim from the vendored copy; every fixture is listed in full.

const GH = "https://github.com/minerval-ai/minerval/blob/main";

function Schema({ schema }: { schema: unknown }) {
  const props = (schema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string; items?: { enum?: string[]; type?: string; properties?: Record<string, { description?: string; enum?: string[] }> } }> })?.properties;
  if (!props) return <pre>{JSON.stringify(schema, null, 2)}</pre>;
  return (
    <div className={s.wrap}>
      <table className={s.metrics}>
        <thead><tr><th>field</th><th>answers</th><th>question</th></tr></thead>
        <tbody>
          {Object.entries(props).map(([k, v]) => (
            <tr key={k}>
              <td><code>{k}</code></td>
              <td className={s.note}>{v.enum ? v.enum.join(" / ") : v.items ? `list of ${v.items.enum ? v.items.enum.join(" / ") : v.items.type ?? "objects"}${v.items.properties ? ` (${Object.keys(v.items.properties).join(", ")})` : ""}` : v.type}</td>
              <td>{v.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The step-by-step flow of a driver, as a numbered list: who does what, what moves where. */
function Flow({ steps }: { steps: Array<[string, string]> }) {
  return (
    <ol>
      {steps.map(([what, detail], i) => (
        <li key={i}><strong>{what}.</strong> {detail}</li>
      ))}
    </ol>
  );
}

export const MORE_TOPICS: Topic[] = [
  // ------------------------------------------------------------------ stable
  {
    slug: "cascade",
    kind: "eval",
    group: "stable",
    title: "Cascade stability",
    line: "When one claim is reassessed, does the ripple die out or grow? Reconstructed from the run's own telemetry, free.",
    tags: () => [{ text: "on every run since 2026-09-18", kind: "run" }, { text: "free", kind: "cost" }],
    sections: () => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p>
              A <G t="Steward" /> that changes its verdict tells the Stewards of the claims that depend on it. Each of those judges for itself whether the change matters. If they mostly say no, a change dies out in a generation or two. If they mostly say yes, one edit becomes many, and the queue grows instead of draining.
            </p>
            <p>
              The number is <strong>R</strong>: for each reassessment that materially changed a claim, how many of the reassessments it caused also materially changed theirs. Below 1 the ripple shrinks; at or above 1 it does not. A material change is a status change or a credence move of at least 0.1 (<code>--material</code>).
            </p>
            <p>Alongside R: how fast notifications stop leading to runs, generation by generation (materiality decay); how much of a storm the pending-slot coalescing absorbed; the size and depth of every cascade; claims whose status went A to B and back to A; and whether the pending queue drained monotonically or re-inflated.</p>
          </>
        ),
      },
      {
        title: "How it is computed, step by step",
        body: (
          <Flow steps={[
            ["Read the telemetry", "every Steward run in the window (agent_runs), every Steward enqueue with who caused it and whether it joined an existing pending slot (enqueue_events), and every assessment written (assessments history)."],
            ["Attach each run to the event that woke it", "a run's slot is the Steward events on its claim after the previous run on that claim started; the slot's creator names the parent. A run with no Steward parent (onboarding, an accepted contribution, a staleness sweep, a user order) is a root."],
            ["Classify each run's change", "first assessment, material, minor, or none, by comparing the assessment it wrote with the one before."],
            ["Count per generation", "notified, ran, materially changed; R over all generations and over reassessments alone."],
            ["Read the shape", "cascade sizes and depths, oscillations per claim, the pending-depth curve from queue_depth_snapshots when the sampler ran and otherwise reconstructed from enqueues and run starts (approximate, and marked so)."],
            ["Write and register", "cascade.json in the run directory, a §22 block in the scorecard, and a row of kind cascade in the eval-run registry. Every corpus run prints the one-line summary at its end."],
          ]} />
        ),
      },
      {
        title: "What it cannot show",
        body: (
          <ul>
            <li>Lineage is reconstructed from timestamps, not carried as a cascade id; a telemetry gap makes an unattributed root, and the reading names how many.</li>
            <li>A newly minted subclaim is onboarded through the claim pipeline, so it counts as a root; R measures reassessment propagation, not decomposition fan-out.</li>
            <li>Oscillation is counted per claim over the window, not per tree.</li>
            <li>The reconstructed drain curve assumes an empty lane at the start of the window.</li>
          </ul>
        ),
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:cascade                                   # the corpus DB, whole history
npm run corpus:cascade -- snap:<name> --since=<iso> --material=0.15
npm run corpus:run -- blackholes                         # prints the cascade line at the end`}</Cmd> },
    ],
  },
  {
    slug: "history",
    kind: "eval",
    group: "stable",
    title: "Assessment history",
    line: "Two things a graph's own record of verdicts says about the Steward, with no answer key and no second run.",
    tags: () => [{ text: "built; needs a graph that has been reassessed", kind: "notyet" }, { text: "free", kind: "cost" }],
    sections: () => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p><strong>Evidence monotonicity.</strong> An accepted supporting contribution should not lower a claim&rsquo;s <G t="credence" />, and an accepted challenge should not raise it. The sign of the move is checked, not its size. Each accepted support, source instance or challenge is linked to the reassessment that followed its review, and every wrong-signed move is listed by claim and contribution.</p>
            <p><strong>Overturn-rate discrimination.</strong> Bin every claim by the credence its first assessment gave it. For each bin, how often was the claim later materially changed, and how often reversed (credence crossed 0.5, or the status flipped between the supported and the contradicted side)? If claims at 0.9 reverse as often as claims at 0.6, the credences are not telling anything apart. This is the only falsification signal available for the contested core of the graph without an outside referent.</p>
          </>
        ),
      },
      {
        title: "How it is computed, step by step",
        body: (
          <Flow steps={[
            ["Read the record", "the assessment history of every claim, ordered by time, and the accepted contributions with their review time and type."],
            ["Link contribution to reassessment", "the first assessment after the review, preferring one whose trigger is contribution_accepted; a reassessment that integrated contributions pulling both ways is skipped as ambiguous."],
            ["Check the sign", "support and add_instance expect a non-negative credence move; challenge expects a non-positive one."],
            ["Bin and count", "first credence in 0 to 0.2, 0.2 to 0.4, and so on, plus bins by distance from 0.5; per bin, the share later materially changed and the share reversed; bins under --min-bin are flagged as too small."],
            ["Write and register", "history.json in the run directory and a row of kind history."],
          ]} />
        ),
      },
      {
        title: "What it cannot show",
        body: (
          <ul>
            <li>A graph straight out of one ingest has nothing to reverse; run it after a contribution scenario, a staleness sweep or the fixpoint property.</li>
            <li>The contribution-to-reassessment link is by time, so a reassessment with another cause in the same window can be attributed to the contribution.</li>
            <li>An added instance is treated as affirming; the contribution row carries no stance.</li>
            <li>Contested and unknown never count as a polarity flip.</li>
          </ul>
        ),
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:contributions -- blackholes      # or corpus:property -- fixpoint blackholes
npm run corpus:history -- db --min-bin=5`}</Cmd> },
    ],
  },
  {
    slug: "canonical-goldens",
    kind: "eval",
    group: "stable",
    title: "Canonical-form goldens",
    line: "Twenty-six source excerpts with the one neutral wording each should become. The regression net for the Extractor's wording.",
    tags: (d) => {
      const g = d.goldenCanonicalRuns[d.goldenCanonicalRuns.length - 1];
      return g?.summary
        ? [{ text: `${g.summary.passed}/${g.summary.total} on ${fmtDate(g.generatedAt)}` }, { text: g.costMicroUsd != null ? `$${microToUsd(g.costMicroUsd)!.toFixed(2)} per run` : "cents per run", kind: "cost" }]
        : [{ text: "built; no committed run", kind: "notyet" }, { text: "cents per run", kind: "cost" }];
    },
    sections: (d) => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p>
              The <G t="Extractor" /> proposes a <G t="canonical form" /> for every claim it finds, and since the 2026-08-11 finding that the <G t="Matcher" /> rewrote that proposal on most new claims, both agents&rsquo; wording is under test. A prompt or model change that starts rewriting good wording, sharpening a vague proposition with numbers nobody committed to, or writing the form in the source&rsquo;s direction rather than the direction the discourse debates, would show here first.
            </p>
            <p>Each case pins a verbatim two-to-four sentence excerpt from a committed corpus document and the form its central proposition should take. Six categories: direction (the source argues against the proposition; the form must still state the affirmative), neutrality, scope, survive (the excerpt is already near-canonical and must not be rewritten in substance), hedging, specificity.</p>
          </>
        ),
      },
      {
        title: "How it is run, step by step",
        body: (
          <Flow steps={[
            ["Extract", "the real Extractor, its production prompt unchanged, runs once on the excerpt as a source of type excerpt, capped at three claims."],
            ["Pick", "of the proposals it made, the one closest to the expected form by embedding similarity is the one judged; the rest are recorded."],
            ["Judge", "a pair judge on JUDGE_MODEL answers three narrow questions about the proposed form against the expected one: same proposition, same direction, neutral with no invented specificity. Pass is all three yes."],
            ["Report", "per case the proposals, the one judged, its similarity and the judge's verdict and note; per category the pass rate; the exact metered cost. The report is filed under corpus/scorecards/golden-canonical/ and registered as kind golden-canonical; --min-pass makes it a gate."],
          ]} />
        ),
      },
      {
        title: "The judge's prompt",
        hint: "verbatim",
        body: d.canonicalJudge ? (
          <>
            <p className={s.small}>What the judge is sent per case, placeholders where the case&rsquo;s fields go. Source: <a href={`${GH}/scripts/corpus/golden-canonical-lib.ts`}>golden-canonical-lib.ts</a>.</p>
            <pre>{d.canonicalJudge.prompt}</pre>
            <p className={s.small}>The response schema:</p>
            <Schema schema={d.canonicalJudge.schema} />
          </>
        ) : <p className={s.small}>Not vendored yet.</p>,
      },
      {
        title: `The ${d.canonical.cases.length} cases`,
        hint: "the fixture, in full",
        body: (
          <>
            {d.canonical.description ? <p className={s.small}>{d.canonical.description}</p> : null}
            <ul className={s.claims}>
              {d.canonical.cases.map((c) => (
                <li key={c.id}>
                  <p className={s.cmeta}><span>{c.id}</span><span>{c.category}</span>{c.sourceTitle ? <span>{c.sourceTitle}</span> : null}</p>
                  <p className={s.ctext}>&ldquo;{c.excerpt}&rdquo;</p>
                  <p className={s.cnote}><strong>Expected:</strong> {c.expected}{c.note ? <> &middot; {c.note}</> : null}</p>
                </li>
              ))}
            </ul>
            <p className={s.small}>The file: <a href={`${GH}/corpus/golden/canonical-forms.json`}>canonical-forms.json</a>.</p>
          </>
        ),
      },
      ...(d.goldenCanonicalRuns.length
        ? [{
            title: "Results",
            hint: `${d.goldenCanonicalRuns.length} run${d.goldenCanonicalRuns.length === 1 ? "" : "s"}`,
            body: (
              <div className={s.wrap}>
                <table className={s.metrics}>
                  <thead><tr><th>run</th><th className={s.num}>passed</th><th>by category</th><th className={s.num}>cost</th></tr></thead>
                  <tbody>
                    {d.goldenCanonicalRuns.map((r) => (
                      <tr key={r.file}>
                        <td><code>{r.file}</code></td>
                        <td className={s.num}>{r.summary ? `${r.summary.passed}/${r.summary.total}` : "?"}</td>
                        <td className={s.note}>{r.summary?.byCategory ? Object.entries(r.summary.byCategory).map(([k, v]) => `${k} ${v.passed}/${v.total}`).join(" · ") : ""}</td>
                        <td className={s.num}>{r.costMicroUsd != null ? `$${microToUsd(r.costMicroUsd)!.toFixed(2)}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          }]
        : []),
      {
        title: "What it cannot show",
        body: (
          <ul>
            <li>Grading is a judge&rsquo;s opinion on three narrow questions, not an exact match. A disagreement on a direction case is a fixture judgment to discuss, not a model failure.</li>
            <li>Only the proposal closest to the expected form is judged; a case can pass on a neighbouring claim the Extractor happened to state.</li>
            <li>The judge warns, but does not refuse, when it is the same model as the Extractor.</li>
          </ul>
        ),
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:golden-canonical -- --profile=production
npm run corpus:golden-canonical -- --category=direction --min-pass=0.9`}</Cmd> },
    ],
  },
  {
    slug: "model-lifecycle",
    kind: "eval",
    group: "stable",
    title: "Model discovery and adoption",
    line: "Which models the providers now offer that the code does not know, and what a candidate buys per dollar before anyone changes a pin.",
    tags: () => [{ text: "discover: network only · adopt: two runs", kind: "cost" }],
    sections: () => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p><strong>Discover</strong> polls the three providers&rsquo; model lists and diffs them against everything the code registers (the model tables, the production pins, the pricing table): candidates the code has never heard of, registered models a provider no longer lists (the drift the per-PR guard cannot see), and prices that OpenRouter resells at a rate other than the one the code bills through. It opens no issues; <code>--json</code> is the hook for a workflow that would.</p>
            <p><strong>Adopt</strong> runs a candidate through the agent&rsquo;s own suite with the judge pinned: for the <G t="Matcher" /> the <Link href="/docs/evals/golden-pairs">golden pairs</Link> on candidate and incumbent, plus a <Link href="/docs/evals/model-swap">swap</Link> when a cluster is given; for the other agents a swap. It summarises quality per dollar in one line: adopt, hold, or reject. A person decides; the pin changes by pull request.</p>
          </>
        ),
      },
      {
        title: "How adopt runs, step by step",
        body: (
          <Flow steps={[
            ["Resolve the incumbent", "the agent's model after --profile, from the same config the run would use."],
            ["Golden pairs twice", "for the Matcher: the suite on the candidate and on the incumbent, each a child process, each filed and registered as a golden run."],
            ["Swap", "when --cluster is given: arm A on the incumbent, arm B on the candidate, snapshotted and compared by graph agreement."],
            ["Summarise", "pass-rate points per dollar and fidelity per dollar against fixed tolerances (a golden delta within 0.05, an F1 above 0.85 is close, below 0.6 is a reject) into one recommendation, registered as kind adopt."],
          ]} />
        ),
      },
      {
        title: "What it cannot show",
        body: (
          <ul>
            <li>The golden delta is exact-match on a saturating task; the swap is one sample of each arm.</li>
            <li>The Extractor, Steward and Curator have no per-decision golden set, so their verdict rests on fidelity and cost alone.</li>
            <li>Discover&rsquo;s idea of a candidate is a deliberately narrow list of vendors; pricing drift compares against OpenRouter&rsquo;s resold rate, not the vendor&rsquo;s page.</li>
          </ul>
        ),
      },
      { title: "Run it", body: <Cmd>{`npm run models:discover -- --json
npm run corpus:adopt -- --agent=matcher --model=<id> --profile=production
npm run corpus:adopt -- --agent=steward --model=<id> --cluster=eggs --baseline=<snapshot>`}</Cmd> },
    ],
  },
  // ------------------------------------------------------------------ graph
  {
    slug: "epoch-gate",
    kind: "eval",
    group: "graph",
    title: "Epoch gate",
    line: "Before a prompt or model change ships, its scored runs against the committed baseline, with the noise band applied to every headline metric.",
    tags: () => [{ text: "built; refuses to gate until each side has two runs", kind: "notyet" }, { text: "free", kind: "cost" }],
    sections: () => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p>The <Link href="/docs/evals/noise-band">comparison rule</Link>, made into a verdict. It reads the committed scorecards of a cluster, takes a baseline group and a candidate group, applies the band to every headline metric in the direction that counts as better for it, and exits non-zero on a regression of a gated metric: the claim-bar pass rate, coherence violations, the dedup ratio, and the share of assessments with a trace.</p>
            <p>It refuses, printing the deltas for reading, when a side has fewer than two runs or the sides differ in profile or epoch: a delta across configurations is a different graph, not a regression. A passed gate means not shown to regress, never shown equal.</p>
          </>
        ),
      },
      {
        title: "How it chooses the sides",
        body: (
          <Flow steps={[
            ["Baseline", "--baseline=<files>, else corpus/scorecards/<cluster>/baselines.json, else the earliest runs sharing the earliest run's epoch and profile."],
            ["Candidate", "--candidate=<files|latest>, else the newest runs outside the baseline sharing the newest run's fingerprint."],
            ["Band", "for each metric the mean and sample spread per side; a delta counts only beyond the combined spread."],
            ["Verdict", "regressed, improved, within band, moved (for undirected metrics such as max depth), or no verdict."],
          ]} />
        ),
      },
      { title: "What it cannot show", body: <p>Anything with one run on a side. Undirected metrics are reported as moved and never gated. It is file-only: it reads no database and registers nothing.</p> },
      { title: "Run it", body: <Cmd>{`npm run corpus:gate -- blackholes
npm run corpus:gate -- blackholes --candidate=latest --min-n=2 --gated=claim-bar,coherence`}</Cmd> },
    ],
  },
  // ------------------------------------------------------------------ use
  {
    slug: "reasoner-probe",
    kind: "eval",
    group: "use",
    title: "Reasoner probe",
    line: "Hand the graph's record to a model and ask it questions. Does its confidence follow the record, and does a retraction reach the claims that rested on it?",
    tags: () => [{ text: "built; diagnostic only, never a scoring rule", kind: "notyet" }, { text: "a reasoner call per question, twice", kind: "cost" }],
    sections: (d) => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p>The graph exists to be reasoned from. For each pinned question the probe asks a reasoner twice: once with the record the graph returns for the question (the top claims with status, verdict confidence, credence and assessment), told to use only that, and once from its own knowledge. It records both confidences, whether the answer cited the record at all, how far its confidence sat from the credences of the claims it cited, and whether it used a verified claim as false or a contradicted one as true.</p>
            <p>With <code>--retraction</code> it picks a source, flags every claim with an instance from it as if a lookout had found it retracted, drains the Stewards, and reports which of those claims and their parents were reassessed and how credence moved.</p>
            <p>Diagnostic only: a reasoner&rsquo;s confidence is not ground truth for the graph, and nothing here feeds a gate.</p>
          </>
        ),
      },
      {
        title: "How it runs, step by step",
        body: (
          <Flow steps={[
            ["Retrieve", "hybrid search over the corpus graph for the question, the top eight claims, each with its current assessment."],
            ["Ask with the record", "the with-graph prompt below, answered in a fixed shape: the answer, a confidence from 0 to 1, and the claims it rests on with whether each is taken as true, false or uncertain."],
            ["Ask without", "the without-graph prompt, answer and confidence only."],
            ["Grade", "confidence with versus without; cited or not; tracking = the distance between the stated confidence and the mean credence of the cited claims (a claim used as false counts as one minus its credence); consistency against verified and contradicted claims in the record."],
            ["Retraction, when asked", "the Stewards of the affected claims are enqueued with the lookout_flag trigger and the retraction context below, the queues drained, and the before and after assessments compared for the flagged claims and their direct parents."],
            ["Record", "probe.json carries, per question, the exact record and prompts handed to the reasoner and its verbatim answers; registered as kind probe. The reasoner runs under the probe agent name so its full transcript is traced."],
          ]} />
        ),
      },
      {
        title: "The prompts",
        hint: "verbatim",
        body: d.probePrompts ? (
          <>
            <p className={s.small}>With the record (placeholders where the question and the record go). Source: <a href={`${GH}/scripts/corpus/probe-prompts.ts`}>probe-prompts.ts</a>.</p>
            <pre>{d.probePrompts.withGraph}</pre>
            <Schema schema={d.probePrompts.withGraphSchema} />
            <p className={s.small}>Without the record.</p>
            <pre>{d.probePrompts.withoutGraph}</pre>
            <Schema schema={d.probePrompts.withoutGraphSchema} />
            <p className={s.small}>The retraction context handed to each affected claim&rsquo;s Steward.</p>
            <pre>{d.probePrompts.retraction}</pre>
          </>
        ) : <p className={s.small}>Not vendored yet.</p>,
      },
      ...d.probes.map((f) => ({
        title: `The questions: ${f.cluster}`,
        hint: `${f.questions.length} questions`,
        body: (
          <>
            {f.description ? <p className={s.small}>{f.description}</p> : null}
            <ul className={s.claims}>
              {f.questions.map((q) => (
                <li key={q.id}>
                  <p className={s.cmeta}><span>{q.id}</span>{q.kind ? <span>{q.kind}</span> : null}</p>
                  <p className={s.ctext}>{q.question}</p>
                  {q.note ? <p className={s.cnote}>{q.note}</p> : null}
                </li>
              ))}
            </ul>
          </>
        ),
      })),
      {
        title: "What it cannot show",
        body: (
          <ul>
            <li>Tracking is one number that conflates the reasoner&rsquo;s calibration with the graph&rsquo;s.</li>
            <li>Consistency is read from the reasoner&rsquo;s own tags; a contradiction in prose tagged uncertain is not caught.</li>
            <li>The record is what search returns; a graph that holds the answer under a phrasing search misses reads as not in the record.</li>
            <li>There is no retraction path in the system yet, so the flag is simulated through the Steward&rsquo;s lookout trigger; nothing is un-ingested, and dependents are followed one level up.</li>
          </ul>
        ),
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:probe -- blackholes                     # after a run; PROBE_MODEL or --model
npm run corpus:snapshot -- save before-retraction
npm run corpus:probe -- blackholes --retraction --source=giddings`}</Cmd> },
    ],
  },

  // ------------------------------------------------------------------ governance / use
  {
    slug: "adversarial",
    kind: "eval",
    group: "governance",
    title: "Adversarial robustness",
    line: "Attack the same claim toward true and toward false from one snapshot, beside a sincere contributor with the same budget. What does illegitimate technique buy that argument does not?",
    tags: (d) => [{ text: `${d.adversarial.length} scenario${d.adversarial.length === 1 ? "" : "s"} · ${d.adversarial.reduce((n, sc) => n + sc.targets.length, 0)} targets`, kind: "run" }, { text: "built; never run", kind: "notyet" }, { text: "a review round per arm, six to nine arms per scenario", kind: "cost" }],
    sections: (d) => {
      const armsOf = (arms: Record<string, { direction?: string; contributions: unknown[] } | unknown[]>) =>
        Object.entries(arms).map(([k, v]) => [k, Array.isArray(v) ? { direction: undefined, contributions: v } : v] as const);
      return [
        {
          title: "What it checks",
          open: true,
          body: (
            <>
              <p>Robustness is not immovability: a good argument should move the graph, so &ldquo;did the credence move&rdquo; is never the measure on its own. The protocol is symmetric and controlled.</p>
              <p><strong>Symmetric.</strong> The same claim is attacked toward true (the pro arm) and toward false (the con arm) from the same <G t="snapshot" />, with the same number of contributions. If both arms move the <G t="credence" /> their way, the assessment tracks the loudest argument, a failure whatever the merits. If neither moves, the benign arm tells a settled claim from an inert pipeline. If one moves, that is evidence about how confidently the stored credence was held, read against the headroom it left in each direction.</p>
              <p><strong>Controlled.</strong> Every attack arm has a benign control: a sincere, competent contributor with a real case for a declared direction, same claim, same budget. The quantity of interest is the legitimacy gap, attacker displacement minus benign displacement. At or below zero the attack bought nothing argument would not have; above zero is the finding.</p>
              <p>Four cells: a pinned library of gambits fired at single claims (this page); an adaptive attacker that keeps notes across episodes (the red team, below); and both again at graph level, where the objective is what the cluster is about rather than one verdict.</p>
            </>
          ),
        },
        {
          title: "How an arm runs, step by step",
          body: (
            <Flow steps={[
              ["Restore", "the baseline snapshot into the corpus database, so every arm starts from the identical graph."],
              ["Before", "the target claim is found by its search query; its text, status, credence, confidence, assessment and reasoning are recorded, and the whole graph is kept for the agreement measure."],
              ["Mint the personas", "each with its capability tier written before the first submission (fresh: reputation 15, a new account that one bad-faith flag burns; standard: 50; trusted: 85), so the Reviewer sees the standing the scenario intends."],
              ["Submit", "each contribution through the same service path a real submission takes; the Contribution Reviewer decides; accepted ones notify the Steward; escalations reach the Arbitrator; rejections with an appeal are appealed and drained again."],
              ["After", "the target's state again, the reassessments that ran with their triggers, the graph agreement against the baseline (claim-set F1, credence divergence, status agreement, edge edit distance), the metered cost, reputation lost and accounts burned."],
              ["Attribute", "not admitted; admitted but no reassessment; admitted and the Steward held; admitted and the Steward moved; or moved without admission. A Reviewer that lets a gambit in and a Steward that over-weights it once in are different defects."],
              ["Judge blind", "the before and after assessments in a seeded random order, provenance and direction withheld, with the constitution's standards pinned: which is the better-reasoned, more faithful representation, and was any movement warranted? The order and the pair shown are recorded so the blinding can be audited."],
              ["Keep the evidence", "the arm's end state is snapshotted; the report, the registry row (kind adversarial) and a replay of every arm are written."],
            ]} />
          ),
        },
        {
          title: "The gambits",
          hint: "the pinned tactics",
          body: d.adversarialPrompts ? (
            <ul>
              {Object.entries(d.adversarialPrompts.gambits).map(([k, v]) => <li key={k}><code>{k}</code>: {v}</li>)}
            </ul>
          ) : null,
        },
        {
          title: "The judges' prompts",
          hint: "verbatim",
          body: d.adversarialPrompts ? (
            <>
              <p className={s.small}>The blind before/after judge, per arm. Source: <a href={`${GH}/scripts/corpus/adversarial-prompts.ts`}>adversarial-prompts.ts</a>.</p>
              <pre>{d.adversarialPrompts.blindJudge.prompt}</pre>
              <Schema schema={d.adversarialPrompts.blindJudge.schema} />
              <p className={s.small}>The holistic graph-level judge, for a campaign.</p>
              <pre>{d.adversarialPrompts.holisticJudge.prompt}</pre>
              <Schema schema={d.adversarialPrompts.holisticJudge.schema} />
            </>
          ) : null,
        },
        ...d.adversarial.map((sc) => ({
          title: `The scenario: ${sc.scenario}`,
          hint: `${sc.targets.length} targets · ${sc.personas.length} personas`,
          body: (
            <>
              {sc.description ? <p className={s.small}>{sc.description}</p> : null}
              <p className={s.small}>Personas: {sc.personas.map((p) => `${p.displayName} (${p.tier})`).join(" · ")}.</p>
              {sc.targets.map((t) => (
                <div key={t.key} className={s.pair}>
                  <div className={s.who}>Target · {t.kind.replace(/_/g, " ")}</div>
                  <p>&ldquo;{t.query}&rdquo;</p>
                  {t.note ? <p className={s.small}>{t.note}</p> : null}
                  {armsOf(t.arms).map(([arm, v]) => (
                    <div key={arm}>
                      <div className={s.who}>{arm} arm{v.direction ? ` · pushes ${v.direction}` : ""}</div>
                      <ul className={s.claims}>
                        {(v.contributions as AdversarialContributionLike[]).map((c) => (
                          <li key={c.id}>
                            <p className={s.cmeta}><span>{c.id}</span><span>{c.persona}</span><span>{c.type}</span><span>gambit {c.gambit}</span>{c.fabricated ? <span className={s.flag}>fabricated evidence</span> : null}</p>
                            <p className={s.ctext}>{c.content}</p>
                            {c.proposedCanonicalForm ? <p className={s.cnote}><strong>Proposed wording:</strong> {c.proposedCanonicalForm}</p> : null}
                            {c.evidenceUrls?.length ? <p className={s.cnote}>Evidence: {c.evidenceUrls.join(", ")}</p> : null}
                            {c.appealIfRejected ? <p className={s.cnote}><strong>Appeal if rejected:</strong> {c.appealIfRejected}</p> : null}
                            {c.expect ? <p className={s.cnote}><strong>Expect:</strong> {c.expect}</p> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {t.expect ? <div className={s.expect}><strong>Expect:</strong> {t.expect}</div> : null}
                </div>
              ))}
              {sc.campaign ? (
                <div className={s.pair}>
                  <div className={s.who}>Campaign · graph level</div>
                  {armsOf(sc.campaign.arms).map(([arm, v]) => (
                    <div key={arm}>
                      <div className={s.who}>{arm} arm</div>
                      <ul className={s.claims}>
                        {(v.contributions as AdversarialContributionLike[]).map((c) => (
                          <li key={c.id}>
                            <p className={s.cmeta}><span>{c.id}</span><span>{c.persona}</span><span>{c.type}</span><span>gambit {c.gambit}</span>{c.target ? <span>on &ldquo;{c.target.query}&rdquo;</span> : null}</p>
                            <p className={s.ctext}>{c.content}</p>
                            {c.expect ? <p className={s.cnote}><strong>Expect:</strong> {c.expect}</p> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className={s.small}>The file: <a href={`${GH}/corpus/adversarial/${sc.scenario}.json`}>adversarial/{sc.scenario}.json</a>. The expect notes orient a reader; no gate reads them.</p>
            </>
          ),
        })),
        {
          title: "The red team: an attacker that learns",
          body: d.adversarialPrompts ? (
            <>
              <p>The adaptive cell. An agent on <code>REDTEAM_MODEL</code> (the cheap tier by default) gets read-only graph tools, a tool to stage a contribution with its gambit, and a notes file it reads before and updates after every episode. Each episode restores the snapshot, the agent reads the target and its notes, stages up to its budget, the driver submits and drains, and the agent is shown the review decisions, any bad-faith finding and the new assessment, then writes its notes. The output is a success curve over episodes (does it learn, does it plateau) and the playbook itself. <code>--benign</code> gives the same tools to a sincere contributor for the control curve; <code>--campaign</code> aims it at the cluster&rsquo;s framing.</p>
              <p>Dual use: isolated corpus deployments only. A playbook the attacker discovers is a security finding, not a fixture: the notes go to the ignored runs directory and a path under the corpus is refused.</p>
              <p className={s.small}>The attacker&rsquo;s system prompt, verbatim.</p>
              <pre>{d.adversarialPrompts.redteam.attackSystem}</pre>
              <p className={s.small}>The benign control&rsquo;s.</p>
              <pre>{d.adversarialPrompts.redteam.benignSystem}</pre>
              <p className={s.small}>The campaign variant.</p>
              <pre>{d.adversarialPrompts.redteam.campaignSystem}</pre>
              <p className={s.small}>The episode message and the feedback message.</p>
              <pre>{d.adversarialPrompts.redteam.episode}</pre>
              <pre>{d.adversarialPrompts.redteam.feedback}</pre>
              <p className={s.small}>Its tools.</p>
              <pre>{JSON.stringify(d.adversarialPrompts.redteam.tools, null, 2)}</pre>
            </>
          ) : null,
        },
        {
          title: "What it cannot show",
          body: (
            <ul>
              <li>The gambit library is a fixed regression net; it cannot find a tactic it does not contain. The red team is bounded by its model and episode budget: a flat curve on the cheap tier means that model did not find it, not that there is nothing to find.</li>
              <li>One sample per arm, so a gap is read against the idempotency noise floor, not on its own.</li>
              <li>Only the contribution surface is under test. Poisoned sources at ingest, the allocation engine and anything outside the contribution interface are out of scope.</li>
              <li>Credence is coarse: where the constitution allows an assessment to state none, the status stands in on an ordinal scale, and a claim can be reframed with no movement on either, which is why the assessment texts are printed.</li>
              <li>The framing verdict of a campaign is one model&rsquo;s judgment over a truncated top-forty view.</li>
            </ul>
          ),
        },
        { title: "Run it", body: <Cmd>{`npm run corpus:run -- blackholes --profile=production
npm run corpus:snapshot -- save bh_base
npm run corpus:adversarial -- blackholes --baseline=bh_base --dry-run
npm run corpus:adversarial -- blackholes --baseline=bh_base --targets=astrophysical --arms=pro,con,benign
npm run corpus:redteam -- blackholes --baseline=bh_base --target="black holes would evaporate through Hawking radiation" --direction=down --episodes=5 --tier=standard
npm run corpus:redteam -- blackholes --baseline=bh_base --target="…" --direction=down --episodes=5 --benign`}</Cmd> },
      ];
    },
  },
  {
    slug: "personas",
    kind: "eval",
    group: "use",
    title: "Simulated users",
    line: "Twenty people, each an agent playing a manifest entry against a built graph: readers with a question, contributors of every temperament, scripts, and a hostile minority.",
    tags: (d) => [{ text: `${d.personas.length} personas` , kind: "run" }, { text: "built; never run", kind: "notyet" }, { text: "one agent session per persona", kind: "cost" }],
    sections: (d) => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p>A scripted contribution scenario says nothing about what a person does when they arrive with a question, browse, hit a dead end, and decide whether to contribute at all. Each persona here is an agent with the graph&rsquo;s read tools and three actions a user has (submit a contribution, propose a claim, file a finding), through the same service path a real submission takes, then the real review, intake, escalation and arbitration.</p>
            <p>The report gives, per persona, every action and every review decision verbatim, its reputation change and its cost; the adversarial minority&rsquo;s outcomes in their own table (rejected? flagged? did anything land?); and the findings, deduplicated and ranked by severity times count, for a person to read before any issue is opened. Findings are the most valuable thing a persona produces.</p>
          </>
        ),
      },
      {
        title: "How a session runs, step by step",
        body: (
          <Flow steps={[
            ["Mint the account", "one contributor per persona per run, at the tier the manifest names (a fresh account, or one started at reputation 65 or 88 so review treats it as established)."],
            ["Brief the agent", "the system prompt below, built from the manifest entry: the plain statement that it is a simulated user in an isolated deployment, who it is, where it is, its budget of reads, contributions, proposals and findings, and how the tools are to be used; then the opening message with what is on its mind."],
            ["Act", "a tool-using loop on PERSONA_MODEL: search and read claims, and, within budget, contribute, propose or file a finding; the tools refuse calls past the budget."],
            ["Drain", "the queues run to quiescence: the Reviewer, the Steward, the Arbitrator; a persona marked as one who appeals writes its appeal in character with one more model turn."],
            ["Report", "actions and decisions verbatim, the adversarial table, the triaged findings, the cost per persona from its own usage rows; registered as kind personas, with a replay whose events carry every persona's full transcript."],
          ]} />
        ),
      },
      {
        title: "The twenty",
        hint: "the manifest",
        body: (
          <ul className={s.claims}>
            {d.personas.map((p) => (
              <li key={p.key}>
                <p className={s.cmeta}><span>{p.key}</span><span>{p.kind}</span><span>{p.tier}</span><span>{p.budget}</span>{p.tactic ? <span className={s.flag}>tactic {p.tactic}</span> : null}{p.pairWith ? <span>pairs with {p.pairWith}</span> : null}{p.appeals ? <span>appeals</span> : null}</p>
                <p className={s.ctext}><strong>{p.name}</strong>, {p.archetype}. Cares about {p.clusters.join(", ")}.</p>
                <p className={s.cnote}>Goals: {p.goals.join(" ")} Style: {p.style}{p.opening ? ` Arrives thinking: ${p.opening}` : ""}</p>
              </li>
            ))}
          </ul>
        ),
      },
      {
        title: "The prompts",
        hint: "verbatim, every persona",
        body: d.personaPrompts ? (
          <>
            <p className={s.small}>The notice every persona is given first.</p>
            <pre>{d.personaPrompts.notice}</pre>
            <p className={s.small}>The action tools, as defined for the model.</p>
            <pre>{JSON.stringify(d.personaPrompts.tools, null, 2)}</pre>
            {d.personaPrompts.prompts.map((p) => (
              <details key={p.key} className={s.section}>
                <summary>{p.key} on {p.cluster} <span className={s.hint}>{p.tools.join(", ")}</span></summary>
                <div className={s.body}>
                  <pre>{p.system}</pre>
                  <p className={s.small}>Opening message:</p>
                  <pre>{p.opening}</pre>
                </div>
              </details>
            ))}
            <p className={s.small}>Source: <a href={`${GH}/scripts/corpus/persona-prompts.ts`}>persona-prompts.ts</a>.</p>
          </>
        ) : null,
      },
      {
        title: "What it cannot show",
        body: (
          <ul>
            <li>The web app is not exercised; personas go through the service layer, and route rate limits are not applied.</li>
            <li>A persona never sees its review decision within its session, so &ldquo;no reply&rdquo; is never a finding.</li>
            <li>Findings are as sharp as the model playing the persona; sockpuppet coordination is supplied by the driver; the prompt injector&rsquo;s injection is written in character, and its effect is read from whether anything of it landed.</li>
            <li>Phase one is twenty hand-picked personas; the generated hundreds and the automatic filing of triaged issues are not built.</li>
          </ul>
        ),
      },
      { title: "Run it", body: <Cmd>{`npm run corpus:personas -- eggs --dry-run --limit=3      # the plan and the first prompt
npm run corpus:personas -- eggs                            # PERSONA_MODEL, the cheap tier by default`}</Cmd> },
    ],
  },
  {
    slug: "monitors",
    kind: "eval",
    group: "use",
    title: "Production monitors",
    line: "Continuous signals read off the live graph and its trace: candidates for audit, never verdicts. Every query is on this page.",
    tags: () => [{ text: "built; GET /monitors and a CLI; scheduler off by default", kind: "notyet" }, { text: "free", kind: "cost" }],
    sections: (d) => [
      {
        title: "What it checks",
        open: true,
        body: (
          <>
            <p>Seven signals over the production database, each a read that changes nothing. Two are candidate detectors whose hits can be handed to the Audit Agent as input: <strong>performed settling</strong> (a verdict that reads as settled while the record shows live disagreement) and <strong>empty chairs</strong> (a contested claim whose record carries only one side). Two are the coherence checks that need no referent: <strong>overturn-rate discrimination</strong> and <strong>evidence monotonicity</strong>, as on the <Link href="/docs/evals/history">assessment history</Link> page but over the live graph. Then <strong>cascade health</strong> (per-day R from the enqueue events), <strong>queue health</strong> and per-agent <strong>cost and error rollups</strong>.</p>
            <p>A hit is a claim worth a second look, and most second looks should end with the verdict holding. A detector that produced mostly real problems would be evidence the Steward is broken, not that the detector is good.</p>
          </>
        ),
      },
      {
        title: "The document, with every query",
        hint: "verbatim",
        body: d.monitorsDoc ? <Markdown>{d.monitorsDoc}</Markdown> : <p className={s.small}>Not vendored yet.</p>,
      },
      { title: "Run it", body: <Cmd>{`npm run monitors -- --corpus                  # a drained corpus DB, read the way production is
npm run monitors -- --signal=performed_settling --json
curl https://api.claimgraph.io/monitors`}</Cmd> },
    ],
  },
  // ------------------------------------------------------------------ background
  {
    slug: "replays-guide",
    kind: "background",
    group: "background",
    title: "Reading a replay",
    line: "What a recording holds, how it was made, and how to get from the overview down to a verbatim prompt.",
    sections: () => [
      {
        title: "What a recording is",
        open: true,
        body: (
          <>
            <p>Every driver that runs the real agents writes one at the end of its run, built from the trace the run already keeps (every agent run and step, every enqueue, every model call) and the graph tables. Nothing in it is authored by hand; where attribution is a heuristic, the record says so on each change. <Link href="/docs/evals/replays">The committed recordings</Link> are played back on this site.</p>
            <p>Five levels, each one click from the next: the episode (what it tests, the commands, the fingerprint, the scenario, the distinct system prompts used); the timeline and the graph building as events land, two arms side by side for a two-arm episode with the paired claims linked; an event (its agent, trigger, cost, what caused it and what it caused, what it read and wrote); a step, verbatim (the prompt step shows the system prompt, the initial messages and the tool definitions; a tool call its full input; a result its full output); and a claim&rsquo;s lineage (the source&rsquo;s verbatim text, the Extractor&rsquo;s proposed form, the Matcher&rsquo;s decision with the search results it saw, the Steward&rsquo;s edges and verdicts, its credence over time). Every level has a link.</p>
          </>
        ),
      },
      {
        title: "How it is made",
        body: (
          <ol>
            <li>Every model call in a tool-using loop or a single-shot completion records a prompt step first: model, effort, token limit, the full system prompt, the initial messages, the tool definitions.</li>
            <li>Every assistant turn and every tool result is recorded as a step, untrimmed, capped only by the trace&rsquo;s per-step limit, which the recording marks.</li>
            <li>After the drain the exporter reads the window: one event per agent run in time order, harness events for each source submitted, changes to the graph credited exactly where a decision tool named them and by run window otherwise, causality from the enqueue events, cost from the usage rows.</li>
            <li>Two layouts are written: an index with one-line gists and sizes, and one file per event with everything, fetched only when opened.</li>
          </ol>
        ),
      },
      { title: "What it cannot show", body: <p>Anything the trace did not record: a run traced off yields events with no steps, and the player says so. A recording is one run; it shows what happened, not what usually happens.</p> },
      { title: "Run it", body: <Cmd>{`npm run corpus:run -- blackholes --limit=1            # writes runs/<run>/replay.json
npm run corpus:replay -- db --since=<iso> --name=<name> --commit-as=<name>
npx tsx scripts/sync-frontend-content.ts                 # vendors corpus/replays/ into the site`}</Cmd> },
    ],
  },
];

type AdversarialContributionLike = { id: string; persona: string; type: string; gambit: string; content: string; evidenceUrls?: string[]; fabricated?: boolean; proposedCanonicalForm?: string; appealIfRejected?: string; expect?: string; target?: { query: string } };

/** Index-table rows for these topics; the shape guide.tsx's indexRow returns. */
export function moreIndexRow(slug: string, d: EvalsData): { property: string; status: string; statusKind: "run" | "notyet" | "ci"; lastRun: string; result: string; cost: string } | null {
  const none = "not yet";
  switch (slug) {
    case "cascade":
      return { property: "a reassessment ripples less than one-for-one (R < 1)", status: "on every run", statusKind: "run", lastRun: "each run", result: "printed per run; no committed record", cost: "free" };
    case "history":
      return { property: "credence moves with the evidence's sign and discriminates reversals", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "free" };
    case "canonical-goldens": {
      const g = d.goldenCanonicalRuns[d.goldenCanonicalRuns.length - 1];
      return { property: "the Extractor writes the neutral, debated-direction wording and keeps good wording", status: g ? "run" : "not run", statusKind: g ? "run" : "notyet", lastRun: g ? fmtDate(g.generatedAt) : none, result: g?.summary ? `${g.summary.passed}/${g.summary.total}` : none, cost: g?.costMicroUsd != null ? `$${microToUsd(g.costMicroUsd)!.toFixed(2)}` : "cents" };
    }
    case "model-lifecycle":
      return { property: "new and withdrawn models are noticed; a candidate is priced before a pin moves", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "network; 2 runs" };
    case "epoch-gate":
      return { property: "a change's scored runs do not regress the baseline beyond noise", status: "built", statusKind: "notyet", lastRun: none, result: "refuses: one baseline run", cost: "free" };
    case "reasoner-probe":
      return { property: "a reasoner's confidence follows the record; a retraction reaches dependents", status: "built", statusKind: "notyet", lastRun: none, result: none, cost: "2 calls per question" };
    case "adversarial":
      return { property: "illegitimate technique buys no more movement than a sincere case", status: "built", statusKind: "notyet", lastRun: none, result: `${d.adversarial.reduce((n, sc) => n + sc.targets.length, 0)} targets pinned`, cost: "6 – 9 arms" };
    case "personas":
      return { property: "readers, contributors, scripts and a hostile minority are served and handled", status: "built", statusKind: "notyet", lastRun: none, result: `${d.personas.length} personas`, cost: "20 sessions" };
    case "monitors":
      return { property: "the live graph's own record flags what deserves a second look", status: "built", statusKind: "notyet", lastRun: none, result: "scheduler off", cost: "free" };
    default:
      return null;
  }
}

export const MORE_GROUPS: Array<{ key: string; title: string; note?: string }> = [
  { key: "use", title: "Does it hold up in use?", note: "Hand the graph to a reasoner and to contributors, sincere and hostile." },
];

export type { Tag };
