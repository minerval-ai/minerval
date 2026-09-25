/**
 * Persona simulation (#334 S8, from #82), the pure half: the manifest's
 * shape and validation, the action budget, the findings triage, the run
 * summary and the report. personas.ts runs the personas; nothing here
 * touches a database or a model.
 */
import type { ContributionType } from "./contributions-lib.js";

export const PERSONA_KINDS = ["reader", "contributor", "programmatic", "adversarial"] as const;
export type PersonaKind = (typeof PERSONA_KINDS)[number];

export const PERSONA_TIERS = ["fresh", "standard", "trusted"] as const;
export type PersonaTier = (typeof PERSONA_TIERS)[number];

/** How an adversarial persona misbehaves; drives the adversarial section of the report. */
export const ADVERSARIAL_TACTICS = ["sea-lion", "spam", "sockpuppet", "prompt-injection"] as const;
export type AdversarialTactic = (typeof ADVERSARIAL_TACTICS)[number];

export interface PersonaEntry {
  key: string;
  name: string;
  kind: PersonaKind;
  /** One line: the archetype (#82's list), e.g. "journalist checking a quote". */
  archetype: string;
  goals: string[];
  style: string;
  tier: PersonaTier;
  /** "reads:6 contributions:2 proposals:1 findings:2" — see parseBudget. */
  budget: string;
  /** Clusters this persona cares about; "*" = any. */
  clusters: string[];
  /** Whether a rejected contribution is appealed with the persona's own reasoning. */
  appeals?: boolean;
  /** What is on the persona's mind as it arrives (readers "arrive with a question"). */
  opening?: string;
  /** Sockpuppet pair: the key of the OTHER account this persona also operates; the pair runs in manifest order. */
  pairWith?: string;
  /** Adversarial only. */
  tactic?: AdversarialTactic;
}

export interface PersonaManifest {
  name: string;
  description?: string;
  personas: PersonaEntry[];
}

export interface ActionBudget {
  reads: number;
  contributions: number;
  proposals: number;
  findings: number;
}

export const BUDGET_KEYS = ["reads", "contributions", "proposals", "findings"] as const;

/**
 * Parse "reads:6 contributions:2 proposals:1 findings:2". Missing keys are
 * 0; an unknown key or a non-integer throws, so a manifest typo fails at
 * validation rather than silently giving a persona no budget.
 */
export function parseBudget(raw: string): ActionBudget {
  const budget: ActionBudget = { reads: 0, contributions: 0, proposals: 0, findings: 0 };
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = /^([a-z]+):(\d+)$/.exec(token);
    if (!m) throw new Error(`budget token "${token}" is not <key>:<n>`);
    const key = m[1] as keyof ActionBudget;
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) throw new Error(`budget key "${key}" unknown (${BUDGET_KEYS.join(", ")})`);
    budget[key] = Number(m[2]);
  }
  return budget;
}

/** Tool-loop iterations a budget needs: every budgeted action, plus slack for refusals and the closing turn. */
export function budgetIterations(b: ActionBudget, slack = 4): number {
  return b.reads + b.contributions + b.proposals + b.findings + slack;
}

/** Structural validation; returns human-readable problems (empty = valid). */
export function validateManifest(m: PersonaManifest): string[] {
  const problems: string[] = [];
  if (!m.name) problems.push("manifest needs a name");
  const keys = new Set<string>();
  for (const p of m.personas ?? []) {
    const where = `persona "${p.key ?? "?"}"`;
    if (!p.key) problems.push("a persona is missing a key");
    else if (keys.has(p.key)) problems.push(`duplicate key ${p.key}`);
    keys.add(p.key);
    if (!p.name) problems.push(`${where}: name required`);
    if (!PERSONA_KINDS.includes(p.kind)) problems.push(`${where}: unknown kind "${p.kind}"`);
    if (!p.archetype) problems.push(`${where}: archetype required`);
    if (!Array.isArray(p.goals) || p.goals.length === 0) problems.push(`${where}: at least one goal`);
    if (!p.style) problems.push(`${where}: style required`);
    if (!PERSONA_TIERS.includes(p.tier)) problems.push(`${where}: unknown tier "${p.tier}"`);
    if (!Array.isArray(p.clusters) || p.clusters.length === 0) problems.push(`${where}: at least one cluster (or "*")`);
    try {
      const b = parseBudget(p.budget ?? "");
      if (b.reads + b.contributions + b.proposals + b.findings === 0) problems.push(`${where}: budget allows no action`);
      if (p.kind === "programmatic" && (b.contributions > 0 || b.proposals > 0)) problems.push(`${where}: programmatic clients only read and report`);
      if (p.kind === "reader" && b.contributions > 0) problems.push(`${where}: readers do not contribute against claims (they may propose)`);
    } catch (err) {
      problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (p.kind === "adversarial" && !p.tactic) problems.push(`${where}: adversarial personas name a tactic`);
    if (p.tactic && !ADVERSARIAL_TACTICS.includes(p.tactic)) problems.push(`${where}: unknown tactic "${p.tactic}"`);
    if (p.tactic && p.kind !== "adversarial") problems.push(`${where}: only adversarial personas carry a tactic`);
  }
  for (const p of m.personas ?? []) {
    if (p.pairWith) {
      const other = (m.personas ?? []).find((q) => q.key === p.pairWith);
      if (!other) problems.push(`persona "${p.key}": pairWith "${p.pairWith}" not in manifest`);
      else if (other.pairWith !== p.key) problems.push(`persona "${p.key}": pair is not mutual`);
    }
  }
  if ((m.personas?.length ?? 0) === 0) problems.push("manifest has no personas");
  const adversarial = (m.personas ?? []).filter((p) => p.kind === "adversarial").length;
  if (adversarial > 0 && adversarial * 2 > (m.personas?.length ?? 0)) problems.push("the adversarial minority is not a minority");
  return problems;
}

/** The personas that care about a cluster, in manifest order. */
export function personasForCluster(m: PersonaManifest, cluster: string, only?: string[]): PersonaEntry[] {
  const wanted = only ? new Set(only) : null;
  return m.personas.filter((p) => (p.clusters.includes("*") || p.clusters.includes(cluster)) && (!wanted || wanted.has(p.key)));
}

// ---------------------------------------------------------------------------
// What a persona did and what happened
// ---------------------------------------------------------------------------

export type FindingSeverity = "low" | "medium" | "high";

export interface PersonaFinding {
  persona: string;
  severity: FindingSeverity;
  where: string;
  what: string;
  expected: string;
}

export interface ReviewOutcome {
  decision: string;
  confidence: number;
  reasoning: string;
  policyCitations: string[];
  suspectedBadFaith: boolean;
  badFaithCategory: string | null;
}

export interface PersonaContribution {
  contributionId: string | null;
  type: ContributionType;
  claimId: string;
  targetText: string | null;
  content: string;
  evidenceUrls: string[];
  proposedCanonicalForm: string | null;
  mergeTargetClaimId: string | null;
  /** Why the submission itself failed, when it did (service error, unknown claim). */
  error: string | null;
  reviewStatus: string | null;
  review: ReviewOutcome | null;
  escalationReason: string | null;
  appeal: { id: string; status: string; reasoning: string } | null;
  arbitration: { outcome: string; decision: string; reasoning: string; suspectedBadFaith: boolean; humanReviewRecommended: boolean } | null;
  claimChange: { textBefore: string; textAfter: string; statusBefore: string | null; statusAfter: string | null } | null;
}

export interface PersonaProposal {
  contributionId: string | null;
  claimText: string;
  argumentText: string;
  error: string | null;
  reviewStatus: string | null;
  review: ReviewOutcome | null;
  /** The claim the intake path created on acceptance, if any. */
  createdClaimId: string | null;
}

export interface PersonaRead {
  tool: "search_claims" | "get_claim";
  /** The query, or the claim id. */
  target: string;
  /** Result count for a search; whether the claim was found for a read. */
  hits: number | null;
}

export interface PersonaOutcome {
  key: string;
  name: string;
  kind: PersonaKind;
  tier: PersonaTier;
  tactic: AdversarialTactic | null;
  /** agent_runs.id of the persona's session, when tracing was on. */
  runId: string | null;
  model: string;
  iterations: number;
  stopReason: string | null;
  /** The persona's closing account, verbatim. */
  closing: string | null;
  budget: ActionBudget;
  /** Budget keys the persona ran out of. */
  exhausted: string[];
  reads: PersonaRead[];
  contributions: PersonaContribution[];
  proposals: PersonaProposal[];
  findings: PersonaFinding[];
  /** Calls the persona made that no tool answered (unknown tool, malformed input). */
  toolErrors: Array<{ tool: string; error: string }>;
  reputation: { before: number; after: number; standing: string; suspended: boolean; badFaithFlags: number };
  /** The persona's own LLM spend (its run), not the review it caused. */
  costMicroUsd: number | null;
}

// ---------------------------------------------------------------------------
// Findings triage
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "is", "was", "it", "this", "that", "with",
  "not", "no", "but", "be", "as", "by", "from", "are", "were", "have", "has", "had", "i", "my", "me", "there",
]);

/** Token set of a finding's location + description: lowercase, alphanumeric, stopwords and short tokens dropped. */
export function findingTokens(f: Pick<PersonaFinding, "where" | "what">): Set<string> {
  const tokens = `${f.where} ${f.what}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^[0-9a-f]{8,}$/.test(t));
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3 };

export interface TriagedFinding {
  representative: PersonaFinding;
  members: PersonaFinding[];
  count: number;
  personas: string[];
  severity: FindingSeverity;
  /** severity weight × count — the ranking key. */
  score: number;
}

/**
 * Deduplicate findings by where+what similarity (greedy: a finding joins
 * the first cluster whose representative is at least `similarity` Jaccard
 * away, else opens one) and rank by severity × count. This is a reading
 * aid for the human who triages before any issue is opened — not a filing
 * mechanism.
 */
export function triageFindings(findings: PersonaFinding[], opts: { similarity?: number } = {}): TriagedFinding[] {
  const threshold = opts.similarity ?? 0.4;
  const clusters: Array<TriagedFinding & { tokens: Set<string> }> = [];
  for (const f of findings) {
    const tokens = findingTokens(f);
    const home = clusters.find((c) => jaccard(c.tokens, tokens) >= threshold);
    if (home) {
      home.members.push(f);
      continue;
    }
    clusters.push({ representative: f, members: [f], count: 0, personas: [], severity: f.severity, score: 0, tokens });
  }
  const out: TriagedFinding[] = clusters.map((c) => {
    const severity = c.members.reduce<FindingSeverity>(
      (max, m) => (SEVERITY_WEIGHT[m.severity] > SEVERITY_WEIGHT[max] ? m.severity : max),
      "low"
    );
    const personas = [...new Set(c.members.map((m) => m.persona))];
    return {
      representative: c.representative,
      members: c.members,
      count: c.members.length,
      personas,
      severity,
      score: SEVERITY_WEIGHT[severity] * c.members.length,
    };
  });
  out.sort((a, b) => b.score - a.score || b.count - a.count);
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface AdversarialOutcome {
  key: string;
  name: string;
  tactic: AdversarialTactic | null;
  submitted: number;
  accepted: number;
  rejected: number;
  escalated: number;
  pending: number;
  badFaithFlags: number;
  appeals: number;
  appealsUpheld: number;
  standing: string;
  suspended: boolean;
  reputationDelta: number;
  /** Anything of theirs that landed in the graph — what a defence is measured against. */
  landed: Array<{ contributionId: string | null; type: string; claimId: string | null }>;
}

export interface PersonaRunSummary {
  personas: number;
  byKind: Record<string, number>;
  reads: number;
  contributionsSubmitted: number;
  contributionDecisions: Record<string, number>;
  proposalsSubmitted: number;
  proposalDecisions: Record<string, number>;
  findings: number;
  findingClusters: number;
  findingsBySeverity: Record<string, number>;
  toolErrors: number;
  exhausted: Array<{ persona: string; keys: string[] }>;
  adversarial: AdversarialOutcome[];
  personaCostMicroUsd: number | null;
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function summarizeAdversarial(o: PersonaOutcome): AdversarialOutcome {
  const r: AdversarialOutcome = {
    key: o.key,
    name: o.name,
    tactic: o.tactic,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    escalated: 0,
    pending: 0,
    badFaithFlags: 0,
    appeals: 0,
    appealsUpheld: 0,
    standing: o.reputation.standing,
    suspended: o.reputation.suspended,
    reputationDelta: o.reputation.after - o.reputation.before,
    landed: [],
  };
  const items: Array<{ contributionId: string | null; type: string; claimId: string | null; review: ReviewOutcome | null; reviewStatus: string | null; appeal: PersonaContribution["appeal"]; arbitration: PersonaContribution["arbitration"] }> = [
    ...o.contributions.filter((c) => c.contributionId).map((c) => ({ contributionId: c.contributionId, type: c.type, claimId: c.claimId, review: c.review, reviewStatus: c.reviewStatus, appeal: c.appeal, arbitration: c.arbitration })),
    ...o.proposals.filter((p) => p.contributionId).map((p) => ({ contributionId: p.contributionId, type: "propose_claim", claimId: p.createdClaimId, review: p.review, reviewStatus: p.reviewStatus, appeal: null, arbitration: null })),
  ];
  for (const it of items) {
    r.submitted++;
    const decision = it.review?.decision;
    const final = it.arbitration?.decision ?? decision;
    if (!it.review) r.pending++;
    else if (decision === "escalate" || it.reviewStatus === "escalated") r.escalated++;
    if (final === "accept") {
      r.accepted++;
      r.landed.push({ contributionId: it.contributionId, type: it.type, claimId: it.claimId });
    } else if (final === "reject") r.rejected++;
    if (it.review?.suspectedBadFaith || it.arbitration?.suspectedBadFaith) r.badFaithFlags++;
    if (it.appeal) r.appeals++;
    if (it.appeal && it.arbitration && it.arbitration.decision === "accept") r.appealsUpheld++;
  }
  return r;
}

export function summarizeOutcomes(outcomes: PersonaOutcome[], triaged: TriagedFinding[]): PersonaRunSummary {
  const s: PersonaRunSummary = {
    personas: outcomes.length,
    byKind: {},
    reads: 0,
    contributionsSubmitted: 0,
    contributionDecisions: {},
    proposalsSubmitted: 0,
    proposalDecisions: {},
    findings: 0,
    findingClusters: triaged.length,
    findingsBySeverity: {},
    toolErrors: 0,
    exhausted: [],
    adversarial: [],
    personaCostMicroUsd: null,
  };
  let cost = 0;
  let costKnown = false;
  for (const o of outcomes) {
    count(s.byKind, o.kind);
    s.reads += o.reads.length;
    for (const c of o.contributions) {
      if (!c.contributionId) continue;
      s.contributionsSubmitted++;
      count(s.contributionDecisions, c.review?.decision ?? "pending");
    }
    for (const p of o.proposals) {
      if (!p.contributionId) continue;
      s.proposalsSubmitted++;
      count(s.proposalDecisions, p.review?.decision ?? "pending");
    }
    for (const f of o.findings) {
      s.findings++;
      count(s.findingsBySeverity, f.severity);
    }
    s.toolErrors += o.toolErrors.length;
    if (o.exhausted.length) s.exhausted.push({ persona: o.key, keys: o.exhausted });
    if (o.kind === "adversarial") s.adversarial.push(summarizeAdversarial(o));
    if (o.costMicroUsd != null) {
      cost += o.costMicroUsd;
      costKnown = true;
    }
  }
  s.personaCostMicroUsd = costKnown ? cost : null;
  return s;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtUsd(micro: number | null): string {
  return micro == null ? "n/a" : `$${(micro / 1_000_000).toFixed(4)}`;
}

function short(s: string | null | undefined, n = 90): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function kv(map: Record<string, number>): string {
  const e = Object.entries(map);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

export function renderReport(input: {
  manifest: PersonaManifest;
  cluster: string;
  outcomes: PersonaOutcome[];
  triaged: TriagedFinding[];
  summary: PersonaRunSummary;
  totalCostMicroUsd: number | null;
  generatedAt: string;
}): string {
  const { outcomes, triaged, summary } = input;
  const L: string[] = [];
  L.push(`# Persona simulation — ${input.manifest.name} on ${input.cluster}`);
  L.push("");
  L.push(`Generated ${input.generatedAt}. ${summary.personas} persona(s) (${kv(summary.byKind)}), each an LLM agent playing a manifest entry against the graph in the corpus DB, through the same service path a user takes. Every contribution went through the real Contribution Reviewer; rejections that carried an appeal went to the real Dispute Arbitrator.`);
  L.push("");
  L.push(`## Summary`);
  L.push("");
  L.push(`- reads ${summary.reads} · contributions ${summary.contributionsSubmitted} (${kv(summary.contributionDecisions)}) · proposed claims ${summary.proposalsSubmitted} (${kv(summary.proposalDecisions)})`);
  L.push(`- findings ${summary.findings} (${kv(summary.findingsBySeverity)}) in ${summary.findingClusters} cluster(s) after dedupe · tool errors ${summary.toolErrors}`);
  if (summary.exhausted.length) L.push(`- budget exhausted: ${summary.exhausted.map((e) => `${e.persona} (${e.keys.join(", ")})`).join("; ")}`);
  L.push(`- persona spend ${fmtUsd(summary.personaCostMicroUsd)} · whole run (personas + review + arbitration + stewardship) ${fmtUsd(input.totalCostMicroUsd)}`);
  L.push("");

  L.push(`## Findings, triaged`);
  L.push("");
  L.push(`Deduplicated by where+what similarity and ranked by severity × count. **A human reads this list before any issue is opened** — a finding is one simulated visitor's experience, not a confirmed defect, and several personas hitting the same wall is the signal worth chasing.`);
  L.push("");
  if (triaged.length === 0) L.push(`_No findings filed._`);
  for (const [i, t] of triaged.entries()) {
    L.push(`### ${i + 1}. [${t.severity}] ${short(t.representative.where, 80)} — ×${t.count} (${t.personas.join(", ")})`);
    L.push("");
    L.push(`- **what:** ${t.representative.what}`);
    L.push(`- **expected:** ${t.representative.expected}`);
    if (t.members.length > 1) {
      L.push(`- also reported as:`);
      for (const m of t.members.slice(1)) L.push(`  - (${m.persona}, ${m.severity}) ${short(m.what, 160)}`);
    }
    L.push("");
  }

  const adversarial = summary.adversarial;
  L.push(`## The adversarial minority`);
  L.push("");
  if (adversarial.length === 0) L.push(`_No adversarial persona in this run._`);
  else {
    L.push(`| persona | tactic | submitted | rejected | accepted | escalated | bad-faith flags | appeals (upheld) | standing | Δ reputation |`);
    L.push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const a of adversarial) {
      L.push(`| ${a.name} | ${a.tactic ?? ""} | ${a.submitted} | ${a.rejected} | ${a.accepted} | ${a.escalated} | ${a.badFaithFlags} | ${a.appeals} (${a.appealsUpheld}) | ${a.standing}${a.suspended ? ", suspended" : ""} | ${a.reputationDelta >= 0 ? "+" : ""}${a.reputationDelta.toFixed(1)} |`);
    }
    L.push("");
    for (const a of adversarial) {
      if (a.landed.length) {
        L.push(`**${a.name} got something in:** ${a.landed.map((l) => `${l.type} ${l.contributionId?.slice(0, 8) ?? "?"}${l.claimId ? ` on ${l.claimId.slice(0, 8)}` : ""}`).join(", ")} — read those reviews below.`);
      }
    }
    L.push("");
  }

  L.push(`## Per persona`);
  L.push("");
  for (const o of outcomes) {
    L.push(`### ${o.name} (\`${o.key}\`, ${o.kind}, ${o.tier}${o.tactic ? `, ${o.tactic}` : ""})`);
    L.push("");
    L.push(`- model ${o.model} · ${o.iterations} turn(s) · stop ${o.stopReason ?? "?"} · run ${o.runId ?? "untraced"} · cost ${fmtUsd(o.costMicroUsd)}`);
    L.push(`- reputation ${o.reputation.before} → ${o.reputation.after} (${o.reputation.standing}${o.reputation.suspended ? ", suspended" : ""}${o.reputation.badFaithFlags ? `, ${o.reputation.badFaithFlags} bad-faith flag(s)` : ""})`);
    if (o.exhausted.length) L.push(`- ran out of: ${o.exhausted.join(", ")}`);
    if (o.reads.length) {
      L.push(`- reads (${o.reads.length}): ${o.reads.map((r) => `${r.tool === "search_claims" ? `search "${short(r.target, 50)}"` : `claim ${r.target.slice(0, 8)}`}${r.hits != null ? ` → ${r.hits}` : ""}`).join("; ")}`);
    }
    for (const c of o.contributions) {
      L.push("");
      L.push(`**${c.type}** on ${c.claimId.slice(0, 8)} "${short(c.targetText, 80)}"${c.contributionId ? ` — contribution ${c.contributionId.slice(0, 8)}` : ""}`);
      L.push("");
      L.push(`> ${c.content.replace(/\n/g, "\n> ")}`);
      if (c.proposedCanonicalForm) L.push(`> \n> proposed wording: ${c.proposedCanonicalForm}`);
      if (c.evidenceUrls.length) L.push(`> \n> evidence: ${c.evidenceUrls.join(", ")}`);
      L.push("");
      if (c.error) L.push(`- submission failed: ${c.error}`);
      if (c.review) {
        L.push(`- review: **${c.review.decision}** (confidence ${c.review.confidence.toFixed(2)}${c.review.suspectedBadFaith ? `, bad faith: ${c.review.badFaithCategory ?? "unspecified"}` : ""}${c.review.policyCitations.length ? `; cites ${c.review.policyCitations.join(", ")}` : ""})`);
        L.push(`  > ${c.review.reasoning.replace(/\n/g, "\n  > ")}`);
      } else if (c.contributionId) L.push(`- review: pending (${c.reviewStatus ?? "?"})`);
      if (c.escalationReason) L.push(`- escalated: ${c.escalationReason}`);
      if (c.appeal) {
        L.push(`- appeal ${c.appeal.id.slice(0, 8)} (${c.appeal.status}): "${short(c.appeal.reasoning, 200)}"`);
      }
      if (c.arbitration) {
        L.push(`- arbitration: **${c.arbitration.outcome} → ${c.arbitration.decision}**${c.arbitration.suspectedBadFaith ? " (bad faith)" : ""}${c.arbitration.humanReviewRecommended ? " (human review recommended)" : ""}`);
        L.push(`  > ${c.arbitration.reasoning.replace(/\n/g, "\n  > ")}`);
      }
      if (c.claimChange && (c.claimChange.textBefore !== c.claimChange.textAfter || c.claimChange.statusBefore !== c.claimChange.statusAfter)) {
        L.push(`- the claim changed: status ${c.claimChange.statusBefore ?? "—"} → ${c.claimChange.statusAfter ?? "—"}${c.claimChange.textBefore !== c.claimChange.textAfter ? `; text "${short(c.claimChange.textBefore, 60)}" → "${short(c.claimChange.textAfter, 60)}"` : ""}`);
      }
    }
    for (const p of o.proposals) {
      L.push("");
      L.push(`**propose_claim** "${p.claimText}"${p.contributionId ? ` — contribution ${p.contributionId.slice(0, 8)}` : ""}`);
      L.push("");
      L.push(`> ${p.argumentText.replace(/\n/g, "\n> ")}`);
      L.push("");
      if (p.error) L.push(`- submission failed: ${p.error}`);
      if (p.review) {
        L.push(`- review: **${p.review.decision}** (confidence ${p.review.confidence.toFixed(2)}${p.review.suspectedBadFaith ? ", bad faith" : ""})${p.createdClaimId ? ` → claim ${p.createdClaimId.slice(0, 8)} created` : ""}`);
        L.push(`  > ${p.review.reasoning.replace(/\n/g, "\n  > ")}`);
      } else if (p.contributionId) L.push(`- review: pending (${p.reviewStatus ?? "?"})`);
    }
    for (const f of o.findings) {
      L.push("");
      L.push(`**finding [${f.severity}]** at ${f.where}: ${f.what} — expected: ${f.expected}`);
    }
    if (o.toolErrors.length) {
      L.push("");
      L.push(`- tool errors: ${o.toolErrors.map((e) => `${e.tool}: ${short(e.error, 80)}`).join("; ")}`);
    }
    if (o.closing) {
      L.push("");
      L.push(`_Closing account:_`);
      L.push("");
      L.push(`> ${o.closing.replace(/\n/g, "\n> ")}`);
    }
    L.push("");
  }
  return L.join("\n");
}
