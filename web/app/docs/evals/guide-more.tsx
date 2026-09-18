import Link from "next/link";
import { Cmd, G, type Tag } from "@/components/evals/Bits";
import { TwoArmDiagram } from "@/components/evals/Diagrams";
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
];

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
    default:
      return null;
  }
}

export const MORE_GROUPS: Array<{ key: string; title: string; note?: string }> = [
  { key: "use", title: "Does it hold up in use?", note: "Hand the graph to a reasoner and to contributors, sincere and hostile." },
];

export type { Tag };
