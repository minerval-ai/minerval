/**
 * Skills for the graph's callers (#620): the agents that use Minerval from
 * outside, over MCP, rather than administer it.
 *
 * The administrators' skills live in `skills/` and are loaded into admin
 * prompts (src/llm/prompts/skills.ts). These live in `plugin/skills/`, where
 * the Claude Code / Cowork plugin ships them as ordinary Agent Skills. They
 * carry the constitution's principles to an outside agent as advice it is
 * free to follow, not as governance: report the graph's judgment as the
 * graph's, keep uncertainty honest, treat gaps as contributions, fund work in
 * good faith. `minerval-constitution` bundles the constitution itself, and
 * `administrator-skills` the administrators' own skills and role prompts.
 *
 * Not every MCP client loads skills, so the server serves the same files as
 * resources (`minerval://skills/{name}`, `minerval://constitution`) and puts
 * the shortest form of the principles in its initialize instructions. One
 * source of truth: the files under plugin/skills. The personal assistant
 * (#646) is meant to read these same files, since it is a caller like any
 * other and can do nothing the user's own agent over MCP could not.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseYamlSubset, splitFrontmatter } from "../llm/prompts/skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/mcp (and dist/mcp in the image) sit two levels below the root.
const CALLER_SKILLS_DIR = resolve(__dirname, "../../plugin/skills");

export interface CallerSkill {
  name: string;
  description: string;
  /** The whole SKILL.md, frontmatter included, as a skill loader reads it. */
  text: string;
}

let _skills: CallerSkill[] | null = null;

export function callerSkillsDir(): string {
  return CALLER_SKILLS_DIR;
}

export function listCallerSkills(): CallerSkill[] {
  if (_skills) return _skills;
  if (!existsSync(CALLER_SKILLS_DIR)) {
    throw new Error(
      `plugin/skills not found at ${CALLER_SKILLS_DIR}; the MCP server serves the caller skills from it`
    );
  }
  _skills = readdirSync(CALLER_SKILLS_DIR)
    .filter((name) => statSync(join(CALLER_SKILLS_DIR, name)).isDirectory())
    .sort()
    .map((dir) => {
      const path = join(CALLER_SKILLS_DIR, dir, "SKILL.md");
      const text = readFileSync(path, "utf-8");
      const fm = parseYamlSubset(splitFrontmatter(text, path).frontmatter, path);
      if (fm.name !== dir) {
        throw new Error(`${path}: frontmatter name must be "${dir}"`);
      }
      if (typeof fm.description !== "string" || !fm.description) {
        throw new Error(`${path}: frontmatter needs a description`);
      }
      return { name: dir, description: fm.description, text };
    });
  return _skills;
}

export function getCallerSkill(name: string): CallerSkill | null {
  return listCallerSkills().find((s) => s.name === name) ?? null;
}

/**
 * The server's initialize instructions: what every MCP client is shown,
 * whether or not it loads skills. The principles in their shortest form,
 * with pointers to the full text.
 */
export const MCP_INSTRUCTIONS = `Minerval is a shared, public map of what is known, how well it is known, and where real disagreement lies. Its claims are assessed by administrator agents working under a published constitution. You are a caller, not an administrator: these are principles for using the graph well, which you are free to follow.

- Report the graph's judgment as the graph's: its status, its confidence, and the claim's page_url. Keep your own view separate and labeled as yours.
- Don't round. A status describes the evidence, not the debate; contestation is reported separately. "inconclusive" and "doubtful" are findings, not failures. A verified claim is reported plainly.
- When a question is hard, find what it turns on: get_decomposition shows which subclaims are settled and which are not.
- Silence is not evidence. An unknown or unassessed claim is not a license to answer from recollection; when the graph is silent or wrong on something that matters, propose a claim, submit a source, or contribute, with your user's agreement.
- Quote the graph accurately wherever you cite it, even in writing that takes a side.
- Act in good faith. The graph is shared infrastructure that others rely on, and it presumes good faith of everyone who contributes to it or funds work on it. Funding buys attention, never conclusions: the Grantmaker declines mandates that try to steer outcomes, and you should not ask it to. Mandates and contributions are public.
- Spend is your user's money. Reads are free; check get_account and confirm amounts before anything that spends or escrows owls.

Read the constitution (resource minerval://constitution) before you contribute or fund anything, and whenever a verdict surprises you. Fuller guidance is in the resources minerval://skills/claim-checking (checking and citing claims), minerval://skills/commissioning-research (funding work, appropriate mandates), minerval://skills/minerval-constitution (a reader's guide to the constitution), and minerval://skills/administrator-skills (what each of the graph's own agents works under).`;
