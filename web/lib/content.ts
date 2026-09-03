import { readFileSync } from "fs";
import { resolve } from "path";

// Verbatim project documents, real agent prompts, and domain skills, vendored
// into web/content/ by scripts/sync-frontend-content.ts. Read at the server.
const CONTENT = resolve(process.cwd(), "content");

export interface AgentSkillRef {
  name: string;
  /** The skill's sections this agent receives, in document order. */
  sections: string[];
}

export interface AgentMeta {
  key: string;
  name: string;
  stage: number;
  group: "processing" | "governance";
  tagline: string;
  invokedWhen: string;
  model: string;
  hasConstitution: boolean;
  roleChars: number;
  fullChars: number;
  /** The skills that can be spliced into this agent's prompt. */
  skills: AgentSkillRef[];
}

export interface SkillToolMeta {
  name: string;
  description: string;
  roles: string[];
  input_schema: unknown;
}

export interface SkillMeta {
  name: string;
  displayName: string;
  description: string;
  version: number;
  sinceEpoch: string;
  domains: string[];
  /** Every role that receives at least one section, with those sections. */
  roles: Array<{ key: string; sections: string[] }>;
  tools: SkillToolMeta[];
  bodyChars: number;
}

export interface SkillIndex {
  /** The loader's composition table: role key to the sections it receives. */
  roleView: Record<string, string[]>;
  skills: SkillMeta[];
}

export function getDoc(name: "constitution" | "architecture" | "policies"): string {
  return readFileSync(resolve(CONTENT, `${name}.md`), "utf-8");
}

export function getAgentIndex(): AgentMeta[] {
  const raw = readFileSync(resolve(CONTENT, "agents/index.json"), "utf-8");
  return (JSON.parse(raw) as AgentMeta[])
    .map((a) => ({ ...a, skills: a.skills ?? [] }))
    .sort((a, b) => a.stage - b.stage);
}

export function getAgent(key: string): AgentMeta | undefined {
  return getAgentIndex().find((a) => a.key === key);
}

export function getAgentPrompt(key: string, which: "role" | "full"): string {
  return readFileSync(resolve(CONTENT, `agents/${key}.${which}.md`), "utf-8");
}

export function getSkillIndex(): SkillIndex {
  const raw = readFileSync(resolve(CONTENT, "skills/index.json"), "utf-8");
  return JSON.parse(raw) as SkillIndex;
}

export function getSkills(): SkillMeta[] {
  return getSkillIndex().skills;
}

export function getSkill(name: string): SkillMeta | undefined {
  return getSkills().find((s) => s.name === name);
}

/** The skill's Markdown body, verbatim (frontmatter fields are in the index). */
export function getSkillBody(name: string): string {
  return readFileSync(resolve(CONTENT, `skills/${name}.md`), "utf-8");
}

/** The exact block spliced into `roleKey`'s system prompt for this skill. */
export function getSkillView(name: string, roleKey: string): string {
  return readFileSync(resolve(CONTENT, `skills/${name}.${roleKey}.md`), "utf-8");
}
