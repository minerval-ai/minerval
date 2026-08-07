/**
 * Vendors verbatim project documents and the real agent system prompts into the
 * web/ frontend, so the explainer shows exactly what the agents are governed by.
 *
 * Run from the repo root:  npx tsx scripts/sync-frontend-content.ts
 *
 * Re-run whenever the constitution, docs, or prompts change.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { getExtractorSystemPrompt } from "../src/llm/prompts/extractor.js";
import { getMatcherSystemPrompt } from "../src/llm/prompts/matcher.js";
import { getContributionReviewerSystemPrompt } from "../src/llm/prompts/contribution-reviewer.js";
import { getClaimStewardSystemPrompt } from "../src/llm/prompts/claim-steward.js";
import { getCuratorSystemPrompt } from "../src/llm/prompts/curator.js";
import { getDisputeArbitratorSystemPrompt } from "../src/llm/prompts/dispute-arbitrator.js";
import { getAuditAgentSystemPrompt } from "../src/llm/prompts/audit-agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const contentDir = resolve(root, "web/content");
const agentsDir = resolve(contentDir, "agents");
mkdirSync(agentsDir, { recursive: true });

// ---- verbatim docs --------------------------------------------------------
copyFileSync(resolve(root, "admin_constitution.md"), resolve(contentDir, "constitution.md"));
copyFileSync(resolve(root, "docs/architecture.md"), resolve(contentDir, "architecture.md"));
copyFileSync(resolve(root, "docs/policies.md"), resolve(contentDir, "policies.md"));

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
    model: "Claude Fable 5", fn: getClaimStewardSystemPrompt },
  { key: "curator", name: "Curator", stage: 5, group: "governance",
    tagline: "The graph-level counterpart to the Steward. It owns the connective tissue between claims, merging duplicates and counterparts, splitting conflations, and suggesting cross-claim edges for Stewards to adopt.",
    invokedWhen: "When a Steward escalates a structural concern (and, as a follow-up, on new-claim neighborhood sweeps).",
    model: "Claude Fable 5", fn: getCuratorSystemPrompt },
  { key: "dispute-arbitrator", name: "Dispute Arbitrator", stage: 6, group: "governance",
    tagline: "Resolves escalations and appeals through careful adjudication, the highest-stakes governance call.",
    invokedWhen: "A review is escalated, an appeal is filed, or a claim is persistently contested.",
    model: "Claude Fable 5", fn: getDisputeArbitratorSystemPrompt },
  { key: "audit-agent", name: "Audit Agent", stage: 7, group: "governance",
    tagline: "Quality control over the governance system itself: flags issues, adjusts reputation, suspends bad actors.",
    invokedWhen: "Random 5% sampling, high-reputation decisions, complaints, or anomalies.",
    model: "Claude Fable 5", fn: getAuditAgentSystemPrompt },
];

const index = AGENTS.map((a) => {
  const full = a.fn();
  const { role, hasConstitution } = splitPrompt(full);
  writeFileSync(resolve(agentsDir, `${a.key}.role.md`), role);
  writeFileSync(resolve(agentsDir, `${a.key}.full.md`), full);
  const { fn, ...meta } = a;
  void fn;
  return { ...meta, hasConstitution, roleChars: role.length, fullChars: full.length };
});

writeFileSync(resolve(agentsDir, "index.json"), JSON.stringify(index, null, 2));

console.log(`Synced ${AGENTS.length} agents + 3 docs into web/content/`);
console.log(index.map((a) => `  ${a.stage}. ${a.name} — role ${a.roleChars}c, full ${a.fullChars}c`).join("\n"));
