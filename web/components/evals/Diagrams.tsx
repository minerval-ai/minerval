import type { ReactNode } from "react";

// Diagrams of the eval setups (#368): inline SVG in the site's paper-and-ink
// palette, sized by viewBox so they scale with the column. Boxes are agents,
// stores or steps; arrows are data flow. Every label is text, not colour.

const F = "var(--sans)";

function Box({ x, y, w, h = 34, label, sub, dashed, strong }: { x: number; y: number; w: number; h?: number; label: string; sub?: string; dashed?: boolean; strong?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={3} fill={strong ? "var(--paper-sunk)" : "var(--paper-card)"} stroke="var(--rule)" strokeDasharray={dashed ? "4 3" : undefined} />
      <text x={x + w / 2} y={y + (sub ? 15 : h / 2 + 4)} textAnchor="middle" fontFamily={F} fontSize={12} fontWeight={600} fill="var(--ink)">{label}</text>
      {sub ? <text x={x + w / 2} y={y + 28} textAnchor="middle" fontFamily={F} fontSize={10} fill="var(--muted)">{sub}</text> : null}
    </g>
  );
}

function Arrow({ d, label, lx, ly }: { d: string; label?: string; lx?: number; ly?: number }) {
  return (
    <g>
      <path d={d} fill="none" stroke="var(--ink-soft)" strokeWidth={1.2} markerEnd="url(#arr)" />
      {label ? <text x={lx} y={ly} textAnchor="middle" fontFamily={F} fontSize={10} fill="var(--muted)">{label}</text> : null}
    </g>
  );
}

function Note({ x, y, children, anchor = "start" }: { x: number; y: number; children: ReactNode; anchor?: "start" | "middle" | "end" }) {
  return <text x={x} y={y} textAnchor={anchor} fontFamily={F} fontSize={10} fill="var(--muted)">{children}</text>;
}

function Svg({ h, title, children }: { h: number; title: string; children: ReactNode }) {
  return (
    <svg viewBox={`0 0 720 ${h}`} width="100%" role="img" aria-label={title} style={{ display: "block", maxWidth: "40rem", margin: "0.4rem 0 0.8rem" }}>
      <title>{title}</title>
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-soft)" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

/** A corpus run: documents → Extractor → Matcher → Steward (with decomposition) → Curator → graph, in the isolated database. */
export function RunDiagram() {
  return (
    <Svg h={230} title="A corpus run: documents go through the Extractor, the Matcher, a Steward per new claim, and the Curator, into a separate database.">
      <rect x={168} y={8} width={544} height={214} rx={4} fill="none" stroke="var(--rule)" strokeDasharray="4 3" />
      <Note x={180} y={24}>the test database (episteme_corpus), never the live graph</Note>
      <Box x={8} y={60} w={130} h={50} label="a cluster" sub="4 documents, committed" />
      <Arrow d="M 138 85 L 190 85" />
      <Box x={192} y={68} w={100} label="Extractor" sub="lists claims" h={40} />
      <Arrow d="M 292 88 L 344 88" label="each claim" lx={318} ly={80} />
      <Box x={346} y={68} w={100} label="Matcher" sub="already here?" h={40} />
      <Arrow d="M 446 80 L 500 60" label="new" lx={478} ly={62} />
      <Arrow d="M 446 96 L 500 150" label="known" lx={462} ly={130} />
      <Box x={502} y={40} w={110} label="Steward" sub="decompose + verdict" h={40} />
      <Arrow d="M 557 80 C 557 110, 470 110, 446 96" label="each subclaim goes back to the Matcher" lx={600} ly={126} />
      <Box x={502} y={140} w={110} label="instance" sub="added to the claim" h={40} />
      <Box x={625} y={40} w={82} label="Curator" sub="tends links" h={40} />
      <Arrow d="M 612 60 L 623 60" />
      <Box x={502} y={190} w={205} h={26} label="the claim graph" strong />
      <Arrow d="M 557 180 L 557 190" />
      <Arrow d="M 666 80 L 666 190" />
    </Svg>
  );
}

/** Scoring: a graph gives free counts and a judged sample; scorecards accumulate; groups compare. A person reviews the judge. */
export function ScoreDiagram() {
  return (
    <Svg h={205} title="Scoring a run: counts from the graph, a judged sample graded against the constitution, a scorecard file, and comparison across groups of runs; a person reviews the judge's task.">
      <Box x={8} y={70} w={110} h={40} label="a run's graph" strong />
      <Arrow d="M 118 82 L 152 50" />
      <Arrow d="M 118 98 L 152 130" />
      <Box x={154} y={30} w={190} h={40} label="counts" sub="no model, free" />
      <Box x={154} y={110} w={190} h={40} label="judge" sub="Sonnet, constitution text pinned" />
      <Arrow d="M 344 50 L 384 82" />
      <Arrow d="M 344 130 L 384 98" />
      <Box x={386} y={70} w={120} h={40} label="scorecard" sub="one file per run" />
      <Arrow d="M 506 90 L 556 90" label="3 vs 3" lx={531} ly={82} />
      <Box x={558} y={70} w={154} h={40} label="compare" sub="delta beyond the spread?" />
      <Box x={154} y={168} w={190} h={28} label="a person reads the verdicts" dashed />
      <Arrow d="M 249 168 L 249 152" />
      <Note x={356} y={186}>fixes to the judge&apos;s task</Note>
    </Svg>
  );
}

/** Two arms: the same cluster built twice with one thing changed, snapshotted, compared. */
export function TwoArmDiagram({ change }: { change: string }) {
  return (
    <Svg h={190} title={`Two arms: the same cluster built twice, arm B with ${change}; both saved as snapshots and compared by the graph-agreement metric.`}>
      <Box x={8} y={70} w={110} h={40} label="a cluster" />
      <Arrow d="M 118 80 L 178 44" />
      <Arrow d="M 118 100 L 178 136" />
      <Box x={180} y={22} w={150} h={40} label="arm A" sub="the reference run" />
      <Box x={180} y={116} w={150} h={40} label="arm B" sub={change} />
      <Arrow d="M 330 42 L 390 42" />
      <Arrow d="M 330 136 L 390 136" />
      <Box x={392} y={22} w={100} h={40} label="snapshot A" dashed />
      <Box x={392} y={116} w={100} h={40} label="snapshot B" dashed />
      <Arrow d="M 492 46 L 552 80" />
      <Arrow d="M 492 132 L 552 100" />
      <Box x={554} y={70} w={156} h={40} label="agreement" sub="claims · verdicts · edges" strong />
    </Svg>
  );
}

/** Contributions: personas submit against a graph; Reviewer decides; escalations and appeals reach the Arbitrator. */
export function ContributionDiagram() {
  return (
    <Svg h={200} title="A contribution scenario: four personas submit contributions against a graph; the Reviewer accepts, rejects or escalates; rejections can be appealed to the Arbitrator; accepted changes go to the Steward.">
      <Box x={8} y={70} w={120} h={40} label="4 personas" sub="scripted contributions" />
      <Arrow d="M 128 90 L 188 90" label="10 submissions" lx={158} ly={82} />
      <Box x={190} y={70} w={110} h={40} label="Reviewer" sub="Sonnet" />
      <Arrow d="M 300 80 L 360 40" label="accept" lx={335} ly={50} />
      <Arrow d="M 300 90 L 360 90" label="escalate" lx={330} ly={104} />
      <Arrow d="M 300 100 L 360 150" label="reject" lx={318} ly={140} />
      <Box x={362} y={20} w={110} h={40} label="Steward" sub="applies the change" />
      <Box x={362} y={70} w={110} h={40} label="Arbitrator" sub="Fable" />
      <Box x={362} y={130} w={110} h={40} label="appeal" sub="if the script says so" dashed />
      <Arrow d="M 417 130 L 417 112" />
      <Arrow d="M 472 90 L 540 90" />
      <Box x={542} y={70} w={168} h={40} label="report" sub="every decision + its reasoning" strong />
    </Svg>
  );
}

/** Predictions: a question seeded as a claim; the Steward's last credence before the cutoff is scored once the world settles it. */
export function PredictionTimeline() {
  return (
    <Svg h={150} title="A prediction over time: seeded as a claim, assessed by the Steward, credence frozen at the cutoff, then scored against the outcome.">
      <path d="M 20 90 L 700 90" stroke="var(--rule)" strokeWidth={1.5} />
      {[
        [60, "seeded", "as an ordinary claim"],
        [230, "assessed", "Steward records a credence"],
        [400, "cutoff", "last credence before this counts"],
        [560, "resolved", "the world settles it"],
        [660, "scored", "Brier, log, calibration"],
      ].map(([x, l, sub]) => (
        <g key={String(l)}>
          <circle cx={Number(x)} cy={90} r={4} fill="var(--ink)" />
          <text x={Number(x)} y={70} textAnchor="middle" fontFamily={F} fontSize={12} fontWeight={600} fill="var(--ink)">{l}</text>
          <text x={Number(x)} y={112} textAnchor="middle" fontFamily={F} fontSize={10} fill="var(--muted)">{sub}</text>
        </g>
      ))}
    </Svg>
  );
}

/** The noise band: two groups of three runs; the difference of means must clear the combined spread. */
export function NoiseBandDiagram() {
  const a = [0.58, 0.63, 0.61];
  const b = [0.66, 0.71, 0.69];
  const x = (v: number) => 60 + (v - 0.5) * 2200;
  return (
    <Svg h={120} title="Noise band: three runs on each side; the difference between the two means counts only when it exceeds the sum of the two spreads.">
      <path d="M 40 60 L 680 60" stroke="var(--rule)" />
      {a.map((v, i) => <circle key={`a${i}`} cx={x(v)} cy={60} r={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />)}
      {b.map((v, i) => <circle key={`b${i}`} cx={x(v)} cy={60} r={5} fill="var(--ink)" />)}
      <path d={`M ${x(0.58)} 40 L ${x(0.63)} 40`} stroke="var(--ink)" strokeWidth={1} />
      <path d={`M ${x(0.66)} 40 L ${x(0.71)} 40`} stroke="var(--ink)" strokeWidth={1} />
      <Note x={x(0.605)} y={30} anchor="middle">A: mean ± spread</Note>
      <Note x={x(0.685)} y={30} anchor="middle">B: mean ± spread</Note>
      <path d={`M ${x(0.607)} 85 L ${x(0.687)} 85`} stroke="var(--ink-soft)" strokeWidth={1.2} markerEnd="url(#arr)" markerStart="url(#arr)" />
      <Note x={x(0.647)} y={105} anchor="middle">Δ of means: a result only if larger than spread A + spread B</Note>
    </Svg>
  );
}

/** How the evals relate, for the index. */
export function MapDiagram() {
  return (
    <Svg h={250} title="How the evals fit together: a run makes a graph; counts and a judge score it; two runs are compared for stability; fixed cases test the Matcher; scripted contributions test governance; predictions are checked against reality.">
      <Box x={250} y={10} w={220} h={36} label="a corpus run builds a graph" strong />
      <Arrow d="M 300 46 L 120 80" />
      <Arrow d="M 360 46 L 360 80" />
      <Arrow d="M 420 46 L 600 80" />
      <Box x={20} y={82} w={200} h={44} label="score it" sub="counts · judge · review" />
      <Box x={280} y={82} w={160} h={44} label="build it again" sub="same · shuffled · swapped" />
      <Box x={500} y={82} w={200} h={44} label="contribute to it" sub="Reviewer · Arbitrator" />
      <Arrow d="M 120 126 L 120 160" />
      <Arrow d="M 360 126 L 360 160" />
      <Box x={20} y={162} w={200} h={40} label="compare runs" sub="3 vs 3, beyond the noise" />
      <Box x={280} y={162} w={160} h={40} label="agreement" sub="how far the graph moved" />
      <Box x={500} y={162} w={200} h={40} label="golden pairs" sub="30 fixed Matcher cases, cents" />
      <Box x={20} y={214} w={680} h={28} label="predictions: the one place reality grades the graph" dashed />
    </Svg>
  );
}
