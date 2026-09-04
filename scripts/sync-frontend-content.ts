/**
 * Vendors verbatim project documents, the real agent system prompts, and the
 * domain skills into the web/ frontend, so the explainer shows exactly what
 * the agents are governed by, and the eval system's record into
 * web/content/evals/ so the public evals page (#368) renders from committed
 * files rather than anyone's database.
 *
 * Run from the repo root:  npx tsx scripts/sync-frontend-content.ts
 *
 * Re-run whenever the constitution, docs, prompts, or skills change, and
 * after committing a scorecard, a filled judge-review sheet, a golden-suite
 * run, or a change to a fixture or the production model pins. Publishing a
 * new eval result is: commit the file under corpus/, run this, commit
 * web/content/evals/, open the PR. The drift test
 * (tests/unit/scripts/frontend-content-drift.test.ts) regenerates the agents
 * and skills into a temporary directory and diffs them against web/content/,
 * so a stale vendored copy fails CI rather than quietly misdescribing the
 * agents.
 */
import {
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execSync } from "child_process";

import { API_STACK_PATH, parseModelPins } from "./corpus/production-pins.js";
import { buildEvalsIndex, type ClusterInput, type ContributionScenarioInput } from "./evals-content.js";
import { hasExplicitRates, ratesForModel } from "../src/llm/pricing.js";
import { MODELS } from "../src/llm/models.js";

import { getExtractorSystemPrompt } from "../src/llm/prompts/extractor.js";
import { getMatcherSystemPrompt } from "../src/llm/prompts/matcher.js";
import { getContributionReviewerSystemPrompt } from "../src/llm/prompts/contribution-reviewer.js";
import { getClaimStewardSystemPrompt } from "../src/llm/prompts/claim-steward.js";
import { getCuratorSystemPrompt } from "../src/llm/prompts/curator.js";
import { getDisputeArbitratorSystemPrompt } from "../src/llm/prompts/dispute-arbitrator.js";
import { getAuditAgentSystemPrompt } from "../src/llm/prompts/audit-agent.js";
import { getGrantmakerSystemPrompt } from "../src/llm/prompts/grantmaker.js";
import { getMathSolverSystemPrompt } from "../src/llm/prompts/math-solver.js";
import { buildJudgePrompt, CONSTITUTION_STANDARDS, JUDGE_SCHEMA } from "./corpus/judge.js";
import { PAIR_JUDGE_SCHEMA, pairJudgePrompt } from "./corpus/graph-agreement.js";
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
  group: "processing" | "governance" | "instruments";
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
  // The solver (docs/mathematics.md §7.1): an instrument, not an
  // administrator. It owns no claim, holds no standing, receives no
  // constitution, and writes nothing to the graph; its prompt is the
  // Mathematics skill's `For the solver` section plus the harness block.
  { key: "math-solver", name: "Solver", stage: 9, group: "instruments",
    tagline: "The platform's own prover, an instrument rather than an administrator: it receives no constitution, owns nothing, and writes nothing to the graph. One bounded attempt on one published formal statement, with Lean, a computer-algebra sandbox, and a notebook; its report goes to the claim's Steward, who decides what it means.",
    invokedWhen: "A funded attempt_proof action on a claim with a published formal statement is covered on the ledger; the solver worker runs it and hands the result to the Steward.",
    model: "Claude Fable 5.1", fn: getMathSolverSystemPrompt },
];

export interface AgentIndexEntry {
  key: string;
  name: string;
  stage: number;
  group: "processing" | "governance" | "instruments";
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

/**
 * Write the eval system's record (#368) into `contentDir`/evals: everything
 * the evals page shows that is a fact rather than prose, the committed
 * scorecards and review sheets, the fixtures, and an index of what production
 * runs on, at what price, over which clusters. The page reads only from
 * web/content/evals/; nothing on the public site touches a corpus database.
 * Kept apart from syncFrontendContent because its output carries a timestamp
 * and the git commit, so the drift test does not diff it.
 */
export function syncEvalsContent(contentDir: string): {
  scorecards: number;
  goldenRuns: number;
  reviews: number;
  clusters: number;
  goldenPairs: number;
  predictions: number;
  contributions: number;
  pinnedAgents: number;
  gitCommit: string | null;
} {
  const corpusDir = resolve(root, "corpus");
  const evalsDir = resolve(contentDir, "evals");
  rmSync(evalsDir, { recursive: true, force: true });
  mkdirSync(evalsDir, { recursive: true });

  const jsonFiles = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  const readJson = <T,>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

  // Clusters: every corpus/<dir>/manifest.json, sized over its committed posts.
  const clusters: ClusterInput[] = readdirSync(corpusDir)
    .filter((d) => existsSync(join(corpusDir, d, "manifest.json")) && statSync(join(corpusDir, d)).isDirectory())
    .filter((d) => d !== "predictions")
    .sort()
    .map((key) => {
      const manifest = readJson<{
        kind?: string;
        description: string;
        source: string;
        posts: Array<{ id: string; title: string; author?: string; url?: string; role?: string }>;
      }>(join(corpusDir, key, "manifest.json"));
      const postsDir = join(corpusDir, key, "posts");
      const total = existsSync(postsDir)
        ? readdirSync(postsDir)
            .filter((f) => f.endsWith(".md"))
            .reduce((n, f) => n + words(readFileSync(join(postsDir, f), "utf8")), 0)
        : 0;
      return { key, kind: manifest.kind ?? "lesswrong", description: manifest.description, source: manifest.source, posts: manifest.posts, words: total };
    });

  // Scorecards and golden runs, copied file for file under the same names.
  const scorecardFiles: Array<{ cluster: string; file: string }> = [];
  const goldenRunFiles: string[] = [];
  const scorecardsRoot = join(corpusDir, "scorecards");
  for (const cluster of readdirSync(scorecardsRoot).filter((d) => statSync(join(scorecardsRoot, d)).isDirectory()).sort()) {
    const target = cluster === "golden-matcher" ? resolve(evalsDir, "golden-runs") : resolve(evalsDir, "scorecards", cluster);
    mkdirSync(target, { recursive: true });
    for (const file of jsonFiles(join(scorecardsRoot, cluster))) {
      copyFileSync(join(scorecardsRoot, cluster, file), resolve(target, file));
      if (cluster === "golden-matcher") goldenRunFiles.push(file);
      else scorecardFiles.push({ cluster, file });
    }
  }

  // Filled judge-review sheets (#334 §2.8 as amended).
  const reviewsDir = join(corpusDir, "calibration");
  mkdirSync(resolve(evalsDir, "reviews"), { recursive: true });
  const reviews = (existsSync(reviewsDir) ? readdirSync(reviewsDir).filter((f) => f.endsWith(".md")).sort() : []).map((file) => {
    copyFileSync(join(reviewsDir, file), resolve(evalsDir, "reviews", file));
    return { file, text: readFileSync(join(reviewsDir, file), "utf8") };
  });

  // Fixtures: the golden pairs, the predictions set, the contribution scenarios.
  copyFileSync(join(corpusDir, "golden", "matcher-pairs.json"), resolve(evalsDir, "golden-pairs.json"));
  copyFileSync(join(corpusDir, "predictions", "manifest.json"), resolve(evalsDir, "predictions.json"));
  mkdirSync(resolve(evalsDir, "contributions"), { recursive: true });
  const contributions: ContributionScenarioInput[] = jsonFiles(join(corpusDir, "contributions")).map((file) => {
    copyFileSync(join(corpusDir, "contributions", file), resolve(evalsDir, "contributions", file));
    return readJson<ContributionScenarioInput>(join(corpusDir, "contributions", file));
  });

  let gitCommit: string | null = null;
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    gitCommit = null;
  }

  // The exact texts the evals run on, so the guide shows the artifact rather
  // than describing it: the judge's prompt (rendered with placeholders where a
  // claim's own fields go) and the questions it must answer; the pair judge's
  // prompt; the rubric and the scorecard design note, verbatim.
  const judgePromptSample = buildJudgePrompt({
    id: "<claim id>",
    text: "<the claim's canonical text>",
    claimType: "<claim type>",
    importance: 0.5,
    status: "<status>",
    confidence: 0.8,
    reasoningTrace: "<the Steward's reasoning trace, verbatim>",
    subclaims: [{ relation: "<relation>", text: "<a direct subclaim's text>", status: "<its status>" }],
    instances: [{ originalText: "<a verbatim passage from a source>", stance: "<affirms | denies>", proposedCanonicalForm: "<the Extractor's proposed canonical form>" }],
  });
  writeFileSync(resolve(evalsDir, "judge-prompt.md"), judgePromptSample + "\n");
  writeFileSync(resolve(evalsDir, "judge-standards.md"), CONSTITUTION_STANDARDS + "\n");
  writeFileSync(resolve(evalsDir, "judge-schema.json"), JSON.stringify(JUDGE_SCHEMA, null, 2) + "\n");
  writeFileSync(
    resolve(evalsDir, "pair-judge.json"),
    JSON.stringify({ prompt: pairJudgePrompt("<a claim from graph A>", "<a claim from graph B>"), schema: PAIR_JUDGE_SCHEMA }, null, 2) + "\n"
  );
  copyFileSync(resolve(corpusDir, "RUBRIC.md"), resolve(evalsDir, "rubric.md"));
  copyFileSync(resolve(corpusDir, "SCORING.md"), resolve(evalsDir, "scoring.md"));

  const evalsIndex = buildEvalsIndex({
    syncedAt: new Date().toISOString(),
    gitCommit,
    pins: parseModelPins(readFileSync(API_STACK_PATH, "utf8")),
    // The judge's default (JUDGE_MODEL unset): src/config.ts pins it to Sonnet.
    judgeModel: MODELS.sonnet,
    ratesFor: (model: string) => (hasExplicitRates(model) ? ratesForModel(model) : null),
    clusters,
    golden: readJson(join(corpusDir, "golden", "matcher-pairs.json")),
    predictions: readJson(join(corpusDir, "predictions", "manifest.json")),
    contributions,
    reviews,
    scorecardFiles,
    goldenRunFiles,
    rubric: readFileSync(resolve(corpusDir, "RUBRIC.md"), "utf8"),
  });
  writeFileSync(resolve(evalsDir, "index.json"), JSON.stringify(evalsIndex, null, 2));

  return {
    scorecards: scorecardFiles.length,
    goldenRuns: goldenRunFiles.length,
    reviews: reviews.length,
    clusters: clusters.length,
    goldenPairs: evalsIndex.golden.pairs,
    predictions: evalsIndex.predictions.count,
    contributions: contributions.length,
    pinnedAgents: evalsIndex.pins.length,
    gitCommit,
  };
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const contentDir = resolve(root, "web/content");
  const { agents, skills } = syncFrontendContent(contentDir);
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

  const evals = syncEvalsContent(contentDir);
  console.log(
    `Synced the eval record into web/content/evals/: ${evals.scorecards} scorecard(s), ` +
      `${evals.goldenRuns} golden run(s), ${evals.reviews} review sheet(s), ` +
      `${evals.clusters} clusters, ${evals.goldenPairs} golden pairs, ${evals.predictions} predictions, ` +
      `${evals.contributions} contribution scenario(s); pins from ${evals.pinnedAgents} agents @ ${evals.gitCommit ?? "unknown commit"}`
  );
}
