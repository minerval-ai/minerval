/**
 * The guard on the model seam: in record mode, no model is called outside a
 * logged run.
 *
 * A run is logged when withAgent (usage-context.ts) opened it: the run row,
 * the prompt step with its setup, a step for each turn, and the seal the run
 * waits on. Code that reaches a model without passing through withAgent
 * leaves none of that, and in a deployment that keeps its log as a record
 * (RUN_LOG_MODE=record, docs/run-log.md) such a call must not happen at all:
 * what a model was asked there, and what it answered, has to be on the log.
 * So the two places a provider is reached refuse it: getAdapter
 * (providers/index.ts), which every function of the LLM client goes through,
 * and the web search that is one completion of its own
 * (providers/openrouter.ts).
 *
 * While the log is best-effort nothing is refused: a run that is not traced
 * there (TRACE_LEVEL=off, or a reader's own content, #356) is allowed to be.
 * tests/unit/llm/logged-runs.test.ts is the static half of this guard.
 *
 * Embeddings are not agent work and do not pass through here: an embedding
 * call sends text and gets a vector back, with no prompt, no reasoning and
 * no output to record (services/embedding-service.ts).
 */
import { loadConfig } from "../config.js";
import { getUsageContext } from "./usage-context.js";

/** A model call in record mode with no run open to log it in. */
export class UnloggedModelCallError extends Error {
  constructor(what: string) {
    super(
      `${what} was refused: no agent run is open, so the call would leave no log, and this deployment keeps ` +
        `its run log as a record (RUN_LOG_MODE=record). Make the call inside withAgent (src/llm/usage-context.ts).`
    );
    this.name = "UnloggedModelCallError";
  }
}

/**
 * Refuse a model call that no run would log. `what` names the call for the
 * error: "A model call (<model id>)", "A web search".
 */
export function requireLoggedRun(what: string): void {
  if (loadConfig().runLogMode !== "record") return;
  if (getUsageContext().trace) return;
  throw new UnloggedModelCallError(what);
}
