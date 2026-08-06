/**
 * The Grantmaker agent — the granting conversation (issue: owl economy,
 * corrected model).
 *
 * Grantmaking is not a form. A funder talks their mandate through with this
 * agent the way they would delegate a project to a capable colleague in
 * plan mode: the agent surveys the graph, asks what it needs to, pushes
 * back where judgment differs, quotes expected costs in owls from the live
 * cost estimates, and either drafts a concrete mandate (propose_mandate) or
 * refuses one it must not accept (decline_mandate). Nothing runs and no owl
 * moves until the funder explicitly funds the drafted mandate
 * (grant-conversation-service.fundConversationMandate).
 *
 * The agent runs on the best available model with the full constitution as
 * Layer 1 of its prompt. Its loyalty ordering is explicit in the role
 * prompt: the integrity of the claim graph and the truth outrank the
 * funder, and ideology-warping mandates are declined outright.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { getGrantmakerSystemPrompt } from "../prompts/grantmaker.js";
import { surveyScope } from "./grantor.js";
import { stewardTierCostEstimates } from "../../services/cost-estimate-service.js";
import { microUsdToOwls, capOwls } from "../../services/owl.js";
import type { PlanItem } from "../../services/grant-service.js";
import { getMandatePipeline } from "../../services/mandate-service.js";
import {
  getJobContributions,
  getJobSpentMicroUsd,
} from "../../services/budget-job-service.js";

export interface GrantMandate {
  /** Agent-written working title, shown only on the funder's dashboard. */
  title: string;
  objective: string;
  scope_claim_id?: string | null;
  scope_query?: string | null;
  plan: { strategy: string; items: PlanItem[] };
  expected_cost_owls: number;
  notes?: string;
}

export interface GrantmakerTurnResult {
  reply: string;
  mandate?: GrantMandate;
  declined?: { reason: string };
}

const PLAN_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["assess", "reassess", "deepen", "ingest"],
    },
    claim_id: {
      type: "string",
      description: "Required for assess/reassess/deepen; omit for ingest.",
    },
    url: {
      type: "string",
      description: "Required for ingest; the source URL to extract and match.",
    },
    rationale: { type: "string" },
  },
  required: ["action", "rationale"],
};

const MANDATE_SCHEMA = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      description:
        "Your working title for the funder's dashboard. Never shown on " +
        "claim pages.",
    },
    objective: {
      type: "string",
      description: "One paragraph: what this mandate is for, in plain terms.",
    },
    scope_claim_id: {
      type: "string",
      description: "Optional subtree root the mandate is scoped to.",
    },
    scope_query: {
      type: "string",
      description: "Optional keyword scope for coverage selectors.",
    },
    plan: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          description:
            "How you read the scope and why this allocation maximizes " +
            "epistemic value per owl.",
        },
        items: {
          type: "array",
          description: "The work, in execution order.",
          items: PLAN_ITEM_SCHEMA,
        },
      },
      required: ["strategy", "items"],
    },
    expected_cost_owls: {
      type: "number",
      description:
        "Your honest total estimate in owls, from estimate_costs, including " +
        "overhead. The funder will be asked to escrow at least this.",
    },
    notes: {
      type: "string",
      description:
        "Anything the funder should know: uncertainties in the estimate, " +
        "what you deliberately left out, what a top-up would buy next.",
    },
  },
  required: ["title", "objective", "plan", "expected_cost_owls"],
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mechanical mandate validation; exported for tests. */
export function validateMandate(raw: GrantMandate): string | null {
  if (!raw.title?.trim()) return "title is required";
  if (!raw.objective?.trim()) return "objective is required";
  if (!raw.plan?.items?.length) return "the plan needs at least one item";
  if (!(raw.expected_cost_owls > 0)) {
    return "expected_cost_owls must be positive";
  }
  for (const item of raw.plan.items) {
    if (item.action === "ingest") {
      if (!item.url || !/^https?:\/\//.test(item.url)) {
        return `ingest item needs an http(s) url (got: ${item.url ?? "none"})`;
      }
    } else if (!item.claim_id || !UUID_RE.test(item.claim_id)) {
      return `${item.action} item needs a claim_id from your survey results`;
    }
  }
  return null;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

// Tag every LLM call for the meter; callers add identity context.
export function runGrantmakerTurn(
  input: Parameters<typeof runGrantmakerTurnImpl>[0]
): ReturnType<typeof runGrantmakerTurnImpl> {
  return withAgent("grantmaker", () => runGrantmakerTurnImpl(input));
}

async function runGrantmakerTurnImpl(input: {
  transcript: TranscriptMessage[];
  model?: string;
  /**
   * Set once the conversation's mandate is funded: the live grant this
   * conversation now manages. Unlocks the analytics and plan-adjustment
   * tools, scoped to this grant.
   */
  grantId?: string;
}): Promise<GrantmakerTurnResult> {
  const config = loadConfig();

  const searchTool: Tool = {
    name: "search_claims",
    description:
      "Search the graph's claims by keywords. Returns matches with their " +
      "assessment state, importance, and contestation, most consequential " +
      "first. Use this to find scope roots and to see what already exists.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results, default 15." },
      },
      required: ["query"],
    },
  };
  const surveyTool: Tool = {
    name: "survey_scope",
    description:
      "Survey a scope (a claim's subtree and/or a keyword query) with the " +
      "allocation signals: importance, contestation, assessment state and " +
      "age, expected gain from another pass, deferred subclaims. Paginate " +
      "with offset.",
    input_schema: {
      type: "object" as const,
      properties: {
        claim_id: { type: "string", description: "Subtree root (optional)." },
        query: { type: "string", description: "Keyword scope (optional)." },
        offset: { type: "number" },
      },
      required: [],
    },
  };
  const costTool: Tool = {
    name: "estimate_costs",
    description:
      "Quote expected costs in owls for a bundle of work, from the live " +
      "metered averages (falling back to priors). Owls map to dollars of " +
      "platform spend one for one; quotes are estimates, and the funder " +
      "pays metered actuals against the escrowed budget.",
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
  const proposeTool: Tool = {
    name: "propose_mandate",
    description:
      "Record the drafted mandate for the funder to fund. Call this once " +
      "the conversation has converged; then summarize the draft in your " +
      "reply and tell the funder that funding it escrows the budget.",
    input_schema: MANDATE_SCHEMA as Tool["input_schema"],
  };
  const declineTool: Tool = {
    name: "decline_mandate",
    description:
      "Refuse the mandate this conversation is asking for, because it " +
      "conflicts with the integrity of the graph or attempts to influence " +
      "its conclusions or ideology. The reason is recorded. Tell the " +
      "funder directly in your reply; the conversation may continue toward " +
      "an acceptable goal.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "A reason you would be comfortable publishing.",
        },
      },
      required: ["reason"],
    },
  };

  // Management tools, available once the mandate is funded: full
  // visibility into the live grant and near-total control of its remaining
  // plan, within the framework (never past the escrowed budget, never
  // into verdicts or importance).
  const overviewTool: Tool = {
    name: "grant_overview",
    description:
      "The live state of this conversation's funded grant: budget, metered " +
      "spend, status, contributors, and the plan with each item's " +
      "execution state.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };
  const fundedTool: Tool = {
    name: "list_funded_assessments",
    description:
      "The assessments this grant has paid for so far, newest first, with " +
      "status, credence, importance, and cost attribution.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description: "Optional status filter (supported, contradicted, …).",
        },
        limit: { type: "number", description: "Max rows, default 30." },
      },
      required: [],
    },
  };
  const pipelineTool: Tool = {
    name: "ingestion_report",
    description:
      "The grant's ingestion pipeline: each source brought in, extraction " +
      "status, how many claims it linked or minted, how many are assessed, " +
      "average and max importance, contested counts, and an importance " +
      "histogram per source. Use this for 'where are the claims coming " +
      "from' and source-quality questions.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };
  const sourceClaimsTool: Tool = {
    name: "claims_from_source",
    description:
      "The claims linked to one ingested source (by source_id from " +
      "ingestion_report), with importance, contestation, assessment state, " +
      "and stance. For digging into a specific source.",
    input_schema: {
      type: "object" as const,
      properties: {
        source_id: { type: "string" },
        limit: { type: "number", description: "Max rows, default 40." },
      },
      required: ["source_id"],
    },
  };
  const distributionTool: Tool = {
    name: "importance_distribution",
    description:
      "Importance and contestation distribution over the claims this " +
      "grant's work has touched (funded assessments plus ingested-source " +
      "claims): decile histogram, mean, and counts by assessment status. " +
      "For data-analytics questions about the mandate's yield.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };
  const adjustTool: Tool = {
    name: "adjust_plan",
    description:
      "Replace the NOT-YET-EXECUTED remainder of the grant's plan with new " +
      "items (already-executed items are immutable history). Use this when " +
      "the funder and you agree the mandate's remaining budget should be " +
      "spent differently. Same item rules as propose_mandate; the same " +
      "refusal duties apply. Does not change the budget.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The new remaining plan, in execution order.",
          items: PLAN_ITEM_SCHEMA,
        },
        note: {
          type: "string",
          description: "One sentence recorded with the amendment: why.",
        },
      },
      required: ["items", "note"],
    },
  };

  let mandate: GrantMandate | undefined;
  let declined: { reason: string } | undefined;

  const managed = !!input.grantId;
  const tools: Tool[] = [
    searchTool,
    surveyTool,
    costTool,
    ...(managed
      ? [
          overviewTool,
          fundedTool,
          pipelineTool,
          sourceClaimsTool,
          distributionTool,
          adjustTool,
        ]
      : [proposeTool, declineTool]),
  ];

  const system = managed
    ? getGrantmakerSystemPrompt() +
      `\n\n## Management mode\n\n` +
      `This conversation's mandate is funded and live. You have full ` +
      `visibility into its execution through your grant tools and ` +
      `near-total control of the remaining plan through adjust_plan, ` +
      `within the framework: you cannot spend past the escrowed budget, ` +
      `cannot touch verdicts or importance, and the refusal duties that ` +
      `govern new mandates govern adjustments equally. Answer data ` +
      `questions from tool results, never from memory; give real numbers. ` +
      `Discuss the technical setup as deeply as the funder wants: you can ` +
      `see the pipeline, the sources, the claims, and the spend.`
    : getGrantmakerSystemPrompt();

  const result = await toolUseLoop({
    initialMessages: input.transcript.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools,
    system,
    model: input.model ?? config.grantmakerModel,
    maxTokens: 4096,
    maxIterations: 16,
    executeTool: async (name, toolInput) => {
      if (name === "search_claims") {
        const limit = Math.min(30, Math.max(1, Number(toolInput.limit ?? 15)));
        const rows = await rawQuery(
          `SELECT c.id, c.text, c.importance, c.contestation,
                  c.steward_state,
                  a.status AS assessment_status,
                  CASE WHEN a.assessed_at IS NULL THEN NULL
                       ELSE FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at))
                                  / 86400)::int END AS days_since_assessed
             FROM claims c
             LEFT JOIN assessments a
               ON a.claim_id = c.id AND a.is_current = true
            WHERE c.state = 'active'
              AND c.text_search @@ websearch_to_tsquery('english', $1)
            ORDER BY c.importance DESC
            LIMIT $2`,
          [String(toolInput.query ?? ""), limit]
        );
        return JSON.stringify({ count: rows.length, claims: rows });
      }
      if (name === "survey_scope") {
        const rows = await surveyScope({
          scopeClaimId:
            typeof toolInput.claim_id === "string" && toolInput.claim_id
              ? toolInput.claim_id
              : null,
          scopeQuery:
            typeof toolInput.query === "string" && toolInput.query
              ? toolInput.query
              : null,
          offset: Number(toolInput.offset ?? 0),
          limit: 40,
        });
        return JSON.stringify({ count: rows.length, claims: rows });
      }
      if (name === "estimate_costs") {
        const tiers = await stewardTierCostEstimates();
        const passOwls = microUsdToOwls(tiers.strongMicroUsd);
        const n = (v: unknown) => Math.max(0, Number(v ?? 0) || 0);
        const assessments = n(toolInput.assessments);
        const reassessments = n(toolInput.reassessments);
        const deepen = n(toolInput.deepen_claims);
        const sources = n(toolInput.sources_to_ingest);
        const ingestOwls = capOwls("source_ingest");
        const lines = {
          assessment_each_owls: passOwls,
          reassessment_each_owls: passOwls,
          deepen_each_owls: Math.round(passOwls * 3 * 1000) / 1000,
          ingest_each_owls: ingestOwls,
        };
        const subtotal =
          (assessments + reassessments) * passOwls +
          deepen * passOwls * 3 +
          sources * ingestOwls;
        // Conversation + planning overhead rides on the mandate.
        const overhead = Math.max(0.25, Math.round(subtotal * 0.05 * 100) / 100);
        return JSON.stringify({
          unit_estimates: lines,
          subtotal_owls: Math.round(subtotal * 100) / 100,
          suggested_overhead_owls: overhead,
          suggested_total_owls: Math.round((subtotal + overhead) * 100) / 100,
          note:
            "Estimates from live metered averages where available, priors " +
            "otherwise. Actual spend is metered; unspent budget refunds.",
        });
      }
      if (name === "propose_mandate") {
        const raw = toolInput as unknown as GrantMandate;
        const problem = validateMandate(raw);
        if (problem) return JSON.stringify({ success: false, problem });
        mandate = {
          title: String(raw.title).slice(0, 200),
          objective: String(raw.objective),
          scope_claim_id: raw.scope_claim_id || null,
          scope_query: raw.scope_query || null,
          plan: raw.plan,
          expected_cost_owls: raw.expected_cost_owls,
          ...(raw.notes ? { notes: String(raw.notes) } : {}),
        };
        return JSON.stringify({
          success: true,
          recorded_items: mandate.plan.items.length,
        });
      }
      if (name === "decline_mandate") {
        declined = { reason: String(toolInput.reason ?? "") };
        return JSON.stringify({ success: true });
      }
      if (managed && input.grantId) {
        const out = await executeManagementTool(input.grantId, name, toolInput);
        if (out != null) return out;
      }
      return `Unknown tool: ${name}`;
    },
  });

  const reply = (result?.content ?? "").trim();
  return {
    reply:
      reply ||
      "I recorded that. Tell me more about what you want this mandate to do.",
    ...(mandate ? { mandate } : {}),
    ...(declined ? { declined } : {}),
  };
}

/**
 * The funded-grant tool surface: live analytics over exactly the data the
 * public dashboard shows, plus the one write the framework allows
 * (amending the unexecuted remainder of the plan). Returns null for tool
 * names it doesn't own.
 */
async function executeManagementTool(
  grantId: string,
  name: string,
  toolInput: Record<string, unknown>
): Promise<string | null> {
  if (name === "grant_overview") {
    const [grant] = await rawQuery<{
      status: string;
      plan: { strategy?: string; items?: PlanItem[] } | null;
      plan_cursor: number;
      budget_job_id: string;
      budget_micro_usd: number;
      job_status: string;
    }>(
      `SELECT g.status, g.plan, g.plan_cursor, g.budget_job_id,
              j.budget_micro_usd, j.status AS job_status
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
        WHERE g.id = $1`,
      [grantId]
    );
    if (!grant) return JSON.stringify({ error: "grant not found" });
    const spent = await getJobSpentMicroUsd(grant.budget_job_id);
    const contributions = await getJobContributions(grant.budget_job_id);
    return JSON.stringify({
      status: grant.status,
      budget_status: grant.job_status,
      budget_owls: microUsdToOwls(Number(grant.budget_micro_usd)),
      spent_owls: microUsdToOwls(spent),
      remaining_owls: microUsdToOwls(
        Math.max(0, Number(grant.budget_micro_usd) - spent)
      ),
      contributors: contributions.length,
      strategy: grant.plan?.strategy ?? null,
      plan: (grant.plan?.items ?? []).map((item, i) => ({
        ...item,
        state:
          i < grant.plan_cursor
            ? "done"
            : i === grant.plan_cursor
              ? "current"
              : "queued",
      })),
    });
  }
  if (name === "list_funded_assessments") {
    const limit = Math.min(100, Math.max(1, Number(toolInput.limit ?? 30)));
    const status =
      typeof toolInput.status === "string" && toolInput.status
        ? toolInput.status
        : null;
    const rows = await rawQuery(
      `SELECT a.claim_id, c.text, a.status, a.claim_credence, c.importance,
              c.contestation, a.assessed_at
         FROM assessments a
         JOIN grants g ON g.id = $1
         JOIN claims c ON c.id = a.claim_id
        WHERE a.funded_by_job_id = g.budget_job_id
          AND ($2::text IS NULL OR a.status = $2)
        ORDER BY a.assessed_at DESC
        LIMIT $3`,
      [grantId, status, limit]
    );
    return JSON.stringify({ count: rows.length, assessments: rows });
  }
  if (name === "ingestion_report") {
    const pipeline = await getMandatePipeline(grantId);
    return JSON.stringify({ sources: pipeline.length, pipeline });
  }
  if (name === "claims_from_source") {
    const limit = Math.min(100, Math.max(1, Number(toolInput.limit ?? 40)));
    const rows = await rawQuery(
      `SELECT ci.claim_id, cl.text, cl.importance, cl.contestation,
              cl.steward_state, ci.stance,
              a.status AS assessment_status
         FROM claim_instances ci
         JOIN grant_sources gs
           ON gs.source_id = ci.source_id AND gs.grant_id = $1
         JOIN claims cl ON cl.id = ci.claim_id AND cl.state = 'active'
         LEFT JOIN assessments a
           ON a.claim_id = ci.claim_id AND a.is_current = true
        WHERE ci.source_id = $2
        ORDER BY cl.importance DESC
        LIMIT $3`,
      [grantId, String(toolInput.source_id ?? ""), limit]
    );
    return JSON.stringify({ count: rows.length, claims: rows });
  }
  if (name === "importance_distribution") {
    const [row] = await rawQuery<Record<string, unknown>>(
      `WITH touched AS (
         SELECT DISTINCT cl.id, cl.importance, cl.contestation,
                a.status AS assessment_status
           FROM grants g
           LEFT JOIN assessments fa ON fa.funded_by_job_id = g.budget_job_id
           LEFT JOIN grant_sources gs ON gs.grant_id = g.id
           LEFT JOIN claim_instances ci ON ci.source_id = gs.source_id
           JOIN claims cl
             ON cl.id = COALESCE(fa.claim_id, ci.claim_id)
            AND cl.state = 'active'
           LEFT JOIN assessments a
             ON a.claim_id = cl.id AND a.is_current = true
          WHERE g.id = $1
       )
       SELECT COUNT(*)::int AS claims,
              ROUND(AVG(importance)::numeric, 3) AS mean_importance,
              ROUND(AVG(contestation)::numeric, 3) AS mean_contestation,
              array_agg_hist AS importance_deciles,
              statuses
         FROM touched,
       LATERAL (
         SELECT array_agg(n ORDER BY bucket) AS array_agg_hist FROM (
           SELECT width_bucket(importance, 0, 1.0001, 10) AS bucket,
                  COUNT(*)::int AS n
             FROM touched GROUP BY 1) h
       ) hist,
       LATERAL (
         SELECT jsonb_object_agg(COALESCE(assessment_status, 'unassessed'), n)
                AS statuses
           FROM (SELECT assessment_status, COUNT(*)::int AS n
                   FROM touched GROUP BY 1) s
       ) st
       GROUP BY array_agg_hist, statuses`,
      [grantId]
    );
    return JSON.stringify(row ?? { claims: 0 });
  }
  if (name === "adjust_plan") {
    const items = (toolInput.items ?? []) as PlanItem[];
    const note = String(toolInput.note ?? "").trim();
    if (!note) return JSON.stringify({ success: false, problem: "note required" });
    const probe: GrantMandate = {
      title: "x",
      objective: "x",
      plan: { strategy: "x", items },
      expected_cost_owls: 1,
    };
    const problem = validateMandate(probe);
    if (problem) return JSON.stringify({ success: false, problem });
    const rows = await rawQuery<{ plan_cursor: number }>(
      `UPDATE grants g
          SET plan = jsonb_set(
                COALESCE(g.plan, '{}'::jsonb), '{items}',
                (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                   FROM jsonb_array_elements(
                     COALESCE(g.plan->'items', '[]'::jsonb)) WITH ORDINALITY t(e, i)
                  WHERE t.i <= g.plan_cursor) || $2::jsonb),
              updated_at = now()
        WHERE g.id = $1 AND g.status = 'active'
        RETURNING g.plan_cursor`,
      [grantId, JSON.stringify(items)]
    );
    if (rows.length === 0) {
      return JSON.stringify({
        success: false,
        problem: "grant is not active; the plan can no longer be amended",
      });
    }
    return JSON.stringify({
      success: true,
      executed_items_kept: rows[0]!.plan_cursor,
      new_remaining_items: items.length,
      note_recorded: note,
    });
  }
  return null;
}
