/**
 * load_skill: how an agent reads a skill when its work calls for one.
 *
 * Skills are not spliced into the prompt. A role's prompt carries the
 * catalog of the skills it can load (name, description, what loading gives
 * it), and this tool returns a skill's text addressed to the role as the
 * tool result, the progressive disclosure of the Agent Skills format. The
 * tools a skill describes are in the toolset whether or not it is loaded;
 * the skill is the procedure for using them well.
 *
 * Every load is recorded (noteSkillLoaded): on the run's agent_runs row,
 * and on the usage context, so an assessment written after the load names
 * it. Which skills a run read is part of its record, the way its tool calls
 * are, and the Audit Agent can ask why a run did not load one.
 *
 * A claim's recorded domains point to the domain skills that cover its
 * subject, and a mandate's `grants.skills` names the skills its runs should
 * know of; `pointerNote` names them for the task message. A pointer, never
 * a load.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  getSkill,
  getSkillView,
  loadableSkills,
  skillsPointedTo,
  type Skill,
  type SkillRole,
} from "../prompts/skills.js";
import { noteSkillLoaded } from "../usage-context.js";

type Tool = Anthropic.Tool;

export const LOAD_SKILL_TOOL_NAME = "load_skill";

export interface SkillLoadTools {
  /** [load_skill], or [] for a role no skill addresses. */
  definitions: Tool[];
  /** The tool result for load_skill; null for any other tool name. */
  execute(name: string, input: Record<string, unknown>): Promise<string | null>;
  /** The skills the recorded domains or names point to, for the task message. */
  pointed: Skill[];
  /** A paragraph for the task message naming those skills; "" when none. */
  pointerNote: string;
}

export function getLoadSkillToolDefinition(role: SkillRole): Tool {
  const names = loadableSkills(role).map((s) => s.name);
  return {
    name: LOAD_SKILL_TOOL_NAME,
    description:
      "Load a skill: its text, addressed to your role, returns as the result. " +
      "The Skills section of your instructions lists the skills you can load " +
      "and what each covers. Load one when the work in front of you calls for " +
      "it, before relying on the tools it describes. The load is recorded with " +
      "the run.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          enum: names,
          description: "The skill to load, by its name in the catalog.",
        },
      },
      required: ["name"],
    },
  };
}

export function createSkillLoadTools(
  role: SkillRole,
  options: { domains?: readonly string[] | null; names?: readonly string[] | null } = {}
): SkillLoadTools {
  const loadable = loadableSkills(role);
  const named = new Set(options.names ?? []);
  const byDomain = new Set(skillsPointedTo(options.domains, role).map((s) => s.name));
  const pointed = loadable.filter((s) => byDomain.has(s.name) || named.has(s.name));
  const pointerNote =
    pointed.length > 0
      ? `\n\nSkills that cover this run's subject: ${pointed
          .map((s) => `the ${s.displayName} skill (${s.name})`)
          .join(", ")}. Load one with load_skill if the work calls for it.`
      : "";

  const execute = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<string | null> => {
    if (name !== LOAD_SKILL_TOOL_NAME) return null;
    const wanted = String(input.name ?? "").trim();
    const skill = loadable.find((s) => s.name === wanted);
    if (!skill) {
      return JSON.stringify({
        success: false,
        message:
          `No skill named "${wanted}" can be loaded by your role. ` +
          `Skills you can load: ${loadable.map((s) => s.name).join(", ") || "(none)"}.`,
      });
    }
    noteSkillLoaded(skill.name);
    return getSkillView(getSkill(skill.name), role);
  };

  return {
    definitions: loadable.length > 0 ? [getLoadSkillToolDefinition(role)] : [],
    execute,
    pointed,
    pointerNote,
  };
}
