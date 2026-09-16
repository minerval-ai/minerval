/**
 * "Ask the graph" (issue #312): one conversational service behind the
 * browser extension's popup chat, the claim page's ask box, and the site's
 * ask page. Runs the graph chat agent in the caller's context mode and
 * hydrates the claim references its reply cites.
 *
 * The conversation is the reader's own: every exchange runs untraced and no
 * transcript is kept (#356). What persists is metering, one llm_usage row
 * per call with counts and cost, never content.
 */
import { loadConfig } from "../config.js";
import { graphChat, type ChatTurn } from "../llm/agents/graph-chat.js";
import type { GraphChatContext } from "../llm/prompts/graph-chat.js";
import { untraced } from "../llm/usage-context.js";
import { getClaimById } from "./claim-service.js";
import { getCurrentAssessment } from "./assessment-service.js";

/** Link to the claim's page on the public site (same knob as the MCP server, #73). */
export function claimPageUrl(claimId: string): string {
  const base = loadConfig().publicWebBaseUrl.replace(/\/$/, "");
  return `${base}/claims/${claimId}`;
}

const CITATION_RE =
  /\[claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** Claim ids cited inline in a chat reply as [claim:<uuid>]. Exported for tests. */
export function extractCitedClaimIds(reply: string): string[] {
  return [...new Set([...reply.matchAll(CITATION_RE)].map((m) => m[1]!.toLowerCase()))];
}

export interface ChatCitation {
  id: string;
  canonical_form: string;
  status: string | null;
  url: string;
}

/** At most this many distinct citations are hydrated per reply. */
const MAX_CITATIONS = 20;

/**
 * Hydrate every cited id that resolves in the graph. An id fabricated from
 * thin air virtually never resolves, so it is still dropped; an id the
 * agent legitimately saw anywhere (search results, other tool outputs, the
 * context block, an earlier turn) links correctly instead of being silently
 * deleted from the rendered reply (#181).
 */
export async function hydrateCitations(reply: string): Promise<ChatCitation[]> {
  const citations: ChatCitation[] = [];
  for (const id of extractCitedClaimIds(reply).slice(0, MAX_CITATIONS)) {
    const [claim, assessment] = await Promise.all([
      getClaimById(id),
      getCurrentAssessment(id),
    ]);
    if (!claim) continue;
    citations.push({
      id,
      canonical_form: claim.text,
      status: assessment?.status ?? null,
      url: claimPageUrl(id),
    });
  }
  return citations;
}

export interface AskGraphResult {
  reply: string;
  citations: ChatCitation[];
  /** The model that answered, named so every surface can say so. */
  model: string | null;
}

/** Thrown when claim mode names a claim the graph does not hold. */
export class UnknownClaimError extends Error {
  constructor(readonly claimId: string) {
    super(`Claim not found: ${claimId}`);
  }
}

export async function askGraph(input: {
  messages: ChatTurn[];
  context: GraphChatContext;
}): Promise<AskGraphResult> {
  const config = loadConfig();

  // Claim mode is anchored to a real claim; a stale or mistyped id is the
  // caller's error, not a conversation to run.
  if (input.context.kind === "claim") {
    const claim = await getClaimById(input.context.claimId);
    if (!claim) throw new UnknownClaimError(input.context.claimId);
  }

  // The conversation is the reader's own: no transcript of it is kept.
  const result = await untraced(() =>
    graphChat({
      messages: input.messages,
      context: input.context,
      model: config.extensionModel,
    })
  );

  return {
    reply: result.reply,
    citations: await hydrateCitations(result.reply),
    model: result.model ?? config.extensionModel,
  };
}
