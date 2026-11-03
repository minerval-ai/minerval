import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { getMatcherSystemPromptBlocks, getMatchingPrompt } from "../prompts/matcher.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { findSimilarClaims, keywordClaimSearch } from "../../services/search-service.js";
import { loadConfig } from "../../config.js";
import { getUsageContext, runBudget, withAgent, withPassBudget, withSkills } from "../usage-context.js";
import { executeGraphReadTool, getGraphReadToolDefinitions } from "../tools/graph-read-tools.js";
import { createReportTools } from "../tools/report-tools.js";
import { INSTANCE_STANCES, isInstanceStance, type InstanceStance } from "../../schemas/common.js";
import { NODE_KINDS, type NodeKind } from "../../schemas/kinds.js";

/**
 * How the Matcher's run ended (#419). `match` and `new` are verdicts the
 * Matcher submitted; `undecided` means it ran out of search budget without
 * submitting one. An undecided result is NOT a negative identity verdict:
 * nothing was compared, so a caller must not mint a claim from it.
 */
export type MatchOutcome = "match" | "new" | "undecided";

export interface MatchDecision {
  outcome: MatchOutcome;
  is_match: boolean;
  matched_claim_id: string | null;
  new_canonical_form: string | null;
  /**
   * Whether this source asserts the claim as canonically stated ("affirms"),
   * asserts its negation ("denies"; a contrary is a rival claim, not a
   * denial, #716), or states the proposition as an
   * open question without taking a side ("poses", #445). Lets a claim and its
   * denial share one canonical node while preserving which side each source
   * takes, and lets a conjecture statement be recorded without a polarity it
   * does not have.
   */
  instance_stance: InstanceStance;
  /**
   * For a new claim: one sentence on why the canonical form is stated in the
   * direction it is (#360). The direction is chosen on the proposition's own
   * terms, the affirmative form of the question as the discourse poses it,
   * never inherited from the source that arrived first; the note is stored
   * on the claim so a later agent does not silently re-invert the form.
   */
  direction_note?: string | null;
  /**
   * For a new node: the kind it should have (§2, §7a), which may differ from
   * the kind proposed (a question that asks how much is a quantity). Null
   * leaves the proposed kind. On a match, the matched node keeps its own.
   */
  kind?: NodeKind | null;
  confidence: number;
  reasoning: string;
  alternative_matches: string[];
  relationship_notes: string | null;
}

const MATCH_DECISION_SCHEMA = {
  type: "object" as const,
  properties: {
    is_match: { type: "boolean", description: "Whether the proposition is an existing node, under any wording or as its negation. A contrary (both could be false) is a different claim: not a match." },
    matched_claim_id: { type: ["string", "null"], description: "ID of the matched claim if is_match is True, copied exactly from a search_similar_claims result" },
    new_canonical_form: { type: ["string", "null"], description: "Proposed canonical form if is_match is False" },
    instance_stance: { type: "string", enum: [...INSTANCE_STANCES], description: "Whether this source asserts the canonical claim as stated (affirms), asserts its negation (denies), or states the proposition as an open question without endorsing either side (poses: a conjecture as a survey states it, 'problem X asks whether...'). Judged against the canonical direction, not assumed from the source" },
    direction_note: { type: ["string", "null"], description: "For a new claim: one sentence on why the canonical form is stated in this direction (the affirmative form of the question as the discourse poses it). Stored with the claim so a later rewording does not silently invert it." },
    kind: { type: ["string", "null"], enum: [...NODE_KINDS, null], description: "For a new node: its kind (claim, quantity, or question), when it differs from the kind proposed; null to keep the proposed kind. A question that asks whether X is so is the claim X; one that asks how much, how many, how often, or when is a quantity." },
    confidence: { type: "number", description: "Confidence in the matching decision (0.0-1.0)" },
    reasoning: { type: "string", description: "Detailed explanation of the decision" },
    alternative_matches: { type: "array", items: { type: "string" }, description: "IDs of other claims considered, each copied exactly from a search_similar_claims result" },
    relationship_notes: { type: ["string", "null"], description: "How the near-misses relate to this proposition: specification, generalization, rival (a contrary), or possibly the same node. The caller reads this to decide whether to link or escalate." },
  },
  required: ["is_match", "confidence", "reasoning", "instance_stance"],
};

/**
 * The first run's tool-use turn cap (#727). The decision's budget
 * (config.matcherBudgetUsd) is what bounds the searching; this is the
 * backstop for a loop that has stopped spending (a provider returning empty
 * turns, a harness fault) while a caller is blocked on the decision, which
 * money cannot catch. It sits well above what the budget buys in normal
 * use (the old cap of 12 was the limit runs hit, #419, #467). The Matcher
 * is told both numbers up front and sees the spend after every turn.
 */
export const MATCHER_TURN_GUARD = 30;
/** The retry's turns: one more search, the decision, and one spare. */
export const MATCHER_RETRY_TURNS = 3;
/** The retry's money, as a fraction of the first run's. */
const MATCHER_RETRY_BUDGET_FRACTION = 0.25;

/** Thrown from beforeTurn when the decision's budget is spent. */
class MatcherBudgetSpent extends Error {}

/**
 * The agentic Matcher is the single decider of claim identity (issue #25).
 *
 * It is a tool-use loop armed with `search_similar_claims`. Embedding similarity
 * is *retrieval*, not decision: the search is NOT gated at a high threshold, and
 * the matcher is expected to issue multiple queries — the claim, rewordings, and
 * the negation — before concluding a claim is novel. The final judgment ("same
 * proposition? its negation? a rival? a specification?") is the model's, reported via the
 * `submit_match_decision` tool.
 *
 * Every new claim — top-level and subclaim — flows through this one matcher.
 */
// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function matchClaim(
  input: Parameters<typeof matchClaimImpl>[0]
): ReturnType<typeof matchClaimImpl> {
  return withAgent("matcher", () => matchClaimImpl(input));
}

async function matchClaimImpl(input: {
  extractedText: string;
  proposedCanonical: string;
  /**
   * A claim id to exclude from search results (e.g. the parent when matching a
   * subclaim, so a claim can't match itself). Optional.
   */
  excludeClaimId?: string;
  /**
   * The domain tags the caller knows (the Steward's or Curator's claim, the
   * Extractor's prior at ingestion). They point to the domain skills whose
   * "For the Matcher" view the run can load: identity is judged differently
   * in some domains.
   */
  domains?: readonly string[];
  /** The kind of node proposed (§2, §7a); claim when absent. */
  kind?: NodeKind;
  /**
   * The passage around the source text, when the caller has it (#721). The
   * stance recorded on the instance is the reading the author most
   * plausibly meant, judged from context (§4).
   */
  context?: string | null;
  model?: string;
}): Promise<MatchDecision> {
  const config = loadConfig();
  const skillLoader = createSkillLoadTools("matcher", { domains: input.domains });
  const skills = skillLoader.pointed;

  // The decision's money (#727): its own pass budget, never more than the
  // caller's pass has left, so a Matcher nested in a Steward's run cannot
  // spend past the Steward's ceiling.
  const callerLeft = runBudget()?.remainingMicroUsd;
  const ownMicroUsd = Math.round(config.matcherBudgetUsd * 1_000_000);
  const firstBudgetMicroUsd = Math.max(
    0,
    callerLeft === undefined ? ownMicroUsd : Math.min(ownMicroUsd, callerLeft)
  );
  const retryBudgetMicroUsd = Math.round(firstBudgetMicroUsd * MATCHER_RETRY_BUDGET_FRACTION);
  const promptFor = (turns: number, budgetMicroUsd: number) =>
    getMatchingPrompt(input.extractedText, input.proposedCanonical, {
      context: input.context ?? null,
      kind: input.kind ?? "claim",
      domains: input.domains ?? [],
      skills,
      turnBudget: turns,
      budgetUsd: budgetMicroUsd / 1_000_000,
    });
  const system = getMatcherSystemPromptBlocks();

  const searchTool: Tool = {
    name: "search_similar_claims",
    description:
      "Search existing nodes (claims, quantities, questions). `query` is " +
      "matched by meaning: results are ranked by similarity above only a low " +
      "floor, as retrieval for your judgment, not a decision. A true match, " +
      "especially a negation, can score low or miss the floor under one " +
      "framing, so search several framings (the wording, paraphrases, and " +
      "the negation) before concluding the proposition is new. `keywords` " +
      "adds a keyword search: nodes whose wording contains every term, for " +
      "what embeddings serve badly (a problem-list number, a theorem's or a " +
      "person's name). Each hit says how it was found.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "A phrasing of the proposition to search for by meaning" },
        keywords: {
          type: "string",
          description:
            "Optional. Terms that must all appear in a node's wording; a quoted phrase stays a phrase.",
        },
      },
      required: ["query"],
    },
  };
  // Two of the shared free reads (#725): the role prompt names a candidate's
  // decomposition as an identity diagnostic, and a search hit carries only
  // its wording. Reads cost no tokens of their own and write nothing.
  const MATCHER_READS = new Set(["get_claim", "get_decomposition"]);
  const readTools = getGraphReadToolDefinitions().filter((t) => MATCHER_READS.has(t.name));
  const submitTool: Tool = {
    name: "submit_match_decision",
    description: "Submit the final claim-identity decision once you have searched enough.",
    input_schema: MATCH_DECISION_SCHEMA as Tool["input_schema"],
  };

  let finalResult: MatchDecision | null = null;
  const model = input.model ?? config.matcherModel;

  // Every search the Matcher ran, with its top hits (#467). The retry loop is
  // a fresh transcript: without this, a first run that spent its budget
  // searching leaves nothing behind and the retry re-derives retrieval from
  // scratch. The constitution asks an admin under a bounded budget to record
  // its best current conclusions before the budget expires; the searches are
  // the part of that record the agent itself already holds, so it is kept
  // here rather than asked for through one more tool call the budget cannot
  // spare.
  type SearchHit = {
    id: string;
    canonical_form: string;
    score: number;
    kind?: NodeKind;
    /** How the hit was found when not by meaning alone (#725). */
    found_by?: "keywords";
  };
  const searchLog: Array<{ query: string; results: SearchHit[] }> = [];

  // Every claim id the Matcher has been shown (#470). Its searches are its
  // only source of ids, so an id in a submitted decision that none of them
  // returned is a transcription error: a model retyping a UUID into its
  // structured output has spliced two neighbours' ids into one that resolves
  // to nothing, and a caller told to weigh alternative_matches then reads a
  // phantom near-miss as evidence. Resolve each submitted id against this
  // set: exact, or by its first UUID group when that names one retrieved
  // claim; anything else is not an id the Matcher could have meant.
  const retrievedIds = new Set<string>();
  const UUID_GROUP_CHARS = 8;
  const resolveRetrievedId = (id: unknown): string | null => {
    if (typeof id !== "string" || id.length === 0) return null;
    if (retrievedIds.has(id)) return id;
    if (id.length < UUID_GROUP_CHARS) return null;
    const group = id.slice(0, UUID_GROUP_CHARS);
    const candidates = [...retrievedIds].filter((r) => r.startsWith(group));
    return candidates.length === 1 ? candidates[0]! : null;
  };

  // A submitted decision is accepted only when it is whole. The schema marks
  // is_match required, but not every provider enforces tool schemas: GLM 5.3
  // Flash on OpenRouter has submitted decisions whose reasoning names the
  // matched claim with 0.9+ confidence and that carry neither is_match nor
  // matched_claim_id — read as-is, `undefined` is falsy and a match the model
  // made becomes a duplicate node. Refuse the call instead and let the model
  // resubmit; it costs one more turn and keeps the decision the model made.
  const decisionDefect = (raw: Record<string, unknown>): string | null => {
    if (typeof raw.is_match !== "boolean") return "is_match must be true or false";
    if (raw.is_match && typeof raw.matched_claim_id !== "string") {
      return "matched_claim_id is required when is_match is true";
    }
    if (raw.is_match && resolveRetrievedId(raw.matched_claim_id) === null) {
      return (
        `matched_claim_id ${JSON.stringify(raw.matched_claim_id)} was not returned by ` +
        `any search_similar_claims call in this run; copy the id exactly from a search result`
      );
    }
    if (!isInstanceStance(raw.instance_stance)) {
      return 'instance_stance must be "affirms", "denies", or "poses"';
    }
    if (raw.kind != null && !(NODE_KINDS as readonly unknown[]).includes(raw.kind)) {
      return 'kind must be "claim", "quantity", "question", or null';
    }
    return null;
  };
  const rejectDecision = (defect: string): string =>
    JSON.stringify({
      success: false,
      message:
        `Decision not recorded: ${defect}. Call submit_match_decision again now, ` +
        `in this turn, with every required field set explicitly: is_match, ` +
        `matched_claim_id (when is_match is true), instance_stance, confidence, ` +
        `reasoning. Every claim id must be copied exactly from a ` +
        `search_similar_claims result. Do not end your turn without the call.`,
    });
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  const acceptDecision = (toolInput: Record<string, unknown>): MatchDecision => {
    const submitted = toolInput as unknown as Omit<MatchDecision, "outcome">;
    // Ids are taken from the retrieved set, not from the model's retyping
    // (#470): decisionDefect has already established that a match's id
    // resolves, so here it is normalised; an alternative that resolves to
    // nothing is dropped rather than handed to a caller as a near-miss.
    const matched_claim_id = submitted.is_match
      ? resolveRetrievedId(submitted.matched_claim_id)
      : null;
    const alternative_matches: string[] = [];
    for (const raw of Array.isArray(submitted.alternative_matches) ? submitted.alternative_matches : []) {
      const id = resolveRetrievedId(raw);
      if (id === null) {
        console.warn(
          `[matcher] dropping alternative_matches id ${JSON.stringify(raw)}: ` +
            `not returned by any search in this run (#470)`
        );
        continue;
      }
      if (id !== matched_claim_id && !alternative_matches.includes(id)) alternative_matches.push(id);
    }
    // The outcome is derived here, never trusted from the model: a match
    // without an id is not a match a caller can link to.
    const outcome: MatchOutcome = submitted.is_match && matched_claim_id ? "match" : "new";
    finalResult = { ...submitted, matched_claim_id, alternative_matches, outcome };
    return finalResult;
  };

  // One search loop under its own pass budget (#727). `retryNote`, when set,
  // is the second attempt's framing (#419): the first run ended without
  // submitting, so this one is short, has a smaller allowance, and is told
  // to decide. Each loop's prompt states its own turns and money (#727: the
  // retry used to repeat the first run's "12 turns" while it had 3).
  const runLoop = async (opts: { maxIterations: number; budgetMicroUsd: number; retryNote?: string }) => {
    const prompt = promptFor(opts.maxIterations, opts.budgetMicroUsd);
    // The run ends once its budget is spent, after the one turn the loop's
    // "budget spent" notice gives it to submit.
    let graceTurnUsed = false;
    const loop = () =>
      toolUseLoop({
        initialMessages: [
          {
            role: "user",
            content: opts.retryNote
              ? [
                  { type: "text", text: prompt },
                  { type: "text", text: opts.retryNote },
                ]
              : prompt,
          },
        ],
        tools: [searchTool, ...readTools, submitTool, ...skillLoader.definitions, ...reportTools.definitions],
        system,
        model,
        // A cap, not a target: the decision itself is a few hundred tokens. But a
        // model that writes its reasoning into the turn (GLM 5.3 Flash) hit 4096
        // mid-thought on a third of the golden pairs, and a turn cut at
        // max_tokens ends the loop with no decision — a duplicate node.
        maxTokens: 16384,
        maxIterations: opts.maxIterations,
        beforeTurn: () => {
          const budget = runBudget();
          if (!budget || budget.spentMicroUsd < budget.ceilingMicroUsd) return;
          if (graceTurnUsed) throw new MatcherBudgetSpent();
          graceTurnUsed = true;
        },
        // Tell the Matcher before the turn guard cuts it off (#419): a run that
        // ends without a submission is an undecided result the caller cannot act
        // on, so a decision at honest confidence beats one more search. The
        // budget's own notices come from the loop.
        iterationBudgetNotice: {
          warnWithin: 2,
          message: (remaining) =>
            `Turn notice: ${remaining} tool-use turn(s) remain. ` +
            `Call submit_match_decision on your next turn with your best ` +
            `judgment from the searches so far, at honest confidence. A run ` +
            `that ends without a submission counts as no decision at all.`,
        },
        // A turn that ends in prose with no decision (GLM 5.3 Flash, after a
        // refused submission: "Resubmitting with every required field." and then
        // end_turn) would otherwise end the run undecided. One nudge.
        finalToolNudge: {
          max: 1,
          message:
            "No decision has been recorded. Call submit_match_decision now with " +
            "every required field (is_match, matched_claim_id when is_match is " +
            "true, instance_stance, confidence, reasoning).",
        },
        executeTool: async (name, toolInput) => {
          const loaded = await skillLoader.execute(name, toolInput);
          if (loaded !== null) return loaded;
          // The report channel first (#366): null means "not my tool".
          const report = await reportTools.execute(name, toolInput);
          if (report !== null) return report;
          if (MATCHER_READS.has(name)) {
            return (await executeGraphReadTool(name, toolInput)) ?? `Error: Unknown tool: ${name}`;
          }
          if (name === "submit_match_decision") {
            const defect = decisionDefect(toolInput);
            if (defect) return rejectDecision(defect);
            acceptDecision(toolInput);
            return JSON.stringify({ success: true });
          }
          if (name === "search_similar_claims") {
            return search(String(toolInput.query ?? ""), toolInput.keywords);
          }
          return `Error: Unknown tool: ${name}`;
        },
        onFinalTool: (name, toolInput) => {
          if (name === "submit_match_decision") {
            // A defective submission is not final: executeTool answers it with
            // the refusal above and the loop continues.
            if (decisionDefect(toolInput)) return null;
            return acceptDecision(toolInput);
          }
          return null;
        },
      }).catch((err) => {
        if (!(err instanceof MatcherBudgetSpent)) throw err;
        return null;
      });
    // The pass's meter shadows the caller's, so what this run billed is
    // added back to the caller's, where its action and allocation
    // accounting (and an ingest's settlement) read it.
    const callerMeter = getUsageContext().meter;
    const { billedMicroUsd } = await withPassBudget(
      { microUsd: opts.budgetMicroUsd, source: "this match decision's budget" },
      loop
    );
    if (callerMeter) callerMeter.billedMicroUsd += billedMicroUsd;
  };

  /**
   * One search: by meaning on `query`, and by keywords when given (#725).
   * When the embedding fails, the query falls back to a keyword search, so
   * a search still returns what it can, including nodes minted without an
   * embedding, which the cosine search never sees.
   */
  const search = async (query: string, rawKeywords: unknown): Promise<string> => {
    const keywords = typeof rawKeywords === "string" && rawKeywords.trim() ? rawKeywords.trim() : null;
    const byId = new Map<string, SearchHit>();
    const add = (
      rows: Array<{ id: string; text: string; similarity_score: number; kind?: NodeKind }>,
      foundBy?: "keywords"
    ) => {
      for (const r of rows) {
        if (byId.has(r.id)) continue;
        byId.set(r.id, {
          id: r.id,
          canonical_form: r.text,
          score: Number(r.similarity_score.toFixed(3)),
          // A hit's kind, where it is not a claim: identity is judged within
          // a kind, and a figure matches the quantity it is a value of.
          ...(r.kind && r.kind !== "claim" ? { kind: r.kind } : {}),
          ...(foundBy ? { found_by: foundBy } : {}),
        });
      }
    };
    const searchOpts = { limit: config.matchingTopK, excludeId: input.excludeClaimId };
    let note: string | undefined;
    try {
      let embedding: number[] | null = null;
      try {
        embedding = await generateEmbedding(query);
      } catch (err) {
        note =
          `Search by meaning is unavailable (${err instanceof Error ? err.message : String(err)}); ` +
          `these results are a keyword search on your query.`;
      }
      if (embedding) {
        // Retrieval, not decision: keep a low floor so negations and
        // alternate framings that embed far apart still surface (#25).
        add(await findSimilarClaims(embedding, { ...searchOpts, minSimilarity: 0.4 }));
      } else {
        add(await keywordClaimSearch(query, searchOpts), "keywords");
      }
      if (keywords) add(await keywordClaimSearch(keywords, searchOpts), "keywords");
    } catch (err) {
      return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
    }
    const hits = [...byId.values()];
    searchLog.push({ query: keywords ? `${query} [keywords: ${keywords}]` : query, results: hits });
    for (const hit of hits) retrievedIds.add(hit.id);
    return JSON.stringify({
      query,
      ...(keywords ? { keywords } : {}),
      count: hits.length,
      results: hits,
      ...(note ? { note } : {}),
    });
  };

  await withSkills([], async () => {
    await runLoop({ maxIterations: MATCHER_TURN_GUARD, budgetMicroUsd: firstBudgetMicroUsd });
    if (finalResult) return;
    // One bounded retry (#419): most runs that end undecided are a Matcher
    // mid-search, not stuck, so a short second run told to decide usually
    // yields a verdict.
    await runLoop({
      maxIterations: MATCHER_RETRY_TURNS,
      budgetMicroUsd: retryBudgetMicroUsd,
      retryNote:
        "Your previous attempt at this decision ended without calling " +
        "submit_match_decision. " +
        priorSearchesNote(searchLog) +
        "Run at most one more search_similar_claims query, then submit " +
        "your decision at honest confidence. Do not end without submitting.",
    });
  });

  if (finalResult) return finalResult;

  // The Matcher never submitted a decision, even after the retry. This is
  // signalled as undecided, not as "new" (#419): a timeout is not a negative
  // identity verdict, and a caller that minted from it would manufacture a
  // duplicate. `new_canonical_form` is null so nothing can be created from
  // this result by accident; the stance is a placeholder, not a judgment.
  return {
    outcome: "undecided",
    is_match: false,
    matched_claim_id: null,
    new_canonical_form: null,
    instance_stance: "affirms",
    direction_note: null,
    confidence: 0,
    reasoning:
      "Matcher did not submit a decision within its budget (after one retry). " +
      "No identity verdict was reached: this is not a finding that the claim is new.",
    alternative_matches: [],
    relationship_notes: null,
  };
}

/**
 * The first run's searches as a note for the retry (#467): each query with
 * its top hits, so the retry confirms prior work instead of repeating it.
 * Capped per query and in wording length so a long first run does not turn
 * the short retry's prompt into the transcript it replaces.
 */
const PRIOR_HITS_PER_QUERY = 5;
const PRIOR_HIT_TEXT_CHARS = 200;

export function priorSearchesNote(
  searchLog: ReadonlyArray<{
    query: string;
    results: ReadonlyArray<{ id: string; canonical_form: string; score: number }>;
  }>
): string {
  if (searchLog.length === 0) return "";
  const clip = (text: string): string =>
    text.length > PRIOR_HIT_TEXT_CHARS ? `${text.slice(0, PRIOR_HIT_TEXT_CHARS - 1)}…` : text;
  const lines = searchLog.map((entry, i) => {
    const hits = entry.results
      .slice(0, PRIOR_HITS_PER_QUERY)
      .map((r) => `  - ${r.id} (score ${r.score}): ${clip(r.canonical_form)}`);
    const body = hits.length > 0 ? hits.join("\n") : "  (no results above the floor)";
    return `${i + 1}. Query: ${JSON.stringify(entry.query)}\n${body}`;
  });
  return (
    "Its searches and their top hits are recorded below; treat them as " +
    "already run and do not repeat them.\n\n" +
    `Searches from the previous attempt (${searchLog.length}):\n` +
    lines.join("\n") +
    "\n\n"
  );
}
