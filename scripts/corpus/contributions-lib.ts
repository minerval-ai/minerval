/**
 * Contribution driver, the pure half (#334 L1): scenario validation and the
 * report's summary. contributions.ts does the submitting and draining.
 */

export const CONTRIBUTION_TYPES = [
  "challenge",
  "support",
  "propose_merge",
  "propose_split",
  "propose_edit",
  "add_instance",
  "propose_argument",
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

export interface ScenarioContributor {
  key: string;
  displayName: string;
  note?: string;
}

export interface ScenarioContribution {
  id: string;
  contributor: string;
  type: ContributionType;
  target: { query: string };
  mergeTarget?: { query: string };
  content: string;
  proposedCanonicalForm?: string;
  evidenceUrls?: string[];
  appealIfRejected?: string;
  expect?: string;
}

export interface Scenario {
  scenario: string;
  cluster: string;
  description?: string;
  contributors: ScenarioContributor[];
  contributions: ScenarioContribution[];
}

/** Structural validation; returns human-readable problems (empty = valid). */
export function validateScenario(s: Scenario): string[] {
  const problems: string[] = [];
  if (!s.scenario) problems.push("scenario needs a name");
  if (!s.cluster) problems.push("scenario needs a cluster");
  const personas = new Set<string>();
  for (const c of s.contributors ?? []) {
    if (!c.key || !c.displayName) problems.push(`contributor ${c.key ?? "?"}: key and displayName required`);
    if (personas.has(c.key)) problems.push(`duplicate contributor key ${c.key}`);
    personas.add(c.key);
  }
  const ids = new Set<string>();
  for (const c of s.contributions ?? []) {
    const where = `contribution "${c.id ?? "?"}"`;
    if (!c.id) problems.push("a contribution is missing an id");
    else if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!personas.has(c.contributor)) problems.push(`${where}: unknown contributor "${c.contributor}"`);
    if (!CONTRIBUTION_TYPES.includes(c.type)) problems.push(`${where}: unknown type "${c.type}"`);
    if (!c.target?.query) problems.push(`${where}: target.query required`);
    if (!c.content) problems.push(`${where}: content required`);
    if (c.type === "propose_merge" && !c.mergeTarget?.query) problems.push(`${where}: propose_merge needs mergeTarget.query`);
    if (c.type === "propose_edit" && !c.proposedCanonicalForm) problems.push(`${where}: propose_edit needs proposedCanonicalForm`);
    for (const u of c.evidenceUrls ?? []) {
      if (!/^https?:\/\//.test(u)) problems.push(`${where}: evidence url "${u}" is not http(s)`);
    }
  }
  if ((s.contributions?.length ?? 0) === 0) problems.push("scenario has no contributions");
  return problems;
}

export interface ContributionOutcome {
  id: string;
  type: ContributionType;
  contributor: string;
  targetClaimId: string | null;
  targetText: string | null;
  contributionId: string | null;
  reviewStatus: string | null;
  review: {
    decision: string;
    confidence: number;
    reasoning: string;
    policyCitations: string[];
    suspectedBadFaith: boolean;
    badFaithCategory: string | null;
  } | null;
  escalationReason: string | null;
  appeal: { id: string; status: string } | null;
  arbitration: {
    outcome: string;
    decision: string;
    reasoning: string;
    suspectedBadFaith: boolean;
    humanReviewRecommended: boolean;
  } | null;
  claimChange: { textBefore: string; textAfter: string; statusBefore: string | null; statusAfter: string | null } | null;
  expect?: string;
}

export interface ContributionSummary {
  submitted: number;
  reviewed: number;
  decisions: Record<string, number>;
  decisionsByType: Record<string, Record<string, number>>;
  escalated: number;
  badFaithFlags: number;
  appealsFiled: number;
  arbitrated: number;
  arbitrationOutcomes: Record<string, number>;
  humanReviewRecommended: number;
  claimsChanged: number;
  unreviewed: string[];
}

export function summarizeOutcomes(outcomes: ContributionOutcome[]): ContributionSummary {
  const decisions: Record<string, number> = {};
  const decisionsByType: Record<string, Record<string, number>> = {};
  const arbitrationOutcomes: Record<string, number> = {};
  let reviewed = 0;
  let escalated = 0;
  let badFaith = 0;
  let appeals = 0;
  let arbitrated = 0;
  let human = 0;
  let changed = 0;
  const unreviewed: string[] = [];
  for (const o of outcomes) {
    if (o.review) {
      reviewed++;
      decisions[o.review.decision] = (decisions[o.review.decision] ?? 0) + 1;
      const byType = (decisionsByType[o.type] ??= {});
      byType[o.review.decision] = (byType[o.review.decision] ?? 0) + 1;
      if (o.review.suspectedBadFaith) badFaith++;
    } else if (o.contributionId) {
      unreviewed.push(o.id);
    }
    if (o.reviewStatus === "escalated" || o.review?.decision === "escalate") escalated++;
    if (o.appeal) appeals++;
    if (o.arbitration) {
      arbitrated++;
      arbitrationOutcomes[o.arbitration.outcome] = (arbitrationOutcomes[o.arbitration.outcome] ?? 0) + 1;
      if (o.arbitration.humanReviewRecommended) human++;
      if (o.arbitration.suspectedBadFaith) badFaith++;
    }
    if (o.claimChange && (o.claimChange.textBefore !== o.claimChange.textAfter || o.claimChange.statusBefore !== o.claimChange.statusAfter)) {
      changed++;
    }
  }
  return {
    submitted: outcomes.filter((o) => o.contributionId).length,
    reviewed,
    decisions,
    decisionsByType,
    escalated,
    badFaithFlags: badFaith,
    appealsFiled: appeals,
    arbitrated,
    arbitrationOutcomes,
    humanReviewRecommended: human,
    claimsChanged: changed,
    unreviewed,
  };
}

export function renderReport(input: {
  scenario: Scenario;
  outcomes: ContributionOutcome[];
  summary: ContributionSummary;
  costMicroUsd: number | null;
  reputation: Array<{ key: string; displayName: string; before: number; after: number; standing: string }>;
  generatedAt: string;
}): string {
  const { scenario, outcomes, summary } = input;
  const o: string[] = [];
  const w = (l = "") => o.push(l);
  const usd = (m: number | null) => (m === null ? "n/a" : `$${(m / 1_000_000).toFixed(4)}`);
  w(`# Contribution scenario — ${scenario.scenario}`);
  w();
  w(`_generated ${input.generatedAt} · cluster \`${scenario.cluster}\` · metered cost ${usd(input.costMicroUsd)}_`);
  w();
  w(`## Summary`);
  w();
  w(`| | |`);
  w(`|---|---|`);
  w(`| submitted / reviewed | ${summary.submitted} / ${summary.reviewed} |`);
  w(`| decisions | ${Object.entries(summary.decisions).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`);
  w(`| escalated | ${summary.escalated} |`);
  w(`| bad-faith findings | ${summary.badFaithFlags} |`);
  w(`| appeals filed / arbitrated | ${summary.appealsFiled} / ${summary.arbitrated} |`);
  w(`| arbitration outcomes | ${Object.entries(summary.arbitrationOutcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`);
  w(`| human review recommended | ${summary.humanReviewRecommended} |`);
  w(`| targeted claims changed | ${summary.claimsChanged} |`);
  if (summary.unreviewed.length) w(`| unreviewed (still pending) | ${summary.unreviewed.join(", ")} |`);
  w();
  w(`### Decisions by type`);
  w();
  w(`| type | decisions |`);
  w(`|---|---|`);
  for (const [t, d] of Object.entries(summary.decisionsByType)) {
    w(`| ${t} | ${Object.entries(d).map(([k, v]) => `${k} ${v}`).join(", ")} |`);
  }
  w();
  w(`### Personas`);
  w();
  w(`| persona | reputation before → after | standing |`);
  w(`|---|---|---|`);
  for (const r of input.reputation) w(`| ${r.displayName} (${r.key}) | ${r.before} → ${r.after} | ${r.standing} |`);
  w();
  w(`## Contributions`);
  for (const c of outcomes) {
    w();
    w(`### ${c.id} — ${c.type} by ${c.contributor}`);
    w();
    w(`**Target:** ${c.targetText ?? "(unresolved)"}${c.targetClaimId ? ` (\`${c.targetClaimId.slice(0, 8)}\`)` : ""}`);
    if (c.expect) w(`**Expect (orienting):** ${c.expect}`);
    w();
    if (!c.contributionId) {
      w(`_not submitted_`);
      continue;
    }
    if (c.review) {
      w(`**Review:** ${c.review.decision} (confidence ${c.review.confidence.toFixed(2)})` +
        (c.review.suspectedBadFaith ? ` · **bad faith: ${c.review.badFaithCategory ?? "flagged"}**` : "") +
        (c.review.policyCitations.length ? ` · cites ${c.review.policyCitations.join(", ")}` : ""));
      w();
      w(`> ${c.review.reasoning.split("\n").join("\n> ")}`);
    } else {
      w(`**Review:** none recorded (status ${c.reviewStatus ?? "?"})`);
    }
    if (c.escalationReason) {
      w();
      w(`**Escalated:** ${c.escalationReason}`);
    }
    if (c.appeal) {
      w();
      w(`**Appeal:** filed (${c.appeal.status})`);
    }
    if (c.arbitration) {
      w();
      w(`**Arbitration:** ${c.arbitration.outcome} — ${c.arbitration.decision}` +
        (c.arbitration.suspectedBadFaith ? " · **bad faith**" : "") +
        (c.arbitration.humanReviewRecommended ? " · human review recommended" : ""));
      w();
      w(`> ${c.arbitration.reasoning.split("\n").join("\n> ")}`);
    }
    if (c.claimChange && (c.claimChange.textBefore !== c.claimChange.textAfter || c.claimChange.statusBefore !== c.claimChange.statusAfter)) {
      w();
      w(`**Claim changed:**`);
      if (c.claimChange.textBefore !== c.claimChange.textAfter) w(`- text: "${c.claimChange.textBefore}" → "${c.claimChange.textAfter}"`);
      if (c.claimChange.statusBefore !== c.claimChange.statusAfter) w(`- status: ${c.claimChange.statusBefore ?? "none"} → ${c.claimChange.statusAfter ?? "none"}`);
    }
  }
  w();
  w(`Read against corpus/RUBRIC.md section G. Decisions are judgment; the expect notes are orienting, not a gate.`);
  return o.join("\n");
}
