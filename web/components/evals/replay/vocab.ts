import type { ReplayDelta, ReplayEvent, ReplayStep } from "@/lib/replay-core";

// The player's vocabulary: agent names and the docs page each maps to,
// trigger/decision/outcome labels shared with the claim timeline, and every
// delta op in words. Gists here are DERIVED and say so; model output is never
// paraphrased by the player, only by the exporter's trimming, which `truncated`
// marks.

export const AGENTS: Record<string, { label: string; short: string; docs: string | null }> = {
  extractor: { label: "Extractor", short: "Ext", docs: "extractor" },
  matcher: { label: "Matcher", short: "Mat", docs: "matcher" },
  steward: { label: "Claim Steward", short: "Stw", docs: "claim-steward" },
  claim_steward: { label: "Claim Steward", short: "Stw", docs: "claim-steward" },
  curator: { label: "Curator", short: "Cur", docs: "curator" },
  tagger: { label: "Tagger", short: "Tag", docs: null },
  contribution_reviewer: { label: "Contribution Reviewer", short: "Rev", docs: "contribution-reviewer" },
  dispute_arbitrator: { label: "Dispute Arbitrator", short: "Arb", docs: "dispute-arbitrator" },
  audit: { label: "Audit", short: "Aud", docs: "audit-agent" },
  lookout: { label: "Lookout", short: "Look", docs: "lookout" },
  consistency_checker: { label: "Consistency Checker", short: "Cons", docs: "consistency-checker" },
  grantmaker: { label: "Grantmaker", short: "Grant", docs: "grantmaker" },
  judge: { label: "Judge", short: "Judge", docs: null },
  redteam: { label: "Attacker", short: "Atk", docs: null },
  persona: { label: "Contributor (simulated)", short: "Per", docs: null },
  system: { label: "System", short: "Sys", docs: null },
};

export function agentMeta(agent: string) {
  return AGENTS[agent] ?? { label: agent.replace(/_/g, " "), short: agent.slice(0, 3), docs: null };
}

/** The CSS class that colours an agent; unknown agents fall back to system grey. */
export function agentClass(agent: string): string {
  return AGENTS[agent] ? `ag-${agent}` : "ag-system";
}

// Mirrors ClaimTimeline's vocabulary so a decision reads the same here as on a claim page.
export const TYPE_LABELS: Record<string, string> = {
  challenge: "Challenge",
  support: "Supporting evidence",
  propose_merge: "Merge proposal",
  propose_split: "Split proposal",
  propose_edit: "Edit proposal",
  add_instance: "Source instance",
  propose_argument: "Argument",
  propose_claim: "Claim proposal",
  propose_source: "Source proposal",
};
export const DECISION_LABELS: Record<string, string> = {
  accept: "accepted",
  reject: "rejected",
  escalate: "escalated to arbitration",
};
export const OUTCOME_LABELS: Record<string, string> = {
  uphold_original: "original decision upheld",
  overturn: "decision overturned",
  modify: "decision modified",
  mark_contested: "claim marked contested",
  human_review: "referred for human review",
};
export const TRIGGER_PHRASES: Record<string, string> = {
  structure_and_assess: "initial assessment",
  pipeline_assessment: "initial assessment",
  steward_reassessment: "steward review",
  subclaim_change: "a subclaim changed",
  contribution_accepted: "an accepted contribution",
  user_order: "a reader's order",
  steward_escalation: "an escalated review",
  escalated_review: "an escalated review",
  appeal: "an appeal",
  conflict_resolution: "conflict resolution",
  curator_change: "a curator change",
  new_instance: "a new instance",
  extracted_claim: "an extracted claim",
  source_submitted: "a submitted source",
  contribution_submitted: "a submitted contribution",
  review_decided: "a review decision",
  duplicate_scan: "a duplicate scan",
  scenario: "the scenario script",
};

export function triggerPhrase(t: string | null | undefined): string | null {
  if (!t) return null;
  return TRIGGER_PHRASES[t] ?? t.replace(/_/g, " ");
}
export function typeLabel(t: string | null | undefined): string {
  return (t && TYPE_LABELS[t]) || "Contribution";
}
export function decisionLabel(d: string): string {
  return DECISION_LABELS[d] ?? d.replace(/_/g, " ");
}
export function outcomeLabel(o: string): string {
  return OUTCOME_LABELS[o] ?? o.replace(/_/g, " ");
}

export const STEP_KIND_LABEL: Record<string, string> = {
  prompt: "prompt",
  thought: "thought",
  tool_call: "tool call",
  tool_result: "result",
  decision: "decision",
  completion: "output",
};
export function stepKindLabel(k: string): string {
  return STEP_KIND_LABEL[k] ?? k.replace(/_/g, " ");
}

export function fmtCost(micro: number | null | undefined): string {
  if (micro == null || !Number.isFinite(micro)) return "—";
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
export function fmtChars(n: number | null | undefined): string {
  if (n == null) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k chars` : `${n} chars`;
}
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 19);
}
export function quote(text: string | null | undefined, max = 90): string {
  if (!text) return "";
  const t = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `“${t}”`;
}

/** One delta in words, for the "what changed" list. `texts` resolves claim ids to their current text. */
export function describeDelta(d: ReplayDelta, texts: (id: string) => string | null): string {
  const name = (id: string) => quote(texts(id) ?? id, 70);
  switch (d.op) {
    case "source_submitted":
      return `Source submitted: ${d.title ? quote(d.title) : d.sourceId}`;
    case "claim_created":
      return `Created ${d.topLevel ? "top-level claim" : "subclaim"} ${quote(d.text)}${d.createdBy ? ` (by the ${agentMeta(d.createdBy).label})` : ""}`;
    case "claim_matched":
      return `Matched to existing claim ${name(d.claimId)}, stance ${d.stance}${d.proposed ? `; the Extractor had proposed ${quote(d.proposed, 60)}` : ""}`;
    case "instance_added":
      return `Added an instance of ${name(d.claimId)}, stance ${d.stance}`;
    case "edge_added":
      return `Linked ${name(d.parentId)} —${d.relation}→ ${name(d.childId)}`;
    case "assessment_recorded":
      return `Assessed ${name(d.claimId)}: ${d.status}${d.credence != null ? `, credence ${d.credence.toFixed(2)}` : ""}, confidence ${d.confidence.toFixed(2)}${d.trigger ? ` (after ${triggerPhrase(d.trigger)})` : ""}`;
    case "canonical_form_updated":
      return `Reworded ${quote(d.before, 50)} → ${quote(d.after, 50)}`;
    case "importance_set":
      return `Set importance of ${name(d.claimId)} to ${d.importance.toFixed(2)}`;
    case "claim_merged":
      return `Merged ${name(d.claimId)} into ${name(d.into)}`;
    case "steward_notified":
      return `Notified the Steward of ${name(d.claimId)} (${triggerPhrase(d.trigger)}${d.coalesced ? ", coalesced with a pending notice" : ""})`;
    case "contribution_submitted":
      return `${typeLabel(d.type)} submitted${d.claimId ? ` against ${name(d.claimId)}` : ""} by ${d.contributor}${d.gambit ? ` — gambit: ${d.gambit}` : ""}`;
    case "review_decided":
      return `${typeLabel(null)} ${decisionLabel(d.decision)}${d.confidence != null ? `, confidence ${d.confidence.toFixed(2)}` : ""}${d.badFaith ? ", flagged as suspected bad faith" : ""}`;
    case "appeal_filed":
      return `Appeal filed on contribution ${d.contributionId}`;
    case "arbitration_decided":
      return `Arbitration: ${outcomeLabel(d.outcome)}`;
    case "note":
      return d.text;
    default:
      return JSON.stringify(d);
  }
}

/** The claim ids a delta names, for pulses and lineage. */
export function deltaClaimIds(d: ReplayDelta): string[] {
  const ids: string[] = [];
  if ("claimId" in d && d.claimId) ids.push(d.claimId);
  if (d.op === "edge_added") ids.push(d.parentId, d.childId);
  if (d.op === "claim_merged") ids.push(d.into);
  return ids;
}

/** A step's one-line gist for lists; the index text when the exporter wrote one. */
export function stepGist(s: ReplayStep): string {
  if (s.text) return s.text;
  if (s.kind === "tool_call") return `${s.tool ?? "tool"} called`;
  if (s.kind === "tool_result") return `${s.tool ?? "tool"} returned`;
  return stepKindLabel(s.kind);
}

export function eventShort(e: ReplayEvent): string {
  return `${agentMeta(e.agent).label} · #${e.seq}`;
}
