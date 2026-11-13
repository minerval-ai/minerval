/**
 * What accepting a contribution does beyond recording the decision, in one
 * place (#724). The Reviewer's accept and the Arbitrator's overturn both
 * accept a contribution, so both run these effects: a proposed request is
 * filed in the request's own form, material offered to meet a request is
 * recorded as work on it for its keeper (Part VIII), and an intake proposal
 * is materialized through the Matcher (#157). Before this lived only in the
 * Reviewer's tool, an overturned propose_request read "accepted" with no
 * request on the graph.
 *
 * A prize claim's admission is not here: the Reviewer admits it directly,
 * and an Arbitrator's overturn is admitted by the prize worker
 * (reconcileArbitratedAdmissions).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { rawQuery } from "../db/client.js";
import { fileRequest, getRequest, notifyRequestKeeper, recordWork } from "./request-service.js";
import {
  isIntakeContributionType,
  materializeAcceptedIntake,
  type IntakeMaterializationResult,
} from "./intake-service.js";
import { getContributionById, MANDATE_LABEL } from "./contribution-service.js";

type SchemaProperty = Anthropic.Tool["input_schema"]["properties"];

/**
 * The `request` and `request_id` parameters both accepting tools take, so
 * the Reviewer and the Arbitrator file a request in the same form.
 */
export function acceptanceSchemaProperties(): NonNullable<SchemaProperty> {
  return {
    request: {
      type: "object",
      description:
        "Required to accept a propose_request: the request as it will be filed, in your " +
        "words from the contributor's (Part VIII). ask, why (what the judgments it bears " +
        "on would become under its outcomes), satisfied_by; who_could and addressed_to " +
        "where known. A request that asks for a particular result is restated to ask for " +
        "what would decide the matter either way. bears_on: the nodes and sources it bears " +
        "on (claim_ids, source_ids), and in text anything it bears on that the graph does " +
        "not hold yet; omitted, it bears on the contribution's target, or is described " +
        "from the contribution in words when there is none. budget_usd: what doing it " +
        "should cost, when the contributor stated one you judge plausible for the work (the " +
        "costing skill says how to check one); omit it otherwise, and a scoping pass will " +
        "quote it.",
      properties: {
        ask: { type: "string" },
        why: { type: "string" },
        satisfied_by: { type: "string" },
        who_could: { type: "string" },
        addressed_to: { type: "string" },
        budget_usd: { type: "number" },
        bears_on: {
          type: "object",
          properties: {
            claim_ids: { type: "array", items: { type: "string" } },
            source_ids: { type: "array", items: { type: "string" } },
            text: { type: "string" },
          },
        },
      },
      required: ["ask", "why", "satisfied_by"],
    },
    request_id: {
      type: "string",
      description:
        "Required to accept an answer_request: the request the material is offered for.",
    },
  };
}

export type AcceptanceEffects =
  | { ok: true; note: string; materialization: IntakeMaterializationResult | null }
  | { ok: false; error: string };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ids = (v: unknown) =>
  Array.isArray(v) ? v.map((x) => text(x)).filter(Boolean) : [];

/**
 * Check what accepting needs before anything is written, so a refusal
 * leaves the contribution untouched. Returns the error to show, or null.
 */
export async function checkAcceptanceInput(
  contributionId: string,
  input: Record<string, unknown>
): Promise<string | null> {
  const c = await getContributionById(contributionId);
  if (!c) return `Contribution ${contributionId} not found.`;
  if (c.contributionType === "propose_request") {
    const r = (input.request ?? null) as Record<string, unknown> | null;
    if (!r || !text(r.ask) || !text(r.why) || !text(r.satisfied_by)) {
      return (
        "Accepting a propose_request needs request: {ask, why, satisfied_by}, the request as " +
        "it will be filed. Nothing was recorded."
      );
    }
  }
  if (c.contributionType === "answer_request") {
    const requestId = text(input.request_id);
    if (!requestId || !(await getRequest(requestId))) {
      return "Accepting an answer_request needs request_id, the request the material is offered for. Nothing was recorded.";
    }
  }
  return null;
}

/**
 * Run the effects of accepting `contributionId`. Refusals come back before
 * anything is written; the intake materialization is idempotent, so a retry
 * after a partial failure is safe.
 */
export async function applyAcceptanceEffects(
  contributionId: string,
  input: Record<string, unknown>
): Promise<AcceptanceEffects> {
  const refusal = await checkAcceptanceInput(contributionId, input);
  if (refusal) return { ok: false, error: refusal };
  const c = (await getContributionById(contributionId))!;
  let note = "";

  if (c.contributionType === "propose_request") {
    const r = input.request as Record<string, unknown>;
    const bears = (r.bears_on ?? {}) as Record<string, unknown>;
    const named = ids(bears.claim_ids);
    const claimIds = named.length > 0 ? named : c.claimId ? [c.claimId] : [];
    const sourceIds = ids(bears.source_ids);
    // A request bears on what it names; where it names nothing the graph
    // holds, it says so in words (Part VIII), from the contribution itself
    // when the reviewer gave none.
    const bearsOnText =
      text(bears.text) ||
      (claimIds.length === 0 && sourceIds.length === 0 ? c.content.slice(0, 1000) : "");
    try {
      const filed = await fileRequest({
        ask: text(r.ask),
        why: text(r.why),
        satisfiedBy: text(r.satisfied_by),
        budgetUsd: typeof r.budget_usd === "number" && r.budget_usd > 0 ? r.budget_usd : null,
        whoCould: text(r.who_could) || null,
        addressedTo: text(r.addressed_to) || null,
        claimIds,
        sourceIds,
        bearsOnText: bearsOnText || null,
        // A mandate proposes under the mandate (Part VIII).
        filer: c.grantId
          ? { kind: "mandate", grantId: c.grantId }
          : { kind: "contributor", contributorId: c.contributorId },
      });
      note = ` Request ${filed.id} filed.`;
    } catch (err) {
      return {
        ok: false,
        error: `The request could not be filed (${err instanceof Error ? err.message : String(err)}). Nothing was recorded.`,
      };
    }
  }

  if (c.contributionType === "answer_request") {
    const requestId = text(input.request_id);
    const [contributor] = await rawQuery<{ display_name: string }>(
      `SELECT display_name FROM contributors WHERE id = $1`,
      [c.contributorId]
    );
    await recordWork({
      requestId,
      byLabel: c.grantId ? MANDATE_LABEL : (contributor?.display_name ?? "a contributor"),
      contributorId: c.grantId ? null : c.contributorId,
      fundedByJobId: c.fundedByJobId ?? null,
      outcome: null,
      summary: c.content.slice(0, 4000),
    });
    await notifyRequestKeeper(requestId, `a contributor offered material for it (contribution ${contributionId}).`);
    note = ` Recorded as work on request ${requestId}; its keeper is notified.`;
  }

  // A published page's submission (docs/published-pages.md): admitting it
  // attaches the page to the node as a source and tells the node's Steward.
  // Idempotent: a page already attached is not attached twice.
  if (c.contributionType === "add_instance" && c.reviewStatus !== "accepted") {
    const { publicationOfContribution, takeIn } = await import("./published-page-service.js");
    const publishedPageId = await publicationOfContribution(contributionId);
    if (publishedPageId) {
      const taken = await takeIn(publishedPageId, { first: true });
      note = taken.attached
        ? " The published page is attached to the node as a source, and the node's Steward has been told; do not call notify_claim_steward."
        : " The publication is admitted to the node's record and its Steward has been told; no page has been released yet, so there is nothing to attach. Do not call notify_claim_steward.";
    }
  }

  const materialization = isIntakeContributionType(c.contributionType)
    ? await materializeAcceptedIntake(contributionId)
    : null;
  return { ok: true, note, materialization };
}
