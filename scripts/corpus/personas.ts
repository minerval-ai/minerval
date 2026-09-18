/**
 * Persona simulation driver (#334 S8 phase 1, from #82): run a manifest of
 * simulated users — readers, contributors, programmatic clients, and an
 * adversarial minority — against the graph in the corpus DB, each as an
 * LLM agent with read tools and three action tools, through the same
 * service path a real user takes; drain the real review, escalation and
 * arbitration pipelines; report what each did and what happened to it,
 * the adversarial outcomes separately, and the findings triaged for a
 * human to read before any issue is opened.
 *
 * Usage:
 *   npm run corpus:personas -- <cluster> [--personas=k1,k2] [--limit=N] [--dry-run] [--no-appeals]
 *
 * The persona model is PERSONA_MODEL (default: the cheap OpenRouter flash
 * pin, src/llm/models.ts). Prompts and tool definitions are pure functions
 * in persona-prompts.ts; the manifest is corpus/personas/manifest.json.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_ROOT, gitCommit, hasFlag, loadManifest, positional, RUNS_ROOT, CORPUS_PROFILE, CORPUS_DATABASE_URL } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { OPENROUTER_MODELS } from "../../src/llm/models.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { complete, toolUseLoop } from "../../src/llm/client.js";
import { getUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { executeGraphReadTool, getGraphReadToolDefinitions } from "../../src/llm/tools/graph-read-tools.js";
import { getOrCreateContributor } from "../../src/services/contributor-service.js";
import { getClaimById } from "../../src/services/claim-service.js";
import { createAppeal, createContribution, getReviewForContribution } from "../../src/services/contribution-service.js";
import { createClaimProposal } from "../../src/services/intake-service.js";
import { enqueueArbitration, enqueueContribution } from "../../src/services/queue-service.js";
import { drainLocalQueues } from "../../src/workers/local-runner.js";
import type { DrainStats, RunnerEvent } from "../../src/workers/local-runner.js";
import { CONTRIBUTION_TYPES, type ContributionType } from "./contributions-lib.js";
import {
  budgetIterations,
  parseBudget,
  personasForCluster,
  renderReport,
  summarizeOutcomes,
  triageFindings,
  validateManifest,
  type ActionBudget,
  type PersonaContribution,
  type PersonaEntry,
  type PersonaFinding,
  type PersonaManifest,
  type PersonaOutcome,
  type PersonaProposal,
  type PersonaRead,
  type ReviewOutcome,
} from "./personas-lib.js";
import {
  buildPersonaOpeningMessage,
  buildPersonaSystemPrompt,
  personaActionToolDefinitions,
  personaToolNames,
} from "./persona-prompts.js";
import type { Replay, ReplayArm, ReplayFingerprint, ReplayMatching, ReplayScenario } from "./replay-types.js";

/** The contract scripts/corpus/replay.ts implements (written beside this driver; imported dynamically below). */
interface ReplayModule {
  collectArm(opts: {
    databaseUrl?: string; since: Date; until?: Date; key: string; label: string; variation: string | null;
    fingerprint: ReplayFingerprint; database?: string | null; capped?: boolean;
  }): Promise<ReplayArm>;
  assembleReplay(opts: {
    kind: Replay["kind"]; name: string; title: string; cluster: string | null; about: string; arms: ReplayArm[];
    matching?: ReplayMatching[] | null; scenario?: ReplayScenario | null; summary?: Record<string, unknown> | null; evalRunId?: string | null;
  }): Replay;
  writeReplay(runDir: string, replay: Replay): string;
}

const RUN_STARTED_AT = new Date();
const PERSONA_MODEL = process.env.PERSONA_MODEL ?? OPENROUTER_MODELS.flash;

/** Reputation each tier starts the run with (reputation-service thresholds: ≥50 standard, ≥80 trusted). */
const TIER_REPUTATION: Record<string, { score: number; accepted: number } | null> = {
  fresh: null,
  standard: { score: 65, accepted: 4 },
  trusted: { score: 88, accepted: 15 },
};

function describeDrain(stats: DrainStats): string {
  const acts = Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`);
  const errs = Object.values(stats.errors).reduce((a, b) => a + b, 0);
  return (acts.join(", ") || "nothing") + (errs ? `, ${errs} handler errors` : "") + (stats.capped ? " (CAPPED)" : "");
}

async function claimState(id: string): Promise<{ text: string; status: string | null }> {
  const [row] = await rawQuery<{ text: string; status: string | null }>(
    `SELECT c.text, a.status FROM claims c LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current WHERE c.id = $1`,
    [id]
  );
  return { text: row?.text ?? "", status: row?.status ?? null };
}

async function readReview(contributionId: string): Promise<ReviewOutcome | null> {
  const [r] = await rawQuery<{
    decision: string; confidence: number; reasoning: string; policy_citations: string[] | null;
    suspected_bad_faith: boolean; bad_faith_category: string | null;
  }>(
    `SELECT decision, confidence, reasoning, policy_citations, suspected_bad_faith, bad_faith_category
       FROM contribution_reviews WHERE contribution_id = $1 AND NOT superseded ORDER BY reviewed_at DESC LIMIT 1`,
    [contributionId]
  );
  return r
    ? { decision: r.decision, confidence: r.confidence, reasoning: r.reasoning, policyCitations: r.policy_citations ?? [], suspectedBadFaith: r.suspected_bad_faith, badFaithCategory: r.bad_faith_category }
    : null;
}

interface Session {
  entry: PersonaEntry;
  contributorId: string;
  reputationBefore: number;
  budget: ActionBudget;
  used: ActionBudget;
  exhausted: Set<string>;
  reads: PersonaRead[];
  contributions: PersonaContribution[];
  proposals: PersonaProposal[];
  findings: PersonaFinding[];
  toolErrors: Array<{ tool: string; error: string }>;
  before: Map<string, { text: string; status: string | null }>;
  runId: string | null;
  iterations: number;
  stopReason: string | null;
  closing: string | null;
}

function spend(s: Session, key: keyof ActionBudget): string | null {
  if (s.used[key] >= s.budget[key]) {
    s.exhausted.add(key);
    return `Budget exhausted: no ${key} left this session (${s.budget[key]} allowed). Finish with your closing account.`;
  }
  s.used[key]++;
  return null;
}

async function executePersonaTool(s: Session, name: string, input: Record<string, unknown>): Promise<string> {
  const allowed = personaToolNames(s.entry.kind) as readonly string[];
  if (!allowed.includes(name)) {
    s.toolErrors.push({ tool: name, error: "not a tool this persona holds" });
    return `Error: "${name}" is not available to you.`;
  }
  try {
    if (name === "search_claims" || name === "get_claim") {
      const refused = spend(s, "reads");
      if (refused) return refused;
      const out = (await executeGraphReadTool(name, input)) ?? JSON.stringify({ error: "no result" });
      let hits: number | null = null;
      try {
        const parsed = JSON.parse(out) as { count?: number; error?: string; claim?: unknown };
        hits = name === "search_claims" ? (parsed.count ?? 0) : parsed.claim ? 1 : 0;
      } catch { /* leave hits null */ }
      s.reads.push({ tool: name, target: name === "search_claims" ? String(input.query ?? "") : String(input.claim_id ?? ""), hits });
      return out;
    }
    if (name === "submit_contribution") {
      const refused = spend(s, "contributions");
      if (refused) return refused;
      const type = String(input.type ?? "") as ContributionType;
      const claimId = String(input.claim_id ?? "");
      const record: PersonaContribution = {
        contributionId: null,
        type,
        claimId,
        targetText: null,
        content: String(input.content ?? ""),
        evidenceUrls: Array.isArray(input.evidence_urls) ? input.evidence_urls.map(String) : [],
        proposedCanonicalForm: input.proposed_canonical_form ? String(input.proposed_canonical_form) : null,
        mergeTargetClaimId: input.merge_target_claim_id ? String(input.merge_target_claim_id) : null,
        error: null,
        reviewStatus: null,
        review: null,
        escalationReason: null,
        appeal: null,
        arbitration: null,
        claimChange: null,
      };
      s.contributions.push(record);
      if (!CONTRIBUTION_TYPES.includes(type)) {
        record.error = `unknown contribution type "${type}"`;
        return `Error: ${record.error}. Types: ${CONTRIBUTION_TYPES.join(", ")}.`;
      }
      const claim = await getClaimById(claimId);
      if (!claim || claim.state !== "active") {
        record.error = `no active claim with id "${claimId}"`;
        return `Error: ${record.error}. Use the id from search_claims or get_claim.`;
      }
      if (type === "propose_edit" && !record.proposedCanonicalForm) {
        record.error = "propose_edit needs proposed_canonical_form";
        return `Error: ${record.error}.`;
      }
      if (type === "propose_merge" && !record.mergeTargetClaimId) {
        record.error = "propose_merge needs merge_target_claim_id";
        return `Error: ${record.error}.`;
      }
      if (!record.content.trim()) {
        record.error = "content is empty";
        return `Error: ${record.error}.`;
      }
      record.targetText = claim.text;
      if (!s.before.has(claimId)) s.before.set(claimId, await claimState(claimId));
      const contribution = await createContribution({
        claimId,
        contributorId: s.contributorId,
        contributionType: type,
        content: record.content,
        evidenceUrls: record.evidenceUrls,
        mergeTargetClaimId: record.mergeTargetClaimId ?? undefined,
        proposedCanonicalForm: record.proposedCanonicalForm ?? undefined,
      });
      await enqueueContribution({ contributionId: contribution.id });
      record.contributionId = contribution.id;
      return JSON.stringify({ ok: true, contribution_id: contribution.id, status: "pending review", note: "The Contribution Reviewer will decide later; you will not see the decision in this session." });
    }
    if (name === "propose_claim") {
      const refused = spend(s, "proposals");
      if (refused) return refused;
      const record: PersonaProposal = {
        contributionId: null,
        claimText: String(input.claim_text ?? ""),
        argumentText: String(input.argument_text ?? ""),
        error: null,
        reviewStatus: null,
        review: null,
        createdClaimId: null,
      };
      s.proposals.push(record);
      if (!record.claimText.trim() || !record.argumentText.trim()) {
        record.error = "claim_text and argument_text are both required";
        return `Error: ${record.error}.`;
      }
      const contribution = await createClaimProposal({ claimText: record.claimText, argumentText: record.argumentText, contributorId: s.contributorId });
      record.contributionId = contribution.id;
      return JSON.stringify({ ok: true, contribution_id: contribution.id, status: "pending review", note: "If accepted, the claim is created and assessed; you will not see that in this session." });
    }
    if (name === "file_finding") {
      const refused = spend(s, "findings");
      if (refused) return refused;
      const severity = String(input.severity ?? "low");
      s.findings.push({
        persona: s.entry.key,
        severity: severity === "high" || severity === "medium" ? severity : "low",
        where: String(input.where ?? ""),
        what: String(input.what ?? ""),
        expected: String(input.expected ?? ""),
      });
      return JSON.stringify({ ok: true, note: "Recorded for the people who build the system." });
    }
    s.toolErrors.push({ tool: name, error: "unknown tool" });
    return `Error: unknown tool "${name}".`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.toolErrors.push({ tool: name, error: message });
    return `Error: ${message}`;
  }
}

function toolDefinitionsFor(entry: PersonaEntry) {
  const names = personaToolNames(entry.kind) as readonly string[];
  const reads = getGraphReadToolDefinitions().filter((t) => names.includes(t.name));
  const actions = personaActionToolDefinitions().filter((t) => names.includes(t.name));
  return [...reads, ...actions];
}

function pairAddendum(partner: Session | undefined): string | null {
  if (!partner) return null;
  const lines = [`Your other account, "${partner.entry.name}", already acted this session:`];
  for (const c of partner.contributions) {
    if (!c.contributionId) continue;
    lines.push(`- ${c.type} on claim ${c.claimId} ("${(c.targetText ?? "").slice(0, 80)}"): "${c.content.slice(0, 160)}"`);
  }
  for (const p of partner.proposals) {
    if (!p.contributionId) continue;
    lines.push(`- proposed the claim "${p.claimText.slice(0, 120)}"`);
  }
  if (lines.length === 1) lines.push(`- nothing that went through.`);
  return lines.join("\n");
}

async function runPersona(
  entry: PersonaEntry,
  cluster: string,
  clusterDescription: string | null,
  contributorId: string,
  reputationBefore: number,
  partner: Session | undefined
): Promise<Session> {
  const budget = parseBudget(entry.budget);
  const s: Session = {
    entry, contributorId, reputationBefore, budget,
    used: { reads: 0, contributions: 0, proposals: 0, findings: 0 },
    exhausted: new Set(), reads: [], contributions: [], proposals: [], findings: [], toolErrors: [],
    before: new Map(), runId: null, iterations: 0, stopReason: null, closing: null,
  };
  const system = buildPersonaSystemPrompt(entry, { cluster, clusterDescription });
  const opening = buildPersonaOpeningMessage(entry, pairAddendum(partner));
  const maxIterations = budgetIterations(budget);

  await withAgent("persona", async () => {
    s.runId = getUsageContext().runId ?? null;
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: opening }],
      tools: toolDefinitionsFor(entry),
      system,
      model: PERSONA_MODEL,
      maxTokens: 4096,
      maxIterations,
      executeTool: async (name, input) => {
        s.iterations++;
        return executePersonaTool(s, name, input);
      },
      iterationBudgetNotice: {
        warnWithin: 2,
        message: (remaining) => `You have ${remaining} turn(s) left. Finish what matters and write your closing account.`,
      },
    });
    s.stopReason = result.stopReason;
    const text = (result.rawContent as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n")
      .trim();
    s.closing = text || null;
  });
  return s;
}

/** One more turn in character: appeal the rejection, or let it go. */
async function writeAppeal(c: PersonaContribution, system: string): Promise<string | null> {
  const prompt =
    `Your ${c.type} on the claim "${c.targetText ?? c.claimId}" — you wrote: "${c.content}" — was rejected by the reviewer with this reasoning:\n\n` +
    `${c.review?.reasoning ?? "(no reasoning recorded)"}\n\n` +
    `You may appeal to an arbitrator. If this person would appeal, write the appeal in their own words (2–5 sentences, in character, no preamble). ` +
    `If they would let it go, reply with exactly NO_APPEAL.`;
  return withAgent("persona", async () => {
    const r = await complete({ messages: [{ role: "user", content: prompt }], system, model: PERSONA_MODEL, maxTokens: 1024 });
    const text = r.content.trim();
    if (!text || /^NO_APPEAL\b/.test(text)) return null;
    return text;
  });
}

async function main(): Promise<void> {
  assertCorpusDb();
  const cluster = positional(0);
  if (!cluster) {
    console.error("Usage: corpus:personas -- <cluster> [--personas=k1,k2] [--limit=N] [--dry-run] [--no-appeals]");
    process.exit(1);
  }
  const manifestPath = join(CORPUS_ROOT, "personas", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PersonaManifest;
  const problems = validateManifest(manifest);
  if (problems.length) {
    console.error("Manifest invalid:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  const only = argFlag("personas")?.split(",").map((k) => k.trim()).filter(Boolean);
  const limit = argFlag("limit") ? Number(argFlag("limit")) : undefined;
  let entries = personasForCluster(manifest, cluster, only);
  if (limit) entries = entries.slice(0, limit);
  if (entries.length === 0) throw new Error(`no persona in the manifest cares about "${cluster}"${only ? ` among ${only.join(",")}` : ""}`);

  let clusterDescription: string | null = null;
  try {
    clusterDescription = loadManifest(cluster).description;
  } catch { /* an unknown cluster name is allowed: the graph is what it is */ }

  const claimCount = (await rawQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM claims WHERE state = 'active'`))[0]?.n ?? 0;
  if (claimCount === 0) throw new Error("the corpus DB has no claims — run a corpus run for this cluster first");

  console.log(`\n=== personas: ${manifest.name} on ${cluster} — ${entries.length} persona(s) against ${claimCount} claims, model ${PERSONA_MODEL} ===`);
  for (const e of entries) {
    console.log(`  ${e.key.padEnd(26)} ${e.kind.padEnd(13)} ${e.tier.padEnd(9)} ${e.budget.padEnd(48)} ${e.tactic ?? ""}`);
  }
  if (hasFlag("dry-run")) {
    console.log(`\n--- system prompt for ${entries[0]!.key} ---\n`);
    console.log(buildPersonaSystemPrompt(entries[0]!, { cluster, clusterDescription }));
    console.log(`\n--- tools for ${entries[0]!.key}: ${toolDefinitionsFor(entries[0]!).map((t) => t.name).join(", ")}`);
    console.log("\n  --dry-run: nothing submitted.");
    return;
  }

  const trace: RunnerEvent[] = [];
  const sessions = new Map<string, Session>();

  console.log("\n--- sessions ---");
  for (const entry of entries) {
    const contributor = await getOrCreateContributor({
      externalId: `corpus:personas:${manifest.name}:${entry.key}`,
      displayName: `${entry.name} (persona)`,
    });
    const tier = TIER_REPUTATION[entry.tier];
    if (tier) {
      await rawQuery(
        `UPDATE contributors SET reputation_score = GREATEST(reputation_score, $2), contributions_accepted = GREATEST(contributions_accepted, $3) WHERE id = $1`,
        [contributor.id, tier.score, tier.accepted]
      );
    }
    const [rep] = await rawQuery<{ reputation_score: number }>(`SELECT reputation_score FROM contributors WHERE id = $1`, [contributor.id]);
    const partner = entry.pairWith ? sessions.get(entry.pairWith) : undefined;
    process.stdout.write(`  ${entry.key.padEnd(26)} `);
    const started = Date.now();
    try {
      const s = await runPersona(entry, cluster, clusterDescription, contributor.id, rep?.reputation_score ?? contributor.reputationScore, partner);
      sessions.set(entry.key, s);
      console.log(
        `reads ${s.reads.length} · contributions ${s.contributions.filter((c) => c.contributionId).length} · proposals ${s.proposals.filter((p) => p.contributionId).length} · findings ${s.findings.length}` +
          (s.exhausted.size ? ` · exhausted ${[...s.exhausted].join(",")}` : "") +
          ` · ${((Date.now() - started) / 1000).toFixed(0)}s`
      );
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      sessions.set(entry.key, {
        entry, contributorId: contributor.id, reputationBefore: rep?.reputation_score ?? 50, budget: parseBudget(entry.budget),
        used: { reads: 0, contributions: 0, proposals: 0, findings: 0 }, exhausted: new Set(), reads: [], contributions: [], proposals: [], findings: [],
        toolErrors: [{ tool: "(session)", error: err instanceof Error ? err.message : String(err) }],
        before: new Map(), runId: null, iterations: 0, stopReason: "error", closing: null,
      });
    }
  }

  console.log("\n--- draining: review, intake, escalation, notifications ---");
  const drain1 = await drainLocalQueues({ onEvent: (e) => trace.push(e) });
  console.log(`  ${describeDrain(drain1)}`);

  // Appeals, in character, for the personas whose style says they appeal.
  let appealsFiled = 0;
  if (!hasFlag("no-appeals")) {
    console.log("\n--- appeals ---");
    for (const s of sessions.values()) {
      if (!s.entry.appeals) continue;
      const system = buildPersonaSystemPrompt(s.entry, { cluster, clusterDescription });
      for (const c of s.contributions) {
        if (!c.contributionId) continue;
        const review = await getReviewForContribution(c.contributionId);
        if (!review || review.decision !== "reject") continue;
        c.review = await readReview(c.contributionId);
        let reasoning: string | null = null;
        try {
          reasoning = await writeAppeal(c, system);
        } catch (err) {
          s.toolErrors.push({ tool: "(appeal)", error: err instanceof Error ? err.message : String(err) });
        }
        if (!reasoning) {
          console.log(`  · ${s.entry.key}: ${c.type} rejected, let it go`);
          continue;
        }
        const appeal = await createAppeal({ contributionId: c.contributionId, originalReviewId: review.id, appellantId: s.contributorId, appealReasoning: reasoning });
        await enqueueArbitration({ contributionId: c.contributionId, trigger: "appeal", appealId: appeal.id });
        c.appeal = { id: appeal.id, status: "pending", reasoning };
        appealsFiled++;
        console.log(`  ↑ ${s.entry.key}: ${c.type} rejected, appeal ${appeal.id.slice(0, 8)} filed`);
      }
    }
    if (appealsFiled === 0) console.log("  (no appeal filed)");
    else {
      console.log("\n--- draining: arbitration ---");
      const drain2 = await drainLocalQueues({ onEvent: (e) => trace.push(e) });
      console.log(`  ${describeDrain(drain2)}`);
    }
  }

  // Collect what happened.
  const outcomes: PersonaOutcome[] = [];
  for (const s of sessions.values()) {
    for (const c of s.contributions) {
      if (!c.contributionId) continue;
      const [row] = await rawQuery<{ review_status: string; escalation_reason: string | null }>(`SELECT review_status, escalation_reason FROM contributions WHERE id = $1`, [c.contributionId]);
      c.reviewStatus = row?.review_status ?? null;
      c.escalationReason = row?.escalation_reason ?? null;
      c.review = await readReview(c.contributionId);
      if (c.appeal) {
        const [a] = await rawQuery<{ status: string }>(`SELECT status FROM appeals WHERE id = $1`, [c.appeal.id]);
        c.appeal.status = a?.status ?? c.appeal.status;
      }
      const [arb] = await rawQuery<{ outcome: string; decision: string; reasoning: string; suspected_bad_faith: boolean; human_review_recommended: boolean }>(
        `SELECT outcome, decision, reasoning, suspected_bad_faith, human_review_recommended FROM arbitration_results WHERE contribution_id = $1 ORDER BY arbitrated_at DESC LIMIT 1`,
        [c.contributionId]
      );
      c.arbitration = arb ? { outcome: arb.outcome, decision: arb.decision, reasoning: arb.reasoning, suspectedBadFaith: arb.suspected_bad_faith, humanReviewRecommended: arb.human_review_recommended } : null;
      const b = s.before.get(c.claimId);
      if (b) {
        const after = await claimState(c.claimId);
        c.claimChange = { textBefore: b.text, textAfter: after.text, statusBefore: b.status, statusAfter: after.status };
      }
    }
    for (const p of s.proposals) {
      if (!p.contributionId) continue;
      const [row] = await rawQuery<{ review_status: string; claim_id: string | null }>(`SELECT review_status, claim_id FROM contributions WHERE id = $1`, [p.contributionId]);
      p.reviewStatus = row?.review_status ?? null;
      p.createdClaimId = row?.claim_id ?? null;
      p.review = await readReview(p.contributionId);
    }
    const [rep] = await rawQuery<{ reputation_score: number; contribution_standing: string; is_suspended: boolean; bad_faith_flags: number }>(
      `SELECT reputation_score, contribution_standing, is_suspended, bad_faith_flags FROM contributors WHERE id = $1`,
      [s.contributorId]
    );
    let costMicroUsd: number | null = null;
    if (s.runId) {
      const [cost] = await rawQuery<{ micro: string | null }>(`SELECT SUM(cost_micro_usd) AS micro FROM llm_usage WHERE run_id = $1`, [s.runId]);
      costMicroUsd = cost?.micro != null ? Number(cost.micro) : 0;
    }
    outcomes.push({
      key: s.entry.key,
      name: s.entry.name,
      kind: s.entry.kind,
      tier: s.entry.tier,
      tactic: s.entry.tactic ?? null,
      runId: s.runId,
      model: PERSONA_MODEL,
      iterations: s.iterations,
      stopReason: s.stopReason,
      closing: s.closing,
      budget: s.budget,
      exhausted: [...s.exhausted],
      reads: s.reads,
      contributions: s.contributions,
      proposals: s.proposals,
      findings: s.findings,
      toolErrors: s.toolErrors,
      reputation: {
        before: s.reputationBefore,
        after: rep?.reputation_score ?? s.reputationBefore,
        standing: rep?.contribution_standing ?? "?",
        suspended: rep?.is_suspended ?? false,
        badFaithFlags: rep?.bad_faith_flags ?? 0,
      },
      costMicroUsd,
    });
  }

  const [cost] = await rawQuery<{ micro: string | null }>(`SELECT SUM(cost_micro_usd) AS micro FROM llm_usage WHERE created_at >= $1`, [RUN_STARTED_AT]);
  const totalCostMicroUsd = cost?.micro != null ? Number(cost.micro) : null;
  const triaged = triageFindings(outcomes.flatMap((o) => o.findings));
  const summary = summarizeOutcomes(outcomes, triaged);
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const dir = join(RUNS_ROOT, `personas-${cluster}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trace.jsonl"), trace.map((e) => JSON.stringify(e)).join("\n"));

  const cfg = loadConfig();
  const prompts = Object.fromEntries(entries.map((e) => [e.key, buildPersonaSystemPrompt(e, { cluster, clusterDescription })]));
  const report = {
    generatedAt,
    manifest: manifest.name,
    cluster,
    model: PERSONA_MODEL,
    summary,
    triaged,
    outcomes,
    /** The exact system prompt each persona was given, and the tools, so the record is complete. */
    prompts,
    tools: { read: getGraphReadToolDefinitions().filter((t) => t.name === "search_claims" || t.name === "get_claim"), action: personaActionToolDefinitions() },
    totalCostMicroUsd,
    triageNote: "A human triages these findings before any issue is opened.",
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "report.md"), renderReport({ manifest, cluster, outcomes, triaged, summary, totalCostMicroUsd, generatedAt }));

  console.log(`\n=== outcome ===`);
  console.log(`  reads ${summary.reads} · contributions ${summary.contributionsSubmitted} (${Object.entries(summary.contributionDecisions).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}) · proposals ${summary.proposalsSubmitted} (${Object.entries(summary.proposalDecisions).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
  console.log(`  findings ${summary.findings} in ${summary.findingClusters} cluster(s) · tool errors ${summary.toolErrors}`);
  for (const a of summary.adversarial) {
    console.log(`  adversarial ${a.key} (${a.tactic}): ${a.submitted} submitted, ${a.rejected} rejected, ${a.accepted} accepted, ${a.badFaithFlags} bad-faith flag(s), standing ${a.standing}${a.suspended ? " (suspended)" : ""}`);
  }
  console.log(`  persona spend ${summary.personaCostMicroUsd != null ? formatMicroUsd(summary.personaCostMicroUsd) : "n/a"} · whole run ${totalCostMicroUsd != null ? formatMicroUsd(totalCostMicroUsd) : "n/a"}`);
  console.log(`  report: ${join(dir, "report.md")}`);
  console.log(`  a human triages the findings before any issue is opened.`);

  let evalRunId: string | null = null;
  try {
    const [row] = await getDb()
      .insert(evalRuns)
      .values({
        cluster,
        kind: "personas",
        config: {
          pipelineEpoch: cfg.pipelineEpoch,
          gitCommit: gitCommit(),
          manifest: manifest.name,
          personas: entries.map((e) => e.key),
          models: { persona: PERSONA_MODEL, governance: cfg.governanceModel, arbitration: cfg.arbitrationModel, steward: cfg.stewardModel },
        },
        scorecard: report,
        runDir: dir,
      })
      .returning({ id: evalRuns.id });
    evalRunId = row?.id ?? null;
  } catch (err) {
    console.warn("[personas] eval-run registry write failed (report files are intact):", err instanceof Error ? err.message : err);
  }

  // The replay (#334, the evals page's "show me" half): built by replay.ts,
  // which is being written beside this driver — imported dynamically so this
  // driver runs without it and picks it up when it lands.
  try {
    // A non-literal specifier keeps tsc from resolving a module this branch may not have.
    const replayModule = "./replay.js";
    const replay = (await import(replayModule)) as ReplayModule;
    const fingerprint: ReplayFingerprint = {
      pipelineEpoch: cfg.pipelineEpoch ?? null,
      gitCommit: gitCommit(),
      profile: CORPUS_PROFILE,
      swap: null,
      order: null,
      models: { persona: PERSONA_MODEL, contribution_reviewer: cfg.governanceModel, dispute_arbitrator: cfg.arbitrationModel, steward: cfg.stewardModel },
      caps: {},
    };
    const arm = await replay.collectArm({
      databaseUrl: CORPUS_DATABASE_URL,
      since: RUN_STARTED_AT,
      key: "run",
      label: `${manifest.name} on ${cluster}`,
      variation: null,
      fingerprint,
      database: new URL(CORPUS_DATABASE_URL).pathname.replace(/^\//, ""),
      capped: drain1.capped,
    });
    const rec = replay.assembleReplay({
      kind: "personas",
      name: `personas-${cluster}-${stamp}`,
      title: `Personas: ${manifest.name} on ${cluster}`,
      cluster,
      about:
        `${entries.length} simulated users — readers, contributors, programmatic clients and an adversarial minority — ` +
        `each an LLM agent playing a manifest entry, reading the graph and submitting through the same path a user takes; ` +
        `then the real review, escalation and arbitration. The findings they filed are triaged for a human first.`,
      arms: [arm],
      scenario: {
        name: manifest.name,
        description: manifest.description ?? null,
        actors: entries.map((e) => ({ key: e.key, displayName: e.name, note: e.archetype, tier: e.tier, role: e.kind === "adversarial" ? "attacker" : "persona" })),
      },
      summary: summary as unknown as Record<string, unknown>,
      evalRunId,
    });
    const path = replay.writeReplay(dir, rec);
    console.log(`  replay: ${path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) console.log("  (no replay: scripts/corpus/replay.ts not present on this branch)");
    else console.warn("[personas] replay not written:", message);
  }
  console.log();
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
