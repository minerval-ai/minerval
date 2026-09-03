/**
 * The Grantor agent — a funder's allocator (grant policy 'agent').
 *
 * Given a mandate (scope + budget), it surveys the scope's claims — their
 * importance, contestation, assessment state, staleness, expected yield —
 * and proposes an ALLOCATION PLAN: which claims to spend the budget's
 * attention on, in what order, and why. It allocates; it never assesses.
 * The plan is a proposal: nothing runs and no owl is spent until the funder
 * approves it (grant-service.approveGrantPlan), and execution is then
 * mechanical (grant-pipeline.ts) — ordinary Steward runs under the ordinary
 * constitution, with the grant's funding disclosed on every assessment it
 * pays for.
 *
 * The agent's judgment is the essay's marginal-value estimate made
 * conversational: prefer contested, consequential, unassessed or stale
 * claims where another pass buys real epistemic movement; skip settled
 * scaffolding a formula might naively fund.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { RAISING_ISSUES_POLICIES } from "../prompts/policies.js";
import type { PlanItem } from "../../services/grant-service.js";

export interface GrantorPlan {
  strategy: string;
  items: PlanItem[];
}

const PLAN_SCHEMA = {
  type: "object" as const,
  properties: {
    strategy: {
      type: "string",
      description:
        "A short public note to the funder: how you read the scope and why " +
        "this allocation maximizes epistemic value per owl.",
    },
    items: {
      type: "array",
      description:
        "The allocation, in execution order. Each item is one claim to fund.",
      items: {
        type: "object",
        properties: {
          claim_id: { type: "string" },
          action: {
            type: "string",
            enum: ["assess", "deepen"],
            description:
              "'assess': one Steward pass (assessment or reassessment). " +
              "'deepen': also work through the claim's pending/deferred " +
              "subclaims (costs several passes).",
          },
          rationale: {
            type: "string",
            description: "One sentence: why this claim, why this action.",
          },
        },
        required: ["claim_id", "action", "rationale"],
      },
    },
  },
  required: ["strategy", "items"],
};

function getGrantorSystemPrompt(): string {
  return `You are the Grantor agent for Minerval, a claim graph with transparent
assessments. A funder has escrowed a budget of "owls" (1 owl ≈ one Steward
assessment pass) and given you a mandate: a scope of claims and the goal of
spending the budget where it buys the most epistemic value.

You ALLOCATE; you never assess. Your plan will be shown to the funder for
approval before anything runs, and each funded assessment publicly discloses
the grant behind it. Assessments run under the same standards regardless of
funding — you are choosing WHERE attention goes, never what conclusions come
out.

What buys epistemic value (in rough order):
- consequential, contested claims with NO assessment yet;
- assessments that are stale or that recorded high marginal_yield (the last
  pass said another one would help);
- live cruxes with high contestation;
- 'deepen' on a claim whose subtree holds deferred stubs that matter to the
  funder's area.
What does NOT: settled scaffolding (low importance, uncontested), claims
already freshly assessed with low marginal_yield, duplicates of the same
crux. Do not exceed the budget: plan roughly one owl per 'assess' item and
three per 'deepen' item, and stop below the budget rather than padding.

${RAISING_ISSUES_POLICIES}`;
}

/** One row of the survey the agent sees per claim in scope. */
interface SurveyRow {
  id: string;
  text: string;
  importance: number;
  contestation: number | null;
  queue_priority: number;
  steward_state: string;
  assessment_status: string | null;
  days_since_assessed: number | null;
  marginal_yield: number | null;
  deferred_subclaims: number;
}

export async function surveyScope(input: {
  scopeClaimId: string | null;
  scopeQuery: string | null;
  filterQuery?: string;
  offset: number;
  limit: number;
}): Promise<SurveyRow[]> {
  const query = input.filterQuery?.trim() || input.scopeQuery?.trim() || null;
  return rawQuery<SurveyRow>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $1
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
     ),
     scope AS (
       SELECT c.id FROM claims c
        WHERE c.state = 'active'
          AND (($1::uuid IS NOT NULL AND c.id IN (SELECT id FROM subtree))
               OR ($2::text IS NOT NULL
                   AND c.text_search @@ websearch_to_tsquery('english', $2)))
     )
     SELECT c.id, c.text, c.importance, c.contestation, c.queue_priority,
            c.steward_state,
            a.status AS assessment_status,
            CASE WHEN a.assessed_at IS NULL THEN NULL
                 ELSE FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at)) / 86400)::int
            END AS days_since_assessed,
            a.marginal_yield,
            (SELECT COUNT(*)::int FROM claim_relationships cr
              JOIN claims sub ON sub.id = cr.child_claim_id
             WHERE cr.parent_claim_id = c.id
               AND sub.steward_state = 'deferred') AS deferred_subclaims
       FROM claims c
       JOIN scope ON scope.id = c.id
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      ORDER BY c.queue_priority DESC
      OFFSET $3 LIMIT $4`,
    [input.scopeClaimId, query, input.offset, input.limit]
  );
}

// Tag every LLM call for the meter; callers add identity + grant-job context.
export function runGrantor(
  input: Parameters<typeof runGrantorImpl>[0]
): ReturnType<typeof runGrantorImpl> {
  return withAgent("grantor", () => runGrantorImpl(input));
}

async function runGrantorImpl(input: {
  grantName: string;
  scopeClaimId: string | null;
  scopeQuery: string | null;
  budgetOwls: number;
  model?: string;
}): Promise<GrantorPlan> {
  const config = loadConfig();

  const surveyTool: Tool = {
    name: "survey_scope",
    description:
      "List claims in the surveyed slice of the graph with their allocation " +
      "signals (importance, contestation, assessment state and age, marginal " +
      "yield, deferred subclaims), most valuable first. A search aid, not " +
      "the scope: the mandate's scope is its words. Paginate with offset; " +
      "optionally narrow with a keyword query.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Optional keyword filter within the scope",
        },
        offset: { type: "number" },
      },
      required: [],
    },
  };
  const submitTool: Tool = {
    name: "submit_allocation_plan",
    description:
      "Submit the final allocation plan once you have surveyed enough.",
    input_schema: PLAN_SCHEMA as Tool["input_schema"],
  };

  let plan: GrantorPlan | null = null;
  const maxItems = Math.max(1, Math.min(25, Math.floor(input.budgetOwls)));
  const model = input.model ?? config.governanceModel;
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  await toolUseLoop({
    initialMessages: [
      {
        role: "user",
        content:
          `Mandate: "${input.grantName}".\n` +
          `Scope: ` +
          (input.scopeClaimId
            ? `the subtree of claim ${input.scopeClaimId}`
            : "") +
          (input.scopeClaimId && input.scopeQuery ? " and " : "") +
          (input.scopeQuery ? `claims matching "${input.scopeQuery}"` : "") +
          `.\nBudget: ${input.budgetOwls} owls (≈ that many Steward passes; ` +
          `a 'deepen' item costs about three).\n\n` +
          `Survey the scope, then propose an allocation plan of at most ` +
          `${maxItems} items. Only include claims that appear in your survey ` +
          `results — never invent ids.`,
      },
    ],
    tools: [surveyTool, submitTool, ...reportTools.definitions],
    system: getGrantorSystemPrompt(),
    model,
    maxTokens: 8192,
    maxIterations: 12,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      if (name === "submit_allocation_plan") {
        const raw = toolInput as unknown as GrantorPlan;
        // Mechanical validation: only real, in-scope-shaped items survive.
        const items = (raw.items ?? [])
          .filter(
            (i) =>
              typeof i.claim_id === "string" &&
              (i.action === "assess" || i.action === "deepen") &&
              typeof i.rationale === "string"
          )
          .slice(0, maxItems);
        plan = { strategy: String(raw.strategy ?? ""), items };
        return JSON.stringify({ success: true, accepted_items: items.length });
      }
      if (name === "survey_scope") {
        const rows = await surveyScope({
          scopeClaimId: input.scopeClaimId,
          scopeQuery: input.scopeQuery,
          filterQuery:
            typeof toolInput.query === "string" ? toolInput.query : undefined,
          offset: Number(toolInput.offset ?? 0),
          limit: 40,
        });
        return JSON.stringify({ count: rows.length, claims: rows });
      }
      return `Unknown tool: ${name}`;
    },
  });

  if (!plan) {
    throw new Error("Grantor run ended without submitting an allocation plan");
  }
  return plan;
}
