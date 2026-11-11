/**
 * The prompt set: one manifest, and one hash, for the text the repository
 * sets its agents up with (#552 groundwork, after setup-service.ts).
 *
 * The setup service records, for each run, the hash of every part the run
 * was given. This module answers the question that leaves open: which parts
 * make up "the prompts this code runs", as one identity a reader can name.
 * The manifest lists the constitution's hash, each known role's system
 * blocks by hash, and each skill by version and hash; the prompt set's hash
 * is taken over those lines. A run records the hash of the prompt set its
 * code would build (the prompt step's `setup.promptSet`), so "this run's
 * role prompt is the published one" is a lookup: the role-part hash on the
 * run is, or is not, one of the manifest's.
 *
 * Role blocks are hashed exactly as a run's role parts are (setup-split.ts:
 * the constitution replaced by its placeholder, the run's date line
 * removed), so the two can be compared directly. A skill is hashed as its
 * whole SKILL.md, frontmatter included, since the version, the tools and
 * the changelog there all reach agents.
 *
 * What it does not cover: tool descriptors and the task message an agent
 * file builds for a run. Those are recorded per run as parts or as the
 * prompt step's messages, and are not yet fixed text in one place.
 *
 * The hash is over plain lines so anyone can recompute it from the manifest
 * with nothing but sha256:
 *
 *   minerval-prompt-set/1
 *   constitution <hash>
 *   role <name> <block hash> [<block hash> ...]     one line per entry, sorted
 *   skill <name> <version> <hash>                   one line per skill, sorted
 *
 * joined with "\n", no trailing newline.
 */
import { readFileSync } from "node:fs";
import { getConstitution } from "../llm/prompts/constitution.js";
import { KNOWN_ROLES } from "../llm/prompts/known-roles.js";
import { listSkills } from "../llm/prompts/skills.js";
import { hashText, roleText } from "./setup-split.js";

export const PROMPT_SET_FORMAT = 1;

export interface PromptSetRole {
  name: string;
  source_path: string;
  /** The role's system blocks in order, each as a run's role part is hashed. */
  blocks: string[];
}

export interface PromptSetSkill {
  name: string;
  version: number;
  hash: string;
}

export interface PromptSet {
  format: typeof PROMPT_SET_FORMAT;
  /** sha256 over the lines described in this module's comment. */
  hash: string;
  constitution: { hash: string; source_path: string };
  roles: PromptSetRole[];
  skills: PromptSetSkill[];
}

/** The lines the prompt set's hash is taken over, in order. */
export function promptSetLines(set: Pick<PromptSet, "constitution" | "roles" | "skills">): string[] {
  return [
    `minerval-prompt-set/${PROMPT_SET_FORMAT}`,
    `constitution ${set.constitution.hash}`,
    ...set.roles.map((r) => `role ${r.name} ${r.blocks.join(" ")}`).sort(),
    ...set.skills.map((s) => `skill ${s.name} ${s.version} ${s.hash}`).sort(),
  ];
}

export function hashPromptSet(set: Pick<PromptSet, "constitution" | "roles" | "skills">): string {
  return hashText(promptSetLines(set).join("\n"));
}

/**
 * Build the manifest from the running code. Unlike the setup service's
 * registry, a role whose prompt cannot be built is an error here: leaving it
 * out would give a different prompt set the same standing as the real one.
 */
export function buildPromptSet(): PromptSet {
  const constitution = getConstitution();
  const roles = KNOWN_ROLES.map((role) => ({
    name: role.name,
    source_path: role.sourcePath,
    blocks: role.blocks().map((block) => hashText(roleText(block, constitution))),
  })).sort((a, b) =>
    a.name === b.name ? a.blocks.join(" ").localeCompare(b.blocks.join(" ")) : a.name.localeCompare(b.name)
  );
  const skills = listSkills()
    .map((s) => ({ name: s.name, version: s.version, hash: hashText(readFileSync(s.path, "utf-8")) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const body = {
    constitution: { hash: hashText(constitution), source_path: "admin_constitution.md" },
    roles,
    skills,
  };
  return { format: PROMPT_SET_FORMAT, hash: hashPromptSet(body), ...body };
}

let cached: PromptSet | null = null;

/** The prompt set of the running code, built once per process. */
export function getPromptSet(): PromptSet {
  return (cached ??= buildPromptSet());
}

/** For tests: rebuild from the current code on the next read. */
export function resetPromptSet(): void {
  cached = null;
}
