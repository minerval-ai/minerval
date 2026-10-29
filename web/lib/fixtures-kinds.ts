import type {
  ClaimDetail, QuantityDefinition, QuantityEstimate, RequestItem, TreeNode,
} from "./types";

// Fixtures for the kinds of node beyond the proposition (constitution §2,
// §7a; Part VIII, Requests): a quantity, a claim about which side of a
// figure it lies, a question, and requests. They are built around the 1918
// influenza pandemic because its death toll is a quantity people genuinely
// argue over, with published estimates a factor of five apart.
//
// The sources are real and their figures are as published; quotations are
// from their abstracts or pages, and a figure with no quotable sentence
// carries none. Everything the graph itself says here (statuses, the
// estimate, the work, the requests and their outcomes) is illustrative
// fixture content, written to model the spec, not a finding.

const ASSESSED = "2026-10-20T10:00:00Z";
const CREATED = "2026-09-02T12:00:00Z";

// ---------------------------------------------------------------------------
// The quantity: worldwide deaths in the 1918–1920 pandemic
// ---------------------------------------------------------------------------

export const FLU_DEATHS_ID = "flu-1918-deaths";

const FLU_DEFINITION: QuantityDefinition = {
  measures: "Deaths caused by the 1918–1920 influenza pandemic",
  population: "Worldwide",
  conditions:
    "Deaths in the pandemic's waves from early 1918 to 1920, including deaths from secondary bacterial pneumonia, counted as excess over expected mortality",
  unit: { kind: "count", noun: "deaths", min: 0 },
};

// The graph's estimate: skewed upward, with its median at the geometric mean
// of the compilations' common range (see the work below).
const FLU_ESTIMATE: QuantityEstimate = {
  form: "distribution",
  quantiles: [
    { p: 0.05, v: 17e6 },
    { p: 0.25, v: 26e6 },
    { p: 0.5, v: 35e6 },
    { p: 0.75, v: 50e6 },
    { p: 0.95, v: 80e6 },
  ],
  shape:
    "Skewed upward: the extrapolation from registered deaths sets a floor near 17 million, and the uncertainty in unregistered regions stretches the upper tail.",
};

const ARG_EXTRAP_WRITTEN =
  "If [[claim:flu-registered-extrapolate|excess mortality in the countries that registered deaths carries over, region by region, to the rest of the world]], and [[claim:flu-india-series|British India's registered deaths are a fair guide to Asia]], then scaling the registered excess to the world's 1918 population gives about 17 million deaths, and totals above 25 million are hard to reach.";
const ARG_EXTRAP_EVAL =
  "Granting its premises, the arithmetic is straightforward and the figure follows closely. The weight falls on [[claim:flu-registered-extrapolate|the extrapolation]], which assumes the unregistered majority died at rates like the registered minority's.";

const ARG_COMPILE_WRITTEN =
  "Adding the best available estimate for each country and region, after correcting for [[claim:flu-undercount|official counts that undercount pandemic deaths]], gives a total in the tens of millions. Where the regional estimates are uncertain, [[claim:flu-unregistered-majority|as they are for most of the deaths]], the total inherits that uncertainty.";
const ARG_COMPILE_EVAL =
  "Sound if the regional estimates are, and only as good as its weakest large region; for several regions the estimates range widely, so the total is likely to lie in this range without being pinned within it.";

const ARG_LIMITS_WRITTEN =
  "Because [[claim:flu-unregistered-majority|most deaths occurred where nothing was registered]], and [[claim:flu-registered-lower|the countries that did register deaths died at lower rates than the world as a whole]], any global figure rests on assumptions about the unregistered majority that the records cannot test.";
const ARG_LIMITS_EVAL =
  "If both premises hold, no record-based method can narrow the toll much below a factor of three, whatever its arithmetic; the argument bears on how precise any estimate can be rather than on where the value lies.";

function premise(
  id: string, text: string, arg: { id: string; name: string; content: string; evaluation: string; verdict: string; shows: TreeNode["argument_shows"] },
  rel: TreeNode["relation_type"], status: TreeNode["assessment_status"], conf: number, reasoning: string,
): TreeNode {
  return {
    id, text, claim_type: "empirical_derived", state: "active", depth: 1,
    relation_type: rel, reasoning, confidence: 0.85,
    assessment_status: status, assessment_confidence: status ? conf : null,
    argument_id: arg.id, argument_name: arg.name, argument_stance: null,
    argument_content: arg.content, argument_verdict: arg.verdict, argument_evaluation: arg.evaluation,
    argument_shows: arg.shows,
    children: [],
  };
}

const A_EXTRAP = {
  id: "arg-flu-extrap", name: "Extrapolation from registered deaths",
  content: ARG_EXTRAP_WRITTEN, evaluation: ARG_EXTRAP_EVAL, verdict: "likely",
  shows: { text: "at most 25 million, most likely about 17 million", range: { side: "below" as const, high: 25e6, inclusive: true } },
};
const A_COMPILE = {
  id: "arg-flu-compile", name: "Compilation of national and regional estimates",
  content: ARG_COMPILE_WRITTEN, evaluation: ARG_COMPILE_EVAL, verdict: "likely",
  shows: { text: "tens of millions, most likely 25 to 50 million, with higher totals not ruled out", range: { side: "between" as const, low: 25e6, high: 50e6 } },
};
const A_LIMITS = {
  id: "arg-flu-limits", name: "What the records can settle",
  content: ARG_LIMITS_WRITTEN, evaluation: ARG_LIMITS_EVAL, verdict: "likely",
  shows: { text: "that no figure narrower than roughly a factor of three is supported" },
};

const FLU_TREE: TreeNode = {
  id: FLU_DEATHS_ID,
  text: "Worldwide deaths from the 1918–1920 influenza pandemic",
  claim_type: "empirical_derived", state: "active", depth: 0,
  relation_type: null, reasoning: null, confidence: null,
  assessment_status: null, assessment_confidence: null,
  argument_id: null, argument_name: null, argument_stance: null,
  node_kind: "quantity", estimate: FLU_ESTIMATE, unit: FLU_DEFINITION.unit,
  children: [
    premise("flu-registered-extrapolate",
      "Excess mortality in countries with complete death registration in 1918 can be extrapolated by region to the rest of the world.",
      A_EXTRAP, "requires", "doubtful", 0.62,
      "The extrapolation's figure is only as good as the assumption that unregistered populations died at rates like the registered ones."),
    premise("flu-india-series",
      "British India's registered deaths for 1918–1919 are a reliable guide to pandemic mortality across Asia.",
      A_EXTRAP, "requires", "inconclusive", 0.55,
      "Asia held most of the world's population; the extrapolation uses British India to stand for it."),
    premise("flu-undercount",
      "Official death counts for 1918–1920 substantially undercount pandemic deaths in most countries.",
      A_COMPILE, "requires", "supported", 0.8,
      "The compilations correct official counts upward; without the undercount the correction would be unwarranted."),
    premise("flu-unregistered-majority",
      "Most deaths in the 1918 influenza pandemic occurred in populations without death registration.",
      A_COMPILE, "requires", "supported", 0.78,
      "Where most deaths went unregistered, the compiled total rests on regional estimates rather than counts."),
    premise("flu-registered-lower",
      "Countries with complete death registration in 1918 had lower pandemic mortality rates than the world as a whole.",
      A_LIMITS, "requires", "supported", 0.7,
      "If the registered countries were typical, extrapolation from them would be safer and the range could narrow."),
  ],
};
// The third argument shares one premise with the second.
FLU_TREE.children.push({ ...FLU_TREE.children[3], argument_id: A_LIMITS.id, argument_name: A_LIMITS.name, argument_content: A_LIMITS.content, argument_evaluation: A_LIMITS.evaluation, argument_verdict: A_LIMITS.verdict, argument_shows: A_LIMITS.shows, subtree_collapsed: true });

const SPREEUWENBERG = {
  title: "Spreeuwenberg, Kroneman & Paget (2018), “Reassessing the Global Mortality Burden of the 1918 Influenza Pandemic”, American Journal of Epidemiology",
  url: "https://academic.oup.com/aje/article/187/12/2561/5092383",
};
const JOHNSON_MUELLER = {
  title: "Johnson & Mueller (2002), “Updating the Accounts: Global Mortality of the 1918–1920 ‘Spanish’ Influenza Pandemic”, Bulletin of the History of Medicine",
  url: "https://muse.jhu.edu/article/4826",
};

const FLU_ASSESSMENT_SUMMARY =
  "In the tens of millions: most likely about 35 million, with a 90% interval of 17 to 80 million. The lowest careful figure, about 17 million, [[claim:flu-registered-extrapolate|extrapolates from the countries that registered deaths]], and that extrapolation is doubtful because [[claim:flu-registered-lower|those countries died at lower rates than the world as a whole]]. The compilations of national and regional estimates run from about 25 to 50 million and allow more. Since [[claim:flu-unregistered-majority|most deaths occurred where nothing was registered]], the estimate is wide, and it leans upward.";

const FLU_WORK =
  "Figures: 17.4 million, with totals above 25 million judged unrealistic by its authors (extrapolation from registered deaths, 2018); 24.7 to 39.3 million (compilation, 1991); of the order of 50 million, perhaps twice that (compilation, 2002); at least 50 million (a public-health summary that restates the 2002 compilation and is not counted separately).\n\nCombination: the extrapolation is treated as a floor rather than a central figure, because [[claim:flu-registered-extrapolate|its key premise]] fails in the direction of undercounting. The two compilations share most of their regional inputs, so they count as one line of evidence with its own spread, not two. The upper tail stops at 80 million rather than 100, because the 2002 doubling is offered as a possibility rather than an estimate.\n\nArithmetic: the median is the geometric mean of the compilations' common range, √(25 × 50) ≈ 35.4 million, rounded to 35 million. The 5% point sits at the extrapolation's figure, about 17 million, and the 95% point at 80 million.";

export const FLU_DEATHS: ClaimDetail = {
  claim: {
    id: FLU_DEATHS_ID,
    kind: "quantity",
    text: "Worldwide deaths from the 1918–1920 influenza pandemic",
    claim_type: "empirical_derived",
    state: "active",
    decomposition_status: "complete",
    importance: 0.55,
    contestation: 0.5,
    steward_state: "done",
    created_by: "claim_steward",
    created_at: CREATED,
    updated_at: ASSESSED,
  },
  subclaim_count: 5,
  formalization: null, verification: null, bounty: null, attempts: [], prize_claims: [], research_runs: [],
  // A quantity has no verdict; the record behind its estimate is quantity.assessed.
  assessment: null,
  arguments: [
    { id: A_EXTRAP.id, name: A_EXTRAP.name, stance: "neutral", content: A_EXTRAP.content, evidence_urls: [SPREEUWENBERG.url], created_by: "claim_steward", created_at: CREATED, verdict: "likely", evaluation: A_EXTRAP.evaluation, shows: A_EXTRAP.shows },
    { id: A_COMPILE.id, name: A_COMPILE.name, stance: "neutral", content: A_COMPILE.content, evidence_urls: [JOHNSON_MUELLER.url], created_by: "claim_steward", created_at: CREATED, verdict: "likely", evaluation: A_COMPILE.evaluation, shows: A_COMPILE.shows },
    { id: A_LIMITS.id, name: A_LIMITS.name, stance: "neutral", content: A_LIMITS.content, evidence_urls: [], created_by: "claim_steward", created_at: CREATED, verdict: "likely", evaluation: A_LIMITS.evaluation, shows: A_LIMITS.shows },
  ],
  quantity: {
    assessed: { summary: FLU_ASSESSMENT_SUMMARY, work: FLU_WORK, model: "claude-opus-5-5", assessed_at: ASSESSED },
    definition: FLU_DEFINITION,
    estimate: FLU_ESTIMATE,
    estimates: [
      {
        id: "est-spreeuwenberg", argument_id: A_EXTRAP.id,
        source_title: SPREEUWENBERG.title, source_url: SPREEUWENBERG.url, source_type: "peer_reviewed",
        stated: { form: "point", central: 17.4e6 },
        verbatim_text: "Our results suggest that the global mortality impact of the 1918 pandemic was important (17.4 million) but not as severe as most frequently cited estimates.",
      },
      {
        id: "est-spreeuwenberg-bound", argument_id: A_EXTRAP.id,
        source_title: SPREEUWENBERG.title, source_url: SPREEUWENBERG.url, source_type: "peer_reviewed",
        stated: { form: "bound", bound: { side: "below", value: 25e6 } },
        verbatim_text: "simulations of total number of deaths being greater than 25 million are not realistic based on the underlying mortality rates included in Human Mortality Database and in British India.",
      },
      {
        id: "est-patterson-pyle", argument_id: A_COMPILE.id,
        source_title: "Patterson & Pyle (1991), “The Geography and Mortality of the 1918 Influenza Pandemic”, Bulletin of the History of Medicine",
        source_url: "https://pubmed.ncbi.nlm.nih.gov/2021692/", source_type: "peer_reviewed",
        stated: { form: "interval", low: 24.7e6, high: 39.3e6 },
        verbatim_text: null,
      },
      {
        id: "est-johnson-mueller", argument_id: A_COMPILE.id,
        source_title: JOHNSON_MUELLER.title, source_url: JOHNSON_MUELLER.url, source_type: "peer_reviewed",
        stated: { form: "interval", low: 50e6, high: 100e6, central: 50e6 },
        verbatim_text: "This paper suggests that it was of the order of 50 million. … even this vast figure may be substantially lower than the real toll, perhaps as much as 100 percent understated.",
      },
      {
        id: "est-cdc", argument_id: null,
        source_title: "US Centers for Disease Control and Prevention, “1918 Pandemic (H1N1 virus)”",
        source_url: "https://www.cdc.gov/flu/pandemic-resources/1918-pandemic-h1n1.html", source_type: "government",
        stated: { form: "bound", bound: { side: "above", value: 50e6 } },
        verbatim_text: "The number of deaths was estimated to be at least 50 million worldwide with about 675,000 occurring in the United States.",
      },
    ],
    readings: [
      {
        id: "rd-hmd",
        source_title: "Human Mortality Database: death registrations for the 13 countries with complete series for 1918–1919",
        source_url: "https://www.mortality.org",
        measured: "All-cause deaths registered by year in 13 countries with complete vital registration; pandemic deaths are read as the excess over trend.",
        figure: "13 national series",
        bearing: "These countries held a small share of the world's population, mostly in Europe, North America and Oceania. They speak to the global toll only through the assumption that rates elsewhere were similar, and the evidence is that rates elsewhere were higher.",
        claim: { id: "flu-registered-lower", text: "Countries with complete death registration in 1918 had lower pandemic mortality rates than the world as a whole.", status: "supported" },
      },
      {
        id: "rd-us",
        source_title: "US death registration, as summarized by the Centers for Disease Control and Prevention",
        source_url: "https://www.cdc.gov/flu/pandemic-resources/1918-pandemic-h1n1.html",
        measured: "Deaths in the United States attributed to the pandemic, from the death registration area and estimates for the states outside it.",
        figure: "about 675,000 deaths",
        bearing: "One country's toll, under 2% of any global estimate in the literature. It informs the global figure only as one of the registered countries the extrapolations start from.",
        claim: null,
      },
    ],
    cuts: [
      { id: "flu-1918-over-50m", text: "The 1918 influenza pandemic killed more than 50 million people.", direction: "above", value: 50e6, status: "doubtful", credence: 0.25 },
    ],
  },
  dependents: [
    {
      id: "flu-1918-over-50m",
      text: "The 1918 influenza pandemic killed more than 50 million people.",
      claim_type: "empirical_derived", relation_type: "cuts",
      reasoning: "Widely repeated in its own right, and relied on by claims about pandemic preparedness; its credence follows from this quantity's estimate.",
      assessment_status: "doubtful", assessment_confidence: 0.65, assessment_credence: 0.25,
      node_kind: "claim", cut: { direction: "above", value: 50e6 },
    },
    {
      id: "flu-1918-more-than-ww1",
      text: "The 1918 influenza pandemic killed more people than the First World War.",
      claim_type: "empirical_derived", relation_type: "requires",
      reasoning: "The comparison turns on this toll against the war's; the war's deaths are a quantity of their own.",
      assessment_status: "supported", assessment_confidence: 0.72, assessment_credence: 0.85,
    },
  ],
  tree: FLU_TREE,
  instances: [],
  provenance_story: null,
  requests: [],
};

// ---------------------------------------------------------------------------
// A claim about which side of a figure the quantity lies (rare: it has a
// node of its own because it is widely repeated and relied on)
// ---------------------------------------------------------------------------

export const FLU_OVER_50M: ClaimDetail = {
  claim: {
    id: "flu-1918-over-50m",
    text: "The 1918 influenza pandemic killed more than 50 million people.",
    claim_type: "empirical_derived",
    state: "active",
    decomposition_status: "complete",
    importance: 0.45,
    contestation: 0.4,
    steward_state: "done",
    created_by: "extractor",
    created_at: CREATED,
    updated_at: ASSESSED,
  },
  subclaim_count: 1,
  formalization: null, verification: null, bounty: null, attempts: [], prize_claims: [], research_runs: [],
  assessment: {
    id: "a-flu-50m",
    status: "doubtful",
    confidence: 0.65,
    claim_credence: 0.25,
    summary:
      "Doubtful. The figure is widely repeated, but [[claim:flu-1918-deaths|the graph's estimate of the toll]] puts about a quarter of its weight above 50 million. The compilations that reach 50 million allow it; the extrapolation from registered deaths makes it unlikely.",
    reasoning_trace:
      "The credence is read from the quantity's estimate: 50 million is its 75th percentile, so P(toll > 50 million) ≈ 0.25.",
    subclaim_summary: {},
    assessed_at: ASSESSED,
    model: "claude-opus-5-5",
  },
  threshold_of: {
    quantity_id: FLU_DEATHS_ID,
    quantity_text: "Worldwide deaths from the 1918–1920 influenza pandemic",
    definition: FLU_DEFINITION,
    estimate: FLU_ESTIMATE,
    direction: "above",
    value: 50e6,
  },
  tree: {
    id: "flu-1918-over-50m",
    text: "The 1918 influenza pandemic killed more than 50 million people.",
    claim_type: "empirical_derived", state: "active", depth: 0,
    relation_type: null, reasoning: null, confidence: null,
    assessment_status: "doubtful", assessment_confidence: 0.65,
    argument_id: null, argument_name: null, argument_stance: null,
    children: [
      {
        id: FLU_DEATHS_ID,
        text: "Worldwide deaths from the 1918–1920 influenza pandemic",
        claim_type: "empirical_derived", state: "active", depth: 1,
        relation_type: "requires",
        reasoning: "Whether the toll exceeded 50 million is a question about this quantity's value.",
        confidence: 0.95, assessment_status: null, assessment_confidence: null,
        argument_id: null, argument_name: null, argument_stance: null,
        node_kind: "quantity", estimate: FLU_ESTIMATE, unit: FLU_DEFINITION.unit,
        children: [],
      },
    ],
  },
  dependents: [],
  instances: [
    {
      id: "inst-cdc-50m",
      source_id: "src-cdc-1918",
      verbatim_text: "The number of deaths was estimated to be at least 50 million worldwide with about 675,000 occurring in the United States.",
      context: "From the agency's page on the 1918 pandemic.",
      confidence: 0.9,
      source_title: "US Centers for Disease Control and Prevention, “1918 Pandemic (H1N1 virus)”",
      source_url: "https://www.cdc.gov/flu/pandemic-resources/1918-pandemic-h1n1.html",
      source_type: "government",
    },
  ],
};

// ---------------------------------------------------------------------------
// A question: where the pandemic began
// ---------------------------------------------------------------------------

export const FLU_ORIGIN_ID = "flu-1918-origin";

export const FLU_ORIGIN: ClaimDetail = {
  claim: {
    id: FLU_ORIGIN_ID,
    kind: "question",
    text: "Where did the 1918 influenza pandemic begin?",
    claim_type: "empirical_derived",
    state: "active",
    decomposition_status: "complete",
    importance: 0.4,
    contestation: 0.55,
    steward_state: "done",
    created_by: "question_steward",
    created_at: CREATED,
    updated_at: ASSESSED,
  },
  subclaim_count: 7,
  formalization: null, verification: null, bounty: null, attempts: [], prize_claims: [], research_runs: [],
  // A question has no verdict; its assessment is question.assessment.
  assessment: null,
  question: {
    assessment: {
      standing: "open",
      summary:
        "Open. Three places of origin have serious advocates, and the evidence leaves them level: [[claim:flu-origin-kansas|rural Kansas in early 1918]], [[claim:flu-origin-france|British army camps in northern France in 1916–1917]], and [[claim:flu-origin-china|northern China, carried to Europe by the Chinese Labour Corps]]. Each rests on reports of severe respiratory outbreaks before the pandemic's recognized spread, and [[claim:flu-earliest-outbreaks|none of those outbreaks has been shown to be the pandemic virus]]. The question also presupposes [[claim:flu-single-origin|a single place of origin]], which is itself unsettled; if [[claim:flu-origin-diffuse|the virus emerged gradually in several places]], the question has no one answer.",
      reasoning_trace:
        "The answers rule each other out, so at most one is right, and the question can lean only when the evidence separates them. What would separate them is [[claim:flu-earliest-outbreaks|the identity of the virus in the pre-1918 outbreaks]] and [[claim:flu-spring-wave-same|whether the spring 1918 wave was the same virus as the autumn's]]; the first is unknown and the second leans yes, which does not favor any one place.",
      model: "claude-opus-5-5",
      assessed_at: ASSESSED,
      favored_ids: [],
    },
    standing: "open",
    presuppositions: [
      { id: "flu-single-origin", text: "The 1918 influenza pandemic spread from a single place of origin.", status: "inconclusive" },
    ],
    subquestions: [
      { id: "flu-spring-wave-same", text: "Was the spring 1918 wave caused by the same virus as the autumn wave?", standing: "leaning" },
      { id: "flu-earliest-outbreaks", text: "Which respiratory outbreaks before March 1918 were caused by the pandemic virus?", standing: "unknown" },
    ],
    answers: [
      { id: "flu-origin-kansas", text: "The 1918 influenza pandemic began in rural Kansas in early 1918.", kind: "claim", status: "inconclusive", basis: "both" },
      { id: "flu-origin-france", text: "The 1918 influenza pandemic began in British army camps in northern France in 1916–1917.", kind: "claim", status: "inconclusive", basis: "both" },
      { id: "flu-origin-china", text: "The 1918 influenza pandemic began in northern China and reached Europe with the Chinese Labour Corps.", kind: "claim", status: "inconclusive", basis: "prominence" },
      { id: "flu-origin-diffuse", text: "The 1918 pandemic virus emerged gradually in several places before the spring 1918 wave.", kind: "claim", status: null, basis: "quality" },
    ],
    relations: [
      { a: "flu-origin-kansas", b: "flu-origin-france", relation: "excludes" },
      { a: "flu-origin-kansas", b: "flu-origin-china", relation: "excludes" },
      { a: "flu-origin-france", b: "flu-origin-china", relation: "excludes" },
      { a: "flu-origin-diffuse", b: "flu-origin-kansas", relation: "excludes" },
      { a: "flu-origin-diffuse", b: "flu-origin-france", relation: "excludes" },
      { a: "flu-origin-diffuse", b: "flu-origin-china", relation: "excludes" },
    ],
    depended_on_by: [
      { id: "flu-first-wave-troops", text: "The first wave of the 1918 influenza pandemic spread along First World War troop movements.", status: "supported" },
    ],
    instances: [
      {
        id: "qi-barry", role: "asks",
        verbatim_text: "The site of origin of the 1918 influenza pandemic and its public health implications",
        source_title: "Barry (2004), Journal of Translational Medicine",
        source_url: "https://translational-medicine.biomedcentral.com/articles/10.1186/1479-5876-2-3",
        source_type: "peer_reviewed",
      },
      {
        id: "qi-barry-a", role: "answers",
        verbatim_text: null,
        source_title: "Barry (2004), Journal of Translational Medicine",
        source_url: "https://translational-medicine.biomedcentral.com/articles/10.1186/1479-5876-2-3",
        source_type: "peer_reviewed",
        answer_id: "flu-origin-kansas",
      },
      {
        id: "qi-oxford-a", role: "answers",
        verbatim_text: null,
        source_title: "Oxford et al. (2005), Vaccine",
        source_url: null,
        source_type: "peer_reviewed",
        answer_id: "flu-origin-france",
      },
      {
        id: "qi-humphries", role: "asks",
        verbatim_text: "Paths of Infection: The First World War and the Origins of the 1918 Influenza Pandemic",
        source_title: "Humphries (2014), War in History",
        source_url: null,
        source_type: "peer_reviewed",
      },
      {
        id: "qi-humphries-a", role: "answers",
        verbatim_text: null,
        source_title: "Humphries (2014), War in History",
        source_url: null,
        source_type: "peer_reviewed",
        answer_id: "flu-origin-china",
      },
    ],
    incomplete: null,
  },
  tree: {
    id: FLU_ORIGIN_ID,
    text: "Where did the 1918 influenza pandemic begin?",
    claim_type: "empirical_derived", state: "active", depth: 0,
    relation_type: null, reasoning: null, confidence: null,
    assessment_status: null, assessment_confidence: null,
    argument_id: null, argument_name: null, argument_stance: null,
    node_kind: "question", standing: "open",
    children: [
      ...([
        ["flu-origin-kansas", "The 1918 influenza pandemic began in rural Kansas in early 1918.", "inconclusive"],
        ["flu-origin-france", "The 1918 influenza pandemic began in British army camps in northern France in 1916–1917.", "inconclusive"],
        ["flu-origin-china", "The 1918 influenza pandemic began in northern China and reached Europe with the Chinese Labour Corps.", "inconclusive"],
        ["flu-origin-diffuse", "The 1918 pandemic virus emerged gradually in several places before the spring 1918 wave.", null],
      ] as const).map(([id, text, st]): TreeNode => ({
        id, text, claim_type: "empirical_derived", state: "active", depth: 1,
        relation_type: "answers", reasoning: "A candidate answer.", confidence: 0.9,
        assessment_status: st, assessment_confidence: st ? 0.55 : null,
        argument_id: null, argument_name: null, argument_stance: null,
        node_kind: "claim", children: [],
      })),
      {
        id: "flu-spring-wave-same", text: "Was the spring 1918 wave caused by the same virus as the autumn wave?",
        claim_type: "empirical_derived", state: "active", depth: 1,
        relation_type: "part_of", reasoning: "Tells whether the spring outbreaks locate the origin.", confidence: 0.9,
        assessment_status: null, assessment_confidence: null,
        argument_id: null, argument_name: null, argument_stance: null,
        node_kind: "question", standing: "leaning", children: [],
      },
      {
        id: "flu-earliest-outbreaks", text: "Which respiratory outbreaks before March 1918 were caused by the pandemic virus?",
        claim_type: "empirical_derived", state: "active", depth: 1,
        relation_type: "part_of", reasoning: "Would separate the candidate origins.", confidence: 0.9,
        assessment_status: null, assessment_confidence: null,
        argument_id: null, argument_name: null, argument_stance: null,
        node_kind: "question", standing: "unknown", children: [],
      },
      {
        id: "flu-single-origin", text: "The 1918 influenza pandemic spread from a single place of origin.",
        claim_type: "empirical_derived", state: "active", depth: 1,
        relation_type: "assumes", reasoning: "The question asks for one place.", confidence: 0.9,
        assessment_status: "inconclusive", assessment_confidence: 0.55,
        argument_id: null, argument_name: null, argument_stance: null,
        node_kind: "claim", children: [],
      },
    ],
  },
  dependents: [
    {
      id: "flu-first-wave-troops",
      text: "The first wave of the 1918 influenza pandemic spread along First World War troop movements.",
      claim_type: "causal", relation_type: "requires",
      reasoning: "Where the first wave started bears on which troop movements could have carried it.",
      assessment_status: "supported", assessment_confidence: 0.66,
    },
  ],
  instances: [],
};

// ---------------------------------------------------------------------------
// Requests (Part VIII, Requests): on one node, on several, and on nothing the
// graph yet holds
// ---------------------------------------------------------------------------

const QTY_REF = { id: FLU_DEATHS_ID, text: "Worldwide deaths from the 1918–1920 influenza pandemic", kind: "quantity" as const };
const ORIGIN_REF = { id: FLU_ORIGIN_ID, text: "Where did the 1918 influenza pandemic begin?", kind: "question" as const };

export const REQUESTS: RequestItem[] = [
  {
    id: "req-flu-unregistered",
    ask: "Reconstructions of 1918–1920 excess mortality for the large regions without death registration, from surviving colonial, missionary, census and burial records.",
    why: "Most of the estimate's width comes from these regions. Reconstructions near the registered countries' rates would pull the estimate toward 17 million; reconstructions at the rates the compilations assume would pull it toward 50 million and narrow the interval either way.",
    satisfied_by: "Estimates with stated methods and uncertainty for regions that together held at least half of the 1918 population outside the registered countries.",
    who_could: "Historical demographers with archive access. The published records are within the graph's Researcher's reach; the archive work is not.",
    addressed_to: null,
    bears_on: [QTY_REF],
    filed_by: { kind: "admin", label: "Claim Steward" },
    keeper: { kind: "steward", label: "the quantity's Steward" },
    state: "open",
    filed_at: "2026-10-20T10:05:00Z",
  },
  {
    id: "req-flu-trace-50m",
    ask: "Trace the “at least 50 million” figure on the public-health page to the estimate it comes from.",
    why: "If it restates a published compilation, it adds no evidence and counts once; if it rests on an independent estimate, that estimate belongs among the figures.",
    satisfied_by: "The figure's origin, located in a source, with the passage that states it.",
    addressed_to: null,
    bears_on: [QTY_REF],
    filed_by: { kind: "admin", label: "Claim Steward" },
    keeper: { kind: "steward", label: "the quantity's Steward" },
    state: "met",
    state_note: "Met: the figure is counted once, with the 2002 compilation.",
    filed_at: "2026-09-10T09:00:00Z",
    work: [
      {
        by: "Researcher", outcome: "met", at: "2026-09-11T16:20:00Z", funded_by: "General mandate",
        summary: "The page's figure matches the 2002 compilation's central estimate, and no independent estimate of 50 million or more was found behind it. Recorded as restating that compilation.",
      },
    ],
  },
  {
    id: "req-flu-tissue",
    ask: "Sequencing of influenza virus from surviving 1917–1918 respiratory tissue samples taken before March 1918.",
    why: "A virus from an early outbreak matching the pandemic strain would favor the place it came from; finding a different virus in each early outbreak would count against all three single-origin answers and toward a gradual emergence.",
    satisfied_by: "Published sequences, with the provenance of each sample: place, date, and clinical context.",
    who_could: "Pathology archives holding autopsy material from the period, and laboratories able to sequence degraded RNA.",
    addressed_to: "Pathology archives holding 1917–1918 autopsy material",
    bears_on: [ORIGIN_REF, { id: "flu-earliest-outbreaks", text: "Which respiratory outbreaks before March 1918 were caused by the pandemic virus?", kind: "question" }],
    filed_by: { kind: "admin", label: "Question Steward" },
    keeper: { kind: "curator", label: "the Curator" },
    state: "addressed",
    filed_at: "2026-10-21T11:30:00Z",
  },
  {
    id: "req-flu-compilation",
    ask: "A shared dataset of every published national and regional estimate of 1918–1920 pandemic deaths, each with its method and the sources it rests on.",
    why: "Global estimates reuse each other's regional inputs. A dataset tracing each to its origin would show how many independent lines of evidence there are, and would serve the national tolls as well as the global one.",
    satisfied_by: "A versioned table, open to correction, covering the estimates the global reconstructions cite and the regional literatures behind them.",
    who_could: "Within the graph's Researcher's reach for the English-language literature; the regional literatures in other languages need more.",
    addressed_to: null,
    bears_on: [],
    bears_on_text: "No node yet. The dataset would serve this pandemic's global toll and the national tolls the graph will hold.",
    filed_by: { kind: "contributor", label: "hist-demography" },
    keeper: { kind: "curator", label: "the Curator" },
    state: "in_progress",
    filed_at: "2026-09-28T14:10:00Z",
    work: [
      {
        by: "Researcher", outcome: "partly_met", at: "2026-10-15T18:40:00Z", funded_by: "Historical epidemiology mandate",
        summary: "First stage: compiled the estimates cited by the three global reconstructions and traced each to its origin. The regional literatures in other languages are the next stage, and are not yet funded.",
      },
    ],
  },
];

export function getRequest(id: string): RequestItem | null {
  return REQUESTS.find((r) => r.id === id) ?? null;
}

export function requestsFor(nodeId: string): RequestItem[] {
  return REQUESTS.filter((r) => r.bears_on.some((b) => b.id === nodeId));
}

FLU_DEATHS.requests = requestsFor(FLU_DEATHS_ID);
FLU_ORIGIN.requests = requestsFor(FLU_ORIGIN_ID);

export const KIND_CLAIMS: ClaimDetail[] = [FLU_DEATHS, FLU_OVER_50M, FLU_ORIGIN];
