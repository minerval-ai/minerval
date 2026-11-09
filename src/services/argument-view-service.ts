/**
 * The one reading of an argument that `get_argument` returns (#541), for
 * the graph's own agents and MCP clients alike, on the pattern of get_claim
 * (#774): one description, one base view, and sections a caller asks for.
 *
 * The base view is the argument row: its conclusion, name, stance or what
 * it shows about a quantity, its written form, and whether and why it was
 * retired. Sections: `evaluation` (the current rating and its history, each
 * dated against the assessment or estimate it was made under), `premises`
 * (the claims it rests on, with their standing), and `instances` (where
 * sources make, attack or mention it).
 *
 * The view carries no count of instances outside the instances section:
 * how widely an argument is made is not a measure of its standing (§7).
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { EVALUATION_STALE_SQL, getArgument, hasWrittenForm, parseClaimLinks } from "./argument-service.js";
import { listArgumentInstances } from "./argument-instance-service.js";

export const ARGUMENT_VIEW_INCLUDES = ["evaluation", "premises", "instances"] as const;
export type ArgumentViewInclude = (typeof ARGUMENT_VIEW_INCLUDES)[number];

export const DEFAULT_INSTANCES_PAGE = 25;
export const MAX_INSTANCES_PAGE = 100;

export const ARGUMENT_VIEW_DESCRIPTION =
  "Open one argument: a line of reasoning to a conclusion, canonical like a claim and belonging to " +
  "no one who makes it (§7). Every read returns `argument`: the conclusion it reaches (the claim " +
  "or quantity, with its page_url), its name, `stance` (for or against the claim; `neutral` on a " +
  "quantity, with `shows`, what it shows about the value), the written form (inline " +
  "[[claim:<id>]] references are its premises), and `retired` (when and why its Steward retired " +
  "it, else null; a retired argument keeps its record). Add sections with `include`: " +
  "`evaluation` (the current rating of the inference, worded conditionally: certain or likely " +
  "if the premises hold, slight or no support even if they hold; whether it is decisive; and " +
  "earlier evaluations, each dated against the assessment or estimate it was made under, with " +
  "`stale` marking one made under a judgment that is no longer current), `premises` (the claims " +
  "it rests on, with their standing), `instances` (where sources make it, attack it or mention " +
  "it, with each passage and how well it states the argument; one page, with `instances_total`). " +
  "Instances are provenance: they do not rate the inference. Free.";

export const ARGUMENT_VIEW_INCLUDE_DESCRIPTION =
  "Sections to add to the base view; none by default. Ask for the ones your work needs.";

export interface ArgumentViewOptions {
  include?: readonly string[];
  instancesLimit?: number;
  instancesOffset?: number;
}

function pageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** The argument view, or null when no argument has this id. */
export async function getArgumentView(
  argumentId: string,
  opts: ArgumentViewOptions = {}
): Promise<Record<string, unknown> | null> {
  const argument = await getArgument(argumentId);
  if (!argument) return null;
  const include = new Set(opts.include ?? []);

  const [conclusion] = await rawQuery<{ id: string; text: string; kind: string }>(
    `SELECT id, text, kind FROM claims WHERE id = $1`,
    [argument.claimId]
  );

  const payload: Record<string, unknown> = {
    argument: {
      id: argument.id,
      conclusion: conclusion
        ? { id: conclusion.id, text: conclusion.text, kind: conclusion.kind, page_url: pageUrl(conclusion.id) }
        : { id: argument.claimId },
      name: argument.name,
      stance: argument.stance,
      ...(argument.shows ? { shows: argument.shows } : {}),
      written_form: argument.content,
      has_written_form: hasWrittenForm(argument),
      created_at: iso(argument.createdAt),
      retired: argument.retiredAt ? { at: iso(argument.retiredAt), reason: argument.retiredReason } : null,
    },
  };

  const sections: Promise<void>[] = [];

  if (include.has("evaluation")) {
    sections.push(
      (async () => {
        const rows = await rawQuery<{
          verdict: string;
          decisive: boolean;
          content: string;
          is_current: boolean;
          stale: boolean;
          assessment_id: string | null;
          estimate_id: string | null;
          created_at: Date;
        }>(
          `SELECT ae.verdict, ae.decisive, ae.content, ae.is_current,
                  ${EVALUATION_STALE_SQL} AS stale,
                  ae.assessment_id, ae.estimate_id, ae.created_at
             FROM argument_evaluations ae
             JOIN arguments a ON a.id = ae.argument_id
             JOIN claims c ON c.id = a.claim_id
             LEFT JOIN assessments ca ON ca.claim_id = a.claim_id AND ca.is_current = true
             LEFT JOIN quantity_estimates cq ON cq.claim_id = a.claim_id AND cq.is_current = true
            WHERE ae.argument_id = $1
            ORDER BY ae.created_at DESC`,
          [argumentId]
        );
        const shape = (r: (typeof rows)[number]) => ({
          verdict: r.verdict,
          decisive: r.decisive,
          content: r.content,
          stale: r.stale,
          assessment_id: r.assessment_id,
          estimate_id: r.estimate_id,
          created_at: iso(r.created_at),
        });
        const current = rows.find((r) => r.is_current);
        payload.evaluation = current ? shape(current) : null;
        payload.evaluation_history = rows.filter((r) => !r.is_current).map(shape);
      })()
    );
  }

  if (include.has("premises")) {
    sections.push(
      (async () => {
        // A live argument's premises are the edges grouped under it. Retiring
        // releases those groupings (#741), so a retired argument's premises
        // are read from its written form's inline references.
        const grouped = await rawQuery<{ id: string; relation_type: string }>(
          `SELECT cr.child_claim_id AS id, cr.relation_type
             FROM argument_subclaims am
             JOIN claim_relationships cr ON cr.id = am.relationship_id
            WHERE am.argument_id = $1
            ORDER BY am.created_at, cr.id`,
          [argumentId]
        );
        const linked = parseClaimLinks(argument.content).map((l) => l.claimId);
        const ids = [...new Set([...grouped.map((g) => g.id), ...linked])];
        if (ids.length === 0) {
          payload.premises = [];
          return;
        }
        const rows = await rawQuery<{
          id: string;
          text: string;
          kind: string;
          status: string | null;
          confidence: number | null;
          credence: number | null;
          estimate: unknown | null;
        }>(
          `SELECT c.id, c.text, c.kind, a.status, a.confidence, a.claim_credence AS credence,
                  qe.estimate
             FROM claims c
             LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
             LEFT JOIN quantity_estimates qe ON qe.claim_id = c.id AND qe.is_current = true
            WHERE c.id = ANY($1::uuid[])`,
          [ids]
        );
        const byId = new Map(rows.map((r) => [r.id, r]));
        const relation = new Map(grouped.map((g) => [g.id, g.relation_type]));
        payload.premises = ids
          .map((id) => byId.get(id))
          .filter((r): r is NonNullable<typeof r> => !!r)
          .map((r) => ({
            id: r.id,
            text: r.text,
            ...(r.kind !== "claim" ? { kind: r.kind } : {}),
            relation: relation.get(r.id) ?? null,
            grouped: relation.has(r.id),
            assessment_status: r.status,
            assessment_confidence: r.confidence,
            assessment_credence: r.credence,
            ...(r.kind === "quantity" ? { estimate: r.estimate } : {}),
            page_url: pageUrl(r.id),
          }));
      })()
    );
  }

  if (include.has("instances")) {
    sections.push(
      (async () => {
        const { total, items } = await listArgumentInstances(argumentId, {
          limit: opts.instancesLimit ?? DEFAULT_INSTANCES_PAGE,
          offset: opts.instancesOffset ?? 0,
        });
        payload.instances = items.map((i) => ({
          id: i.id,
          source: { id: i.source_id, url: i.source_url, title: i.source_title },
          verbatim_text: i.verbatim_text,
          context: i.context,
          stance: i.stance,
          reading: i.reading,
          ...(i.stated_shows ? { stated_shows: i.stated_shows } : {}),
          speaker: i.speaker,
          publication: i.publication,
          source_date: i.source_date,
          link: i.link,
          recorded_by: i.created_by,
          recorded_at: iso(i.created_at),
        }));
        payload.instances_total = total;
      })()
    );
  }

  await Promise.all(sections);
  return payload;
}
