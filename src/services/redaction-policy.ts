/**
 * The redaction policy of a boundary (docs/showing-a-page.md, "The policy").
 *
 * A boundary is a pair: the label a page was written at, and where it is
 * shown (another label, or outside the deployment). Labels are rows and
 * are not ranked, so a deployment has as many boundaries as it shows pages
 * across, and each has a policy of its own: a document in the deployment's
 * data, versioned, that says what a Redactor removes there.
 *
 * Every boundary starts from the one text in this file. A deployment's
 * administrators then save later versions with categories of their own.
 * Two parts of a policy are not theirs to change, because readers on the
 * other side rely on them being the same at every boundary: how removal
 * works, and what is shown whenever a page is shown. Those are written
 * here and are part of every version's text.
 *
 * Each version is stored as two rows with the same text
 * (redaction_policies): one at the page's label, which the Redactor, Audit
 * and the assessing Steward read, and one on the destination side, so
 * that everyone a page is shown to can read the policy it was shown under.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { PUBLIC_LABEL } from "../labels.js";

export interface PolicyCategory {
  /** The words used in the mark: "[redacted: <name>]". */
  name: string;
  /** What the category covers. */
  covers: string;
  /** Examples, as one line. */
  examples: string;
}

/** The categories every boundary starts from. */
export const DEFAULT_CATEGORIES: readonly PolicyCategory[] = [
  {
    name: "personal data",
    covers: "Detail about an identifiable person who is not a public figure in the matter.",
    examples: "A named employee's conduct in an incident; a customer's account details; text a user wrote.",
  },
  {
    name: "security detail",
    covers: "What would help someone attack the organization's systems or premises.",
    examples: "Network layout; key material; what the monitoring does not see.",
  },
  {
    name: "privileged or third-party confidential material",
    covers: "Legal advice, and what is held under another party's confidentiality terms.",
    examples: "Counsel's memo; a supplier's audit report received under a non-disclosure agreement.",
  },
  {
    name: "unreleased product detail",
    covers: "What the organization has not made public about its products and plans.",
    examples: "Design details; the names of unannounced features; launch dates.",
  },
  {
    name: "commercial figures",
    covers: "Numbers and terms a competitor or a counterparty could use.",
    examples: "Revenue; prices; contract terms; customer names.",
  },
  {
    name: "internal identifiers",
    covers: "Names that mean nothing outside the organization and map its inside.",
    examples: "System and host names; ticket numbers; staff who are not public figures in the matter.",
  },
  {
    name: "weaknesses in others' systems",
    covers: "Unfixed weaknesses in systems the organization does not own.",
    examples: "An unreported flaw in a supplier's interface.",
  },
  {
    name: "detail that would help cause serious harm",
    covers: "Step-level information that would give real help toward serious harm to people.",
    examples: "A working method for making a dangerous substance; working exploit code.",
  },
  {
    name: "test content",
    covers: "Questions, answers and marking schemes whose release would spoil a test still in use.",
    examples: "Held-out examination questions; the marking scheme for a certification.",
  },
];

/** What is shown whenever a page is shown, as the policy states it. */
export const ALWAYS_SHOWN: readonly string[] = [
  "The verdict: the status, the estimate or the answer, with its confidence and any credence.",
  "Coverage: whether the node was examined, and on what kinds of evidence.",
  "That something was removed, in the place it was removed from.",
  "That each source exists: its kind, its fingerprint, whether the organization itself or an outside party supplied it, and whether an interest in the node is recorded for it.",
  "The gaps the page itself records: that each exists, and where it stands.",
  "How the page was made: the prompt set, the version of this policy, the model, any addition a deployment made to a role's prompt, the seal of the assessing run's log with whether its chain checks out, and whether a mandate or a person's order paid for the assessment and whether its funder declared a stake.",
  "The number of removals in each category.",
];

const HOW_REMOVAL_WORKS: readonly string[] = [
  "Text is removed and nothing is rewritten. What remains is the author's, word for word.",
  "The least that protects is removed: the phrase, the figure or the sentence, and a whole paragraph only where the paragraph is nothing else.",
  'Each removal is marked where it was made with the name of its category, as in "[redacted: personal data]". The mark says nothing else: not how long the passage was, and not what it concerned.',
  "A passage is judged by what it gives away, alone and together with what stays around it. A figure removed from one sentence that can be worked out from two others has not been removed.",
  "A passage is removed because a category below covers it. Whether it is favorable or unfavorable to anyone is not a reason to remove it or to keep it.",
  "Where it is in real doubt whether a category covers a passage, the passage is removed and marked: what has been shown cannot be taken back, and every removal is counted where readers can see the count.",
  "Each removal is recorded with its category, the version of this policy, and the Redactor's note of why. The note stays at the label the page was written at.",
];

/** The whole policy as a reader is given it. The same on both sides of the boundary. */
export function renderPolicy(categories: readonly PolicyCategory[], version: number): string {
  return [
    `# Redaction policy, version ${version}`,
    "",
    "This policy says what is removed from a page of this graph when the page is shown to readers who may not " +
      "read the label it was written at. It applies at one boundary: from the label the page was written at, to " +
      "the readers it is shown to. It governs removal only. It does not decide what is assessed, which pages are " +
      "shown, or what the people who hold the permission to release then release or hold.",
    "",
    "## How removal works",
    "",
    ...HOW_REMOVAL_WORKS.map((line, i) => `${i + 1}. ${line}`),
    "",
    "## What is shown whenever a page is shown",
    "",
    ...ALWAYS_SHOWN.map((line) => `- ${line}`),
    "",
    "No category covers any of these. Where one of them could not be shown without giving away what a category " +
      "protects, the page is not shown, and readers on the other side see that it is held.",
    "",
    "A supplier's name, the words of a recorded interest and the words of a gap are not among these. They are " +
      "parts of the page like any other: a category covers them as it covers any passage, and removing one does " +
      "not hold the page.",
    "",
    "## Categories",
    "",
    ...categories.flatMap((c) => [`### ${c.name}`, "", c.covers, "", `Examples: ${c.examples}`, ""]),
    "## Changing this policy",
    "",
    "The deployment's administrators save a new version to add, reword or drop categories. A version cannot " +
      "change how removal works or what is shown whenever a page is shown, and cannot define a category by " +
      "whether a passage is favorable. Every removal records the version it was made under.",
  ].join("\n");
}

export const CATEGORY_NAME_MAX_CHARS = 80;

/**
 * Wording that defines a category by how a passage reflects on someone
 * and not by what kind of content it is. The list catches the plain
 * cases. It cannot catch a category worded to get round it: the checks on
 * that are that the policy is read by everyone a page is shown to, that
 * the Redactor is told a passage's favor is no ground for removal, and
 * that Audit reads what was removed.
 */
const BY_FAVOR =
  /\b(?:un)?favou?rabl\w*|\bembarrass\w*|\b(?:un)?flattering\b|\breputation\w*|\bcritical of\b|\bcriticis\w+ of\b|\bcriticiz\w+ of\b|\breflects? (?:badly|poorly|well) on\b|\blooks? (?:bad|good)\b|\bdamaging to (?:us|the (?:organi[sz]ation|company|firm))\b|\bnegative (?:about|toward|towards|for)\b|\bpositive (?:about|toward|towards|for)\b/i;

/** Wording that names something shown whenever a page is shown. */
const ALWAYS_SHOWN_WORDS =
  /\bverdicts?\b|\bcredences?\b|\bconfidence (?:in|of) the (?:verdict|assessment|status|estimate|answer)\b|\bstatus of the (?:claim|assessment|node)\b|\b(?:count|number) of removals\b|\bprompt set\b|\bpolicy version\b|\bthat (?:something|a passage) was removed\b/i;

export interface PolicyProblem {
  category: string;
  problem: string;
}

/**
 * What stops a set of categories from being saved, each with its reason.
 * An empty list means it can be saved.
 */
export function policyProblems(categories: readonly PolicyCategory[]): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const seen = new Set<string>();
  for (const c of categories) {
    const name = typeof c.name === "string" ? c.name.trim() : "";
    const covers = typeof c.covers === "string" ? c.covers.trim() : "";
    if (!name || name.length > CATEGORY_NAME_MAX_CHARS || /[\[\]\n\r]/.test(name)) {
      problems.push({
        category: name || "(unnamed)",
        problem:
          `A category needs a name of at most ${CATEGORY_NAME_MAX_CHARS} characters with no square brackets or ` +
          `line breaks: the name is the whole of what a mark says, as in "[redacted: personal data]".`,
      });
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      problems.push({ category: name, problem: "Two categories have this name, and a mark could then mean either." });
    }
    seen.add(name.toLowerCase());
    if (!covers) {
      problems.push({ category: name, problem: "A category says what it covers, so that the Redactor and Audit can apply it and readers can see what was removed under it." });
    }
    const byFavor = `${name}. ${covers}`.match(BY_FAVOR);
    if (byFavor) {
      problems.push({
        category: name,
        problem:
          `This category is worded by how a passage reflects on someone ("${byFavor[0]}"). A category names a kind of ` +
          `content. Readers on the other side judge a verdict by what they are shown, so removing text because it is ` +
          `favorable or unfavorable would change what the verdict appears to rest on without their knowing. Say what ` +
          `kind of content is meant instead.`,
      });
    }
    const alwaysShown = `${name}. ${covers}`.match(ALWAYS_SHOWN_WORDS);
    if (alwaysShown) {
      problems.push({
        category: name,
        problem:
          `This category names something that is shown whenever a page is shown ("${alwaysShown[0]}"). A reader ` +
          `cannot weigh a page without its verdict, its confidence, its coverage, its sources' existence, its gaps, ` +
          `how it was made and the count of removals, so no category covers them. A page whose verdict cannot be ` +
          `shown is held whole, which the people who direct the graph or hold release for a party can do.`,
      });
    }
  }
  if (categories.length === 0) {
    // Not refused: a boundary may protect nothing. Said so that it is a choice.
  }
  return problems;
}

export const hashPolicy = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

/** A boundary: the label a page was written at, and where it is shown. `to` null is outside the deployment. */
export interface Boundary {
  from: string;
  to: string | null;
}

/** The label the destination side's rows are kept at: the destination label, or `public` for outside. */
export const destinationLabel = (boundary: Boundary): string => boundary.to ?? PUBLIC_LABEL;

export interface PolicyView {
  id: string;
  boundary_id: string;
  version: number;
  categories: PolicyCategory[];
  body: string;
  hash: string;
  saved_at: string;
  /** True for the version every boundary starts from, which nobody saved. */
  starting_text: boolean;
}

interface PolicyRow {
  id: string;
  boundary_id: string;
  version: number;
  categories: PolicyCategory[];
  body: string;
  hash: string;
  saved_at: Date;
  saved_by: string | null;
}

const policyView = (r: PolicyRow): PolicyView => ({
  id: r.id,
  boundary_id: r.boundary_id,
  version: r.version,
  categories: r.categories,
  body: r.body,
  hash: r.hash,
  saved_at: r.saved_at.toISOString(),
  starting_text: r.saved_by === null && r.version === 1,
});

const COLUMNS = `id, boundary_id, version, categories, body, hash, saved_at, saved_by`;

const REASON_POLICY =
  "A boundary's policy is kept as one row on each side of the boundary, and the two sides may share no label.";

/**
 * The newest version of a boundary's policy, as the page's side holds it.
 * Read with the caller's own clearance: a run at the page's label reads
 * it, and a caller that does not read that label finds none.
 */
export async function policyAtPageSide(boundary: Boundary): Promise<PolicyView | null> {
  const [row] = await rawQuery<PolicyRow>(
    `SELECT ${COLUMNS} FROM redaction_policies
      WHERE side = 'page' AND from_label = $1 AND to_label IS NOT DISTINCT FROM $2 AND to_outside = $3
      ORDER BY version DESC LIMIT 1`,
    [boundary.from, boundary.to, boundary.to === null]
  );
  return row ? policyView(row) : null;
}

/** One policy version by id, with the caller's own clearance. */
export async function policyById(id: string): Promise<PolicyView | null> {
  const [row] = await rawQuery<PolicyRow>(`SELECT ${COLUMNS} FROM redaction_policies WHERE id = $1`, [id]);
  return row ? policyView(row) : null;
}

/**
 * Save a version of a boundary's policy: a row on each side, with the same
 * text. `savedBy` null is the starting text, written the first time a
 * boundary is used. The caller has checked who is asking; this writes as
 * the tables' owner, since the two sides may share no label.
 */
export async function savePolicyVersion(input: {
  boundary: Boundary;
  categories: readonly PolicyCategory[];
  savedBy: string | null;
}): Promise<
  | { ok: true; policy: PolicyView }
  | { ok: false; code: "POLICY_REFUSED"; message: string; problems: PolicyProblem[] }
> {
  const categories = input.categories.map((c) => ({
    name: String(c.name ?? "").trim(),
    covers: String(c.covers ?? "").trim(),
    examples: String(c.examples ?? "").trim(),
  }));
  const problems = policyProblems(categories);
  if (problems.length > 0) {
    return {
      ok: false,
      code: "POLICY_REFUSED",
      message: "This version was not saved. " + problems.map((p) => `"${p.category}": ${p.problem}`).join(" "),
      problems,
    };
  }
  const { from, to } = input.boundary;
  const row = await withSystemClearance(REASON_POLICY, () =>
    withTransaction(async (tx) => {
      // One writer at a time for a boundary, so two saves cannot take the same version number.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`redaction-policy:${from}:${to ?? ""}`]);
      const [last] = await tx.query<{ boundary_id: string; version: number }>(
        `SELECT boundary_id, version FROM redaction_policies
          WHERE side = 'page' AND from_label = $1 AND to_label IS NOT DISTINCT FROM $2 AND to_outside = $3
          ORDER BY version DESC LIMIT 1`,
        [from, to, to === null]
      );
      const version = (last?.version ?? 0) + 1;
      const body = renderPolicy(categories, version);
      const hash = hashPolicy(body);
      const [page] = await tx.query<PolicyRow>(
        `INSERT INTO redaction_policies
           (boundary_id, side, version, categories, body, hash, from_label, to_label, to_outside, saved_by, sensitivity_label)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), 'page', $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $6)
         RETURNING ${COLUMNS}`,
        [last?.boundary_id ?? null, version, JSON.stringify(categories), body, hash, from, to, to === null, input.savedBy]
      );
      // The destination's row names no label its readers may not read.
      await tx.query(
        `INSERT INTO redaction_policies
           (boundary_id, side, version, categories, body, hash, from_label, to_label, to_outside, saved_by, sensitivity_label)
         VALUES ($1, 'destination', $2, $3::jsonb, $4, $5, NULL, $6, $7, $8, $9)`,
        [page!.boundary_id, version, JSON.stringify(categories), body, hash, to, to === null, input.savedBy, destinationLabel(input.boundary)]
      );
      return page!;
    })
  );
  return { ok: true, policy: policyView(row) };
}

/**
 * The newest policy of a boundary, saving the starting text as its first
 * version where the boundary has none yet. Every boundary therefore has a
 * version that both sides can read from the first time it is used.
 *
 * The two sections every version shares are written in this file. When
 * their wording changes, a boundary's newest version no longer says what
 * the code now says, so the next use of the boundary saves a new version
 * with the same categories, as any edit would. A page already shown keeps
 * the version, and the hash, it was shown under.
 */
export async function ensureBoundaryPolicy(boundary: Boundary): Promise<PolicyView> {
  const existing = await withSystemClearance(REASON_POLICY, () => policyAtPageSide(boundary));
  if (existing && existing.body !== renderPolicy(existing.categories, existing.version)) {
    const resaved = await savePolicyVersion({ boundary, categories: existing.categories, savedBy: null });
    // Categories that a later check would refuse stay under the version they were saved in until someone saves anew.
    return resaved.ok ? resaved.policy : existing;
  }
  if (existing) return existing;
  const saved = await savePolicyVersion({ boundary, categories: DEFAULT_CATEGORIES, savedBy: null });
  if (!saved.ok) throw new Error(`The starting policy text was refused: ${saved.message}`);
  return saved.policy;
}

/**
 * The policies the caller may read, newest version of each boundary first:
 * those of boundaries it is on the destination side of, and those at a
 * label it reads. `side` says which a row is; a destination row names no
 * label of origin.
 */
export async function readablePolicies(): Promise<Array<PolicyView & { side: "page" | "destination"; from: string | null; to: string | null; to_outside: boolean }>> {
  const rows = await rawQuery<PolicyRow & { side: "page" | "destination"; from_label: string | null; to_label: string | null; to_outside: boolean }>(
    `SELECT DISTINCT ON (boundary_id, side) ${COLUMNS}, side, from_label, to_label, to_outside
       FROM redaction_policies
      ORDER BY boundary_id, side, version DESC`
  );
  return rows.map((r) => ({ ...policyView(r), side: r.side, from: r.from_label, to: r.to_label, to_outside: r.to_outside }));
}
