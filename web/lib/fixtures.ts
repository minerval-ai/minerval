import type {
  AttemptSummary, ClaimDetail, ClaimEventsPage, FormalizationSummary, PrizeListItem,
  SearchResultItem,
} from "./types";

// Fixture data for design iteration before the API is wired in. A worked
// example built to the constitution's structural rules: "inflation was high"
// canonicalised (§3), decomposing into a verified bedrock fact and a contested
// definitional threshold (§6), which is exactly why the parent lands on
// SUPPORTED rather than VERIFIED (§10). The fixtures double as the sample
// claim linked from empty states, so every field models current spec: the
// arithmetic step lives in the argument's prose rather than as a node (§6),
// the argument carries its written form (#129) and the steward's evaluation
// (#173), credence is omitted where it would be false precision (§10), and
// the contribution record and the events timeline tell one coherent story.

// The "Direct measurement" argument's written form (issue #129): brief prose
// stating how its attached subclaims combine, each referenced inline so
// renderers link them. One string, threaded onto each of the argument's edges
// (as the tree API does) and into the argument record itself. The comparison
// of the two figures is a derivation step, not a claim (§6), so it lives here
// in the prose.
const ARG_DIRECT_WRITTEN =
  "Because [[claim:bls-cpi|the BLS measured 6.5% CPI growth for 2022]] and " +
  "[[claim:threshold-def|the threshold for “high” annual inflation is 5%]], " +
  "and 6.5% exceeds that threshold, the claim follows.";

// The steward's evaluation of the argument (issue #173): does the inference
// go through granting its premises, and which premises carry the weight?
const ARG_DIRECT_EVALUATION =
  "Granting its premises, the inference is simple arithmetic and goes " +
  "through. The argument lives or dies on [[claim:threshold-def|where the " +
  "threshold for “high” inflation is set]]: the measured figure is verified, " +
  "so the contested definitional premise carries all of the remaining weight.";

const FLAGSHIP: ClaimDetail = {
  claim: {
    id: "inflation-2022",
    text: "US CPI inflation in 2022 exceeded the threshold for “high” inflation.",
    claim_type: "empirical_derived",
    state: "active",
    decomposition_status: "complete",
    // §19: real consequence within a domain and actively argued, but the only
    // live question is definitional — a major claim, not a central one.
    importance: 0.6,
    steward_state: "done",
    created_by: "extractor",
    created_at: "2024-11-02T14:20:00Z",
    updated_at: "2026-03-18T09:12:00Z",
  },
  // Direct active children of the claim (the API's getSubclaimCount).
  subclaim_count: 2,
  // Mathematics fields are null and empty on an empirical claim; the sample
  // theorem below carries them.
  formalization: null,
  verification: null,
  bounty: null,
  attempts: [],
  prize_claims: [],
  assessment: {
    id: "a-1",
    status: "supported",
    // Verdict confidence: how sure the Steward is that "supported" is right.
    confidence: 0.78,
    // No credence: the claim's one open question is definitional, and a single
    // probability would be false precision (§10). The omission is information.
    claim_credence: null,
    // Assessment prose carries the same inline conventions as written forms
    // (issue #203): [[claim:<id>]] references link to subclaims, bare source
    // URLs become links.
    summary:
      "US consumer prices [[claim:bls-cpi|rose 6.5% over 2022]], so whether inflation was “high” comes down to [[claim:threshold-def|where the threshold is set]]. Against the Federal Reserve's [[claim:fed-target|2% target]], or the looser 5% often used in policy debate, 6.5% is unambiguously high, and that is the mainstream reading. The one genuine question is definitional, not factual: [[claim:hyperinflation-view|a minority usage reserves “high” for double-digit or hyperinflationary episodes]], under which 2022 would not qualify. The underlying figure itself is not in dispute.",
    reasoning_trace:
      "The measured-magnitude leg of this claim is settled: [[claim:bls-cpi|the Bureau of Labor Statistics reported year-over-year CPI growth of 6.5% for 2022]], a verified bedrock fact traceable to the primary release (https://www.bls.gov/news.release/archives/cpi_01122023.htm). The claim's overall status turns instead on a definitional subclaim: [[claim:threshold-def|what annual rate constitutes “high” inflation]]. Under the most common reference points, the Federal Reserve's 2% target and the looser 5% figure used in policy commentary, 6.5% clearly qualifies; but the threshold is a contested definitional choice rather than an empirical fact, and a minority of credible sources reserve “high” for double-digit or hyperinflationary regimes. Because the conclusion rests on that contested definition, the claim is Supported rather than Verified, and no single probability of truth is stated: the remaining uncertainty is about usage, not about the world. It is not Contested overall, since no credible source disputes the 6.5% figure and the conclusion holds under any mainstream threshold. A shift in the settled usage of “high inflation”, or a revision to the CPI series, would change this conclusion.",
    // Deprecated (#160): the pipeline never computes this; the column defaults
    // to {} and the API carries the empty value forward.
    subclaim_summary: {},
    assessed_at: "2026-03-18T09:12:00Z",
    // The model behind the verdict (#294), shown next to the date.
    model: "claude-fable-5-1",
  },
  trajectory: {
    current: { status: "supported", confidence: 0.78, assessed_at: "2026-03-18T09:12:00Z", is_current: true, trigger: "contribution_accepted" },
    history: [
      { status: "supported", confidence: 0.78, assessed_at: "2026-03-18T09:12:00Z", is_current: true, trigger: "contribution_accepted" },
      { status: "verified", confidence: 0.71, assessed_at: "2025-06-01T00:00:00Z", is_current: false, trigger: "subclaim_change" },
      { status: "unknown", confidence: 0.40, assessed_at: "2024-11-02T14:20:00Z", is_current: false, trigger: "structure_and_assess" },
    ],
    total_assessments: 3,
    status_transitions: 2,
  },
  // A single natural line of support needs no named argument (§7, #204), but
  // naming one is permitted, and the fixture does so deliberately: it is the
  // only offline data exercising the written-form (#129) and evaluation
  // (#173) surfaces. The threshold claim's children below stay ungrouped, so
  // the Basis rendering path is exercised too.
  arguments: [
    {
      id: "arg-direct",
      name: "Direct measurement",
      stance: "for",
      content: ARG_DIRECT_WRITTEN,
      evidence_urls: ["https://www.bls.gov/news.release/archives/cpi_01122023.htm"],
      created_by: "claim_steward",
      created_at: "2024-11-02T14:25:00Z",
      // Steward evaluation (issue #173), maintained with the assessment.
      verdict: "holds",
      evaluation: ARG_DIRECT_EVALUATION,
    },
  ],
  // Claims elsewhere in the graph that lean on this one — reverse decomposition
  // edges. These fill the right margin of the claim page (issue #42). They are
  // design stubs: the ids resolve to the generic "not in fixture set" page until
  // the API is wired in.
  dependents: [
    {
      id: "fed-rate-hikes-justified",
      text: "The Federal Reserve was justified in raising interest rates aggressively through 2022–2023.",
      claim_type: "evaluative",
      relation_type: "requires",
      reasoning:
        "The case for aggressive tightening rests on inflation actually having been high: if 2022 inflation were within the normal range, the rate path needs a different justification entirely.",
      assessment_status: "supported",
      assessment_confidence: 0.66,
    },
    {
      id: "real-wages-fell-2022",
      text: "Real (inflation-adjusted) wages fell for most US workers in 2022.",
      claim_type: "empirical_derived",
      relation_type: "requires",
      reasoning:
        "Falling real wages in 2022 turn on prices having outrun nominal wage growth; if inflation had been modest, the claim would fail.",
      assessment_status: "verified",
      assessment_confidence: 0.9,
      assessment_credence: 0.93,
    },
    {
      id: "cost-of-living-crisis-2022",
      text: "2022 was the worst US cost-of-living squeeze in four decades.",
      claim_type: "evaluative",
      relation_type: "supports",
      reasoning:
        "A forty-year-high inflation print is the strongest single piece of evidence for calling 2022 the worst squeeze in four decades, though the squeeze claim also weighs wages and transfers.",
      assessment_status: "contested",
      assessment_confidence: 0.58,
    },
    {
      id: "tightening-overreaction",
      text: "The 2022 monetary tightening was a policy overreaction to transitory inflation.",
      claim_type: "causal",
      relation_type: "contradicts",
      reasoning:
        "The overreaction thesis frames 2022 inflation as transitory and mild in hindsight, which sits in tension with characterising the year's inflation as historically high.",
      assessment_status: "contested",
      assessment_confidence: 0.47,
    },
    // A genuine `assumes` edge (#205): the dependent's question takes this
    // claim as given, so if it failed the dependent would be ill-posed rather
    // than false.
    {
      id: "supply-driven-2022",
      text: "Supply-chain disruption, not monetary expansion, was the primary driver of 2022 US inflation.",
      claim_type: "causal",
      relation_type: "assumes",
      reasoning:
        "The causal dispute takes the unusually high 2022 inflation as the thing to be explained; if inflation had been within the normal range, the question of what drove it would be beside the point rather than settled either way.",
      assessment_status: "contested",
      assessment_confidence: 0.55,
    },
  ],
  // The public contribution record (#171), newest first. The same two
  // exchanges appear in the events timeline below, with the same ids, dates,
  // and contributors, so the two surfaces tell one coherent story: a rejected
  // methodological challenge that survived appeal, and an accepted
  // definitional challenge behind the trajectory's 2026-03-18 reassessment
  // (trigger: contribution_accepted) that pulled the verdict from Verified
  // back to Supported.
  record: [
    {
      contribution: {
        id: "ct-2",
        contributor: { id: "marisol-vega", display_name: "Marisol Vega" },
        contribution_type: "challenge",
        content:
          "“Verified” overstates this. The 6.5% figure is bedrock, but whether it clears the bar for “high” turns on a definitional threshold that is genuinely contested: a minority usage reserves “high” for double-digit regimes. The verdict should reflect that the conclusion rests on a contested definition, not a settled fact.",
        evidence_urls: [],
        submitted_at: "2026-03-16T18:40:00Z",
        review_status: "accepted",
      },
      review: {
        id: "rv-2",
        decision: "accept",
        reasoning:
          "The challenge engages the decomposition directly: the threshold subclaim is already assessed as contested, and a status of Verified says the evidence, examined directly, establishes the claim. Where the conclusion turns on a contested definitional choice, Supported states the position honestly. Accepted; the claim's steward will revisit the assessment with the definitional dependence weighed explicitly.",
        confidence: 0.86,
        policy_citations: ["EU", "§10 (explicit uncertainty)"],
        reviewed_at: "2026-03-17T09:05:00Z",
        reviewed_by: "contribution_reviewer",
      },
      appeal: null,
      arbitration: null,
    },
    {
      contribution: {
        id: "ct-1",
        contributor: { id: "shelter-lag-skeptic", display_name: "shelter-lag-skeptic" },
        contribution_type: "challenge",
        content:
          "CPI overstates 2022 inflation: the shelter component lags observed market rents by roughly a year, so the 6.5% print partly reflects 2021 housing dynamics. The claim should not treat the headline figure as settled.",
        evidence_urls: ["https://example.com/shelter-lag-working-paper"],
        submitted_at: "2025-08-14T19:47:00Z",
        review_status: "rejected",
      },
      review: {
        id: "rv-1",
        decision: "reject",
        reasoning:
          "The challenge disputes CPI methodology, not the reported figure. The claim references the index as published; the shelter-lag critique belongs on a separate methodological claim rather than undermining this one. No cited source disputes that the BLS reported 6.5%.",
        confidence: 0.84,
        policy_citations: ["CI", "§2 (what a claim is)"],
        reviewed_at: "2025-08-14T20:15:00Z",
        reviewed_by: "contribution_reviewer",
      },
      appeal: {
        id: "ap-1",
        appellant: { id: "shelter-lag-skeptic", display_name: "shelter-lag-skeptic" },
        appeal_reasoning:
          "The review misreads the challenge. If the input measure is systematically biased, a claim derived from it cannot be treated as settled; the lag literature I cited is peer-reviewed, not opinion.",
        submitted_at: "2025-08-20T09:02:00Z",
        status: "resolved",
      },
      arbitration: {
        id: "ar-1",
        outcome: "uphold_original",
        decision: "Rejection upheld.",
        reasoning:
          "The claim, as canonicalised, is about the CPI figure as published. A methodological critique of CPI construction bears on a different claim, which the challenger remains free to propose. All three panel models read it the same way.",
        consensus_achieved: true,
        human_review_recommended: false,
        arbitrated_at: "2025-08-21T11:20:00Z",
        arbitrated_by: "dispute_arbitrator",
      },
    },
  ],
  instances: [
    {
      id: "inst-1",
      source_id: "src-bls",
      original_text:
        "The Consumer Price Index for All Urban Consumers (CPI-U) rose 6.5 percent over the 12 months ending December 2022.",
      context: "From the BLS monthly CPI news release, summary table for the 2022 calendar year.",
      confidence: 0.99,
      source_title: "Consumer Price Index — December 2022 (BLS)",
      source_url: "https://www.bls.gov/news.release/archives/cpi_01122023.htm",
      source_type: "primary_data",
    },
    {
      id: "inst-2",
      source_id: "src-news",
      original_text: "Inflation hit a 40-year high in 2022, squeezing households across the country.",
      context: "Lede of a retrospective news analysis on the 2022 cost-of-living crisis.",
      confidence: 0.82,
      source_title: "A year of soaring prices, in charts",
      source_url: "https://example.com/2022-inflation-charts",
      source_type: "news_secondary",
    },
  ],
  tree: {
    id: "inflation-2022",
    text: "US CPI inflation in 2022 exceeded the threshold for “high” inflation.",
    claim_type: "empirical_derived",
    state: "active",
    depth: 0,
    relation_type: null, reasoning: null, confidence: null,
    assessment_status: "supported", assessment_confidence: 0.78,
    argument_id: null, argument_name: null, argument_stance: null,
    argument_content: null, argument_verdict: null, argument_evaluation: null,
    children: [
      {
        id: "bls-cpi",
        text: "The US Bureau of Labor Statistics reported CPI-U growth of 6.5% for the 12 months ending December 2022.",
        claim_type: "empirical_verifiable", state: "active", depth: 1,
        relation_type: "requires",
        reasoning: "The claim asserts a magnitude of inflation; that magnitude is fixed by the official CPI release. If the reported figure were different, the parent claim's truth would change accordingly.",
        confidence: 0.99, assessment_status: "verified", assessment_confidence: 0.97,
        assessment_credence: 0.99,
        argument_id: "arg-direct", argument_name: "Direct measurement", argument_stance: "for",
        argument_content: ARG_DIRECT_WRITTEN,
        argument_verdict: "holds", argument_evaluation: ARG_DIRECT_EVALUATION,
        children: [],
      },
      {
        id: "threshold-def",
        text: "The threshold for “high” annual CPI inflation is 5%.",
        claim_type: "definitional", state: "active", depth: 1,
        relation_type: "defines",
        reasoning: "Whether 6.5% counts as “high” depends entirely on where the threshold is set. This is a definitional choice, not an empirical finding, and reasonable sources place it differently.",
        // Edge confidence is confidence in the relationship, not in the
        // subclaim: the definitional dependence itself is clear-cut.
        confidence: 0.9,
        // Confidently contested (§10): the steward is near-certain the
        // definitional disagreement is real. No credence on a definition.
        assessment_status: "contested", assessment_confidence: 0.8,
        argument_id: "arg-direct", argument_name: "Direct measurement", argument_stance: "for",
        argument_content: ARG_DIRECT_WRITTEN,
        argument_verdict: "holds", argument_evaluation: ARG_DIRECT_EVALUATION,
        // The threshold claim's own basis (#204): direct dependencies not
        // gathered under a named argument, so no argument fields on the edges.
        children: [
          {
            id: "fed-target",
            text: "The Federal Reserve's stated long-run inflation target is 2%.",
            claim_type: "empirical_verifiable", state: "active", depth: 2,
            relation_type: "supports",
            reasoning: "A 2% target is the conventional baseline against which deviations are judged “high”; 6.5% is more than triple it.",
            confidence: 0.95, assessment_status: "verified", assessment_confidence: 0.96,
            assessment_credence: 0.98,
            argument_id: null, argument_name: null, argument_stance: null,
            argument_content: null, argument_verdict: null, argument_evaluation: null,
            children: [],
          },
          {
            id: "hyperinflation-view",
            text: "Annual inflation qualifies as “high” only at double-digit or hyperinflationary rates.",
            claim_type: "definitional", state: "active", depth: 2,
            relation_type: "contradicts",
            reasoning: "A minority usage reserves “high” for much larger figures; if that usage is the right one, a 5% threshold is wrong and 6.5% would not qualify.",
            confidence: 0.85,
            // Contested, not unsupported: credible sources sit on both sides
            // of the usage question, which is what keeps the parent threshold
            // claim contested (§21).
            assessment_status: "contested", assessment_confidence: 0.6,
            argument_id: null, argument_name: null, argument_stance: null,
            argument_content: null, argument_verdict: null, argument_evaluation: null,
            children: [],
          },
        ],
      },
    ],
  },
};

// The flagship claim's unified event history (issue #175), as the API's
// GET /claims/:id/events returns it: newest first, every kind represented.
// The assessment events agree with the trajectory fixture above, and the two
// contribution exchanges are the same ones in the record fixture — a rejected
// methodological challenge that survived appeal, and an accepted definitional
// challenge that pulled the verdict from Verified back to Supported.
const FLAGSHIP_EVENTS: ClaimEventsPage = {
  total: 12,
  events: [
    {
      kind: "assessment",
      id: "assessment:a-1",
      at: "2026-03-18T09:12:00Z",
      actor: "claim_steward",
      assessment_id: "a-1",
      status: "supported",
      confidence: 0.78,
      claim_credence: null,
      summary:
        "The 6.5% figure is beyond dispute, but the accepted challenge is right that “high” rests on [[claim:threshold-def|a contested definitional threshold]]. Supported, not Verified: the conclusion holds under any mainstream threshold, while the threshold itself remains a definitional choice.",
      trigger: "contribution_accepted",
      trigger_context:
        "Accepted challenge: the “high” threshold is definitional and contested; Verified overstated the settled part.",
      is_current: true,
      prev_status: "verified",
      prev_confidence: 0.71,
    },
    {
      kind: "review",
      id: "review:rv-2",
      at: "2026-03-17T09:05:00Z",
      actor: "contribution_reviewer",
      review_id: "rv-2",
      contribution_id: "ct-2",
      contribution_type: "challenge",
      decision: "accept",
      reasoning:
        "The challenge engages the decomposition directly: the threshold subclaim is already assessed as contested, and a status of Verified says the evidence, examined directly, establishes the claim. Where the conclusion turns on a contested definitional choice, Supported states the position honestly. Accepted; the claim's steward will revisit the assessment with the definitional dependence weighed explicitly.",
      confidence: 0.86,
      policy_citations: ["EU", "§10 (explicit uncertainty)"],
      suspected_bad_faith: false,
    },
    {
      kind: "contribution",
      id: "contribution:ct-2",
      at: "2026-03-16T18:40:00Z",
      actor: "marisol-vega",
      contribution_id: "ct-2",
      contribution_type: "challenge",
      content:
        "“Verified” overstates this. The 6.5% figure is bedrock, but whether it clears the bar for “high” turns on a definitional threshold that is genuinely contested: a minority usage reserves “high” for double-digit regimes. The verdict should reflect that the conclusion rests on a contested definition, not a settled fact.",
      evidence_urls: [],
      review_status: "accepted",
    },
    {
      kind: "steward_note",
      id: "steward_note:au-2",
      at: "2025-08-21T11:32:00Z",
      actor: "claim_steward",
      audit_id: "au-2",
      action: "no_action_needed",
      reasoning:
        "Arbitration upheld the rejection of the shelter-lag challenge; the assessment already notes that the measured figure is not in dispute. No reassessment required.",
    },
    {
      kind: "arbitration",
      id: "arbitration:ar-1",
      at: "2025-08-21T11:20:00Z",
      actor: "dispute_arbitrator",
      arbitration_id: "ar-1",
      contribution_id: "ct-1",
      appeal_id: "ap-1",
      outcome: "uphold_original",
      reasoning:
        "The claim, as canonicalised, is about the CPI figure as published. A methodological critique of CPI construction bears on a different claim, which the challenger remains free to propose. All three panel models read it the same way.",
      consensus_achieved: true,
      human_review_recommended: false,
    },
    {
      kind: "appeal",
      id: "appeal:ap-1",
      at: "2025-08-20T09:02:00Z",
      actor: "shelter-lag-skeptic",
      appeal_id: "ap-1",
      contribution_id: "ct-1",
      reasoning:
        "The review misreads the challenge. If the input measure is systematically biased, a claim derived from it cannot be treated as settled; the lag literature I cited is peer-reviewed, not opinion.",
      status: "resolved",
    },
    {
      kind: "review",
      id: "review:rv-1",
      at: "2025-08-14T20:15:00Z",
      actor: "contribution_reviewer",
      review_id: "rv-1",
      contribution_id: "ct-1",
      contribution_type: "challenge",
      decision: "reject",
      reasoning:
        "The challenge disputes CPI methodology, not the reported figure. The claim references the index as published; the shelter-lag critique belongs on a separate methodological claim rather than undermining this one. No cited source disputes that the BLS reported 6.5%.",
      confidence: 0.84,
      policy_citations: ["CI", "§2 (what a claim is)"],
      suspected_bad_faith: false,
    },
    {
      kind: "contribution",
      id: "contribution:ct-1",
      at: "2025-08-14T19:47:00Z",
      actor: "shelter-lag-skeptic",
      contribution_id: "ct-1",
      contribution_type: "challenge",
      content:
        "CPI overstates 2022 inflation: the shelter component lags observed market rents by roughly a year, so the 6.5% print partly reflects 2021 housing dynamics. The claim should not treat the headline figure as settled.",
      evidence_urls: ["https://example.com/shelter-lag-working-paper"],
      review_status: "rejected",
    },
    {
      kind: "assessment",
      id: "assessment:a-0b",
      at: "2025-06-01T00:00:00Z",
      actor: "claim_steward",
      assessment_id: "a-0b",
      status: "verified",
      confidence: 0.71,
      claim_credence: 0.93,
      summary:
        "The measured-rate subclaim resolved to Verified against the primary BLS release, and the comparison to the threshold is trivial; with every leg of the decomposition settled, the parent follows.",
      trigger: "subclaim_change",
      trigger_context: "The measured-rate subclaim resolved: verified against the primary BLS release.",
      is_current: false,
      prev_status: "unknown",
      prev_confidence: 0.4,
    },
    {
      kind: "steward_note",
      id: "steward_note:au-1",
      at: "2025-05-20T08:00:00Z",
      actor: "claim_steward",
      audit_id: "au-1",
      action: "updated_canonical_form",
      reasoning:
        "Canonicalised from “inflation was high in 2022” to the explicit threshold form. The original wording hid the definitional dependence that the decomposition now makes assessable.",
    },
    {
      kind: "assessment",
      id: "assessment:a-0a",
      at: "2024-11-02T14:20:00Z",
      actor: "claim_steward",
      assessment_id: "a-0a",
      status: "unknown",
      confidence: 0.4,
      claim_credence: null,
      summary:
        "Freshly extracted; the decomposition has not yet resolved the measured figure or the threshold, so no verdict is warranted.",
      trigger: "structure_and_assess",
      trigger_context: null,
      is_current: false,
      prev_status: null,
      prev_confidence: null,
    },
    {
      kind: "created",
      id: "created:inflation-2022",
      at: "2024-11-02T14:20:00Z",
      actor: "extractor",
    },
  ],
};

// Importance values follow §19's cross-domain anchors: the minimum-wage
// employment claim is the constitution's own "major" (≈0.6) example, and the
// settled, uncontested age of the universe scores low even though much
// depends on it.
const INDEX: SearchResultItem[] = [
  { id: "inflation-2022", text: FLAGSHIP.claim.text, claim_type: "empirical_derived", state: "active", similarity_score: 0.91, importance: 0.6, assessment_status: "supported", assessment_confidence: 0.78, prize_micro_usd: null, checked: null },
  { id: "min-wage", text: "The federal minimum wage should be raised to $15 per hour.", claim_type: "normative", state: "active", similarity_score: 0.74, importance: 0.65, assessment_status: "contested", assessment_confidence: 0.62, prize_micro_usd: null, checked: null },
  { id: "universe-age", text: "The universe is approximately 13.8 billion years old.", claim_type: "empirical_derived", state: "active", similarity_score: 0.69, importance: 0.2, assessment_status: "verified", assessment_confidence: 0.94, prize_micro_usd: null, checked: null },
  { id: "mw-employment", text: "Raising the minimum wage to $15 reduces teen employment.", claim_type: "causal", state: "active", similarity_score: 0.66, importance: 0.6, assessment_status: "contested", assessment_confidence: 0.5, prize_micro_usd: null, checked: null },
  // An unassessed, low-importance leaf — left queued under the Steward's budget.
  { id: "cpi-basket-weights", text: "The CPI shelter component was reweighted in the 2023 basket revision.", claim_type: "empirical_verifiable", state: "active", similarity_score: 0.61, importance: 0.18, assessment_status: null, assessment_confidence: null, prize_micro_usd: null, checked: null },
  { id: "deflation-2009", text: "The United States experienced sustained deflation throughout 2009.", claim_type: "empirical_verifiable", state: "active", similarity_score: 0.58, importance: 0.2, assessment_status: "contradicted", assessment_confidence: 0.88, prize_micro_usd: null, checked: null },
];

// ---------------------------------------------------------------------------
// Mathematics (docs/mathematics.md). One open conjecture with a published
// formal statement, a live bounty, and the house solver's attempts; beneath
// it, a machine-checked theorem with its own page. Together they exercise the
// formal statement section, the derived machine-checked badge, the prize
// section, the attempt log, the map's ring and ⊢ marks, the theorem bedrock,
// the cards' chips, and the /prizes listing. The structure is the design's
// own: a proven weaker statement `supports` the open claim (§2.3), and a
// bounty binds to the statement of the open one only.
// ---------------------------------------------------------------------------

const PIN = {
  pin_id: "mathlib-v4.33.1",
  lean_toolchain: "leanprover/lean4:v4.33.1",
  mathlib_rev: "8c2d0f6a1b9e4d7c3a5f2e8b6d1c9a4f7e3b2d5c",
  mathlib_tag: "v4.33.1",
};

const LEGENDRE_STATEMENT: FormalizationSummary = {
  id: "fz-legendre-2",
  version: 2,
  status: "published",
  ...PIN,
  namespace: "Minerval.S1e9d4c7b_v2",
  statement_source: [
    "import Mathlib",
    "set_option autoImplicit false",
    "namespace Minerval.S1e9d4c7b_v2",
    "/-- Statement 2 of claim 1e9d4c7b. The canonical form is in the correspondence note. -/",
    "def Statement : Prop :=",
    "  ∀ n : ℕ, 0 < n → ∃ p : ℕ, p.Prime ∧ n ^ 2 < p ∧ p < (n + 1) ^ 2",
    "/-- Witness that the hypotheses are satisfiable. -/",
    "example : ∃ n : ℕ, 0 < n := ⟨1, by norm_num⟩",
    "end Minerval.S1e9d4c7b_v2",
  ].join("\n"),
  pp_type: "∀ (n : ℕ), 0 < n → ∃ p, Nat.Prime p ∧ n ^ 2 < p ∧ p < (n + 1) ^ 2",
  source_hash: "3f9a2c1d7e5b4a8c6d0f1e2b9a7c5d3e1f8b6a4c2d0e9f7b5a3c1d8e6f4a2b0c",
  expr_hash: "b7e1c4a9f2d6e8b3c5a0d7f1e9b2c4a6d8f0e3b5c7a9d1f2e4b6c8a0d3f5e7b9",
  correspondence:
    "The statement quantifies over the natural numbers with n at least 1, as the canonical form does. Nat.Prime is Mathlib's primality on ℕ, which agrees with the informal reading, and both inequalities are strict, which is the conjecture's own form. Statement 1 was retired during its public review period: it quantified over every natural number, and at n = 0 it asked for a prime strictly between 0 and 1, so it was false for a reason that had nothing to do with the conjecture. The review award was paid to the person who noticed.",
  published_at: "2026-02-20T16:00:00Z",
  review_period_ends_at: "2026-03-06T16:00:00Z",
};

const BERTRAND_STATEMENT: FormalizationSummary = {
  id: "fz-bertrand-1",
  version: 1,
  status: "published",
  ...PIN,
  namespace: "Minerval.S7a3c9e2f_v1",
  statement_source: [
    "import Mathlib",
    "set_option autoImplicit false",
    "namespace Minerval.S7a3c9e2f_v1",
    "/-- Statement 1 of claim 7a3c9e2f. The canonical form is in the correspondence note. -/",
    "def Statement : Prop :=",
    "  ∀ n : ℕ, 0 < n → ∃ p : ℕ, p.Prime ∧ n < p ∧ p ≤ 2 * n",
    "/-- Witness that the hypotheses are satisfiable. -/",
    "example : ∃ n : ℕ, 0 < n := ⟨1, by norm_num⟩",
    "end Minerval.S7a3c9e2f_v1",
  ].join("\n"),
  pp_type: "∀ (n : ℕ), 0 < n → ∃ p, Nat.Prime p ∧ n < p ∧ p ≤ 2 * n",
  source_hash: "a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d1f2a4c6e8b0d2f3a5c7e9b1d3f4a6c8",
  expr_hash: "e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d7",
  correspondence:
    "The statement is Bertrand's postulate in its usual form: for n at least 1, a prime strictly greater than n and at most 2n. Nat.Prime is Mathlib's primality on ℕ. The upper bound is weak, so n = 1 is witnessed by p = 2, as the informal statement intends.",
  published_at: "2026-02-08T11:00:00Z",
  review_period_ends_at: "2026-02-22T11:00:00Z",
};

const BERTRAND_CHECK = {
  id: "lc-bertrand-1",
  kind: "proof" as const,
  verdict: "accepted" as const,
  checked_at: "2026-02-10T18:30:00Z",
  pin_id: PIN.pin_id,
  submission_sha256: "5d2f8a1c9e4b7d3a6f0c2e8b4d9a1f7c3e5b0d8a2f6c4e1b9d7a3f5c0e8b2d4a",
  submitted_by: "math_solver",
};

// The house solver's attempts (§7.7): every one public, with its cost and,
// once the Steward has acted on it, its report and notebook.
const LEGENDRE_ATTEMPT_STD: AttemptSummary = {
  id: "att-legendre-std",
  claim_id: "legendre-conjecture",
  variant: "standard",
  effort: "standard",
  status: "completed",
  outcome: "negative",
  is_calibration: false,
  spent_micro_usd: 9_500_000,
  turns: 48,
  started_at: "2026-02-24T08:00:00Z",
  finished_at: "2026-02-24T11:20:00Z",
  published_at: "2026-02-26T09:00:00Z",
  report: {
    informal_argument:
      "The standard-effort pass surveyed the literature on primes in short intervals and tried the direct route from Bertrand's postulate: sharpen the interval (n, 2n] to (n², (n+1)²) by an explicit Chebyshev bound. The explicit bounds available are polynomially weaker than the conjecture needs, and no rearrangement of the error term closes the gap.",
    approaches_tried: [
      "Explicit Chebyshev bounds on θ(x) with Dusart's constants, aimed at intervals of length 2√x.",
      "A direct search for the statement in Mathlib and in the formal-conjectures corpus; a formal statement exists, no proof does.",
    ],
    obstruction:
      "Unconditional results place a prime in intervals of length x^0.525 for large x; the conjecture needs length 2√x + 1, exponent one half.",
    what_would_help:
      "A maximum-effort pass on the sieve route, or a formalised Dusart bound, which would make a checked proof of the computational range possible.",
    confidence: 0.02,
  },
  notebook: null,
};

const LEGENDRE_ATTEMPT_MAX: AttemptSummary = {
  id: "att-legendre-max",
  claim_id: "legendre-conjecture",
  variant: "max",
  effort: "max",
  status: "completed",
  outcome: "partial",
  is_calibration: false,
  spent_micro_usd: 84_000_000,
  turns: 212,
  started_at: "2026-03-02T04:10:00Z",
  finished_at: "2026-03-02T21:40:00Z",
  published_at: "2026-03-05T10:00:00Z",
  report: {
    informal_argument:
      "The route was to pass from Bertrand-type results to the square gap by sharpening the Chebyshev bounds on ψ(x) with explicit constants, then to close the remaining range by computation. The explicit bounds give a prime in (x, x + x/(25 log² x)] for x ≥ 396,738, which is far weaker than the 2√x + 1 the conjecture needs, and no manipulation of the error term closes the gap. What was settled is a reduction: the conjecture is equivalent to a bound on maximal prime gaps below an explicit threshold, and the threshold is beyond any computation now feasible.",
    approaches_tried: [
      "Explicit Chebyshev bounds on ψ(x) and θ(x) with Dusart's constants, aiming at intervals of length 2√x.",
      "A sieve bound on primes in short intervals, which yields lower bounds only for intervals of length x^θ with θ strictly greater than one half.",
      "Reduction to a statement about maximal prime gaps below a computable bound, then computation; the reduction holds, but the bound is far beyond reach.",
      "Formalising the case n ≤ 10⁶ in Lean by decision procedure; abandoned when elaboration exceeded the check budget.",
    ],
    obstruction:
      "Every known method for primes in short intervals loses a power x^ε beyond √x unconditionally, and the conjecture sits exactly at √x. The obstruction is the one the literature has recorded since Baker, Harman, and Pintz: the exponent 0.525 is the state of the art, and the conjecture needs 0.5.",
    what_would_help:
      "A proof for a density-one set of n would be a genuine partial result and may be within reach of the sieve route. A formalised Dusart bound in Mathlib would make the computational range reachable by a checked proof rather than by tables.",
    confidence: 0.03,
  },
  notebook: {
    "notes.md": [
      "# Legendre, maximum effort",
      "",
      "Target: ∀ n ≥ 1, ∃ p prime, n² < p < (n+1)². Interval length 2n + 1 = 2√x + 1 at x = n².",
      "",
      "1. Dusart (2010): for x ≥ 396738 there is a prime in (x, x + x/(25 log² x)]. Length x/(25 log² x) ≫ 2√x. Useless here.",
      "2. Baker–Harman–Pintz: prime in [x, x + x^0.525] for large x. Still ≫ 2√x. Exponent gap 0.025.",
      "3. Reduction: Legendre ⇔ every maximal prime gap g(p) satisfies g(p) < 2√p + 1 up to the point where BHP takes over. That point is astronomically large; no computation reaches it.",
      "4. Tried Lean decision for n ≤ 10^6 via `decide` on a bounded search: elaboration blew the budget at n ≈ 3000.",
      "",
      "Outcome: reduction only. Nothing here would pass the checker as a proof of Statement.",
    ].join("\n"),
    "Reduction.lean": [
      "import Mathlib",
      "",
      "-- The reduction that did hold: if every prime gap below the BHP threshold is",
      "-- small enough, the square-gap statement follows. The threshold is not reachable.",
      "theorem square_gap_of_gap_bound (T : ℕ)",
      "    (h : ∀ p q : ℕ, p.Prime → q.Prime → p < q → q ≤ T →",
      "      (∀ r, p < r → r < q → ¬ r.Prime) → q < p + 2 * Nat.sqrt p + 2) :",
      "    ∀ n : ℕ, 0 < n → (n + 1) ^ 2 ≤ T → ∃ p : ℕ, p.Prime ∧ n ^ 2 < p ∧ p < (n + 1) ^ 2 := by",
      "  sorry",
    ].join("\n"),
  },
};

// A calibration run (§7.5): the solver against a theorem with a known proof,
// so that its success rate on open problems has a baseline.
const BERTRAND_ATTEMPT_CAL: AttemptSummary = {
  id: "att-bertrand-cal",
  claim_id: "bertrand-postulate",
  variant: "standard",
  effort: "standard",
  status: "completed",
  outcome: "proof",
  is_calibration: true,
  spent_micro_usd: 6_200_000,
  turns: 19,
  started_at: "2026-02-10T17:05:00Z",
  finished_at: "2026-02-10T18:30:00Z",
  published_at: "2026-02-11T09:00:00Z",
  report: {
    informal_argument:
      "Bertrand's postulate is in Mathlib as Nat.exists_prime_lt_and_le_two_mul, in the form n ≠ 0 → ∃ p, p.Prime ∧ n < p ∧ p ≤ 2 * n. The published statement uses 0 < n; the proof converts the hypothesis and applies the library theorem.",
    approaches_tried: [
      "Library search by statement shape, which found the theorem on the first query.",
    ],
    obstruction: "None: a calibration run against a theorem the library already holds.",
    what_would_help: "Nothing is needed; the run establishes the baseline.",
    confidence: 0.99,
  },
  notebook: {
    "Proof.lean": [
      "theorem Minerval.S7a3c9e2f_v1.proof : Minerval.S7a3c9e2f_v1.Statement :=",
      "  fun n hn => Nat.exists_prime_lt_and_le_two_mul n (Nat.pos_iff_ne_zero.mp hn)",
    ].join("\n"),
  },
};

const ARG_PARTIAL_WRITTEN =
  "The conjecture is checked far beyond any range where a counterexample is expected: " +
  "[[claim:legendre-computed|it holds for every n below 4 × 10⁹]]. The proven results point " +
  "the same way without reaching it: [[claim:bertrand-postulate|Bertrand's postulate]] puts a " +
  "prime in every interval (n, 2n], and [[claim:bhp-gaps|the Baker–Harman–Pintz bound]] puts " +
  "one in every interval [x, x + x^0.525] for large x, still longer than the 2n + 1 the " +
  "conjecture needs.";

const ARG_PARTIAL_EVALUATION =
  "Granting its premises the argument establishes exactly what it claims: evidence, not proof. " +
  "The gap between the best proven interval length, x^0.525, and the 2√x + 1 the conjecture " +
  "needs is real and has stood since 2001; [[claim:bhp-gaps|the Baker–Harman–Pintz bound]] " +
  "carries the weight, and [[claim:legendre-computed|the computation]] rules out small " +
  "counterexamples, not large ones.";

const ARG_CHEBYSHEV_WRITTEN =
  "The claim follows from Chebyshev's estimate: [[claim:primorial-bound|the product of the " +
  "primes up to n is less than 4ⁿ]], while the central binomial coefficient is too large to be " +
  "accounted for by prime powers below n alone, so a prime in (n, 2n] must divide it. Mathlib " +
  "carries the Erdős form of the argument as Nat.exists_prime_lt_and_le_two_mul, and the checked " +
  "proof applies it.";

const ARG_CHEBYSHEV_EVALUATION =
  "The inference is the theorem itself. [[claim:primorial-bound|The primorial bound]] is the one " +
  "lemma the discourse names and reuses; the rest is the proof's own arithmetic. The check " +
  "confirms the statement was proven at the pin; the judgment recorded here is that Nat.Prime " +
  "and the strict-then-weak inequalities say what the claim says.";

const LEGENDRE: ClaimDetail = {
  claim: {
    id: "legendre-conjecture",
    text: "For every positive integer n there is a prime between n² and (n+1)².",
    claim_type: "mathematical",
    state: "active",
    decomposition_status: "complete",
    // Notable (§7.7): an open problem the discourse returns to, in the range
    // where the record of AI results suggests tractability.
    importance: 0.46,
    steward_state: "done",
    domains: ["mathematics", "number theory"],
    created_by: "extractor",
    created_at: "2026-01-14T10:02:00Z",
    updated_at: "2026-03-12T09:00:00Z",
  },
  subclaim_count: 3,
  formalization: LEGENDRE_STATEMENT,
  // No accepted check of the published statement: the badge stays off. The
  // machine-checked theorem beneath it carries its own.
  verification: null,
  bounty: {
    id: "bounty-legendre-1",
    amount_micro_usd: 2_500_000_000,
    status: "open",
    resolution: "either",
    formalization_id: LEGENDRE_STATEMENT.id,
    source_hash: LEGENDRE_STATEMENT.source_hash,
    expr_hash: LEGENDRE_STATEMENT.expr_hash,
    pin_id: PIN.pin_id,
    opened_at: "2026-03-12T09:00:00Z",
    expires_at: "2027-03-12T09:00:00Z",
    withdraw_effective_at: null,
    rules_version: "1.0",
    submissions: 3,
    attempts: [
      { id: LEGENDRE_ATTEMPT_STD.id, finished_at: LEGENDRE_ATTEMPT_STD.finished_at!, variant: "standard", cost_micro_usd: LEGENDRE_ATTEMPT_STD.spent_micro_usd, outcome: "negative" },
      { id: LEGENDRE_ATTEMPT_MAX.id, finished_at: LEGENDRE_ATTEMPT_MAX.finished_at!, variant: "max", cost_micro_usd: LEGENDRE_ATTEMPT_MAX.spent_micro_usd, outcome: "partial" },
    ],
    awarded: null,
    state_sentence:
      "The prize is open. No submission is under review: two were turned away by the checker and one was withdrawn, and each may be refiled after its cooldown.",
    terms_url: "/prizes/rules",
  },
  attempts: [LEGENDRE_ATTEMPT_MAX, LEGENDRE_ATTEMPT_STD],
  // Every submission stays on the record, rejected and withdrawn included
  // (§8.10); the checker's gate summary is public on each contribution page.
  prize_claims: [
    {
      id: "pc-legendre-3",
      credit_name: "quietfield",
      direction: "proof",
      submitted_at: "2026-04-15T22:10:00Z",
      status: "rejected",
      rejected_stage: "check",
      contribution_id: "ct-m3",
    },
    {
      id: "pc-legendre-2",
      credit_name: "R. Okafor",
      direction: "disproof",
      submitted_at: "2026-04-02T13:45:00Z",
      status: "withdrawn",
      rejected_stage: null,
      contribution_id: "ct-m2",
    },
    {
      id: "pc-legendre-1",
      credit_name: "quietfield",
      direction: "proof",
      submitted_at: "2026-03-20T07:30:00Z",
      status: "rejected",
      rejected_stage: "check",
      contribution_id: "ct-m1",
    },
  ],
  assessment: {
    id: "a-m2",
    // Supported (§2.4): an open claim with evidence of the kind mathematicians
    // count, computation far beyond where a counterexample would be expected.
    status: "supported",
    confidence: 0.9,
    // Credence is meaningful for an open mathematical claim and is given: the
    // field's view, near certainty short of a proof.
    claim_credence: 0.97,
    summary:
      "Legendre's conjecture is open. It has been [[claim:legendre-computed|checked for every n below 4 × 10⁹]] by the exhaustive tables of prime gaps, and the proven results point the same way without reaching it: [[claim:bertrand-postulate|Bertrand's postulate]] puts a prime in every interval (n, 2n], and [[claim:bhp-gaps|the Baker–Harman–Pintz bound]] puts one in every interval of length x^0.525 for large x, where the conjecture needs length 2√x + 1. Supported, not verified: no proof exists, and the status answers whether one does. The credence records the field's view that the statement is true.",
    reasoning_trace:
      "The claim is a proposition of mathematics, true or false by proof, and no proof is on record. The evidence that bears on it is of three kinds. First, computation: [[claim:legendre-computed|the conjecture holds for every n below 4 × 10⁹]], because every maximal prime gap below 2⁶⁴ is known and none exceeds 1,550, while the interval between n² and (n + 1)² has length 2n + 1. Second, weaker proven statements in the same direction: [[claim:bertrand-postulate|Bertrand's postulate]], machine-checked here, and [[claim:bhp-gaps|the Baker–Harman–Pintz bound]], an accepted proof placing a prime in [x, x + x^0.525] for all sufficiently large x. Third, the heuristic of Cramér's model, under which the conjecture holds with room to spare; that heuristic is not evidence of the kind that changes a status, and it is recorded here only as the reason the credence is high. The formal statement was published on 20 February 2026 as version 2, after version 1 was retired in review for quantifying over n = 0; the house solver attempted the statement twice and settled nothing, and a prize of $2,500 is open on it. The prize changes nothing in this assessment. What would change it: a proof, which would make the claim verified; a counterexample, which the computation makes very unlikely below 4 × 10⁹; or a proof for a density-one set of n, which would strengthen the support without settling the question.",
    subclaim_summary: {},
    assessed_at: "2026-03-02T23:30:00Z",
    model: "claude-fable-5-1",
  },
  trajectory: {
    current: { status: "supported", confidence: 0.9, assessed_at: "2026-03-02T23:30:00Z", is_current: true, trigger: "steward_reassessment" },
    history: [
      { status: "supported", confidence: 0.9, assessed_at: "2026-03-02T23:30:00Z", is_current: true, trigger: "steward_reassessment" },
      { status: "unsupported", confidence: 0.55, assessed_at: "2026-01-14T10:40:00Z", is_current: false, trigger: "structure_and_assess" },
    ],
    total_assessments: 2,
    status_transitions: 1,
  },
  arguments: [
    {
      id: "arg-partial",
      name: "Partial results",
      stance: "for",
      content: ARG_PARTIAL_WRITTEN,
      evidence_urls: ["https://arxiv.org/abs/1309.6122"],
      created_by: "claim_steward",
      created_at: "2026-01-14T10:30:00Z",
      verdict: "holds",
      evaluation: ARG_PARTIAL_EVALUATION,
      lean_check: null,
    },
  ],
  // Claims that would follow from the conjecture (design stubs, like the
  // flagship's: their ids resolve to the not-found page offline).
  dependents: [
    {
      id: "prime-gap-4sqrt",
      text: "The gap after any prime p is less than 4√p + 4.",
      claim_type: "mathematical",
      relation_type: "requires",
      reasoning:
        "If a prime lies in every interval between consecutive squares, the prime after p lies before the second square past p, which bounds the gap by 4√p + 4.",
      assessment_status: "unsupported",
      assessment_confidence: 0.8,
      assessment_credence: 0.96,
      bounty_micro_usd: null,
      checked: null,
      formal: false,
    },
    {
      id: "prime-gaps-sqrt-order",
      text: "The gap between consecutive primes is O(√p).",
      claim_type: "mathematical",
      relation_type: "requires",
      reasoning:
        "The square-gap conjecture gives the bound directly; without it the best unconditional exponent is 0.525.",
      assessment_status: null,
      assessment_confidence: null,
      bounty_micro_usd: null,
      checked: null,
      formal: false,
    },
  ],
  instances: [
    {
      id: "inst-m1",
      source_id: "src-oeis",
      original_text:
        "Legendre's conjecture states that there is a prime number between n² and (n + 1)² for every positive integer n.",
      context: "The opening sentence of the conjecture's encyclopedia entry.",
      confidence: 0.98,
      source_title: "Legendre's conjecture",
      source_url: "https://en.wikipedia.org/wiki/Legendre%27s_conjecture",
      source_type: "unknown",
    },
  ],
  tree: {
    id: "legendre-conjecture",
    text: "For every positive integer n there is a prime between n² and (n+1)².",
    claim_type: "mathematical",
    state: "active",
    depth: 0,
    relation_type: null, reasoning: null, confidence: null,
    assessment_status: "supported", assessment_confidence: 0.9,
    assessment_credence: 0.97,
    argument_id: null, argument_name: null, argument_stance: null,
    argument_content: null, argument_verdict: null, argument_evaluation: null,
    bounty_micro_usd: 2_500_000_000, checked: null, formal: true,
    children: [
      {
        id: "legendre-computed",
        text: "For every positive integer n below 4 × 10⁹ there is a prime between n² and (n+1)².",
        claim_type: "mathematical", state: "active", depth: 1,
        relation_type: "supports",
        reasoning: "A large family of cases: the conjecture verified as far as the tables of prime gaps reach. Evidence of the kind mathematicians count, not a proof of the general statement.",
        confidence: 0.95, assessment_status: "verified", assessment_confidence: 0.96,
        assessment_credence: 1,
        argument_id: "arg-partial", argument_name: "Partial results", argument_stance: "for",
        argument_content: ARG_PARTIAL_WRITTEN,
        argument_verdict: "holds", argument_evaluation: ARG_PARTIAL_EVALUATION,
        // Verified by computation against published tables, not by a Lean
        // proof: no ⊢ mark, no theorem bedrock.
        bounty_micro_usd: null, checked: null, formal: false,
        children: [],
      },
      {
        id: "bertrand-postulate",
        text: "For every positive integer n there is a prime p with n < p ≤ 2n.",
        claim_type: "mathematical", state: "active", depth: 1,
        relation_type: "supports",
        reasoning: "A proven weaker statement in the same direction: a prime in every interval (n, 2n], where the conjecture needs one in every interval (n², (n+1)²).",
        confidence: 0.9, assessment_status: "verified", assessment_confidence: 0.98,
        argument_id: "arg-partial", argument_name: "Partial results", argument_stance: "for",
        argument_content: ARG_PARTIAL_WRITTEN,
        argument_verdict: "holds", argument_evaluation: ARG_PARTIAL_EVALUATION,
        bounty_micro_usd: null, checked: "proof", formal: true,
        children: [
          {
            id: "primorial-bound",
            text: "The product of all primes not exceeding n is less than 4ⁿ.",
            claim_type: "mathematical", state: "active", depth: 2,
            relation_type: "requires",
            reasoning: "Chebyshev's bound is the lemma the proof of Bertrand's postulate rests on; the discourse names and reuses it.",
            confidence: 0.95, assessment_status: "verified", assessment_confidence: 0.98,
            argument_id: "arg-chebyshev", argument_name: "Chebyshev's bound (machine-checked)", argument_stance: "for",
            argument_content: ARG_CHEBYSHEV_WRITTEN,
            argument_verdict: "holds", argument_evaluation: ARG_CHEBYSHEV_EVALUATION,
            argument_lean_check: BERTRAND_CHECK,
            // A machine-checked leaf: theorem bedrock on the map.
            bounty_micro_usd: null, checked: "proof", formal: true,
            children: [],
          },
        ],
      },
      {
        id: "bhp-gaps",
        text: "For all sufficiently large x, the interval [x, x + x^0.525] contains a prime.",
        claim_type: "mathematical", state: "active", depth: 1,
        relation_type: "supports",
        reasoning: "The best unconditional result on primes in short intervals: an accepted proof, not machine-checked, that falls short of the conjecture by the exponent 0.025.",
        confidence: 0.9, assessment_status: "verified", assessment_confidence: 0.94,
        argument_id: "arg-partial", argument_name: "Partial results", argument_stance: "for",
        argument_content: ARG_PARTIAL_WRITTEN,
        argument_verdict: "holds", argument_evaluation: ARG_PARTIAL_EVALUATION,
        bounty_micro_usd: null, checked: null, formal: false,
        children: [],
      },
    ],
  },
};

const BERTRAND: ClaimDetail = {
  claim: {
    id: "bertrand-postulate",
    text: "For every positive integer n there is a prime p with n < p ≤ 2n.",
    claim_type: "mathematical",
    state: "active",
    decomposition_status: "complete",
    // Settled (§19): uncontested, so low even though much depends on it.
    importance: 0.12,
    steward_state: "done",
    domains: ["mathematics", "number theory"],
    created_by: "claim_steward",
    created_at: "2026-01-14T10:30:00Z",
    updated_at: "2026-02-11T09:00:00Z",
  },
  subclaim_count: 1,
  formalization: BERTRAND_STATEMENT,
  // The derived badge (§2.3): an argument whose evidence is a check the
  // checker accepted, at the pin, against the published statement.
  verification: {
    kind: "proof",
    lean_check_id: BERTRAND_CHECK.id,
    checked_at: BERTRAND_CHECK.checked_at,
    formalization_id: BERTRAND_STATEMENT.id,
    pin_id: PIN.pin_id,
  },
  // A theorem with a proof gets no bounty.
  bounty: null,
  attempts: [BERTRAND_ATTEMPT_CAL],
  prize_claims: [],
  assessment: {
    id: "a-b1",
    status: "verified",
    confidence: 0.98,
    // No credence on a proven theorem: the status answers the question, and
    // a probability would add nothing (§2.4).
    claim_credence: null,
    summary:
      "Bertrand's postulate is a theorem: proven by Chebyshev in 1852, given an elementary proof by Erdős in 1932, and carried by Mathlib as Nat.exists_prime_lt_and_le_two_mul. The proof below is machine-checked against the published formal statement at the pinned Mathlib revision. The checker confirms the proof; the verdict here is the judgment that the statement checked says what the claim says.",
    reasoning_trace:
      "Verified by the machine-checked route (§2.4): a formal proof of the published statement checks under the pin with a clean axiom list, and the statement is faithful to the wording. The argument rests on [[claim:primorial-bound|Chebyshev's bound on the primorial]], which the discourse names and reuses and which is itself in Mathlib; the rest of the proof is arithmetic on the central binomial coefficient and is not a claim. The check was the solver's calibration run of 10 February 2026, accepted at mathlib-v4.33.1 with axioms propext, Classical.choice, and Quot.sound only. Fidelity was reviewed at drafting and in a fresh-context pass: Nat.Prime is the primality of the informal statement, the lower bound is strict and the upper bound weak as the postulate states, and the witness n = 1, p = 2 shows the hypotheses are satisfiable.",
    subclaim_summary: {},
    assessed_at: "2026-02-11T09:00:00Z",
    model: "claude-fable-5-1",
  },
  trajectory: {
    current: { status: "verified", confidence: 0.98, assessed_at: "2026-02-11T09:00:00Z", is_current: true, trigger: "steward_reassessment" },
    history: [
      { status: "verified", confidence: 0.98, assessed_at: "2026-02-11T09:00:00Z", is_current: true, trigger: "steward_reassessment" },
      { status: "verified", confidence: 0.95, assessed_at: "2026-01-14T11:00:00Z", is_current: false, trigger: "structure_and_assess" },
    ],
    total_assessments: 2,
    status_transitions: 0,
  },
  arguments: [
    {
      id: "arg-chebyshev",
      name: "Chebyshev's bound (machine-checked)",
      stance: "for",
      content: ARG_CHEBYSHEV_WRITTEN,
      evidence_urls: [],
      created_by: "claim_steward",
      created_at: "2026-02-11T09:00:00Z",
      verdict: "holds",
      evaluation: ARG_CHEBYSHEV_EVALUATION,
      lean_check: BERTRAND_CHECK,
    },
  ],
  dependents: [
    {
      id: "legendre-conjecture",
      text: LEGENDRE.claim.text,
      claim_type: "mathematical",
      relation_type: "supports",
      reasoning: "A proven weaker statement in the same direction as the conjecture.",
      assessment_status: "supported",
      assessment_confidence: 0.9,
      assessment_credence: 0.97,
      bounty_micro_usd: 2_500_000_000,
      checked: null,
      formal: true,
    },
  ],
  instances: [],
  tree: {
    id: "bertrand-postulate",
    text: "For every positive integer n there is a prime p with n < p ≤ 2n.",
    claim_type: "mathematical",
    state: "active",
    depth: 0,
    relation_type: null, reasoning: null, confidence: null,
    assessment_status: "verified", assessment_confidence: 0.98,
    argument_id: null, argument_name: null, argument_stance: null,
    argument_content: null, argument_verdict: null, argument_evaluation: null,
    bounty_micro_usd: null, checked: "proof", formal: true,
    children: [
      {
        id: "primorial-bound",
        text: "The product of all primes not exceeding n is less than 4ⁿ.",
        claim_type: "mathematical", state: "active", depth: 1,
        relation_type: "requires",
        reasoning: "Chebyshev's bound is the lemma the proof of Bertrand's postulate rests on; the discourse names and reuses it.",
        confidence: 0.95, assessment_status: "verified", assessment_confidence: 0.98,
        argument_id: "arg-chebyshev", argument_name: "Chebyshev's bound (machine-checked)", argument_stance: "for",
        argument_content: ARG_CHEBYSHEV_WRITTEN,
        argument_verdict: "holds", argument_evaluation: ARG_CHEBYSHEV_EVALUATION,
        argument_lean_check: BERTRAND_CHECK,
        bounty_micro_usd: null, checked: "proof", formal: true,
        children: [],
      },
    ],
  },
};

const LEGENDRE_EVENTS: ClaimEventsPage = {
  total: 3,
  events: [
    {
      kind: "assessment",
      id: "assessment:a-m2",
      at: "2026-03-02T23:30:00Z",
      actor: "claim_steward",
      assessment_id: "a-m2",
      status: "supported",
      confidence: 0.9,
      claim_credence: 0.97,
      summary:
        "Reassessed after the formal statement was published and the house solver's attempts closed: the computation and the proven weaker statements are evidence of the kind mathematicians count, so Supported rather than Unsupported. Still open; the prize changes nothing here.",
      trigger: "steward_reassessment",
      trigger_context: "Formal statement published; two house attempts closed without settling it.",
      is_current: true,
      prev_status: "unsupported",
      prev_confidence: 0.55,
    },
    {
      kind: "assessment",
      id: "assessment:a-m1",
      at: "2026-01-14T10:40:00Z",
      actor: "claim_steward",
      assessment_id: "a-m1",
      status: "unsupported",
      confidence: 0.55,
      claim_credence: 0.95,
      summary:
        "An open conjecture, freshly extracted; the decomposition has not yet gathered the partial results that bear on it.",
      trigger: "structure_and_assess",
      trigger_context: null,
      is_current: false,
      prev_status: null,
      prev_confidence: null,
    },
    {
      kind: "created",
      id: "created:legendre-conjecture",
      at: "2026-01-14T10:02:00Z",
      actor: "extractor",
    },
  ],
};

const BERTRAND_EVENTS: ClaimEventsPage = {
  total: 3,
  events: [
    {
      kind: "assessment",
      id: "assessment:a-b1",
      at: "2026-02-11T09:00:00Z",
      actor: "claim_steward",
      assessment_id: "a-b1",
      status: "verified",
      confidence: 0.98,
      claim_credence: null,
      summary:
        "Reassessed with the machine-checked proof as evidence of the highest grade: still Verified, now by the machine-checked route rather than the accepted-proof route.",
      trigger: "steward_reassessment",
      trigger_context: "The calibration run's proof was accepted by the checker at mathlib-v4.33.1.",
      is_current: true,
      prev_status: "verified",
      prev_confidence: 0.95,
    },
    {
      kind: "assessment",
      id: "assessment:a-b0",
      at: "2026-01-14T11:00:00Z",
      actor: "claim_steward",
      assessment_id: "a-b0",
      status: "verified",
      confidence: 0.95,
      claim_credence: null,
      summary: "A theorem with a refereed, independently expounded proof that has stood since 1852.",
      trigger: "structure_and_assess",
      trigger_context: null,
      is_current: false,
      prev_status: null,
      prev_confidence: null,
    },
    {
      kind: "created",
      id: "created:bertrand-postulate",
      at: "2026-01-14T10:30:00Z",
      actor: "claim_steward",
    },
  ],
};

const MATH_INDEX: SearchResultItem[] = [
  { id: LEGENDRE.claim.id, text: LEGENDRE.claim.text, claim_type: "mathematical", state: "active", similarity_score: 0.52, importance: 0.46, assessment_status: "supported", assessment_confidence: 0.9, prize_micro_usd: 2_500_000_000, checked: null },
  { id: BERTRAND.claim.id, text: BERTRAND.claim.text, claim_type: "mathematical", state: "active", similarity_score: 0.5, importance: 0.12, assessment_status: "verified", assessment_confidence: 0.98, prize_micro_usd: null, checked: "proof" },
];

const CLAIMS: Record<string, ClaimDetail> = {
  [FLAGSHIP.claim.id]: FLAGSHIP,
  [LEGENDRE.claim.id]: LEGENDRE,
  [BERTRAND.claim.id]: BERTRAND,
};

const EVENTS: Record<string, ClaimEventsPage> = {
  [FLAGSHIP.claim.id]: FLAGSHIP_EVENTS,
  [LEGENDRE.claim.id]: LEGENDRE_EVENTS,
  [BERTRAND.claim.id]: BERTRAND_EVENTS,
};

export function getClaim(id: string): ClaimDetail | null {
  return CLAIMS[id] ?? null;
}

export function getClaimEvents(id: string): ClaimEventsPage | null {
  return EVENTS[id] ?? null;
}

export function listClaims(): SearchResultItem[] {
  return [...INDEX, ...MATH_INDEX];
}

// Open bounties, largest first: the sample theorem's one.
export function listOpenPrizes(): PrizeListItem[] {
  return [
    {
      claim_id: LEGENDRE.claim.id,
      text: LEGENDRE.claim.text,
      claim_type: "mathematical",
      assessment_status: "supported",
      importance: 0.46,
      checked: null,
      bounty: LEGENDRE.bounty!,
    },
  ];
}

export function getAttempt(id: string): AttemptSummary | null {
  return [LEGENDRE, BERTRAND].flatMap((c) => c.attempts).find((a) => a.id === id) ?? null;
}

export const FLAGSHIP_ID = FLAGSHIP.claim.id;
// The sample theorem with the open prize, linked from empty states of the
// prize surfaces the way FLAGSHIP_ID is linked from the claim pages'.
export const MATH_FLAGSHIP_ID = LEGENDRE.claim.id;
