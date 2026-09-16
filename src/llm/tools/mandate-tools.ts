/**
 * The mandate toolbox — what every agent stewarding a mandate's money and
 * mission needs, whichever mode it is running in (#333).
 *
 * A mandate is stewarded by one Grantmaker in three modes: the granting
 * conversation (grantmaker.ts), the planning pass that drafts a spawned or
 * agent-policy mandate's opening plan (grantor.ts), and the autonomous
 * review pass (mandate-review.ts). Each used to hand-roll its own copy of
 * the same tools, and the planning pass simply lacked most of them: a
 * mandate told to "map the nutrition literature" reached its planner with
 * a graph-only survey, no web, no workspace, and a briefing framed around
 * claim ids rather than its mission. Its plan came back empty. Tools that
 * live here are one implementation in every mode, so the planner sees the
 * world the reviewer sees.
 *
 *  - survey_scope: the graph's allocation signals over a subtree and/or a
 *    keyword slice (services/scope-survey-service.ts);
 *  - estimate_costs: owl quotes for a bundle of work from live metered
 *    averages, so a plan is priced before it is proposed;
 *  - update_workspace: the mandate's durable working memory
 *    (`grants.workspace`), read back in full at the start of every pass.
 *
 * Follows the null-delegate convention of graph-read-tools: `execute`
 * returns null for a tool that is not its own, so an agent wires it with
 * one spread and one early return. Web search and web fetch are not here
 * because they are already one implementation for every agent
 * (web-search-tool.ts, web-fetch-tool.ts), chosen by the model.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { rawQuery } from "../../db/client.js";
import { surveyScope } from "../../services/scope-survey-service.js";
import { stewardTierCostEstimates } from "../../services/cost-estimate-service.js";
import { microUsdToOwls, capOwls } from "../../services/owl.js";

/** Generous but bounded working memory: ~100KB of the agent's own notes. */
export const WORKSPACE_MAX_CHARS = 100_000;

export const SURVEY_SCOPE_TOOL_NAME = "survey_scope";
export const ESTIMATE_COSTS_TOOL_NAME = "estimate_costs";
export const UPDATE_WORKSPACE_TOOL_NAME = "update_workspace";

export interface MandateTools {
  definitions: Tool[];
  /** Null means "not my tool"; the agent's own handlers run after. */
  execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
}

export interface MandateToolOptions {
  /**
   * The mandate whose workspace update_workspace rewrites. Without it the
   * workspace tool is not offered (the granting conversation has no
   * mandate yet).
   */
  grantId?: string | null;
  /**
   * The mandate's declared scope hints (`grants.scope_claim_id` /
   * `scope_query`), used as the survey's default when a call names
   * neither a subtree nor a query. Search aids, never the scope itself.
   */
  scopeClaimId?: string | null;
  scopeQuery?: string | null;
  /** Survey rows per page; default 40. */
  surveyLimit?: number;
  /** Include the estimate's suggested planning overhead line; default true. */
  includeOverhead?: boolean;
}

export function getSurveyScopeToolDefinition(): Tool {
  return {
    name: SURVEY_SCOPE_TOOL_NAME,
    description:
      "Survey a scope (a claim's subtree and/or a keyword query) with the " +
      "allocation signals: importance, contestation, assessment state and " +
      "age, expected gain from another pass, deferred subclaims — most " +
      "valuable first. A search aid, not the scope: the mandate's scope is " +
      "its words. Paginate with offset.",
    input_schema: {
      type: "object" as const,
      properties: {
        claim_id: { type: "string", description: "Subtree root (optional)." },
        query: { type: "string", description: "Keyword slice (optional)." },
        offset: { type: "number" },
      },
      required: [],
    },
  };
}

export function getEstimateCostsToolDefinition(): Tool {
  return {
    name: ESTIMATE_COSTS_TOOL_NAME,
    description:
      "Quote expected costs in owls for a bundle of work, from the live " +
      "metered averages (falling back to priors). Owls map to dollars of " +
      "platform spend one for one; quotes are estimates, and the funder " +
      "pays metered actuals against the escrowed budget. Use before " +
      "proposing or growing a plan.",
    input_schema: {
      type: "object" as const,
      properties: {
        assessments: {
          type: "number",
          description: "Steward passes on unassessed claims (best model).",
        },
        reassessments: { type: "number" },
        deepen_claims: {
          type: "number",
          description:
            "Claims to deepen (each roughly three passes over its subtree).",
        },
        sources_to_ingest: { type: "number" },
      },
      required: [],
    },
  };
}

export function getUpdateWorkspaceToolDefinition(): Tool {
  return {
    name: UPDATE_WORKSPACE_TOOL_NAME,
    description:
      "Rewrite your workspace — your own durable working memory, read " +
      "back to you in full at the start of every pass on this mandate. " +
      "Keep here what a person running this mission would keep in their " +
      "working notes: the map of the territory so far, the source backlog " +
      "and what each yielded, strategy, open questions, what the next pass " +
      "should do. Replaces the whole document; carry forward what still " +
      "matters.",
    input_schema: {
      type: "object" as const,
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  };
}

/**
 * Price a bundle of work in owls. Exported so a planner can hold its own
 * proposal to the same estimate the tool quotes.
 */
export async function estimatePlanCosts(counts: {
  assessments?: number;
  reassessments?: number;
  deepen_claims?: number;
  sources_to_ingest?: number;
}): Promise<{
  unit_estimates: {
    assessment_each_owls: number;
    reassessment_each_owls: number;
    deepen_each_owls: number;
    ingest_each_owls: number;
  };
  subtotal_owls: number;
}> {
  const tiers = await stewardTierCostEstimates();
  const passOwls = microUsdToOwls(tiers.strongMicroUsd);
  const n = (v: unknown) => Math.max(0, Number(v ?? 0) || 0);
  const ingestOwls = capOwls("source_ingest");
  const subtotal =
    (n(counts.assessments) + n(counts.reassessments)) * passOwls +
    n(counts.deepen_claims) * passOwls * 3 +
    n(counts.sources_to_ingest) * ingestOwls;
  return {
    unit_estimates: {
      assessment_each_owls: passOwls,
      reassessment_each_owls: passOwls,
      deepen_each_owls: Math.round(passOwls * 3 * 1000) / 1000,
      ingest_each_owls: ingestOwls,
    },
    subtotal_owls: Math.round(subtotal * 100) / 100,
  };
}

/** Rewrite a mandate's workspace, bounded; returns the stored length. */
export async function updateGrantWorkspace(
  grantId: string,
  content: string
): Promise<number> {
  const bounded = String(content ?? "").slice(0, WORKSPACE_MAX_CHARS);
  await rawQuery(
    `UPDATE grants SET workspace = $2, updated_at = now() WHERE id = $1`,
    [grantId, bounded]
  );
  return bounded.length;
}

export function createMandateTools(options: MandateToolOptions = {}): MandateTools {
  const definitions: Tool[] = [
    getSurveyScopeToolDefinition(),
    getEstimateCostsToolDefinition(),
  ];
  if (options.grantId) definitions.push(getUpdateWorkspaceToolDefinition());
  const includeOverhead = options.includeOverhead ?? true;

  return {
    definitions,
    async execute(name, toolInput) {
      if (name === SURVEY_SCOPE_TOOL_NAME) {
        const claimId =
          typeof toolInput.claim_id === "string" && toolInput.claim_id
            ? toolInput.claim_id
            : null;
        const query =
          typeof toolInput.query === "string" && toolInput.query
            ? toolInput.query
            : null;
        // A call naming nothing surveys the mandate's declared hints; a
        // call naming a subtree or a query surveys exactly that.
        const useDefaults = !claimId && !query;
        const rows = await surveyScope({
          scopeClaimId: useDefaults ? (options.scopeClaimId ?? null) : claimId,
          scopeQuery: useDefaults ? (options.scopeQuery ?? null) : query,
          offset: Number(toolInput.offset ?? 0),
          limit: options.surveyLimit ?? 40,
        });
        return JSON.stringify({ count: rows.length, claims: rows });
      }
      if (name === ESTIMATE_COSTS_TOOL_NAME) {
        const est = await estimatePlanCosts(toolInput as Record<string, number>);
        // Conversation + planning + review overhead rides on the mandate.
        const overhead = Math.max(
          0.25,
          Math.round(est.subtotal_owls * 0.05 * 100) / 100
        );
        return JSON.stringify({
          ...est,
          ...(includeOverhead
            ? {
                suggested_overhead_owls: overhead,
                suggested_total_owls:
                  Math.round((est.subtotal_owls + overhead) * 100) / 100,
              }
            : {}),
          note:
            "Estimates from live metered averages where available, priors " +
            "otherwise. Actual spend is metered; unspent budget refunds.",
        });
      }
      if (name === UPDATE_WORKSPACE_TOOL_NAME && options.grantId) {
        const chars = await updateGrantWorkspace(
          options.grantId,
          String(toolInput.content ?? "")
        );
        return JSON.stringify({ success: true, chars });
      }
      return null;
    },
  };
}
