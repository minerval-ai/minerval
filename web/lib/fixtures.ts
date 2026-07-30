import type { ClaimDetail, ClaimEventsPage, SearchResultItem } from "./types";

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
    model: "claude-fable-5",
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
  { id: "inflation-2022", text: FLAGSHIP.claim.text, claim_type: "empirical_derived", state: "active", similarity_score: 0.91, importance: 0.6, assessment_status: "supported", assessment_confidence: 0.78 },
  { id: "min-wage", text: "The federal minimum wage should be raised to $15 per hour.", claim_type: "normative", state: "active", similarity_score: 0.74, importance: 0.65, assessment_status: "contested", assessment_confidence: 0.62 },
  { id: "universe-age", text: "The universe is approximately 13.8 billion years old.", claim_type: "empirical_derived", state: "active", similarity_score: 0.69, importance: 0.2, assessment_status: "verified", assessment_confidence: 0.94 },
  { id: "mw-employment", text: "Raising the minimum wage to $15 reduces teen employment.", claim_type: "causal", state: "active", similarity_score: 0.66, importance: 0.6, assessment_status: "contested", assessment_confidence: 0.5 },
  // An unassessed, low-importance leaf — left queued under the Steward's budget.
  { id: "cpi-basket-weights", text: "The CPI shelter component was reweighted in the 2023 basket revision.", claim_type: "empirical_verifiable", state: "active", similarity_score: 0.61, importance: 0.18, assessment_status: null, assessment_confidence: null },
  { id: "deflation-2009", text: "The United States experienced sustained deflation throughout 2009.", claim_type: "empirical_verifiable", state: "active", similarity_score: 0.58, importance: 0.2, assessment_status: "contradicted", assessment_confidence: 0.88 },
];

export function getClaim(id: string): ClaimDetail | null {
  return id === FLAGSHIP.claim.id ? FLAGSHIP : null;
}

export function getClaimEvents(id: string): ClaimEventsPage | null {
  return id === FLAGSHIP.claim.id ? FLAGSHIP_EVENTS : null;
}

export function listClaims(): SearchResultItem[] {
  return INDEX;
}

export const FLAGSHIP_ID = FLAGSHIP.claim.id;
