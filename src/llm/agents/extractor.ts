import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { toolUseLoop } from "../client.js";
import {
  getExtractorSystemPromptBlocks,
  getExtractionPrompt,
} from "../prompts/extractor.js";
import { knownDomains, listSkills } from "../prompts/skills.js";
import { withAgent, withSkills } from "../usage-context.js";
import { loadConfig } from "../../config.js";
import { LlmRefusalError } from "../errors.js";
import { RUN_TURN_GUARD } from "../prompts/turn-budget.js";
import { createReportTools } from "../tools/report-tools.js";
import { claimTypeEnum } from "../../schemas/common.js";

export interface ExtractedClaim {
  verbatim_text: string;
  context: string | null;
  proposed_canonical_form: string;
  claim_type: string;
  /**
   * claim, quantity, or question (constitution §2, §7a). For a quantity the
   * canonical form is its definition, with its unit, and verbatim_text the
   * figure as the document states it.
   */
  kind?: "claim" | "quantity" | "question";
  confidence: number;
  /** Provisional importance prior (0-1); the Steward later overrides it. */
  importance: number;
  /** Provisional contestation prior (0-1); the Steward later overrides it (#172). */
  contestation: number;
  source_location: string | null;
  /**
   * Domain tags from the closed list of domains that have a skill (a prior;
   * the Steward's set_claim_domains supersedes it). Selects which domain
   * skills the claim's administrators carry.
   */
  domains: string[];
}

/**
 * The schema for one extracted claim, as record_claims takes it. Built per
 * call so the `domains` enum is the closed list of domains the skills define
 * at run time.
 */
export function getExtractedClaimSchema(): Record<string, unknown> {
  const domains = knownDomains();
  return {
    ...EXTRACTED_CLAIM_SCHEMA,
    properties: {
      ...EXTRACTED_CLAIM_SCHEMA.properties,
      domains: {
        type: "array",
        // An empty enum is not a valid schema; with no skills the list is
        // open, and the ingest path drops anything outside the known set.
        items: domains.length > 0 ? { type: "string", enum: domains } : { type: "string" },
        description:
          "Domain tags from the closed list of domains that have a skill" +
          (domains.length > 0 ? ` (${domains.join(", ")})` : "") +
          "; an empty array when none applies. A prior the Steward confirms or corrects.",
      },
    },
    required: [...EXTRACTED_CLAIM_SCHEMA.required, "domains"],
  };
}

const EXTRACTED_CLAIM_SCHEMA = {
  type: "object" as const,
  properties: {
    verbatim_text: { type: "string", description: "The exact span as this source states it: the author's wording, kept as provenance" },
    context: { type: ["string", "null"], description: "Surrounding text for disambiguation" },
    proposed_canonical_form: { type: "string", description: "The shortest neutral statement of the proposition as it is actually debated, about fifteen words, stated at the precision the discourse debates it" },
    claim_type: { type: "string", enum: [...claimTypeEnum.options], description: "The claim's type, as your role description defines each" },
    kind: { type: "string", enum: ["claim", "quantity", "question"], description: "claim, quantity, or question. For a quantity, proposed_canonical_form is its definition, with its unit, and verbatim_text the figure as the document states it" },
    confidence: { type: "number", description: "Confidence this is a valid claim (0.0-1.0)" },
    importance: { type: "number", description: "Provisional importance (0.0-1.0): how much it is worth getting this claim right (roughly consequence-if-wrong × liveness), from document salience, contestedness, and discourse reach. Settled/uncontested facts score low even if load-bearing. A prior the Steward will revise; distinct from confidence." },
    contestation: { type: "number", description: "Provisional contestation (0.0-1.0): how live this proposition is in the discourse at large, disputed or actively consulted, on its own — ~0 for a settled fact stated in passing, ~1 for an actively argued crux with credible parties on both sides. The liveness half of the importance formula recorded separately; a prior the Steward will revise." },
    source_location: { type: ["string", "null"], description: "Where in the document this was found" },
  },
  // Every field is required and the nullable ones (context,
  // source_location) may be null, so a recorded claim is always complete.
  required: ["verbatim_text", "context", "proposed_canonical_form", "claim_type", "kind", "confidence", "importance", "contestation", "source_location"],
  additionalProperties: false,
};

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function extractClaims(
  input: Parameters<typeof extractClaimsImpl>[0]
): ReturnType<typeof extractClaimsImpl> {
  return withAgent("extractor", () => extractClaimsImpl(input));
}

const RECORD_TOOL = "record_claims";
const FINISH_TOOL = "finish_extraction";

const KINDS = new Set(["claim", "quantity", "question"]);
const CLAIM_TYPES = new Set<string>(claimTypeEnum.options);

/** What is wrong with one recorded claim, or null when it is complete. */
function claimProblem(raw: unknown, domains: ReadonlySet<string>): string | null {
  if (!raw || typeof raw !== "object") return "not an object";
  const c = raw as Record<string, unknown>;
  for (const f of ["verbatim_text", "proposed_canonical_form"] as const) {
    if (typeof c[f] !== "string" || !(c[f] as string).trim()) return `${f} must be a non-empty string`;
  }
  for (const f of ["context", "source_location"] as const) {
    if (c[f] !== null && c[f] !== undefined && typeof c[f] !== "string") return `${f} must be a string or null`;
  }
  if (!CLAIM_TYPES.has(String(c.claim_type))) {
    return `claim_type must be one of ${[...CLAIM_TYPES].join(", ")}`;
  }
  if (!KINDS.has(String(c.kind))) return "kind must be claim, quantity, or question";
  for (const f of ["confidence", "importance", "contestation"] as const) {
    const v = c[f];
    if (typeof v !== "number" || !(v >= 0 && v <= 1)) return `${f} must be a number from 0 to 1`;
  }
  if (!Array.isArray(c.domains) || c.domains.some((d) => typeof d !== "string")) {
    return "domains must be an array of domain names (empty when none applies)";
  }
  if (domains.size > 0) {
    const unknown = (c.domains as string[]).filter((d) => !domains.has(d));
    if (unknown.length > 0) return `unknown domains: ${unknown.join(", ")}`;
  }
  return null;
}

function toClaim(c: Record<string, unknown>): ExtractedClaim {
  return {
    verbatim_text: String(c.verbatim_text),
    context: typeof c.context === "string" ? c.context : null,
    proposed_canonical_form: String(c.proposed_canonical_form),
    claim_type: String(c.claim_type),
    kind: c.kind as ExtractedClaim["kind"],
    confidence: c.confidence as number,
    importance: c.importance as number,
    contestation: c.contestation as number,
    source_location: typeof c.source_location === "string" ? c.source_location : null,
    domains: c.domains as string[],
  };
}

/** Why an extraction ended before the Extractor said it was finished. */
export class ExtractionIncompleteError extends Error {}

async function extractClaimsImpl(input: {
  content: string;
  sourceType?: string;
  additionalContext?: string;
  model?: string;
  /** Cap the number of claims extracted (0 = unlimited). Bounds graph fan-out. */
  maxClaims?: number;
  /**
   * A scoped reading: propose only the claims bearing on this subject
   * (services/ingest-focus-service.ts). Absent = the whole document.
   */
  focus?: string | null;
  /**
   * Called with every claim recorded so far, each time more are recorded,
   * for a caller showing the extraction as it goes. A retry on the fallback
   * model starts the list over.
   */
  onClaims?: (claims: ExtractedClaim[]) => void;
}): Promise<ExtractedClaim[]> {
  const config = loadConfig();
  const cap = input.maxClaims && input.maxClaims > 0 ? input.maxClaims : 0;
  const userPrompt =
    getExtractionPrompt(input.sourceType, input.additionalContext, input.maxClaims, input.focus) +
    input.content;
  // The Extractor always carries every skill's "For the Extractor" view and
  // the closed list of domain names (docs/mathematics.md §3.4): it cannot see
  // the graph, so the domain prior it emits is what selects the skills the
  // claim's administrators later carry. Funding never selects this prompt.
  const skills = listSkills();
  // One cached block for the constitution and role, plus one per skill.
  const system = getExtractorSystemPromptBlocks({ skills });
  const domainSet = new Set(knownDomains());

  // The Extractor records claims with tool calls as it settles on them,
  // rather than writing one structured answer at the end: a long document
  // can yield more than one model turn's output, and a turn cut off at the
  // output limit then loses nothing already recorded (the loop's cutoff
  // recovery lets it carry on); the loop streams, so no request timeout
  // bounds a turn; and it carries the report channel (#366) like every
  // agent, for a document that is garbled, paywalled, or carries injected
  // instructions.
  const recordTool: Tool = {
    name: RECORD_TOOL,
    description:
      "Record claims that pass the claim bar, as you settle on them. Call it " +
      "as many times as you like, a few claims at a time; recorded claims are " +
      "kept and cannot be withdrawn, so record a claim only once you have " +
      "decided on it. Each claim is checked: complete ones are kept, and any " +
      "with a problem are returned with the problem, for you to fix and " +
      "record again." +
      (cap ? ` At most ${cap} claims in all; the reply says how many remain.` : ""),
    input_schema: {
      type: "object" as const,
      properties: {
        claims: { type: "array", items: getExtractedClaimSchema() },
      },
      required: ["claims"],
    },
  };
  const finishTool: Tool = {
    name: FINISH_TOOL,
    description:
      "Say the extraction is finished: every claim the document turns on that " +
      "passes the bar has been recorded. Call it with none recorded if nothing " +
      "passes the bar.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };

  const run = async (model: string | undefined): Promise<ExtractedClaim[]> => {
    const recorded: ExtractedClaim[] = [];
    let finished = false;
    input.onClaims?.([]);
    const reportTools = createReportTools({ model });
    // Ends the loop once finish_extraction has run. Not onFinalTool: that
    // stops the loop before the turn's other tool calls run, and a turn that
    // records its last claims and finishes in one go would lose them.
    const done = new Error("finished");
    let result;
    try {
      result = await toolUseLoop({
        initialMessages: [{ role: "user", content: userPrompt }],
        tools: [recordTool, finishTool, ...reportTools.definitions],
        system,
        ...(model ? { model } : {}),
        maxTokens: config.extractionMaxTokens,
        stream: true,
        // The run's budget is its caller's (a mandate's ingest, an account's
        // analysis); the turn cap only halts a loop that has stopped spending.
        maxIterations: RUN_TURN_GUARD,
        finalToolNudge: {
          max: 2,
          message: `Record the claims that pass the bar with ${RECORD_TOOL}, then call ${FINISH_TOOL}. Prose is not recorded.`,
          when: () => !finished,
        },
        beforeTurn: () => {
          if (finished) throw done;
        },
        executeTool: async (name, toolInput) => {
          const report = await reportTools.execute(name, toolInput);
          if (report !== null) return report;
          if (name === FINISH_TOOL) {
            finished = true;
            return JSON.stringify({ success: true, recorded: recorded.length });
          }
          if (name !== RECORD_TOOL) return `Unknown tool: ${name}`;
          const items = Array.isArray(toolInput.claims) ? toolInput.claims : [];
          const rejected: Array<{ index: number; verbatim_text: unknown; problem: string }> = [];
          let kept = 0;
          let overCap = 0;
          items.forEach((raw, index) => {
            const problem = claimProblem(raw, domainSet);
            if (problem) {
              rejected.push({ index, verbatim_text: (raw as { verbatim_text?: unknown })?.verbatim_text ?? null, problem });
            } else if (cap && recorded.length >= cap) {
              overCap++;
            } else {
              recorded.push(toClaim(raw as Record<string, unknown>));
              kept++;
            }
          });
          if (kept > 0) input.onClaims?.([...recorded]);
          return JSON.stringify({
            success: rejected.length === 0 && overCap === 0,
            recorded_now: kept,
            recorded_total: recorded.length,
            ...(cap ? { remaining: Math.max(0, cap - recorded.length) } : {}),
            ...(rejected.length > 0 ? { rejected } : {}),
            ...(overCap > 0
              ? { not_recorded_over_cap: overCap, note: `The cap of ${cap} claims is reached; call ${FINISH_TOOL}.` }
              : {}),
          });
        },
      });
    } catch (err) {
      if (err !== done) throw err;
    }
    if (!finished) {
      // The loop ended without the Extractor saying it was done: cut off at
      // the output limit twice running, or out of turns. What was recorded
      // stands, since each claim was complete when recorded; with nothing
      // recorded there is no extraction to return, and saying "no claims"
      // would be false.
      if (recorded.length === 0) {
        throw new ExtractionIncompleteError(
          `The extraction ended before it finished, with no claims recorded (stop: ${result?.stopReason ?? "unknown"})`
        );
      }
      console.warn(
        `[extractor] ended before finishing (stop: ${result?.stopReason ?? "unknown"}); ` +
          `keeping the ${recorded.length} claims recorded`
      );
    }
    return recorded;
  };

  // The chosen tier decides which propositions become claims and how they are
  // worded, so it is worth the strongest model available. But a REFUSAL is not
  // a judgment about the document's claims — it is the model declining the
  // subject matter, and this graph's live work includes a virology cluster
  // the strong tier has refused before (#78). LlmRefusalError means the server-side
  // Opus fallback refused too, so the retry must leave the family.
  //
  // Without this, a mandate that funds "ingest this pathogen paper" pays for
  // the fetch and gets a cancelled ingest with no claims and no explanation.
  const primary = input.model ?? config.extractorModel;
  return withSkills(
    skills.map((s) => s.name),
    async (): Promise<ExtractedClaim[]> => {
      try {
        return await run(primary);
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        const fallback = config.extractorFallbackModel;
        if (!fallback || fallback === primary) throw err;
        console.warn(
          `[extractor] ${primary} refused the document` +
            (err.category ? ` (category: ${err.category})` : "") +
            `; retrying extraction on ${fallback}.`
        );
        // A fresh reading: claims the refusing model recorded are dropped.
        return await run(fallback);
      }
    }
  );
}
