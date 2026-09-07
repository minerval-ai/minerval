/**
 * The tagger (#272): a small, cheap agent that attaches topic tags to a
 * claim, reusing the graph's existing vocabulary before minting.
 *
 * The first agent on the nano tier. Its judgment is narrow ("what is this
 * about, at what grain?"), it makes no epistemic call, and it runs over
 * every claim the graph holds, so it carries no constitution and defaults to
 * the Matcher's tier, DeepSeek V4 Flash (config.taggerModel, TAGGER_MODEL). The shape is the Matcher's: a
 * tool-use loop armed with a semantic search over the thing it must not
 * duplicate (here the tag vocabulary, there the claims), ending in one
 * submit call. Retrieval is the tool's; the decision is the model's; the
 * write is code's (tag-service.setSubjectTags, which also dedups by slug
 * and by meaning as a backstop).
 *
 * The agent returns a decision; it does not write. The tagging pipeline
 * (src/workers/tagging-pipeline.ts) applies it, so the same agent can be
 * run dry from a script or a test.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import {
  getTaggerSystemPrompt,
  getTaggingPrompt,
  MAX_TAGS_PER_CLAIM,
} from "../prompts/tagger.js";
import {
  searchTags,
  TAG_DESCRIPTION_MAX_CHARS,
  TAG_NAME_MAX_CHARS,
} from "../../services/tag-service.js";

export interface ProposedTag {
  /** An existing tag's slug, from search_tags. Exactly one of slug/name. */
  slug?: string;
  /** A new tag's name, when no existing tag fits. */
  name?: string;
  description?: string;
  confidence: number;
}

export interface TaggingDecision {
  tags: ProposedTag[];
  reasoning: string;
  /** false when the loop ended without a submit (the caller may retry). */
  submitted: boolean;
}

const SUBMIT_SCHEMA = {
  type: "object" as const,
  properties: {
    tags: {
      type: "array",
      maxItems: MAX_TAGS_PER_CLAIM,
      description: `The tags this claim should carry (at most ${MAX_TAGS_PER_CLAIM}); empty only for a claim about nothing.`,
      items: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "The slug of an EXISTING tag returned by search_tags. Use this whenever one fits.",
          },
          name: {
            type: "string",
            description: `A NEW tag's name (Title Case noun phrase, at most ${TAG_NAME_MAX_CHARS} characters), only when no existing tag fits. Give slug OR name, not both.`,
          },
          description: {
            type: "string",
            description: `For a new tag: one or two sentences (at most ${TAG_DESCRIPTION_MAX_CHARS} characters) delimiting the topic.`,
          },
          confidence: {
            type: "number",
            description: "0-1: how sure you are a careful librarian would file the claim here.",
          },
        },
        required: ["confidence"],
      },
    },
    reasoning: { type: "string", description: "One sentence on the choice of tags and grain." },
  },
  required: ["tags", "reasoning"],
};

export const TAGGER_SEARCH_TOOL_NAME = "search_tags";
export const TAGGER_SUBMIT_TOOL_NAME = "submit_tags";

export interface TagClaimInput {
  claimId: string;
  text: string;
  claimType: string;
  domains?: readonly string[];
  existing?: Array<{ name: string; source: string }>;
  model?: string;
}

/** Tag every LLM call in this agent for the per-token meter and the trace. */
export function tagClaim(input: TagClaimInput): Promise<TaggingDecision> {
  return withAgent("tagger", () => tagClaimImpl(input));
}

async function tagClaimImpl(input: TagClaimInput): Promise<TaggingDecision> {
  const config = loadConfig();
  const model = input.model ?? config.taggerModel;

  const searchTool: Tool = {
    name: TAGGER_SEARCH_TOOL_NAME,
    description:
      "Search the existing tag vocabulary by meaning. Returns the closest " +
      "tags with their descriptions and how many claims carry each. Call it " +
      "for every topic you have in mind, under more than one wording, " +
      "before proposing a new tag; reuse an existing tag whenever it names " +
      "the same topic at the same grain.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "A topic to look for" },
      },
      required: ["query"],
    },
  };
  const submitTool: Tool = {
    name: TAGGER_SUBMIT_TOOL_NAME,
    description: "Submit the final tags for this claim, once you have searched enough.",
    input_schema: SUBMIT_SCHEMA as Tool["input_schema"],
  };
  const reportTools = createReportTools({ model });

  let decision: TaggingDecision | null = null;
  const accept = (toolInput: Record<string, unknown>): TaggingDecision => {
    const raw = Array.isArray(toolInput.tags) ? toolInput.tags : [];
    const tags: ProposedTag[] = [];
    for (const item of raw) {
      if (tags.length >= MAX_TAGS_PER_CLAIM) break;
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const slug = typeof t.slug === "string" && t.slug.trim() ? t.slug.trim() : undefined;
      const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : undefined;
      if (!slug && !name) continue;
      const c = Number(t.confidence);
      tags.push({
        ...(slug ? { slug } : {}),
        ...(name ? { name } : {}),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5,
      });
    }
    return {
      tags,
      reasoning: typeof toolInput.reasoning === "string" ? toolInput.reasoning : "",
      submitted: true,
    };
  };

  await toolUseLoop({
    initialMessages: [
      {
        role: "user",
        content: getTaggingPrompt({
          claimId: input.claimId,
          text: input.text,
          claimType: input.claimType,
          domains: input.domains ?? [],
          existing: input.existing ?? [],
        }),
      },
    ],
    tools: [searchTool, submitTool, ...reportTools.definitions],
    system: getTaggerSystemPrompt(),
    model,
    maxTokens: 2048,
    // Enough for a broad and a couple of specific searches plus the submit.
    maxIterations: 8,
    executeTool: async (name, toolInput) => {
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      if (name === TAGGER_SUBMIT_TOOL_NAME) {
        decision = accept(toolInput);
        return JSON.stringify({ success: true });
      }
      if (name === TAGGER_SEARCH_TOOL_NAME) {
        const query = String(toolInput.query ?? "").trim();
        if (!query) return JSON.stringify({ error: "search_tags requires a query" });
        try {
          const hits = await searchTags(query, { limit: 8 });
          return JSON.stringify({
            query,
            count: hits.length,
            tags: hits.map((h) => ({
              slug: h.slug,
              name: h.name,
              description: h.description,
              claims: h.claim_count,
              similarity: Number(h.similarity.toFixed(3)),
            })),
          });
        } catch (err) {
          return `Error searching tags: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return `Error: Unknown tool: ${name}`;
    },
    onFinalTool: (name, toolInput) => {
      if (name === TAGGER_SUBMIT_TOOL_NAME) {
        decision = accept(toolInput);
        return decision;
      }
      return null;
    },
  });

  if (decision) return decision;
  // The loop ended without a submit (iteration cap, or the model stopped
  // talking). Nothing is written from an empty decision; the pipeline
  // counts it as an attempt and the claim comes round again.
  return { tags: [], reasoning: "The tagger did not submit within its search budget.", submitted: false };
}
