/**
 * Placing an argument passage at ingestion (#541): the Matcher's second
 * kind of match. Given a passage where a source reasons about a claim and
 * the claim's arguments (retired ones included), it names the argument the
 * passage makes or attacks, or none, with the passage's stance and reading.
 *
 * One structured call with no search: the candidates are the claim's own
 * arguments, which the caller reads. A claim with no arguments needs no
 * call at all: the passage is left unplaced for the claim's Steward, who
 * alone creates arguments (Part VIII). A failed call leaves it unplaced
 * too, so a passage is never lost to an error.
 */
import { completeStructured } from "../client.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { getArgumentMatchingPrompt, getMatcherSystemPromptBlocks } from "../prompts/matcher.js";
import { ARGUMENT_READINGS, type ArgumentInstanceStance, type ArgumentReading } from "../../schemas/common.js";
import type { ArgumentPassage } from "./extractor.js";

export interface ArgumentCandidate {
  id: string;
  name: string | null;
  stance: string;
  shows: unknown;
  written_form: string;
  retired: boolean;
}

export interface ArgumentPlacement {
  /** The argument the passage makes or attacks; null leaves it for the Steward. */
  argument_id: string | null;
  stance: Extract<ArgumentInstanceStance, "advances" | "criticizes">;
  reading: ArgumentReading | null;
  /** For an unplaced passage: its side on the claim as worded, where it can be told. */
  direction: "for" | "against" | null;
  /** Whether a model call decided this, rather than the no-candidates default or a failure. */
  matched_by_model: boolean;
}

const PLACEMENT_SCHEMA = {
  type: "object",
  properties: {
    argument_id: { type: ["string", "null"] },
    stance: { type: "string", enum: ["advances", "criticizes"] },
    reading: { type: ["string", "null"], enum: [...ARGUMENT_READINGS, null] },
    direction: { type: ["string", "null"], enum: ["for", "against", null] },
    reasoning: { type: "string" },
  },
  required: ["argument_id", "stance", "reading", "direction", "reasoning"],
  additionalProperties: false,
} as const;

/**
 * The placement without a model: unplaced, with the stance the Extractor's
 * role implies and, for a passage that makes the source's case, the side
 * the source's instance takes. A quantity has no sides.
 */
export function defaultPlacement(input: {
  claimKind: string;
  sourceStance: string | null;
  role: ArgumentPassage["role"];
}): ArgumentPlacement {
  let direction: ArgumentPlacement["direction"] = null;
  if (input.claimKind !== "quantity" && input.role === "makes") {
    if (input.sourceStance === "affirms") direction = "for";
    else if (input.sourceStance === "denies") direction = "against";
  }
  return {
    argument_id: null,
    stance: input.role === "makes" ? "advances" : "criticizes",
    reading: null,
    direction,
    matched_by_model: false,
  };
}

export function matchArgumentPassage(
  input: Parameters<typeof matchArgumentPassageImpl>[0]
): ReturnType<typeof matchArgumentPassageImpl> {
  return withAgent("matcher", () => matchArgumentPassageImpl(input));
}

async function matchArgumentPassageImpl(input: {
  claim: { text: string; kind: string };
  sourceStance: string | null;
  passage: ArgumentPassage;
  candidates: ArgumentCandidate[];
  model?: string;
}): Promise<ArgumentPlacement> {
  const fallback = defaultPlacement({
    claimKind: input.claim.kind,
    sourceStance: input.sourceStance,
    role: input.passage.role,
  });
  if (input.candidates.length === 0) return fallback;

  let raw: {
    argument_id: string | null;
    stance: string;
    reading: string | null;
    direction: string | null;
  };
  try {
    raw = await completeStructured({
      system: getMatcherSystemPromptBlocks(),
      messages: [
        {
          role: "user",
          content: getArgumentMatchingPrompt({
            claim: input.claim,
            sourceStance: input.sourceStance,
            passage: input.passage,
            candidates: input.candidates,
          }),
        },
      ],
      schema: PLACEMENT_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "argument_placement",
      model: input.model ?? loadConfig().matcherModel,
      maxTokens: 1024,
    });
  } catch (err) {
    console.warn(`[argument-matcher] placement failed; leaving the passage unplaced: ${String(err)}`);
    return fallback;
  }

  // An id the candidates do not hold is not a match: the passage waits for
  // the Steward rather than landing on an argument nobody offered.
  const ids = new Set(input.candidates.map((c) => c.id));
  const argumentId = raw.argument_id && ids.has(raw.argument_id) ? raw.argument_id : null;
  const stance = raw.stance === "criticizes" ? "criticizes" : "advances";
  const reading = (ARGUMENT_READINGS as readonly (string | null)[]).includes(raw.reading)
    ? (raw.reading as ArgumentReading)
    : null;
  const direction =
    argumentId || input.claim.kind === "quantity"
      ? null
      : raw.direction === "for" || raw.direction === "against"
        ? raw.direction
        : null;
  return { argument_id: argumentId, stance, reading, direction, matched_by_model: true };
}
