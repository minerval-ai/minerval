/**
 * Which agent runs' transcripts are public (#553 groundwork).
 *
 * A transcript holds a run's inputs and every tool result it saw. Public by
 * default would leak whatever a run happened to read, so a run is public only
 * when nothing in it is known to be private, and "known" is decided here:
 *
 *   - AGENT_INPUTS: whether an agent's inputs (system prompt and opening
 *     messages) are public by construction. An agent not listed starts
 *     private.
 *   - TOOL_READS: whether a tool's output can carry private data. A run that
 *     executes a private tool, or a tool not listed, becomes private.
 *
 * Reasons are recorded on the run (agent_runs.private_reasons) as it goes,
 * mechanically: trace-service.ts at the start, the LLM client after each
 * tool turn. Agent code adds a reason when it hands a run private input that
 * the agent's default does not cover (markCurrentRunPrivate). The rule only
 * ever narrows: nothing here makes a run public.
 *
 * Private means: anything about an account that is not public (contact
 * details, balances, keys), money and payee details, restricted attachments,
 * unpublished solver work, a funder's conversation while it is open, a
 * reader's own content, operator data, anything served only behind auth.
 * Public means: what Minerval already serves without auth, the public web,
 * and confirmations of the run's own writes to public records.
 *
 * tests/unit/llm/run-visibility.test.ts fails when a tool defined in the code
 * is missing here, so every new tool gets a decision.
 */

export type Reads = "public" | "private";

export interface Classification {
  reads: Reads;
  /** Why, in a phrase: for public, what the output is; for private, what it exposes. */
  why: string;
}

/** Agents whose inputs are public by construction; any other agent starts private. */
export const AGENT_INPUTS: Readonly<Record<string, Classification>> = {};

/** Every tool an agent can call, by what its output can carry. */
export const TOOL_READS: Readonly<Record<string, Classification>> = {};

/** The reason a run of `agent` starts private, or null when its inputs are public. */
export function agentPrivateReason(agent: string): string | null {
  const c = AGENT_INPUTS[agent];
  if (!c) return `agent:${agent}:unclassified`;
  return c.reads === "private" ? `agent:${agent}` : null;
}

/** The reason executing `tool` makes a run private, or null when its output is public. */
export function toolPrivateReason(tool: string): string | null {
  const c = TOOL_READS[tool];
  if (!c) return `tool:${tool}:unclassified`;
  return c.reads === "private" ? `tool:${tool}` : null;
}
