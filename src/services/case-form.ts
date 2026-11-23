/**
 * The form of a safety case (constitution §7b, #1211), checked.
 *
 * Form is checked; content is judged. Whether a case is well formed under
 * its framework (every step is a known block, every step has a side claim,
 * every leaf is evidence) is a check anyone can run, and this file is that
 * check. Whether a step is sound, a side claim holds or a defeater is
 * answered is the Steward's judgment, and nothing here decides it.
 *
 * The check reads the exported form of a case (`CaseExport`), so the same
 * function tells the Steward where its structure fails as it writes it,
 * and reads an export back wherever it has gone. Nothing in this file
 * reads a database.
 */
import {
  CASE_BLOCKS,
  CASE_ELEMENT_TYPES,
  DEFEATER_STANDINGS,
  type CaseFramework,
} from "../schemas/kinds.js";

/** The format an export names itself by. A change to its shape takes a new name. */
export const CASE_EXPORT_FORMAT = "minerval-cae/1";

/** A graph node as a case presents it: the node, and the graph's judgment of it at the time, unchanged. */
export interface CaseNodeRef {
  id: string;
  kind: string;
  text: string;
  page_url?: string;
  /** The graph's own judgment of the node when the case was read. Null where it has none. */
  judgment: {
    status?: string | null;
    credence?: number | null;
    standing?: string | null;
    estimate?: unknown;
    fidelity?: string | null;
  } | null;
}

/** One element of a case's structure, in the exported form. */
export interface CaseExportElement {
  id: string;
  type: string;
  /** The element it hangs under. Null for the case's top claim alone. */
  parent: string | null;
  /** A step's building block. */
  block?: string | null;
  /** A step: the inference in words. Any other element: what the case needs of the node. */
  statement: string;
  /** The graph node the element presents. Absent on a step. */
  node?: CaseNodeRef | null;
  /** A step: the argument (§7) it reads, where the graph holds one. */
  argument_id?: string | null;
  /** A defeater: where it stands in the case, and why. */
  standing?: string | null;
  standing_reason?: string | null;
  /** A residual doubt: who accepted it, and why. */
  accepted_by?: string | null;
  acceptance?: string | null;
  /** Where the element departs from the framework, in the Steward's words. */
  departure?: string | null;
  /** Whether the developer's published case raises this element. Null where none is being read in. */
  raised_in_published?: boolean | null;
}

export interface FormFailure {
  /** The element the failure is at, or null for one about the case as a whole. */
  element: string | null;
  rule: FormRule;
  message: string;
  /** The Steward's stated departure at this element, where it has said one. The failure is still a failure of form. */
  departure: string | null;
}

export const FORM_RULES = [
  "no_top_claim",
  "several_top_claims",
  "unknown_element",
  "orphan",
  "misplaced",
  "unknown_block",
  "no_side_claim",
  "no_subclaims",
  "no_evidence",
  "evidence_outside_incorporation",
  "undeveloped_claim",
  "unknown_standing",
  "answered_without_subcase",
] as const;
export type FormRule = (typeof FORM_RULES)[number];

/** Where each kind of element may hang. A claim under a defeater is the top of the subcase that answers it. */
const PARENTS: Record<string, readonly string[]> = {
  claim: ["step", "defeater"],
  step: ["claim", "side_claim"],
  side_claim: ["step"],
  evidence: ["step"],
  defeater: ["claim", "step", "side_claim", "evidence"],
};

/** Why an element of `type` may not hang under one of `parentType`, or null where it may. */
export function misplacement(type: string, parentType: string | null): string | null {
  if (parentType === null) return type === "claim" ? null : `Only the case's top claim hangs under nothing; a ${words(type)} hangs under ${under(type)}.`;
  if (PARENTS[type]?.includes(parentType)) return null;
  return `A ${words(type)} hangs under ${under(type)}, not under a ${words(parentType)}.`;
}

const words = (type: string) => type.replace(/_/g, " ");
function under(type: string): string {
  const parents = PARENTS[type] ?? [];
  return parents.map((p) => `a ${words(p)}`).join(" or ") || "nothing";
}

/**
 * Check a case's form. The rules that say what the structure is (one top
 * claim, every element under something it may hang under, a defeater
 * answered by a subcase) hold whatever the framework. The rest are
 * Assurance 2.0's, and are checked of a case that names that framework.
 */
export function checkCaseForm(elements: readonly CaseExportElement[], framework: CaseFramework | string): FormFailure[] {
  const failures: FormFailure[] = [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const children = new Map<string, CaseExportElement[]>();
  for (const e of elements) {
    if (e.parent === null) continue;
    children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
  }
  const kids = (e: CaseExportElement, type: string) => (children.get(e.id) ?? []).filter((c) => c.type === type);
  const fail = (e: CaseExportElement | null, rule: FormRule, message: string) =>
    failures.push({ element: e?.id ?? null, rule, message, departure: e?.departure?.trim() || null });

  const tops = elements.filter((e) => e.parent === null && e.type === "claim");
  if (tops.length === 0) fail(null, "no_top_claim", "The case has no top claim: the conclusion it argues for.");
  for (const extra of tops.slice(1)) fail(extra, "several_top_claims", "A case argues one conclusion: this is a second top claim.");

  for (const e of elements) {
    if (!(CASE_ELEMENT_TYPES as readonly string[]).includes(e.type)) {
      fail(e, "unknown_element", `"${e.type}" is not a kind of element: one of ${CASE_ELEMENT_TYPES.join(", ")}.`);
      continue;
    }
    const parent = e.parent === null ? null : byId.get(e.parent);
    if (parent === undefined) {
      fail(e, "orphan", "This element hangs under an element the case does not hold.");
      continue;
    }
    const wrong = misplacement(e.type, parent?.type ?? null);
    if (wrong) fail(e, "misplaced", wrong);

    if (e.type === "defeater") {
      if (!(DEFEATER_STANDINGS as readonly string[]).includes(e.standing ?? "")) {
        fail(e, "unknown_standing", `A defeater stands as one of ${DEFEATER_STANDINGS.join(", ")}.`);
      } else if (e.standing === "answered" && kids(e, "claim").length === 0) {
        fail(e, "answered_without_subcase", "This defeater is recorded as answered, and no subcase under it answers it.");
      }
    }
    if (framework !== "assurance_2_cae") continue;

    if (e.type === "step") {
      const block = e.block ?? "";
      if (!(CASE_BLOCKS as readonly string[]).includes(block)) {
        fail(e, "unknown_block", `"${block}" is not one of the framework's building blocks: ${CASE_BLOCKS.join(", ")}.`);
      }
      if (kids(e, "side_claim").length === 0) {
        fail(
          e,
          "no_side_claim",
          block === "substitution"
            ? "This substitution has no side claim: nothing says why what was shown of one thing holds of the other."
            : "This step has no side claim: nothing says why the step is legitimate."
        );
      }
      if (block === "evidence_incorporation") {
        if (kids(e, "evidence").length === 0) fail(e, "no_evidence", "This step brings in evidence and names none.");
      } else if (kids(e, "claim").length === 0) {
        fail(e, "no_subclaims", "This step argues from no claims.");
      }
    }
    if (e.type === "evidence" && parent && parent.type === "step" && parent.block !== "evidence_incorporation") {
      fail(e, "evidence_outside_incorporation", "Evidence is brought in by an evidence incorporation step; this step is another block.");
    }
    if ((e.type === "claim" || e.type === "side_claim") && kids(e, "step").length === 0) {
      fail(
        e,
        "undeveloped_claim",
        e.type === "side_claim"
          ? "This side claim is argued for by no step, so it does not bottom out in evidence."
          : "This claim is argued for by no step, so it does not bottom out in evidence."
      );
    }
  }
  return failures;
}

/** One thing that counts against a case that carries the burden. */
export interface CountsAgainst {
  element: string | null;
  kind: "open_defeater" | "sustained_defeater_not_accepted" | "form";
  message: string;
}

/**
 * What counts against the case under its own burden, as far as its
 * structure shows it: a defeater not yet answered, a sustained one nobody
 * has accepted, and a failure of form the Steward has not said is a
 * departure. A residual doubt (sustained and accepted) is not listed here:
 * the verdict rests on it, and says so. Evidence asked for and not supplied
 * is on the case's page as its open requests.
 */
export function countsAgainst(elements: readonly CaseExportElement[], failures: readonly FormFailure[]): CountsAgainst[] {
  const out: CountsAgainst[] = [];
  for (const e of elements) {
    if (e.type !== "defeater") continue;
    if (e.standing === "open") out.push({ element: e.id, kind: "open_defeater", message: "A defeater is open: it has been neither answered nor sustained." });
    if (e.standing === "sustained" && !e.accepted_by?.trim()) {
      out.push({ element: e.id, kind: "sustained_defeater_not_accepted", message: "A defeater is sustained and nobody has accepted it as a residual doubt." });
    }
  }
  for (const f of failures) {
    if (!f.departure) out.push({ element: f.element, kind: "form", message: f.message });
  }
  return out;
}

/** A case in the exported form (docs/safety-cases.md, "Export"). */
export interface CaseExport {
  format: typeof CASE_EXPORT_FORMAT;
  exported_at: string;
  case: {
    id: string;
    title: string;
    page_url: string;
    system: string;
    deployment: string;
    standard: string;
    standard_of: string;
    framework: string;
    not_covered: string | null;
    conclusion: CaseNodeRef;
  };
  /** The case's judgment in force, or null where it has not been judged. */
  judgment: {
    fidelity: string;
    verdict: string | null;
    verdict_basis: string | null;
    would_change: string | null;
    summary: string | null;
    gaps: string | null;
    assessed_at: string;
  } | null;
  elements: CaseExportElement[];
  /** The form as checked when the export was made. A reader runs the check again on `elements`. */
  form: { framework: string; well_formed: boolean; failures: FormFailure[] };
}

/** Read an export back: that it is one, and its form checked afresh from its elements. */
export function readCaseExport(raw: unknown): { export: CaseExport; failures: FormFailure[] } {
  const doc = raw as Partial<CaseExport> | null;
  if (!doc || doc.format !== CASE_EXPORT_FORMAT || !doc.case || !Array.isArray(doc.elements)) {
    throw new Error(`Not a case export: expected format "${CASE_EXPORT_FORMAT}" with a case and its elements.`);
  }
  return { export: doc as CaseExport, failures: checkCaseForm(doc.elements, doc.case.framework ?? "none") };
}
