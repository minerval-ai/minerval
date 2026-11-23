import type {
  ClaimDetail, QuantityDefinition, QuantityEstimate, RequestItem, SearchResultItem, TreeNode,
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
    { id: A_EXTRAP.id, name: A_EXTRAP.name, stance: "neutral", content: A_EXTRAP.content, created_by: "claim_steward", created_at: CREATED, verdict: "likely", evaluation: A_EXTRAP.evaluation, shows: A_EXTRAP.shows },
    { id: A_COMPILE.id, name: A_COMPILE.name, stance: "neutral", content: A_COMPILE.content, created_by: "claim_steward", created_at: CREATED, verdict: "likely", evaluation: A_COMPILE.evaluation, shows: A_COMPILE.shows },
    { id: A_LIMITS.id, name: A_LIMITS.name, stance: "neutral", content: A_LIMITS.content, created_by: "claim_steward", created_at: CREATED, verdict: "likely", evaluation: A_LIMITS.evaluation, shows: A_LIMITS.shows },
  ],
  quantity: {
    assessed: { summary: FLU_ASSESSMENT_SUMMARY, work: FLU_WORK, model: "claude-opus-5-5", assessed_at: ASSESSED },
    definition: FLU_DEFINITION,
    estimate: FLU_ESTIMATE,
    estimates: [
      {
        id: "est-spreeuwenberg", argument_id: A_EXTRAP.id,
        source_title: SPREEUWENBERG.title, source_url: SPREEUWENBERG.url, source_type: "journal_article",
        stated: { form: "point", central: 17.4e6 },
        verbatim_text: "Our results suggest that the global mortality impact of the 1918 pandemic was important (17.4 million) but not as severe as most frequently cited estimates.",
      },
      {
        id: "est-spreeuwenberg-bound", argument_id: A_EXTRAP.id,
        source_title: SPREEUWENBERG.title, source_url: SPREEUWENBERG.url, source_type: "journal_article",
        stated: { form: "bound", bound: { side: "below", value: 25e6 } },
        verbatim_text: "simulations of total number of deaths being greater than 25 million are not realistic based on the underlying mortality rates included in Human Mortality Database and in British India.",
      },
      {
        id: "est-patterson-pyle", argument_id: A_COMPILE.id,
        source_title: "Patterson & Pyle (1991), “The Geography and Mortality of the 1918 Influenza Pandemic”, Bulletin of the History of Medicine",
        source_url: "https://pubmed.ncbi.nlm.nih.gov/2021692/", source_type: "journal_article",
        stated: { form: "interval", low: 24.7e6, high: 39.3e6 },
        verbatim_text: null,
      },
      {
        id: "est-johnson-mueller", argument_id: A_COMPILE.id,
        source_title: JOHNSON_MUELLER.title, source_url: JOHNSON_MUELLER.url, source_type: "journal_article",
        stated: { form: "interval", low: 50e6, high: 100e6, central: 50e6 },
        verbatim_text: "This paper suggests that it was of the order of 50 million. … even this vast figure may be substantially lower than the real toll, perhaps as much as 100 percent understated.",
      },
      {
        id: "est-cdc", argument_id: null,
        source_title: "US Centers for Disease Control and Prevention, “1918 Pandemic (H1N1 virus)”",
        source_url: "https://www.cdc.gov/flu/pandemic-resources/1918-pandemic-h1n1.html", source_type: "report",
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
      source_type: "report",
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
        source_type: "journal_article",
      },
      {
        id: "qi-barry-a", role: "answers",
        verbatim_text: null,
        source_title: "Barry (2004), Journal of Translational Medicine",
        source_url: "https://translational-medicine.biomedcentral.com/articles/10.1186/1479-5876-2-3",
        source_type: "journal_article",
        answer_id: "flu-origin-kansas",
      },
      {
        id: "qi-oxford-a", role: "answers",
        verbatim_text: null,
        source_title: "Oxford et al. (2005), Vaccine",
        source_url: null,
        source_type: "journal_article",
        answer_id: "flu-origin-france",
      },
      {
        id: "qi-humphries", role: "asks",
        verbatim_text: "Paths of Infection: The First World War and the Origins of the 1918 Influenza Pandemic",
        source_title: "Humphries (2014), War in History",
        source_url: null,
        source_type: "journal_article",
      },
      {
        id: "qi-humphries-a", role: "answers",
        verbatim_text: null,
        source_title: "Humphries (2014), War in History",
        source_url: null,
        source_type: "journal_article",
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

// Two requests that ask for a review of one document for its own sake
// (#865): one met, its findings on the document's page; one open and priced.
REQUESTS.push(
  {
    id: "req-rs-review",
    ask: "Review the registry study as a whole after its correction of 12 August 2026: what its data are, what it asserts beyond them, and what the corrected Table 3 changes.",
    why: "Several claims and a 2023 meta-analysis draw on this study, and a correction replaced a row of the table its BMI result rests on. Each claim's Steward reads the part its claim touches; nobody has read the corrected paper as a whole, so a later reader cannot tell what the correction does and does not change.",
    satisfied_by: "A record on the study's page of which parts were examined, with findings anchored to the passages they concern, including the corrected table against the original.",
    addressed_to: null,
    bears_on: [],
    bears_on_sources: [{ id: "registry-study", title: "Night-shift work and incident type 2 diabetes in a national shift registry" }],
    filed_by: { kind: "admin", label: "Claim Steward" },
    keeper: { kind: "curator", label: "the Curator" },
    state: "met",
    state_note: "Met: the corrected table and the sentence resting on it were examined, and the review says plainly that the methods were not re-examined.",
    filed_at: "2026-08-14T09:30:00Z",
    budget_usd: 1.6,
    work: [
      {
        by: "Researcher", outcome: "met", at: "2026-08-20T09:48:00Z", funded_by: "Occupational health mandate",
        summary: "Examined the abstract, the results and the corrected Table 3 against the correction notice. The corrected row for a BMI of 30 or over no longer shows an association; the sentence in Results 3.4 resting on it is unchanged. Two findings are on the study's page.",
      },
    ],
  },
  {
    id: "req-tt-review",
    ask: "Review the four-day week report as a whole: what its survey measured, what it asserts beyond what it measured, and how the coverage that draws on it states its findings.",
    why: "Twenty-six documents draw on the report, and eight of those uses state it more strongly than it states itself; the Stewards who read it found it asserts productivity gains it did not measure. A reader meeting any of those articles has no account of what the report itself shows.",
    satisfied_by: "A record on the report's page of what was examined, with findings anchored to its passages on what the survey asked, what the report concludes from it, and where its uses depart from it.",
    who_could: "Within the graph's Researcher's reach: the report and most of the coverage are public.",
    addressed_to: null,
    bears_on: [],
    bears_on_sources: [{ id: "think-tank-report", title: "The Four-Day Week Dividend: Results from 61 Firms" }],
    filed_by: { kind: "admin", label: "Curator" },
    keeper: { kind: "curator", label: "the Curator" },
    state: "open",
    filed_at: "2026-10-02T15:00:00Z",
    budget_usd: 6.4,
    ledger: { action_id: "act-tt-review", variant: "full", status: "open", cost_usd: 6.4, backing_usd: 0 },
    work: [
      {
        by: "Researcher", outcome: null, at: "2026-10-03T11:10:00Z", funded_by: null,
        summary: "Scoped at about $6.40. The report is 41,000 characters in 17 parts; the survey instrument is in its appendix. Plan: read the methods, the survey and the conclusions closely, the case studies thinly, and compare the twelve most-read articles that draw on it with the passages they cite.",
      },
    ],
  },
);

// One that asks for several things at once, numbered, as many filed
// requests do, and put to whoever holds the records.
REQUESTS.push({
  id: "req-flu-registers",
  ask: "Recover the 1918–1919 death registers of the Indian provinces outside British administration. Still wanted: (1) monthly registered deaths by district for 1917 to 1920, from the princely states' published administration reports; (2) the registration completeness each report states or implies; and (3) any parish, mission or hospital series that overlaps a district, as a check on completeness. Record where each series is held and whether it has been digitised.",
  why: "India's toll is the largest single input to the global estimate, and the provinces outside British administration are estimated by assuming British India's rates. Registers near those rates would narrow the estimate; registers well above or below them would move its centre by several million.",
  satisfied_by: "District-level monthly series for states holding at least a third of the population outside British India, each with its source and a stated completeness.",
  who_could: "Archivists at the national and state archives, or historians with access to the administration reports. Locating the published reports is within the graph's Researcher's reach; reading the unpublished registers is not.",
  addressed_to: "The National Archives of India and the state archives",
  bears_on: [QTY_REF],
  filed_by: { kind: "admin", label: "Claim Steward" },
  keeper: { kind: "steward", label: "the quantity's Steward" },
  state: "addressed",
  filed_at: "2026-11-02T08:40:00Z",
  ledger: { action_id: "act-flu-registers", variant: "scope", status: "open", cost_usd: 0.4, backing_usd: 0 },
});

// The importance of what each bears on and the topics of its nodes, as the
// API serves them with each request.
const PANDEMIC = { slug: "1918-influenza-pandemic", name: "1918 influenza pandemic" };
const DEMOGRAPHY = { slug: "historical-demography", name: "Historical demography" };
const WORK = { slug: "work-and-employment", name: "Work and employment" };
const EXTRAS: Record<string, Pick<RequestItem, "importance" | "tags"> & Partial<RequestItem>> = {
  "req-flu-unregistered": {
    importance: 0.72,
    tags: [PANDEMIC, DEMOGRAPHY],
    ledger: { action_id: "act-flu-unregistered", variant: "full", status: "open", cost_usd: 12, backing_usd: 0 },
    budget_usd: 12,
  },
  "req-flu-trace-50m": { importance: 0.72, tags: [PANDEMIC] },
  "req-flu-tissue": { importance: 0.61, tags: [PANDEMIC] },
  "req-flu-compilation": { importance: null, tags: [] },
  "req-flu-registers": { importance: 0.72, tags: [PANDEMIC, DEMOGRAPHY] },
  "req-rs-review": { importance: null, tags: [] },
  "req-tt-review": { importance: null, tags: [WORK] },
};
for (const r of REQUESTS) {
  Object.assign(r, EXTRAS[r.id] ?? {});
  r.bears_on = r.bears_on.map((b) => ({ ...b, importance: b.id === FLU_ORIGIN_ID ? 0.61 : b.kind === "question" ? 0.4 : 0.72 }));
}

export function getRequest(id: string): RequestItem | null {
  return REQUESTS.find((r) => r.id === id) ?? null;
}

export function requestsFor(nodeId: string): RequestItem[] {
  return REQUESTS.filter((r) => r.bears_on.some((b) => b.id === nodeId));
}

FLU_DEATHS.requests = requestsFor(FLU_DEATHS_ID);
FLU_ORIGIN.requests = requestsFor(FLU_ORIGIN_ID);

// A list (constitution §7b): the published hypotheses of where the 1918
// pandemic began, drawn from the question's answers and judged for fidelity
// to its criteria. One entry has moved since the judgment, so the page shows
// it stale; one node was considered and left out.
export const FLU_ORIGIN_LIST_ID = "flu-origin-hypotheses";

export const FLU_ORIGIN_LIST: ClaimDetail = {
  claim: {
    id: FLU_ORIGIN_LIST_ID,
    kind: "artifact",
    text: "Hypotheses of where the 1918 influenza pandemic began",
    claim_type: "empirical_derived",
    state: "active",
    decomposition_status: "complete",
    importance: 0.35,
    contestation: null,
    steward_state: "done",
    created_by: "user",
    created_at: CREATED,
    updated_at: ASSESSED,
  },
  subclaim_count: 4,
  formalization: null, verification: null, bounty: null, attempts: [], prize_claims: [], research_runs: [],
  // A list has no verdict; its judgment is list.assessment.
  assessment: null,
  list: {
    spec: {
      subtype: "list",
      purpose: "Which places have been seriously proposed as the origin of the 1918 pandemic, and how each stands.",
      inclusion:
        "A claim that the pandemic began in a named place or places, advanced in peer-reviewed work or a scholarly monograph with evidence from before March 1918.",
      exclusion: "Claims about how the pandemic spread once it had begun, and claims about its later waves.",
      ordering: "By the earliest date the hypothesis puts the start, earliest first; a hypothesis with no single date last.",
      entry_kinds: ["claim"],
    },
    fidelity: "incomplete",
    assessment: {
      fidelity: "incomplete",
      summary:
        "Incomplete. The list holds the three single-place hypotheses with serious advocates, [[claim:flu-origin-france|northern France]], [[claim:flu-origin-china|northern China]] and [[claim:flu-origin-kansas|rural Kansas]], and the hypothesis that [[claim:flu-origin-diffuse|the virus emerged gradually in several places]]. Each entry is on it because it meets the criteria, whatever its own verdict, and none of them is established. One hypothesis that meets the criteria is not yet in the graph.",
      reasoning_trace:
        "Searched the graph for claims naming a place of origin, and read the question's answer set. Each entry was checked against the criteria: a named place, scholarly advocacy, and evidence that predates March 1918. [[claim:flu-first-wave-troops|The claim that the first wave followed troop movements]] matches on the words but concerns spread, not origin, and is excluded by the criteria. Reversal check: the criteria admit any place by the same test, and the order is by date, which favors none of them.",
      gaps:
        "An early wave in New York City in February to April 1918 has been argued from mortality records (Olson et al. 2005). The graph holds no node for it yet; a request to bring it in is open.",
      confidence: 0.7,
      model: "claude-opus-5-5",
      assessed_at: ASSESSED,
    },
    entries: [
      {
        id: "flu-origin-france", kind: "claim", status: "inconclusive",
        text: "The 1918 influenza pandemic began in British army camps in northern France in 1916–1917.",
        note: "Names a place (Étaples and Aldershot camps); argued by Oxford and colleagues from outbreaks of purulent bronchitis in 1916–1917.",
      },
      {
        id: "flu-origin-china", kind: "claim", status: "inconclusive",
        text: "The 1918 influenza pandemic began in northern China and reached Europe with the Chinese Labour Corps.",
        note: "Names a place; argued by Humphries from respiratory outbreaks in Shanxi in late 1917 and the Corps' transit through Canada.",
      },
      {
        id: "flu-origin-kansas", kind: "claim", status: "doubtful", changed_since: true,
        text: "The 1918 influenza pandemic began in rural Kansas in early 1918.",
        note: "Names a place (Haskell County); argued by Barry from a local physician's report of severe influenza in January–February 1918.",
      },
      {
        id: "flu-origin-diffuse", kind: "claim", status: null,
        text: "The 1918 pandemic virus emerged gradually in several places before the spring 1918 wave.",
        note: "Names several places at once; argued from phylogenetic dating that puts the virus's emergence years before 1918.",
      },
    ],
    left_out: [
      {
        id: "flu-first-wave-troops", kind: "claim",
        text: "The first wave of the 1918 influenza pandemic spread along First World War troop movements.",
        reason: "About how the pandemic spread once begun, which the criteria exclude; it names no place of origin.",
      },
    ],
    stale: true,
    changed_entries: 1,
  },
  dependents: [],
  related: [],
};

// A safety case (constitution §7b, #1211), about an invented model. The
// graph's assessment of its conclusion and the case's verdict differ, which
// is the ordinary state of a real case: the evidence supports the conclusion,
// and the case does not yet establish it to its standard. One doubt is open,
// one is a residual doubt a named party accepted, two claims are argued for
// by no step, and one node has moved since the judgment.
export const CASE_ID = "corvid-uplift-case";
const CASE_CONCLUSION_ID = "corvid-no-uplift";

export const SAFETY_CASE: ClaimDetail = {
  claim: {
    id: CASE_ID,
    kind: "artifact",
    text: "Safety case: Corvid-3 gives no meaningful uplift to biological weapons development through its public chat product",
    claim_type: "empirical_derived",
    state: "active",
    decomposition_status: "complete",
    importance: 0.6,
    contestation: null,
    steward_state: "done",
    created_by: "user",
    created_at: CREATED,
    updated_at: ASSESSED,
  },
  subclaim_count: 7,
  formalization: null, verification: null, bounty: null, attempts: [], prize_claims: [], research_runs: [],
  // A case has no status; its judgments are safety_case.assessment.
  assessment: null,
  safety_case: {
    spec: {
      subtype: "safety_case",
      system: "Corvid-3, the general-purpose language model, at its released weights.",
      deployment: "The public chat product, with the input and output classifiers its developer runs in production. No fine-tuning access.",
      conclusion_claim_id: CASE_CONCLUSION_ID,
      standard: "A person with undergraduate training in biology gains no meaningful help toward producing a biological weapon beyond what public sources give.",
      standard_of: "The developer's published scaling policy, version 2.",
      framework: "assurance_2_cae",
      not_covered: "Access through the developer's API, fine-tuned or later versions of the model, and theft of the weights.",
    },
    conclusion: {
      id: CASE_CONCLUSION_ID, kind: "claim",
      text: "Corvid-3, as deployed in its public chat product, gives no meaningful uplift to biological weapons development.",
      judgment: { status: "supported", credence: 0.72 },
    },
    fidelity: "incomplete",
    verdict: "not_established",
    assessment: {
      id: "corvid-uplift-case-a1",
      fidelity: "incomplete",
      verdict: "not_established",
      verdict_basis:
        "One doubt about the evaluations is open, and two claims the argument depends on are argued for by no step. The doubt about universal jailbreaks is sustained and was accepted by the developer's safety board as a residual doubt.",
      would_change:
        "An elicitation study that includes fine-tuning, or an argument that the deployment rules it out, would settle the open doubt. The claim about safeguards needs a step and evidence of its own.",
      summary:
        "Incomplete. The case presents [[claim:corvid-evals-below|the evaluation result]] and [[claim:corvid-redteam-trial|the trial behind it]] accurately, and each node it draws on is shown with the graph's own assessment. The branch on [[claim:corvid-safeguards-block|safeguards]] is stated and not yet argued.",
      reasoning_trace:
        "Read the developer's published case against the nodes the graph holds. The capability branch follows the published case and bottoms out in the uplift trial. The published case never raises how the model was elicited; the graph holds a claim that bears on it, added here as a doubt about the trial. The safeguards branch is asserted in the published case with no evidence the graph holds.",
      gaps: "The safeguards branch has no step and no evidence. A request for the developer's classifier evaluation is open.",
      confidence: 0.7,
      model: "claude-opus-5-5",
      run_id: null,
      assessed_at: ASSESSED,
    },
    elements: [
      {
        id: "ce-top", type: "claim", parent: null, position: 1, changed_since: false, raised_in_published: true,
        statement: "The conclusion the case argues for.",
        node: {
          id: CASE_CONCLUSION_ID, kind: "claim",
          text: "Corvid-3, as deployed in its public chat product, gives no meaningful uplift to biological weapons development.",
          judgment: { status: "supported", credence: 0.72 },
        },
      },
      {
        id: "ce-split", type: "step", parent: "ce-top", position: 1, changed_since: false, raised_in_published: true,
        block: "decomposition",
        statement: "The model gives no meaningful uplift if it lacks the capability to, and none in this deployment if the safeguards stop the attempts that remain.",
      },
      {
        id: "ce-split-side", type: "side_claim", parent: "ce-split", position: 1, changed_since: false, raised_in_published: true,
        statement: "That capability and safeguards together cover every route to uplift in this deployment.",
        departure: "Taken as following from the specification, which excludes every other form of access; the case does not argue it further.",
        node: {
          id: "corvid-routes-covered", kind: "claim",
          text: "In the public chat product, uplift from Corvid-3 can come only through the model's own answers as filtered by the product's classifiers.",
          judgment: { status: "supported", credence: null },
        },
      },
      {
        id: "ce-evals", type: "claim", parent: "ce-split", position: 2, changed_since: false, raised_in_published: true,
        statement: "That the model lacks the capability, measured against the standard's threshold.",
        node: {
          id: "corvid-evals-below", kind: "claim",
          text: "Corvid-3 scores below the developer's uplift threshold on its biological risk evaluations.",
          judgment: { status: "supported", credence: 0.8 },
        },
      },
      {
        id: "ce-evals-step", type: "step", parent: "ce-evals", position: 1, changed_since: false, raised_in_published: true,
        block: "evidence_incorporation",
        statement: "The uplift trial is taken as showing the score directly.",
      },
      {
        id: "ce-evals-side", type: "side_claim", parent: "ce-evals-step", position: 1, changed_since: false, raised_in_published: false,
        statement: "That the trial measures the capability the standard is about.",
        node: {
          id: "corvid-trial-valid", kind: "claim",
          text: "The uplift trial's tasks are representative of the steps a person would need help with to produce a biological weapon.",
          judgment: { status: "inconclusive", credence: null },
        },
      },
      {
        id: "ce-trial", type: "evidence", parent: "ce-evals-step", position: 2, changed_since: true, raised_in_published: true,
        statement: "The result itself, as reported.",
        node: {
          id: "corvid-redteam-trial", kind: "claim",
          text: "In the developer's uplift trial, participants with Corvid-3 did no better on weapons-relevant tasks than participants with internet search alone.",
          judgment: { status: "supported", credence: 0.75 },
        },
      },
      {
        id: "ce-elicitation", type: "defeater", parent: "ce-trial", position: 1, changed_since: false, raised_in_published: false,
        statement: "If the model was not elicited as a capable user would elicit it, the trial understates what it can do.",
        standing: "open",
        standing_reason: "No subcase answers it. The graph finds the claim inconclusive, which leaves the doubt open against a case that carries the burden.",
        node: {
          id: "corvid-under-elicited", kind: "claim",
          text: "The uplift trial of Corvid-3 used prompting alone and understates the capability a determined user could elicit.",
          judgment: { status: "inconclusive", credence: null },
        },
      },
      {
        id: "ce-safeguards", type: "claim", parent: "ce-split", position: 3, changed_since: false, raised_in_published: true,
        statement: "That the safeguards stop the attempts the model could otherwise help with.",
        node: {
          id: "corvid-safeguards-block", kind: "claim",
          text: "The public chat product's classifiers block requests for weapons-relevant biological assistance.",
          judgment: null,
        },
      },
      {
        id: "ce-jailbreak", type: "defeater", parent: "ce-safeguards", position: 1, changed_since: false, raised_in_published: true,
        statement: "A jailbreak that works across requests would pass the classifiers whatever they block otherwise.",
        standing: "sustained",
        standing_reason: "The developer's own red team found one during testing, and the case offers no argument that none remains.",
        accepted_by: "The developer's safety board",
        acceptance: "Accepted in the board's published deployment decision, on the ground that the capability branch is meant to hold without the safeguards.",
        node: {
          id: "corvid-universal-jailbreak", kind: "claim",
          text: "Universal jailbreaks that bypass the public chat product's classifiers can be found by a skilled attacker.",
          judgment: { status: "supported", credence: 0.85 },
        },
      },
    ],
    form: {
      framework: "assurance_2_cae",
      well_formed: false,
      failures: [
        {
          element: "ce-split-side", rule: "undeveloped_claim",
          message: "This side claim is argued for by no step, so it does not bottom out in evidence.",
          departure: "Taken as following from the specification, which excludes every other form of access; the case does not argue it further.",
        },
        {
          element: "ce-evals-side", rule: "undeveloped_claim",
          message: "This side claim is argued for by no step, so it does not bottom out in evidence.",
          departure: null,
        },
        {
          element: "ce-safeguards", rule: "undeveloped_claim",
          message: "This claim is argued for by no step, so it does not bottom out in evidence.",
          departure: null,
        },
      ],
    },
    counts_against: [
      { element: "ce-elicitation", kind: "open_defeater", message: "A defeater is open: it has been neither answered nor sustained." },
      { element: "ce-evals-side", kind: "form", message: "This side claim is argued for by no step, so it does not bottom out in evidence." },
      { element: "ce-safeguards", kind: "form", message: "This claim is argued for by no step, so it does not bottom out in evidence." },
    ],
    residual_doubts: ["ce-jailbreak"],
    not_raised_in_published: ["ce-evals-side", "ce-elicitation"],
    stale: true,
    changed_nodes: 1,
  },
  dependents: [],
  related: [],
};

export const KIND_CLAIMS: ClaimDetail[] = [FLU_DEATHS, FLU_OVER_50M, FLU_ORIGIN, FLU_ORIGIN_LIST, SAFETY_CASE];

// The quantity and the question as the browse list and search serve them,
// so the offline /claims shows every kind (the cut claim is a plain claim).
export const KIND_INDEX: SearchResultItem[] = [
  {
    id: FLU_DEATHS_ID, kind: "quantity", text: FLU_DEATHS.claim.text, claim_type: "empirical_derived",
    state: "active", similarity_score: 0.48, importance: FLU_DEATHS.claim.importance,
    assessment_status: null, assessment_confidence: null, prize_micro_usd: null, checked: null,
    estimate: FLU_ESTIMATE, unit: FLU_DEFINITION.unit,
  },
  {
    id: FLU_ORIGIN_ID, kind: "question", text: FLU_ORIGIN.claim.text, claim_type: "empirical_derived",
    state: "active", similarity_score: 0.46, importance: FLU_ORIGIN.claim.importance,
    assessment_status: null, assessment_confidence: null, prize_micro_usd: null, checked: null,
    standing: "open",
  },
  {
    id: FLU_ORIGIN_LIST_ID, kind: "artifact", text: FLU_ORIGIN_LIST.claim.text, claim_type: "empirical_derived",
    state: "active", similarity_score: 0.44, importance: FLU_ORIGIN_LIST.claim.importance,
    assessment_status: null, assessment_confidence: null, prize_micro_usd: null, checked: null,
    fidelity: "incomplete",
  },
  {
    id: CASE_ID, kind: "artifact", text: SAFETY_CASE.claim.text, claim_type: "empirical_derived",
    state: "active", similarity_score: 0.4, importance: SAFETY_CASE.claim.importance,
    assessment_status: null, assessment_confidence: null, prize_micro_usd: null, checked: null,
    fidelity: "incomplete",
  },
];
