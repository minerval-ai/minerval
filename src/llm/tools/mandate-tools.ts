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
 *  - read_page: one public page in full, for when a search snippet cannot
 *    tell you whether a source matters;
 *  - update_workspace: the mandate's durable working memory
 *    (`grants.workspace`), read back in full at the start of every pass.
 *
 * Follows the null-delegate convention of graph-read-tools: `execute`
 * returns null for a tool that is not its own, so an agent wires it with
 * one spread and one early return. Web search is not here because it is
 * already one implementation for every agent (web-search-tool.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { rawQuery } from "../../db/client.js";
import { surveyScope } from "../../services/scope-survey-service.js";
import {
  READ_PAGE_TOOL_NAME,
  getReadPageToolDefinition,
  executeReadPage,
} from "./read-page-tool.js";
import { stewardTierCostEstimates } from "../../services/cost-estimate-service.js";
import { microUsdToOwls, capOwls } from "../../services/owl.js";

export { READ_PAGE_TOOL_NAME };
export const SURVEY_SCOPE_TOOL_NAME = "survey_scope";
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
}

export function getSurveyScopeToolDefinition(): Tool {
  return {
    name: SURVEY_SCOPE_TOOL_NAME,
    description:
      "Survey a scope (a claim's subtree and/or a keyword query) with the " +
      "allocation signals: importance, contestation, assessment state and " +
      "age, expected gain from another pass, deferred subclaims; most " +
      "valuable first. A search aid, not the scope: the mandate's scope is " +
      "its words. A page at a time; when next_offset is set there is more, " +
      "so pass it as offset.",
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

export function getUpdateWorkspaceToolDefinition(): Tool {
  return {
    name: UPDATE_WORKSPACE_TOOL_NAME,
    description:
      "Rewrite your workspace: your own durable working memory, read " +
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
 * The least a plan's ledger items can cost, in owls: one strong Steward pass
 * for each assess, reassess, and deepen item (a deepen costs more, by the
 * children it releases) and one ingestion for each ingest item, at the
 * estimates the ledger itself prices rows with. The planning pass refuses a
 * plan whose floor already overruns the escrow; it is a backstop, not a
 * quote. The Grantmaker prices plans itself from cost_sheet.
 */
export async function planCostFloorOwls(items: readonly { action: string }[]): Promise<{
  floor_owls: number;
  per_item_owls: { steward_pass: number; ingest: number };
}> {
  const tiers = await stewardTierCostEstimates();
  const pass = microUsdToOwls(tiers.strongMicroUsd);
  const ingest = capOwls("source_ingest");
  let floor = 0;
  for (const it of items) {
    if (it.action === "assess" || it.action === "reassess" || it.action === "deepen") floor += pass;
    else if (it.action === "ingest") floor += ingest;
  }
  return {
    floor_owls: Math.round(floor * 100) / 100,
    per_item_owls: { steward_pass: pass, ingest },
  };
}

/** Rewrite a mandate's workspace; returns the stored length. */
export async function updateGrantWorkspace(
  grantId: string,
  content: string
): Promise<number> {
  const text = String(content ?? "");
  await rawQuery(
    `UPDATE grants SET workspace = $2, updated_at = now() WHERE id = $1`,
    [grantId, text]
  );
  return text.length;
}

export function createMandateTools(options: MandateToolOptions = {}): MandateTools {
  const definitions: Tool[] = [
    getSurveyScopeToolDefinition(),
    getReadPageToolDefinition(),
  ];
  if (options.grantId) definitions.push(getUpdateWorkspaceToolDefinition());

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
        const offset = Math.max(0, Number(toolInput.offset ?? 0) || 0);
        const limit = options.surveyLimit ?? 40;
        const rows = await surveyScope({
          scopeClaimId: useDefaults ? (options.scopeClaimId ?? null) : claimId,
          scopeQuery: useDefaults ? (options.scopeQuery ?? null) : query,
          offset,
          limit,
        });
        // A full page may have more behind it; say where it continues (#689).
        return JSON.stringify({
          count: rows.length,
          next_offset: rows.length === limit ? offset + rows.length : null,
          claims: rows,
        });
      }
      if (name === READ_PAGE_TOOL_NAME) return executeReadPage(name, toolInput);
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
