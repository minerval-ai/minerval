/**
 * Executors for the tools domain skills bring (docs/mathematics.md §3.5).
 *
 * A skill's `tools.json` is declarative: the Anthropic tool shape plus the
 * roles whose toolset each tool joins. The code that runs a tool lives here,
 * in a registry from tool name to executor, so a skill can never declare a
 * tool the deployment cannot execute: assertSkillToolsRegistered() is called
 * at startup (and in a unit test) and fails loudly on a declared tool with no
 * executor, a duplicate name, or a name that collides with one of the
 * existing tool families. Names carry a domain prefix (`lean_`), the way the
 * Elicit connector's carry `elicit_`.
 *
 * Every executor returns a string tool result and never throws: a provider
 * failure is a structured error the agent routes around (§20), not a crashed
 * run. The Lean executors are placeholders until the checker lands; they
 * answer that the tools are not configured, and the Steward assesses on the
 * informal evidence.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  getSkillToolDefinitions,
  listSkills,
  type Skill,
  type SkillRole,
} from "../prompts/skills.js";
import { getGraphToolDefinitions } from "./graph-tools.js";
import {
  getClaimContextToolDefinitions,
  getGovernanceToolDefinitions,
} from "./governance-tools.js";
import { getStewardToolDefinitions } from "./steward-tools.js";
import { getMatcherToolDefinition } from "./matcher-tools.js";
import { getCuratorToolDefinitions } from "./curator-tools.js";
import { getReviewerToolDefinitions } from "./reviewer-tools.js";
import { getArbitratorToolDefinitions } from "./arbitrator-tools.js";
import { getAuditToolDefinitions } from "./audit-tools.js";
import { getGraphReadToolDefinitions } from "./graph-read-tools.js";
import { ELICIT_TOOL_PREFIX } from "./elicit-tools.js";

type Tool = Anthropic.Tool;

export interface SkillToolContext {
  /** The role whose toolset the call came from. */
  role: SkillRole;
  /** The claim the run serves, when the role is claim-scoped. */
  claimId?: string;
  /** Why the run happened, as the Steward's executor receives it. */
  run?: { trigger?: string; context?: string; model?: string };
}

export type SkillToolExecutor = (
  input: Record<string, unknown>,
  ctx: SkillToolContext
) => Promise<string>;

const registry = new Map<string, SkillToolExecutor>();

/** Register (or replace) the executor for a skill tool. */
export function registerSkillTool(name: string, executor: SkillToolExecutor): void {
  registry.set(name, executor);
}

/**
 * Tools the Mathematics skill declares whose service does not exist in this
 * deployment yet. The reply tells the agent what to do instead, in the same
 * shape a mid-run checker failure will use once the executors are real.
 */
const LEAN_NOT_CONFIGURED = JSON.stringify({
  success: false,
  message: "Lean tools are not configured in this deployment.",
});

for (const name of ["lean_search", "lean_elaborate", "lean_check", "publish_formalization"]) {
  registerSkillTool(name, async () => LEAN_NOT_CONFIGURED);
}

/** Every tool name declared by any skill's tools.json. */
export function declaredSkillToolNames(): Set<string> {
  return new Set(listSkills().flatMap((s) => s.tools.map((t) => t.name)));
}

export function isSkillTool(name: string): boolean {
  return declaredSkillToolNames().has(name);
}

/** The tool definitions the active skills bring to `role`, in skill order. */
export function getActiveSkillToolDefinitions(
  skills: readonly Skill[],
  role: SkillRole
): Tool[] {
  return skills.flatMap((s) => getSkillToolDefinitions(s, role));
}

/**
 * Run a skill tool. Always a string result: an undeclared or unregistered
 * name, or an executor that throws, comes back as a structured error.
 */
export async function executeSkillTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: SkillToolContext
): Promise<string> {
  if (!isSkillTool(toolName)) {
    return JSON.stringify({
      success: false,
      message: `Unknown skill tool: ${toolName}`,
    });
  }
  const executor = registry.get(toolName);
  if (!executor) {
    return JSON.stringify({
      success: false,
      message: `No executor is registered for ${toolName} in this deployment.`,
    });
  }
  try {
    return await executor(input, ctx);
  } catch (err) {
    return JSON.stringify({
      success: false,
      message:
        `${toolName} failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Proceed with the evidence you have and note in your reasoning that the ` +
        `tool was unavailable.`,
    });
  }
}

/**
 * Tool names defined inline in agent files rather than in a tool family
 * module (the Matcher's loop, the Grantmaker's conversation and review
 * passes, the grantor's planner), listed here so the collision check covers
 * them too.
 */
const AGENT_INLINE_TOOL_NAMES = [
  "web_search",
  "search_similar_claims",
  "submit_match_decision",
  "survey_scope",
  "estimate_costs",
  "propose_mandate",
  "decline_mandate",
  "grant_overview",
  "list_funded_assessments",
  "pipeline_report",
  "claims_from_source",
  "importance_distribution",
  "allocation_report",
  "adjust_plan",
  "update_allocation_policy",
  "regrant",
  "spawn_mandate",
  "set_daily_rate",
  "list_open_actions",
  "set_valuations",
  "extend_plan",
  "update_workspace",
  "continue_review",
  "complete_mandate",
  "ingestion_report",
  "submit_allocation_plan",
];

/** Every tool name the existing families define, plus the inline ones above. */
export function builtinToolNames(): Set<string> {
  const families: Tool[][] = [
    getGraphToolDefinitions(),
    getGovernanceToolDefinitions(),
    getClaimContextToolDefinitions(),
    getStewardToolDefinitions(),
    [getMatcherToolDefinition()],
    getCuratorToolDefinitions(),
    getReviewerToolDefinitions(),
    getArbitratorToolDefinitions(),
    getAuditToolDefinitions(),
    getGraphReadToolDefinitions(),
  ];
  const names = new Set<string>(AGENT_INLINE_TOOL_NAMES);
  for (const family of families) for (const tool of family) names.add(tool.name);
  return names;
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Fail loudly unless every declared skill tool has an executor and a name
 * that collides with nothing: no other skill tool, no built-in family, no
 * reserved prefix. `existingNames` defaults to the built-in families and is
 * injectable so the test can prove a collision is caught.
 */
export function assertSkillToolsRegistered(
  opts: { existingNames?: Iterable<string> } = {}
): void {
  const existing = new Set(opts.existingNames ?? builtinToolNames());
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const skill of listSkills()) {
    for (const tool of skill.tools) {
      if (!TOOL_NAME_RE.test(tool.name)) {
        problems.push(
          `skill "${skill.name}" declares tool "${tool.name}", which is not a lowercase snake_case name`
        );
      }
      if (tool.name.startsWith(ELICIT_TOOL_PREFIX)) {
        problems.push(
          `skill "${skill.name}" declares tool "${tool.name}" under the reserved ${ELICIT_TOOL_PREFIX} prefix`
        );
      }
      if (existing.has(tool.name)) {
        problems.push(
          `skill "${skill.name}" declares tool "${tool.name}", which collides with an existing tool`
        );
      }
      const other = seen.get(tool.name);
      if (other) {
        problems.push(
          `tool "${tool.name}" is declared by both skills "${other}" and "${skill.name}"`
        );
      }
      seen.set(tool.name, skill.name);
      if (!registry.has(tool.name)) {
        problems.push(
          `skill "${skill.name}" declares tool "${tool.name}" but no executor is registered for it`
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`skill tool registry check failed:\n  ${problems.join("\n  ")}`);
  }
}
