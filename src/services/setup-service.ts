/**
 * The setup every agent run ran under, as versioned parts (#552 groundwork).
 *
 * A run's setup is what it was given before it began: the constitution, its
 * role prompt, the tools it could call, and the model settings. Those change
 * over time, so a transcript means little without the exact setup behind it.
 * This module splits each run's setup into parts, stores each part once
 * under the hash of its text, and gives each part a version number the first
 * time that text is seen, so a reader can say "Constitution v14" and anyone
 * can fetch exactly what that was.
 *
 * The splitting and hashing are in setup-split.ts, which the LLM client
 * imports on every prompt step; this module (the registry of known roles,
 * storage and reads) imports every role's prompt module, so the client
 * loads it lazily when it stores parts.
 *
 * Parts of a setup:
 *   - `constitution`: admin_constitution.md, when the system prompt carries it.
 *   - `role`: each system block, with the constitution replaced by
 *     `{{constitution}}` and the run's date line removed. Block 0 is the role
 *     prompt; later blocks (spliced skill views) are numbered `name#1`, ...
 *   - `tool`: each tool's descriptor (name, description, input schema).
 * The model, effort, token cap and temperature are recorded with the run.
 *
 * Version numbers are assigned in order of first sighting, per (kind, name),
 * and never change. Identity is the hash; the number is a reader's handle.
 *
 * What is published. The constitution is public. A role part is public when
 * its text is exactly what the code produces for a known role (the registry
 * below, built from the same prompt functions the agents call), which makes
 * it public by construction: it is the repository's own text at the deployed
 * commit. Any other part (a block that varies per run, a tool descriptor) is
 * recorded by hash and name only until the visibility rules for run content
 * exist (#553): its text could carry run-specific material.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getAuditAgentSystemPromptBlocks } from "../llm/prompts/audit-agent.js";
import { getClaimStewardSystemPromptBlocks } from "../llm/prompts/claim-steward.js";
import { getConsistencyCheckerSystemPromptBlocks } from "../llm/prompts/consistency-checker.js";
import { getContributionReviewerSystemPromptBlocks } from "../llm/prompts/contribution-reviewer.js";
import { getCorrespondentSystemPromptBlocks } from "../llm/prompts/correspondent.js";
import { getCuratorSystemPromptBlocks } from "../llm/prompts/curator.js";
import { getDisputeArbitratorSystemPromptBlocks } from "../llm/prompts/dispute-arbitrator.js";
import { getExtractorSystemPromptBlocks } from "../llm/prompts/extractor.js";
import { getGrantmakerSystemPromptBlocks } from "../llm/prompts/grantmaker.js";
import { getLookoutSystemPromptBlocks } from "../llm/prompts/lookout.js";
import { getMatcherSystemPromptBlocks } from "../llm/prompts/matcher.js";
import { getMathSolverSystemPromptBlocks } from "../llm/prompts/math-solver.js";
import { getQuestionStewardSystemPromptBlocks } from "../llm/prompts/question-steward.js";
import { getResearcherSystemPromptBlocks } from "../llm/prompts/researcher.js";
import { getTaggerSystemPrompt } from "../llm/prompts/tagger.js";
import { hashText, roleText, type SetupPartKind, type SplitPart } from "./setup-split.js";

export { hashText, splitSetup, type SetupPartKind } from "./setup-split.js";

const CONSTITUTION_SOURCE = "admin_constitution.md";

/** A part named and classified, ready to store. */
export interface SetupPart {
  kind: SetupPartKind;
  name: string;
  hash: string;
  content: string;
  /** Whether the text may be served publicly (see the module comment). */
  public: boolean;
  /** The repository file the text comes from, when it is known. */
  sourcePath: string | null;
}

// --- the registry of known roles --------------------------------------------

interface KnownRole {
  name: string;
  sourcePath: string;
  blocks: () => string[];
}

/**
 * Every role whose prompt is fixed text in the repository, with the function
 * its agent calls. Variants a launcher can choose (the Researcher with and
 * without the constitution) are listed as separate entries under one name.
 */
const KNOWN_ROLES: readonly KnownRole[] = [
  { name: "claim-steward", sourcePath: "src/llm/prompts/claim-steward.ts", blocks: getClaimStewardSystemPromptBlocks },
  { name: "question-steward", sourcePath: "src/llm/prompts/question-steward.ts", blocks: getQuestionStewardSystemPromptBlocks },
  { name: "curator", sourcePath: "src/llm/prompts/curator.ts", blocks: getCuratorSystemPromptBlocks },
  { name: "extractor", sourcePath: "src/llm/prompts/extractor.ts", blocks: () => getExtractorSystemPromptBlocks() },
  { name: "matcher", sourcePath: "src/llm/prompts/matcher.ts", blocks: getMatcherSystemPromptBlocks },
  { name: "contribution-reviewer", sourcePath: "src/llm/prompts/contribution-reviewer.ts", blocks: getContributionReviewerSystemPromptBlocks },
  { name: "dispute-arbitrator", sourcePath: "src/llm/prompts/dispute-arbitrator.ts", blocks: getDisputeArbitratorSystemPromptBlocks },
  { name: "audit-agent", sourcePath: "src/llm/prompts/audit-agent.ts", blocks: getAuditAgentSystemPromptBlocks },
  { name: "grantmaker", sourcePath: "src/llm/prompts/grantmaker.ts", blocks: getGrantmakerSystemPromptBlocks },
  { name: "lookout", sourcePath: "src/llm/prompts/lookout.ts", blocks: getLookoutSystemPromptBlocks },
  { name: "correspondent", sourcePath: "src/llm/prompts/correspondent.ts", blocks: getCorrespondentSystemPromptBlocks },
  { name: "consistency-checker", sourcePath: "src/llm/prompts/consistency-checker.ts", blocks: getConsistencyCheckerSystemPromptBlocks },
  { name: "math-solver", sourcePath: "src/llm/prompts/math-solver.ts", blocks: getMathSolverSystemPromptBlocks },
  { name: "researcher", sourcePath: "src/llm/prompts/researcher.ts", blocks: () => getResearcherSystemPromptBlocks({ includeConstitution: true }) },
  { name: "researcher", sourcePath: "src/llm/prompts/researcher.ts", blocks: () => getResearcherSystemPromptBlocks({ includeConstitution: false }) },
  { name: "tagger", sourcePath: "src/llm/prompts/tagger.ts", blocks: () => [getTaggerSystemPrompt()] },
];

let registry: Map<string, { name: string; sourcePath: string }> | null = null;

/** Role-part hash → the known role it belongs to. Built once, from the running code. */
function knownRoleParts(): Map<string, { name: string; sourcePath: string }> {
  if (registry) return registry;
  const map = new Map<string, { name: string; sourcePath: string }>();
  for (const role of KNOWN_ROLES) {
    let blocks: string[];
    try {
      blocks = role.blocks();
    } catch {
      continue; // A prompt that cannot be built here is simply not registered.
    }
    blocks.forEach((block, i) => {
      const name = i === 0 ? role.name : `${role.name}#${i}`;
      map.set(hashText(roleText(block)), { name, sourcePath: role.sourcePath });
    });
  }
  registry = map;
  return map;
}

/** For tests: rebuild the registry from the current code. */
export function resetSetupRegistry(): void {
  registry = null;
  known.clear();
}

// --- naming parts ---------------------------------------------------------

/**
 * Name and classify split parts. A role part matching a known role takes the
 * role's name and is public; any other role part is named after `agent`
 * (block 0) or `agent#i`, and kept private. Tools are private for now.
 */
export function classifyParts(parts: readonly SplitPart[], agent: string): SetupPart[] {
  const roles = knownRoleParts();
  return parts.map((p) => {
    if (p.kind === "constitution") {
      return { kind: p.kind, name: "constitution", hash: p.hash, content: p.content, public: true, sourcePath: CONSTITUTION_SOURCE };
    }
    if (p.kind === "tool") {
      return { kind: p.kind, name: p.name!, hash: p.hash, content: p.content, public: false, sourcePath: null };
    }
    const known = roles.get(p.hash);
    const block = p.block ?? 0;
    return {
      kind: p.kind,
      name: known?.name ?? (block === 0 ? agent : `${agent}#${block}`),
      hash: p.hash,
      content: p.content,
      public: known !== undefined,
      sourcePath: known?.sourcePath ?? null,
    };
  });
}

// --- storing parts ----------------------------------------------------------

/** Parts this process has already stored, so each is written once per process. */
const known = new Set<string>();

function partKey(p: { kind: string; name: string; hash: string }): string {
  return `${p.kind}\u0000${p.name}\u0000${p.hash}`;
}

/**
 * Store each part not yet stored, numbering it after the newest version of
 * the same (kind, name). Two processes seeing two new texts at once can race
 * for a number; the unique index on (kind, name, version) refuses the loser,
 * which retries with the next number.
 */
export async function storeSetupParts(parts: readonly SetupPart[]): Promise<void> {
  const commit = loadConfig().gitSha ?? null;
  for (const p of parts) {
    const key = partKey(p);
    if (known.has(key)) continue;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rawQuery(
          `INSERT INTO setup_parts
             (kind, name, hash, content, public, source_path, first_seen_commit, version)
           SELECT $1, $2, $3, $4, $5, $6, $7,
                  COALESCE(MAX(version), 0) + 1
             FROM setup_parts WHERE kind = $1 AND name = $2
           ON CONFLICT (kind, name, hash) DO NOTHING`,
          [p.kind, p.name, p.hash, p.content, p.public, p.sourcePath, commit]
        );
        known.add(key);
        break;
      } catch (err) {
        // A lost race for a version number: try again with the next one.
        if ((err as { code?: string }).code === "23505" && attempt < 4) continue;
        throw err;
      }
    }
  }
}

// --- reading parts ----------------------------------------------------------

const REPO_URL = "https://github.com/minerval-ai/minerval";

export interface SetupPartView {
  kind: SetupPartKind;
  name: string;
  version: number;
  hash: string;
  public: boolean;
  first_seen_at: string;
  first_seen_commit: string | null;
  source_path: string | null;
  /** The source file at the commit the part was first seen under, when both are known. */
  source_url: string | null;
}

interface PartRow {
  kind: SetupPartKind;
  name: string;
  version: number;
  hash: string;
  public: boolean;
  content: string;
  first_seen_at: Date;
  first_seen_commit: string | null;
  source_path: string | null;
}

function view(r: PartRow): SetupPartView {
  return {
    kind: r.kind,
    name: r.name,
    version: r.version,
    hash: r.hash,
    public: r.public,
    first_seen_at: new Date(r.first_seen_at).toISOString(),
    first_seen_commit: r.first_seen_commit,
    source_path: r.source_path,
    source_url:
      r.first_seen_commit && r.source_path
        ? `${REPO_URL}/blob/${r.first_seen_commit}/${r.source_path}`
        : null,
  };
}

/** Every stored part, newest version first within each (kind, name); text excluded. */
export async function listSetupParts(filter: {
  kind?: string;
  name?: string;
  /** A hash, as a run's setup record names its parts. */
  hash?: string;
} = {}): Promise<SetupPartView[]> {
  const rows = await rawQuery<PartRow>(
    `SELECT kind, name, version, hash, public, '' AS content,
            first_seen_at, first_seen_commit, source_path
       FROM setup_parts
      WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR name = $2)
        AND ($3::text IS NULL OR hash = $3)
      ORDER BY kind, name, version DESC`,
    [filter.kind ?? null, filter.name ?? null, filter.hash ?? null]
  );
  return rows.map(view);
}

/**
 * One part by (kind, name, version), with its text when the part is public.
 * Also returns the previous version's hash, so a reader can ask for the diff.
 */
export async function getSetupPart(
  kind: string,
  name: string,
  version: number
): Promise<(SetupPartView & { content: string | null; previous_version: number | null }) | null> {
  const rows = await rawQuery<PartRow>(
    `SELECT kind, name, version, hash, public, content,
            first_seen_at, first_seen_commit, source_path
       FROM setup_parts WHERE kind = $1 AND name = $2 AND version = $3`,
    [kind, name, version]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...view(row),
    content: row.public ? row.content : null,
    previous_version: row.version > 1 ? row.version - 1 : null,
  };
}
