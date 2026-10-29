/**
 * Node kinds and requests (constitution §2, §3, §7a, §10, Part VIII): the
 * vocabularies and the shapes of the JSON the kinds tables hold. Every write
 * path validates through these schemas, so a stored estimate, unit or
 * value-shown always reads back in the shape the API serves.
 *
 * Kept apart from src/schemas/common.ts on purpose: RELATION_TYPES and
 * INSTANCE_STANCES there are the vocabularies the Steward's and Curator's
 * tools offer today, and the kinds' relations and stances join those tools
 * only when the tools that write them do.
 */
import { z } from "zod";

export const NODE_KINDS = ["claim", "quantity", "question"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const nodeKindEnum = z.enum(NODE_KINDS);

/**
 * Edges between kinds, in claim_relationships with the parent depending on
 * the child as everywhere else: a cut claim on the quantity it cuts is
 * recorded in quantity_cuts rather than as an edge; a question on each of
 * its answers ('answers') and on each of its subquestions ('part_of'). A
 * question's presuppositions are ordinary 'assumes' or 'requires' edges.
 */
export const KIND_RELATION_TYPES = ["answers", "part_of"] as const;
export type KindRelationType = (typeof KIND_RELATION_TYPES)[number];

export const ANSWER_BASES = ["quality", "prominence", "both"] as const;
export type AnswerBasis = (typeof ANSWER_BASES)[number];

/** Instance stances for the kinds: a source states a quantity's value, asks a question, or answers it. */
export const KIND_INSTANCE_STANCES = ["states", "asks", "answers"] as const;
export type KindInstanceStance = (typeof KIND_INSTANCE_STANCES)[number];

export const QUESTION_STANDINGS = ["answered", "leaning", "open", "ill_posed", "unknown"] as const;
export type QuestionStanding = (typeof QUESTION_STANDINGS)[number];

export const ANSWER_RELATIONS = ["excludes", "compatible"] as const;
export type AnswerRelationKind = (typeof ANSWER_RELATIONS)[number];

export const REQUEST_STATES = [
  "open",
  "addressed",
  "in_progress",
  "met",
  "declined",
  "withdrawn",
  "moot",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
/** States a request does not leave once it reaches them. */
export const CLOSED_REQUEST_STATES: readonly RequestState[] = ["met", "declined", "withdrawn", "moot"];

export const REQUEST_OUTCOMES = [
  "met",
  "partly_met",
  "negative",
  "cannot_be_met",
  "declined",
  "revise",
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

export const REQUEST_FILER_KINDS = ["admin", "contributor", "mandate"] as const;
export type RequestFilerKind = (typeof REQUEST_FILER_KINDS)[number];

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

const finite = z.number().finite();

export const QUANTITY_UNIT_KINDS = [
  "proportion",
  "count",
  "currency",
  "temperature",
  "year",
  "duration",
  "rate",
  "measure",
] as const;

export const quantityUnitSchema = z
  .object({
    kind: z.enum(QUANTITY_UNIT_KINDS),
    symbol: z.string().min(1).nullish(),
    noun: z.string().min(1).nullish(),
    currency: z.string().min(1).nullish(),
    per: z.string().min(1).nullish(),
    scale: z.enum(["linear", "log"]).nullish(),
    min: finite.nullish(),
    max: finite.nullish(),
  })
  .strict()
  .refine((u) => u.min == null || u.max == null || u.min < u.max, {
    message: "min must be below max",
  })
  .refine((u) => u.kind !== "currency" || !!u.currency, {
    message: "a currency unit names its currency",
  })
  .refine((u) => u.kind !== "rate" || !!u.per, {
    message: "a rate names what it is per",
  });
export type QuantityUnit = z.infer<typeof quantityUnitSchema>;

export const quantityDefinitionSchema = z
  .object({
    measures: z.string().trim().min(1),
    population: z.string().trim().min(1).nullish(),
    conditions: z.string().trim().min(1).nullish(),
    unit: quantityUnitSchema,
  })
  .strict();
export type QuantityDefinitionInput = z.infer<typeof quantityDefinitionSchema>;

export const ESTIMATE_FORMS = ["distribution", "interval", "bound", "magnitude", "point", "none"] as const;

const quantileSchema = z.object({ p: z.number().gt(0).lt(1), v: finite }).strict();

/**
 * The graph's estimate of a quantity, or a source's statement of it, at the
 * precision the evidence supports (§10). Each form requires its own figures;
 * `outside` is the share of probability on no value at all.
 */
export const quantityEstimateSchema = z
  .object({
    form: z.enum(ESTIMATE_FORMS),
    quantiles: z.array(quantileSchema).optional(),
    low: finite.nullish(),
    high: finite.nullish(),
    level: z.number().gt(0).lt(1).nullish(),
    central: finite.nullish(),
    bound: z.object({ side: z.enum(["above", "below"]), value: finite }).strict().nullish(),
    magnitude: finite.nullish(),
    shape: z.string().min(1).nullish(),
    reason: z.string().trim().min(1).nullish(),
    outside: z
      .object({ share: z.number().min(0).lt(1), meaning: z.string().trim().min(1) })
      .strict()
      .nullish(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    switch (e.form) {
      case "distribution": {
        const q = e.quantiles ?? [];
        need(q.length >= 2, "a distribution gives at least two quantiles");
        for (let i = 1; i < q.length; i++) {
          need(q[i]!.p > q[i - 1]!.p, "quantiles run in increasing p");
          need(q[i]!.v >= q[i - 1]!.v, "quantile values do not decrease");
        }
        break;
      }
      case "interval":
        need(e.low != null && e.high != null, "an interval gives low and high");
        need(e.low == null || e.high == null || e.low <= e.high, "an interval's low is not above its high");
        break;
      case "bound":
        need(e.bound != null, "a bound gives its side and value");
        break;
      case "magnitude":
        need(e.magnitude != null, "an order of magnitude gives its power of ten");
        break;
      case "point":
        need(e.central != null, "a point estimate gives its figure");
        break;
      case "none":
        need(!!e.reason, "an estimate with no figure says why");
        break;
    }
    if (e.central != null && e.low != null && e.high != null) {
      need(e.low <= e.central && e.central <= e.high, "the central figure lies within low and high");
    }
  });
export type QuantityEstimate = z.infer<typeof quantityEstimateSchema>;

/**
 * A place on a value's axis: a figure ("at", or "about" it), a range
 * ("between"), or a side of a figure ("above", "below"; `inclusive` reads
 * "at least" or "at most"). A figure or a lower bound sits in `low`, an
 * upper bound in `high`.
 */
export const valueRangeSchema = z
  .object({
    side: z.enum(["at", "about", "between", "above", "below"]),
    low: finite.nullish(),
    high: finite.nullish(),
    inclusive: z.boolean().nullish(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    switch (r.side) {
      case "at":
      case "about":
      case "above":
        need(r.low != null && r.high == null, `"${r.side}" gives its figure in low only`);
        break;
      case "below":
        need(r.high != null && r.low == null, `"below" gives its figure in high only`);
        break;
      case "between":
        need(r.low != null && r.high != null && r.low < r.high, `"between" gives low below high`);
        break;
    }
  });

/** What an argument about a quantity shows about its value (§7): the Steward's words, and a range where there is one. */
export const valueShownSchema = z
  .object({ text: z.string().trim().min(1), range: valueRangeSchema.nullish() })
  .strict();
export type ValueShown = z.infer<typeof valueShownSchema>;
