/**
 * A mandate's operating policy: the Grantmaker's standing instructions to
 * the program officers who carry the mandate out day to day, and the public
 * statement of how it spends. One part of the mandate document, beside its
 * terms (the title and objective its funder approved), and stored on it as
 * `grants.mandate.operating_policy`. Every version is kept in
 * mandate_policy_versions with the note that justified it.
 *
 * The Grantmaker writes it in prose. It carries two numbers, each the
 * Grantmaker's own choice with its reason beside it: the officers'
 * delegation limit, the most an officer commits in one decision without the
 * Grantmaker, stated to the officers; and the review-pass budget, what each
 * of the Grantmaker's own review passes works to (#820), stated in that
 * pass's briefing. The payer sets what its deliberation is worth; a
 * deployment constant knows nothing about the mandate.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { currentLabel } from "../llm/usage-context.js";

export const POLICY_SECTIONS = ["current", "mission", "priorities", "budgets", "petitions", "delegation"] as const;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

export interface OperatingPolicy {
  /**
   * The Grantmaker's direction for now, beside the standing policy: which
   * branches are promising, what to grant and what to hold until which work
   * reports. Rewritten often; dated when written, and rendered first.
   */
  current?: string;
  current_at?: string;
  mission?: string;
  priorities?: string;
  budgets?: string;
  petitions?: string;
  delegation?: string;
  officer_limit_owls?: number;
  /** The reason the Grantmaker gave for the limit, stated to the officers. */
  officer_limit_reason?: string;
  /** The budget each review pass of this mandate works to, in owls. */
  review_pass_owls?: number;
  /** The reason the Grantmaker gave for it, stated in each pass's briefing. */
  review_pass_reason?: string;
}

const HEADINGS: Record<PolicySection, string> = {
  current: "Current direction",
  mission: "Mission",
  priorities: "Priorities",
  budgets: "Budgets",
  petitions: "Petitions",
  delegation: "Delegation",
};

export async function getOperatingPolicy(grantId: string): Promise<OperatingPolicy> {
  const [row] = await rawQuery<{ policy: OperatingPolicy | null }>(
    `SELECT mandate->'operating_policy' AS policy FROM grants WHERE id = $1`,
    [grantId]
  );
  return row?.policy ?? {};
}

/** The policy as the officers and the public read it. */
export function renderOperatingPolicy(policy: OperatingPolicy): string {
  const parts = POLICY_SECTIONS.filter((s) => policy[s]?.trim()).map(
    (s) =>
      `### ${HEADINGS[s]}${s === "current" && policy.current_at ? ` (written ${policy.current_at.slice(0, 16).replace("T", " ")} UTC)` : ""}\n` +
      policy[s]!.trim()
  );
  return parts.length > 0
    ? parts.join("\n\n")
    : "(No operating policy written yet. Decide as a careful steward of the mandate's terms would, and escalate what you can't settle.)";
}

/** The most an officer may commit in one decision, and why. */
export function officerLimit(policy: OperatingPolicy): { microUsd: number; reason: string } {
  const owls = policy.officer_limit_owls ?? loadConfig().defaultOfficerLimitOwls;
  return {
    microUsd: owlsToMicroUsd(owls),
    reason:
      policy.officer_limit_reason?.trim() ||
      (policy.officer_limit_owls == null
        ? "the platform's default until the Grantmaker sets one"
        : "set by the Grantmaker"),
  };
}

/**
 * The budget a review pass of this mandate works to: the policy's own
 * figure, or the platform's default while the Grantmaker has set none
 * (DEFAULT_REVIEW_PASS_BUDGET_OWLS). A ceiling paid from the mandate's
 * escrow within its pace; the pass returns what it does not spend.
 */
export function reviewPassBudget(policy: OperatingPolicy | null | undefined): {
  microUsd: number;
  /** True when the Grantmaker set it; false for the platform's default. */
  fromPolicy: boolean;
  reason: string;
} {
  const own = Number(policy?.review_pass_owls);
  const fromPolicy = Number.isFinite(own) && own > 0;
  return {
    microUsd: owlsToMicroUsd(fromPolicy ? own : loadConfig().defaultReviewPassBudgetOwls ?? 5),
    fromPolicy,
    reason: fromPolicy
      ? policy?.review_pass_reason?.trim() || "set by the Grantmaker"
      : "the platform's default until the Grantmaker sets one",
  };
}

/**
 * Write the policy, or one section of it, and keep the version. The
 * delegation limit, when given, is stated to the officers with the note as
 * its reason; the review-pass budget, when given, is stated to each review
 * pass with the note as its reason, and applies from the next pass opened.
 */
export async function writeOperatingPolicy(input: {
  grantId: string;
  section?: PolicySection | null;
  content: string;
  note: string;
  author: string;
  officerLimitOwls?: number | null;
  reviewPassOwls?: number | null;
}): Promise<{ ok: true; policy: OperatingPolicy } | { ok: false; message: string }> {
  const content = input.content.trim();
  const note = input.note.trim();
  if (!note) return { ok: false, message: "note is required: it is the public record of why." };
  const current = await getOperatingPolicy(input.grantId);
  const next: OperatingPolicy = { ...current };
  // The two figures alone, with no text: the prose stays as it is.
  const figuresOnly = !content && (input.officerLimitOwls != null || input.reviewPassOwls != null);
  if (figuresOnly) {
    // nothing to rewrite
  } else if (input.section) {
    if (!POLICY_SECTIONS.includes(input.section)) {
      return { ok: false, message: `section must be one of ${POLICY_SECTIONS.join(", ")}.` };
    }
    next[input.section] = content;
    if (input.section === "current") next.current_at = new Date().toISOString();
  } else if (content) {
    // A whole policy: split on its own ### headings when it has them;
    // otherwise it is the mission section, read whole.
    const bySection = splitSections(content);
    for (const s of POLICY_SECTIONS) delete next[s];
    Object.assign(next, bySection);
  }
  if (input.officerLimitOwls != null) {
    const owls = Number(input.officerLimitOwls);
    if (!(owls >= 0)) return { ok: false, message: "officer_limit_owls must be zero or more." };
    next.officer_limit_owls = owls;
    next.officer_limit_reason = note;
  }
  if (input.reviewPassOwls != null) {
    const owls = Number(input.reviewPassOwls);
    if (!(owls > 0)) return { ok: false, message: "review_pass_owls must be above zero." };
    next.review_pass_owls = owls;
    next.review_pass_reason = note;
  }
  await rawQuery(
    `UPDATE grants
        SET mandate = jsonb_set(COALESCE(mandate, '{}'::jsonb), '{operating_policy}', $2::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [input.grantId, JSON.stringify(next)]
  );
  await rawQuery(
    `INSERT INTO mandate_policy_versions (grant_id, part, section, content, note, author, sensitivity_label)
     VALUES ($1, 'policy', $2, $3::jsonb, $4, $5, $6)`,
    [input.grantId, input.section ?? null, JSON.stringify(next), note, input.author, currentLabel()]
  );
  const { recordEvent } = await import("./event-service.js");
  await recordEvent({
    kind: "mandate_changed",
    grantId: input.grantId,
    refs: { part: "policy", section: input.section ?? null },
    summary: `The operating policy${input.section ? `'s ${input.section} section` : ""} was rewritten: ${note}`,
  });
  return { ok: true, policy: next };
}

function splitSections(text: string): OperatingPolicy {
  const out: OperatingPolicy = {};
  const re = /^###\s+(.+)$/gm;
  const marks: Array<{ name: string; at: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ name: m[1]!.trim().toLowerCase(), at: m.index, end: m.index + m[0].length });
  if (marks.length === 0) return { mission: text };
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1]!.at : text.length).trim();
    const key = POLICY_SECTIONS.find((s) => mk.name.startsWith(s));
    if (key && body) out[key] = body;
  });
  return out;
}

export function describeLimit(limit: { microUsd: number; reason: string }): string {
  return `You may commit up to ${microUsdToOwls(limit.microUsd)} owls in one decision without the Grantmaker (${limit.reason}).`;
}
