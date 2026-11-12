/**
 * Splitting an agent run's setup into parts and hashing them: the light half
 * of services/setup-service.ts, imported by the LLM client on every prompt
 * step. It imports no prompt modules; the registry of known roles, which
 * names and publishes role parts, lives with the storage and is loaded only
 * when parts are stored.
 */
import { createHash } from "node:crypto";
import { getConstitution } from "../llm/prompts/constitution.js";
import { stripRunDate } from "../llm/run-date.js";

export type SetupPartKind = "constitution" | "role" | "tool";

export const CONSTITUTION_PLACEHOLDER = "{{constitution}}";

/** A part as split from a run, before the registry names role parts. */
export interface SplitPart {
  kind: SetupPartKind;
  hash: string;
  content: string;
  /** The constitution's and a tool's name; null for a role part. */
  name: string | null;
  /** For a role part, the system block it came from (0 = the role prompt). */
  block?: number;
}

/** A run's setup as recorded on its prompt step: references, plus the settings. */
export interface SetupRecord {
  commit: string | null;
  /**
   * The hash of the prompt set the running code builds (services/
   * prompt-set.ts), added by the client when it records the step. Absent on
   * runs recorded before it was stamped; null when the manifest could not
   * be built.
   */
  promptSet?: string | null;
  /**
   * The label the run wrote at (src/labels.ts), so it is part of what the
   * log's chain covers. Absent on runs recorded before labels existed, all
   * of which were public.
   */
  label?: string;
  /**
   * The features that were switched off for the run (src/features.ts), by
   * name: empty when everything was on. A run with any off was told so in
   * its first task message (llm/features-off-note.ts), which the same step
   * records. Absent on runs recorded before this was stamped, which says
   * nothing either way about them.
   */
  featuresOff?: string[];
  /**
   * What served the run's model: `anthropic`, `openai`, `openrouter`, or
   * `endpoint:<name>` for an endpoint the deployment runs itself, as
   * routing resolved the model id (llm/providers/routing.ts). With `label`
   * it is what a later reader needs to check that the run was served only
   * by a provider cleared for its label (src/provider-labels.ts). Null
   * when the id resolved to nothing, which the client refuses before a
   * call is made. Absent on runs recorded before this was stamped.
   */
  provider?: string | null;
  model: string;
  effort: string | null;
  maxTokens: number | null;
  temperature: number | null;
  parts: Array<{ kind: SetupPartKind; hash: string; name: string | null }>;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A system block with the constitution replaced by its placeholder and the date line removed. */
export function roleText(block: string, constitution = getConstitution()): string {
  const undated = stripRunDate(block);
  return constitution && undated.includes(constitution)
    ? undated.split(constitution).join(CONSTITUTION_PLACEHOLDER)
    : undated;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Split a run's setup into parts: the constitution, each system block, each tool. */
export function splitSetup(input: {
  system?: string | string[] | null;
  tools?: ReadonlyArray<{ name: string } & Record<string, unknown>>;
}): SplitPart[] {
  const parts: SplitPart[] = [];
  const constitution = getConstitution();
  const blocks =
    input.system == null ? [] : typeof input.system === "string" ? [input.system] : input.system;

  if (blocks.some((b) => b.includes(constitution))) {
    parts.push({ kind: "constitution", name: "constitution", hash: hashText(constitution), content: constitution });
  }
  blocks.forEach((block, i) => {
    const text = roleText(block, constitution);
    if (!text.trim()) return;
    parts.push({ kind: "role", name: null, hash: hashText(text), content: text, block: i });
  });
  for (const tool of input.tools ?? []) {
    const content = stableJson(tool);
    parts.push({ kind: "tool", name: tool.name, hash: hashText(content), content });
  }
  return parts;
}

export function setupRecord(
  parts: readonly SplitPart[],
  settings: { model: string; effort?: string | null; maxTokens?: number | null; temperature?: number | null },
  commit: string | null,
  label: string,
  featuresOff: readonly string[],
  provider: string | null
): SetupRecord {
  return {
    commit,
    label,
    featuresOff: [...featuresOff],
    provider,
    model: settings.model,
    effort: settings.effort ?? null,
    maxTokens: settings.maxTokens ?? null,
    temperature: settings.temperature ?? null,
    parts: parts.map((p) => ({ kind: p.kind, hash: p.hash, name: p.name })),
  };
}
