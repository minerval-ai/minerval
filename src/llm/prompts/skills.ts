/**
 * Domain skills: the layer between an administrator's role and its task.
 *
 * A skill (`skills/<name>/SKILL.md`, see `skills/README.md`) says how the
 * constitution and a role apply in one domain, in role-addressed H2 sections.
 * This module loads every skill once per process, the way constitution.ts
 * loads the constitution, and owns ROLE_VIEW: which sections each role
 * receives. Each view is spliced into the prompt as its own system block
 * after the constitution-plus-role block, so the shared block's cache entry
 * is unchanged between skilled and unskilled runs of the same role.
 *
 * Precedence: constitution, then the role (whose prompt carries its operating
 * standards), then the skill. A skill may sharpen a role's obligations and add
 * procedures and tools; it never loosens one, and where it appears to diverge
 * from the constitution the constitution wins and the skill is defective.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAdminPrompt } from "./constitution.js";

type Tool = Anthropic.Tool;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../../skills");

/** The H2 headings a SKILL.md may carry, recognized by exact text. */
export const SKILL_SECTIONS = [
  "For every administrator",
  "For the Claim Steward",
  "For the Grantmaker",
  "For the Contribution Reviewer and the Dispute Arbitrator",
  "For the Audit Agent",
  "For the Curator",
  "For the Matcher",
  "For the Extractor",
  "For the solver",
  "Standards for judging",
  "Failure modes",
] as const;

export type SkillSection = (typeof SKILL_SECTIONS)[number];

const ALL_ADMIN_SECTIONS: readonly SkillSection[] = [
  "For every administrator",
  "For the Claim Steward",
  "For the Grantmaker",
  "For the Contribution Reviewer and the Dispute Arbitrator",
  "For the Audit Agent",
  "For the Curator",
  "For the Matcher",
  "For the Extractor",
];

/**
 * The composition table: which sections of a skill each role receives, in
 * document order. Keys are the agent keys the site uses (`web/content/
 * agents/index.json`), plus `math-solver`, which is an instrument rather than
 * an administrator and receives no constitution.
 */
export const ROLE_VIEW = {
  "claim-steward": ALL_ADMIN_SECTIONS,
  "audit-agent": [...ALL_ADMIN_SECTIONS, "Standards for judging"],
  grantmaker: ["For every administrator", "For the Grantmaker"],
  "contribution-reviewer": [
    "For every administrator",
    "For the Contribution Reviewer and the Dispute Arbitrator",
  ],
  "dispute-arbitrator": [
    "For every administrator",
    "For the Contribution Reviewer and the Dispute Arbitrator",
  ],
  curator: ["For every administrator", "For the Curator", "For the Matcher"],
  matcher: ["For the Matcher"],
  extractor: ["For the Extractor"],
  "math-solver": ["For the solver"],
} as const satisfies Record<string, readonly SkillSection[]>;

export type SkillRole = keyof typeof ROLE_VIEW;

export const SKILL_ROLES = Object.keys(ROLE_VIEW) as SkillRole[];

export function isSkillRole(role: string): role is SkillRole {
  return Object.prototype.hasOwnProperty.call(ROLE_VIEW, role);
}

/** A tool definition a skill brings, plus the roles whose toolset it joins. */
export interface SkillToolDefinition {
  name: string;
  description: string;
  input_schema: Tool["input_schema"];
  roles: SkillRole[];
}

export interface Skill {
  /** Frontmatter `name`; also the directory name and the activating domain. */
  name: string;
  /** Reader-facing name used in the block heading ("Mathematics"). */
  displayName: string;
  description: string;
  version: number;
  sinceEpoch: string;
  /** The `claims.domains` values that activate this skill. */
  domains: string[];
  /** The Markdown body after the frontmatter, verbatim. */
  body: string;
  /** Section bodies in document order, keyed by their recognized heading. */
  sections: Array<{ heading: SkillSection; body: string }>;
  tools: SkillToolDefinition[];
  /** Absolute path of the SKILL.md, for error messages. */
  path: string;
}

/** The sentence of standing every spliced view opens with. */
export const SKILL_STANDING =
  "This skill says how the constitution and your role apply in this domain. " +
  "It never outranks either.";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type YamlValue = string | string[] | { [key: string]: YamlValue };

/**
 * The subset of YAML the frontmatter uses: nested maps by indentation,
 * scalars, folded (`>-`, `>`) and literal (`|`) block strings, and inline
 * lists (`[a, b]`). Anything else is a defect in the skill file.
 */
function parseYamlSubset(text: string, path: string): { [key: string]: YamlValue } {
  const lines = text
    .split("\n")
    .map((line, index) => ({ index, raw: line }))
    .filter((l) => l.raw.trim() !== "" && !l.raw.trim().startsWith("#"));
  const indentOf = (raw: string) => raw.length - raw.trimStart().length;
  let pos = 0;

  const scalar = (value: string): YamlValue => {
    const v = value.trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((s) => unquote(s.trim()));
    }
    return unquote(v);
  };

  const unquote = (v: string): string => {
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      return v.slice(1, -1);
    }
    return v;
  };

  const parseBlock = (indent: number): { [key: string]: YamlValue } => {
    const out: { [key: string]: YamlValue } = {};
    while (pos < lines.length) {
      const line = lines[pos]!;
      const ind = indentOf(line.raw);
      if (ind < indent) break;
      if (ind > indent) {
        throw new Error(
          `${path}: unexpected indentation in frontmatter at line ${line.index + 1}`
        );
      }
      const content = line.raw.trim();
      const colon = content.indexOf(":");
      if (colon === -1) {
        throw new Error(
          `${path}: expected "key: value" in frontmatter at line ${line.index + 1}`
        );
      }
      const key = content.slice(0, colon).trim();
      const rest = content.slice(colon + 1).trim();
      pos++;
      if (rest === "") {
        // A nested map (or, degenerately, an empty value).
        const next = lines[pos];
        if (next && indentOf(next.raw) > indent) {
          out[key] = parseBlock(indentOf(next.raw));
        } else {
          out[key] = "";
        }
      } else if (rest === ">-" || rest === ">" || rest === "|" || rest === "|-") {
        const collected: string[] = [];
        while (pos < lines.length && indentOf(lines[pos]!.raw) > indent) {
          collected.push(lines[pos]!.raw.trim());
          pos++;
        }
        out[key] = rest.startsWith("|")
          ? collected.join("\n")
          : collected.join(" ");
      } else {
        out[key] = scalar(rest);
      }
    }
    return out;
  };

  return parseBlock(0);
}

function splitFrontmatter(raw: string, path: string): { frontmatter: string; body: string } {
  if (!raw.startsWith("---\n")) {
    throw new Error(`${path}: SKILL.md must open with YAML frontmatter (---)`);
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`${path}: unterminated frontmatter in SKILL.md`);
  }
  return {
    frontmatter: raw.slice(4, end),
    body: raw.slice(end + "\n---\n".length),
  };
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isSkillSection(heading: string): heading is SkillSection {
  return (SKILL_SECTIONS as readonly string[]).includes(heading);
}

/**
 * Split the body into its H2 sections. Only the recognized headings may
 * appear at H2, nothing may precede the first one, and no heading repeats:
 * a section the loader could not route would silently vanish from every
 * role's view, so the file fails to load instead.
 */
function splitSections(
  body: string,
  path: string
): Array<{ heading: SkillSection; body: string }> {
  const sections: Array<{ heading: SkillSection; body: string }> = [];
  let current: { heading: SkillSection; lines: string[] } | null = null;
  const preamble: string[] = [];
  let inFence = false;
  const seen = new Set<string>();

  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^## (.+?)\s*$/.exec(line) : null;
    if (m) {
      const heading = m[1]!;
      if (!isSkillSection(heading)) {
        throw new Error(
          `${path}: unrecognized H2 heading "${heading}"; allowed headings are: ` +
            SKILL_SECTIONS.join(", ")
        );
      }
      if (seen.has(heading)) {
        throw new Error(`${path}: H2 heading "${heading}" appears twice`);
      }
      seen.add(heading);
      if (current) {
        sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      }
      current = { heading, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) {
    const c: { heading: SkillSection; lines: string[] } = current;
    sections.push({ heading: c.heading, body: c.lines.join("\n").trim() });
  }
  if (preamble.join("\n").trim() !== "") {
    throw new Error(
      `${path}: text before the first H2 heading has no role to go to; ` +
        `put it under "For every administrator"`
    );
  }
  if (sections.length === 0) {
    throw new Error(`${path}: SKILL.md has no sections`);
  }
  return sections;
}

function displayNameFor(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Parse one SKILL.md (plus an optional tools.json) into a Skill. Exported for tests. */
export function parseSkill(input: {
  raw: string;
  path: string;
  expectedName?: string;
  toolsJson?: string;
}): Skill {
  const { path } = input;
  const { frontmatter, body } = splitFrontmatter(input.raw, path);
  const fm = parseYamlSubset(frontmatter, path);

  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!name || name.length > 64 || !NAME_RE.test(name)) {
    throw new Error(
      `${path}: frontmatter name must be 1-64 characters of lowercase letters, ` +
        `digits, and hyphens (got "${name}")`
    );
  }
  if (input.expectedName && name !== input.expectedName) {
    throw new Error(
      `${path}: frontmatter name "${name}" does not match its directory "${input.expectedName}"`
    );
  }
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description || description.length > 1024) {
    throw new Error(`${path}: description must be present and at most 1,024 characters`);
  }
  const metadata = fm.metadata;
  const minerval =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata.minerval
      : undefined;
  if (!minerval || typeof minerval !== "object" || Array.isArray(minerval)) {
    throw new Error(`${path}: frontmatter needs a metadata.minerval block`);
  }
  const version = Number(minerval.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`${path}: metadata.minerval.version must be a positive integer`);
  }
  const sinceEpoch =
    typeof minerval.since_epoch === "string" ? minerval.since_epoch.trim() : "";
  if (!sinceEpoch) {
    throw new Error(`${path}: metadata.minerval.since_epoch is required`);
  }
  const domainsRaw = minerval.domains;
  const domains = Array.isArray(domainsRaw)
    ? domainsRaw.map((d) => String(d).trim()).filter(Boolean)
    : typeof domainsRaw === "string" && domainsRaw.trim()
      ? [domainsRaw.trim()]
      : [];
  if (domains.length === 0) {
    throw new Error(`${path}: metadata.minerval.domains must list at least one domain`);
  }

  const sections = splitSections(body, path);

  let tools: SkillToolDefinition[] = [];
  if (input.toolsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.toolsJson);
    } catch (err) {
      throw new Error(`${path}: tools.json is not valid JSON`, { cause: err });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${path}: tools.json must be an array of tool definitions`);
    }
    tools = parsed.map((t: unknown, i: number) => {
      const tool = t as Partial<SkillToolDefinition>;
      if (
        !tool ||
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        !tool.input_schema ||
        !Array.isArray(tool.roles)
      ) {
        throw new Error(
          `${path}: tools.json entry ${i} needs name, description, input_schema, and roles`
        );
      }
      for (const role of tool.roles) {
        if (!isSkillRole(String(role))) {
          throw new Error(
            `${path}: tools.json entry "${tool.name}" names unknown role "${role}"`
          );
        }
      }
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        roles: [...tool.roles] as SkillRole[],
      };
    });
  }

  return {
    name,
    displayName: displayNameFor(name),
    description,
    version,
    sinceEpoch,
    domains,
    body: body.replace(/^\n+/, ""),
    sections,
    tools,
    path,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let _skills: Skill[] | null = null;

function loadSkillDir(dir: string, name: string): Skill {
  const skillPath = join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf-8");
  } catch (err) {
    throw new Error(
      `skills/${name}/SKILL.md not found at ${skillPath}; every skill directory needs one`,
      { cause: err }
    );
  }
  const toolsPath = join(dir, "tools.json");
  const toolsJson = existsSync(toolsPath) ? readFileSync(toolsPath, "utf-8") : undefined;
  return parseSkill({ raw, path: skillPath, expectedName: name, toolsJson });
}

/** Every skill under `skills/`, alphabetical by name. Read once per process. */
export function listSkills(): Skill[] {
  if (_skills) return _skills;
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch (err) {
    throw new Error(
      `skills directory not found at ${SKILLS_DIR}; the domain skills every admin prompt lists live there`,
      { cause: err }
    );
  }
  const skills = entries
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .sort()
    .map((entry) => loadSkillDir(join(SKILLS_DIR, entry), entry));
  const domains = new Map<string, string>();
  for (const skill of skills) {
    for (const domain of skill.domains) {
      const owner = domains.get(domain);
      if (owner && owner !== skill.name) {
        throw new Error(
          `domain "${domain}" is claimed by both skills "${owner}" and "${skill.name}"`
        );
      }
      domains.set(domain, skill.name);
    }
  }
  _skills = skills;
  return skills;
}

/** Test hook: drop the cache so a test can observe a fresh load. */
export function resetSkillsForTests(): void {
  _skills = null;
}

/** The skill of that name. Throws when it does not exist: a referenced skill must load. */
export function getSkill(name: string): Skill {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) {
    throw new Error(
      `skill "${name}" not found under ${SKILLS_DIR}; known skills: ` +
        (listSkills().map((s) => s.name).join(", ") || "(none)")
    );
  }
  return skill;
}

/** Every domain value that activates some skill: the closed list `claims.domains` draws from. */
export function knownDomains(): string[] {
  return [...new Set(listSkills().flatMap((s) => s.domains))].sort();
}

/** The skills a claim's domains activate, alphabetical by name (two active skills are both spliced). */
export function skillsForDomains(domains: readonly string[] | null | undefined): Skill[] {
  if (!domains || domains.length === 0) return [];
  const wanted = new Set(domains);
  return listSkills().filter((s) => s.domains.some((d) => wanted.has(d)));
}

/** The skills of those names (unknown names throw). */
export function skillsByName(names: readonly string[] | null | undefined): Skill[] {
  if (!names || names.length === 0) return [];
  const wanted = new Set(names);
  return listSkills().filter((s) => wanted.has(s.name));
}

// ---------------------------------------------------------------------------
// Views and prompt composition
// ---------------------------------------------------------------------------

/** The sections of `skill` that `role` receives, in document order. */
export function sectionsForRole(skill: Skill, role: SkillRole): SkillSection[] {
  const wanted = new Set<string>(ROLE_VIEW[role]);
  return skill.sections.map((s) => s.heading).filter((h) => wanted.has(h));
}

/**
 * The block spliced into `role`'s prompt for `skill`: a heading the agent can
 * cite, one sentence of standing, then the role's sections verbatim.
 */
export function getSkillView(skill: Skill, role: SkillRole): string {
  const wanted = new Set<string>(ROLE_VIEW[role]);
  const parts = skill.sections
    .filter((s) => wanted.has(s.heading))
    .map((s) => `## ${s.heading}\n\n${s.body}`);
  return (
    `# Domain skill: ${skill.displayName} (version ${skill.version})\n\n` +
    `${SKILL_STANDING}\n\n` +
    parts.join("\n\n")
  );
}

/** The views of several skills for one role, in the skills' (alphabetical) order. */
export function getSkillViews(skills: readonly Skill[], role: SkillRole): string[] {
  return skills.map((s) => getSkillView(s, role));
}

/** The one-line catalog of the skills that exist, as `role` sees them. */
export function getSkillCatalog(role: SkillRole): string {
  const skills = listSkills();
  if (skills.length === 0) return "No domain skills exist yet.";
  const entries = skills.map((s) => {
    const sections = sectionsForRole(s, role);
    const view =
      sections.length > 0
        ? `you receive: ${sections.join(", ")}`
        : "you receive none of its sections";
    return `${s.name} (version ${s.version}; activated by domain ${s.domains.join(", ")}; ${view})`;
  });
  return `Skills that exist: ${entries.join("; ")}.`;
}

/**
 * The `## Domain skills` section every role prompt that can receive a skill
 * carries: the forward reference to the block that may follow, and the
 * catalog.
 */
export function domainSkillsSection(role: SkillRole): string {
  return `## Domain skills

A domain skill block may follow this role. It governs how the constitution
and your role apply in that domain and never outranks either: a skill may
sharpen your obligations and add procedures and tools, never loosen them.
Which skills a run carries is decided by the claim's recorded domains, never
by who funds the work. ${getSkillCatalog(role)}`;
}

/** The tool definitions `skill` brings to `role`'s toolset, in the Anthropic shape. */
export function getSkillToolDefinitions(skill: Skill, role: SkillRole): Tool[] {
  return skill.tools
    .filter((t) => t.roles.includes(role))
    .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * The system blocks of an admin prompt: the constitution-plus-role block
 * (exactly what buildAdminPrompt returns), then one block per skill view.
 */
export function buildAdminPromptBlocks(
  rolePrompt: string,
  skillViews: readonly string[] = []
): string[] {
  return [buildAdminPrompt(rolePrompt), ...skillViews];
}

/**
 * Join system blocks into one string, for a consumer that takes a single
 * system string (the seam itself accepts the block array, and the agents
 * pass it directly so each skill is its own cached block).
 */
export function systemFromBlocks(blocks: readonly string[]): string {
  return blocks.join("\n\n---\n\n");
}
