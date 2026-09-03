/**
 * Vendors verbatim project documents, the real agent system prompts, and the
 * domain skills into the web/ frontend, so the explainer shows exactly what
 * the agents are governed by.
 *
 * Run from the repo root:  npx tsx scripts/sync-frontend-content.ts
 *
 * Re-run whenever the constitution, docs, prompts, or skills change. The
 * drift test (tests/unit/scripts/frontend-content-drift.test.ts) regenerates
 * into a temporary directory and diffs it against web/content/, so a stale
 * vendored copy fails CI rather than quietly misdescribing the agents.
 */
import { writeFileSync, mkdirSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { getExtractorSystemPrompt } from "../src/llm/prompts/extractor.js";
import { getMatcherSystemPrompt } from "../src/llm/prompts/matcher.js";
import { getContributionReviewerSystemPrompt } from "../src/llm/prompts/contribution-reviewer.js";
import { getClaimStewardSystemPrompt } from "../src/llm/prompts/claim-steward.js";
import { getCuratorSystemPrompt } from "../src/llm/prompts/curator.js";
import { getDisputeArbitratorSystemPrompt } from "../src/llm/prompts/dispute-arbitrator.js";
import { getAuditAgentSystemPrompt } from "../src/llm/prompts/audit-agent.js";
import { getGrantmakerSystemPrompt } from "../src/llm/prompts/grantmaker.js";
import {
  ROLE_VIEW,
  SKILL_ROLES,
  getSkillView,
  isSkillRole,
  listSkills,
  sectionsForRole,
  type SkillRole,
} from "../src/llm/prompts/skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ---- split the assembled prompt into its constitution / role layers -------
const ROLE_MARKER = "# Your Specific Role";
const FOOTER_MARKER = "\n\n---\n\nRemember:";

function splitPrompt(full: string): { role: string; hasConstitution: boolean } {
  const idx = full.indexOf(ROLE_MARKER);
  if (idx === -1) return { role: full.trim(), hasConstitution: false };
  let role = full.slice(idx + ROLE_MARKER.length);
  const f = role.indexOf(FOOTER_MARKER);
  if (f !== -1) role = role.slice(0, f);
  return { role: role.trim(), hasConstitution: true };
}

type AgentMeta = {
  key: string;
  name: string;
  stage: number;
  group: "processing" | "governance";
  tagline: string;
  invokedWhen: string;
  model: string;
  fn: () => string;
};

const AGENTS: AgentMeta[] = [
  { key: "extractor", name: "Extractor", stage: 1, group: "processing",
    tagline: "Pulls atomic claims out of a source document, in canonical form.",
    invokedWhen: "A URL or document is submitted for ingestion.",
    model: "Claude Sonnet 5", fn: getExtractorSystemPrompt },
  { key: "matcher", name: "Matcher", stage: 2, group: "processing",
    tagline: "The single decider of claim identity: does this proposition already exist (as itself, a rewording, or its negation)? Searches the graph itself.",
    invokedWhen: "For every new claim and subclaim — at ingestion, and as a tool the Steward and Curator call before creating anything.",
    model: "DeepSeek V4 Flash", fn: getMatcherSystemPrompt },
  { key: "contribution-reviewer", name: "Contribution Reviewer", stage: 3, group: "governance",
    tagline: "Evaluates incoming contributions against policy — accept, reject, or escalate.",
    invokedWhen: "A contributor submits a challenge, support, merge, edit, instance, or argument.",
    model: "Claude Sonnet 5", fn: getContributionReviewerSystemPrompt },
  { key: "claim-steward", name: "Claim Steward", stage: 4, group: "governance",
    tagline: "The owner of a claim: it decomposes the claim, maintains its canonical form, and assesses it over time. Its duty runs to the constitution and the health of the graph, not to any one contributor.",
    invokedWhen: "When a claim is first onboarded (structure + assess), a subclaim changes, evidence arrives, a contribution is accepted, or on periodic refresh.",
    model: "Claude Fable 5.1", fn: getClaimStewardSystemPrompt },
  { key: "curator", name: "Curator", stage: 5, group: "governance",
    tagline: "The graph-level counterpart to the Steward. It owns the connective tissue between claims, merging duplicates and counterparts, splitting conflations, and suggesting cross-claim edges for Stewards to adopt.",
    invokedWhen: "When a Steward escalates a structural concern (and, as a follow-up, on new-claim neighborhood sweeps).",
    model: "Claude Fable 5.1", fn: getCuratorSystemPrompt },
  { key: "dispute-arbitrator", name: "Dispute Arbitrator", stage: 6, group: "governance",
    tagline: "Resolves escalations and appeals through careful adjudication, the highest-stakes governance call.",
    invokedWhen: "A review is escalated, an appeal is filed, or a claim is persistently contested.",
    model: "Claude Fable 5.1", fn: getDisputeArbitratorSystemPrompt },
  { key: "audit-agent", name: "Audit Agent", stage: 7, group: "governance",
    tagline: "Quality control over the governance system itself: flags issues, adjusts reputation, suspends bad actors.",
    invokedWhen: "Random 5% sampling, high-reputation decisions, complaints, or anomalies.",
    model: "Claude Fable 5.1", fn: getAuditAgentSystemPrompt },
  { key: "grantmaker", name: "Grantmaker", stage: 8, group: "governance",
    tagline: "Designs and stewards funded mandates: surveys the territory, writes its mandate's valuations over the action ledger, grows its own plan, moves budget between peer mandates, and may refuse money that would warp the graph.",
    invokedWhen: "A funder starts a granting conversation, and autonomously on each active mandate's periodic review pass.",
    model: "Claude Fable 5.1", fn: getGrantmakerSystemPrompt },
];

export interface AgentIndexEntry {
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
  /** The skills that can be spliced into this agent, with the sections it receives. */
  skills: Array<{ name: string; sections: string[] }>;
}

export interface SkillIndexEntry {
  name: string;
  displayName: string;
  description: string;
  version: number;
  sinceEpoch: string;
  domains: string[];
  /** Every role in ROLE_VIEW that receives at least one section, with those sections. */
  roles: Array<{ key: SkillRole; sections: string[] }>;
  tools: Array<{
    name: string;
    description: string;
    roles: SkillRole[];
    input_schema: unknown;
  }>;
  bodyChars: number;
}

/**
 * Write the vendored content into `contentDir`: the three verbatim documents,
 * the agents' role and full prompts plus their index, and the skills' bodies,
 * per-role spliced blocks, and index. Pure with respect to everything but the
 * filesystem, so the drift test can target a temporary directory.
 */
export function syncFrontendContent(contentDir: string): {
  agents: AgentIndexEntry[];
  skills: SkillIndexEntry[];
} {
  const agentsDir = resolve(contentDir, "agents");
  const skillsDir = resolve(contentDir, "skills");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  // ---- verbatim docs ------------------------------------------------------
  copyFileSync(resolve(root, "admin_constitution.md"), resolve(contentDir, "constitution.md"));
  copyFileSync(resolve(root, "docs/architecture.md"), resolve(contentDir, "architecture.md"));
  copyFileSync(resolve(root, "docs/policies.md"), resolve(contentDir, "policies.md"));

  const skills = listSkills();

  // ---- agents: the unskilled prompt is the .full.md; the skill pages show
  // the skilled blocks, so splitPrompt is unchanged ------------------------
  const agentIndex: AgentIndexEntry[] = AGENTS.map((a) => {
    const full = a.fn();
    const { role, hasConstitution } = splitPrompt(full);
    writeFileSync(resolve(agentsDir, `${a.key}.role.md`), role);
    writeFileSync(resolve(agentsDir, `${a.key}.full.md`), full);
    const { fn, ...meta } = a;
    void fn;
    const agentSkills = isSkillRole(a.key)
      ? skills
          .map((s) => ({ name: s.name, sections: sectionsForRole(s, a.key as SkillRole) }))
          .filter((s) => s.sections.length > 0)
      : [];
    return {
      ...meta,
      hasConstitution,
      roleChars: role.length,
      fullChars: full.length,
      skills: agentSkills,
    };
  });
  writeFileSync(resolve(agentsDir, "index.json"), JSON.stringify(agentIndex, null, 2));

  // ---- skills -------------------------------------------------------------
  const skillIndex: SkillIndexEntry[] = skills.map((s) => {
    writeFileSync(resolve(skillsDir, `${s.name}.md`), s.body);
    const roles: SkillIndexEntry["roles"] = [];
    for (const role of SKILL_ROLES) {
      // Every role in ROLE_VIEW gets its spliced block, even one that happens
      // to receive nothing from this skill, so the site can show the exact
      // text a run would carry.
      writeFileSync(resolve(skillsDir, `${s.name}.${role}.md`), getSkillView(s, role));
      const sections = sectionsForRole(s, role);
      if (sections.length > 0) roles.push({ key: role, sections });
    }
    return {
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      version: s.version,
      sinceEpoch: s.sinceEpoch,
      domains: s.domains,
      roles,
      tools: s.tools.map((t) => ({
        name: t.name,
        description: t.description,
        roles: t.roles,
        input_schema: t.input_schema,
      })),
      bodyChars: s.body.length,
    };
  });
  writeFileSync(
    resolve(skillsDir, "index.json"),
    JSON.stringify(
      {
        // The composition table, verbatim, so the site's "who receives which
        // sections" table is generated from the same source the loader uses.
        roleView: ROLE_VIEW,
        skills: skillIndex,
      },
      null,
      2
    )
  );

  return { agents: agentIndex, skills: skillIndex };
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const { agents, skills } = syncFrontendContent(resolve(root, "web/content"));
  console.log(
    `Synced ${agents.length} agents + ${skills.length} skill(s) + 3 docs into web/content/`
  );
  console.log(
    agents
      .map((a) => `  ${a.stage}. ${a.name} — role ${a.roleChars}c, full ${a.fullChars}c`)
      .join("\n")
  );
  console.log(
    skills
      .map(
        (s) =>
          `  skill ${s.name} v${s.version} — ${s.bodyChars}c, ${s.roles.length} roles, ${s.tools.length} tools`
      )
      .join("\n")
  );
}
