/**
 * The downstream-reasoner probe's prompts (#334 S5, from #288) — pure, so
 * the evals guide can render every one of them verbatim (#368) and the
 * unit suite can pin their shape. probe.ts fills them; probe-lib.ts grades
 * what comes back.
 *
 * Three prompts and two schemas:
 *   - WITH the graph: the question plus a rendered record of the top claims
 *     retrieval found (status, verdict confidence, credence, summary), with
 *     the instruction to answer from that record only and to say which
 *     claims the answer rests on and whether it takes each as true or false.
 *   - WITHOUT the graph: the same question, from the model's own knowledge.
 *   - The retraction context: the text handed to the affected claims'
 *     Stewards when a source is (simulated as) retracted.
 */

export interface ContextClaim {
  id: string;
  text: string;
  /** Current assessment status, or null when unassessed. */
  status: string | null;
  /** Verdict confidence (how sure the Steward is of the STATUS), or null. */
  confidence: number | null;
  /** The Steward's probability that the claim is true, or null when none was stated. */
  credence: number | null;
  /** The reader-facing assessment summary (or the head of the reasoning trace), or null. */
  summary: string | null;
  /** Retrieval similarity, for the record. */
  similarity: number;
}

/** Bound the record: enough to reason from, not the whole graph. */
export const MAX_SUMMARY_CHARS = 700;

/** Short ids in the record so the reasoner can cite them without copying UUIDs. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

const fmt = (x: number | null): string => (x === null ? "not stated" : x.toFixed(2));

/**
 * The record of the graph as the reasoner sees it: one block per claim,
 * cited by short id. This exact text is recorded per question in the
 * report, so a reading can be checked against what the reasoner was shown.
 */
export function renderGraphContext(claims: ContextClaim[]): string {
  if (claims.length === 0) return "(the record holds no claims relevant to this question)";
  return claims
    .map(
      (c) =>
        `[${shortId(c.id)}] ${c.text}\n` +
        `  status: ${c.status ?? "unassessed"} · verdict confidence: ${fmt(c.confidence)} · credence (probability true): ${fmt(c.credence)}\n` +
        `  assessment: ${c.summary ? c.summary.slice(0, MAX_SUMMARY_CHARS) : "(none)"}`
    )
    .join("\n\n");
}

export function buildWithGraphPrompt(question: string, claims: ContextClaim[]): string {
  return `You are answering a question using ONLY the record below: a set of claims from a claim graph, each with the status its steward assigned, the steward's confidence in that status, the steward's credence (probability the claim is true, where one was stated), and a short assessment. Do not use outside knowledge to decide the answer; if the record does not settle the question, say so and let your confidence reflect it.

Then state your confidence, from 0 to 1, that your answer is correct. Your confidence should follow the record: an answer that rests on a claim the record marks verified with high credence deserves more confidence than one resting on a contested or unassessed claim, and an answer that has to go beyond the record deserves less. Finally, list the claims your answer rests on by their bracketed id, and for each say whether your answer takes it as true, as false, or as uncertain.

## Question
${question}

## The record
${renderGraphContext(claims)}`;
}

export function buildWithoutGraphPrompt(question: string): string {
  return `Answer the question below from your own knowledge, briefly. Then state your confidence, from 0 to 1, that your answer is correct.

## Question
${question}`;
}

export interface ProbeAnswerWithGraph {
  answer: string;
  confidence: number;
  cited_claims: Array<{ id: string; used_as: "true" | "false" | "uncertain" }>;
}

export interface ProbeAnswerWithoutGraph {
  answer: string;
  confidence: number;
}

export const PROBE_WITH_GRAPH_SCHEMA = {
  type: "object" as const,
  properties: {
    answer: { type: "string", description: "The answer, in a few sentences, from the record only." },
    confidence: { type: "number", description: "0 to 1: your confidence that the answer is correct, following the record's statuses and credences." },
    cited_claims: {
      type: "array",
      description: "The claims the answer rests on, by bracketed id from the record, and how each is used.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The bracketed id exactly as it appears in the record." },
          used_as: { type: "string", enum: ["true", "false", "uncertain"], description: "Whether the answer takes this claim as true, as false, or as uncertain." },
        },
        required: ["id", "used_as"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "confidence", "cited_claims"],
  // Required by native structured outputs' strict schema subset.
  additionalProperties: false,
};

export const PROBE_WITHOUT_GRAPH_SCHEMA = {
  type: "object" as const,
  properties: {
    answer: { type: "string", description: "The answer, in a few sentences." },
    confidence: { type: "number", description: "0 to 1: your confidence that the answer is correct." },
  },
  required: ["answer", "confidence"],
  additionalProperties: false,
};

/**
 * The context the affected claims' Stewards receive when a source is
 * retracted. There is no retraction path in the system today (no
 * source-watch service, no lookout trigger), so the probe simulates the
 * lookout flag by enqueuing each affected claim's Steward with this text.
 */
export function retractionContext(source: { title: string; url: string | null }): string {
  return (
    `Lookout flag: the source "${source.title}"` +
    (source.url ? ` (${source.url})` : "") +
    ` has been RETRACTED by its publisher. Every instance this claim has from that source should now be treated as withdrawn evidence: it no longer counts toward or against the claim. Re-examine the claim's assessment on the evidence that remains, revise the status, confidence and credence as the remaining evidence warrants, and say in the reasoning trace what the retraction changed. If the retracted source was the only evidence, say so and mark the claim accordingly rather than carrying the old verdict forward.`
  );
}
