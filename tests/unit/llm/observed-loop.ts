/**
 * For agent tests that stand in for the tool loop: the executor the real
 * loops (llm/client.ts) give each tool call, inside the run's record of the
 * ids it has been shown (llm/seen-ids.ts). A fake loop that called
 * `executeTool` bare would test an agent without the record every real run
 * has, and the read repair (#934) would never be reached.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { observeRun, type SeenIds } from "../../../src/llm/seen-ids.js";

export function observedExecutor(opts: {
  initialMessages: Anthropic.MessageParam[];
  seenIds?: SeenIds;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
}): { record: SeenIds; execute: (name: string, input: Record<string, unknown>) => Promise<string> } {
  const observed = observeRun(opts.initialMessages, opts.seenIds);
  return {
    record: observed.record,
    execute: (name, input) => observed.call(async () => String(await opts.executeTool(name, input))),
  };
}
