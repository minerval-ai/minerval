/**
 * The mandate review pass — a Grantmaker stewarding its live mandate,
 * autonomously and with discretion.
 *
 * A mandate's scope is defined in WORDS; which work falls under it is a
 * judgment call. On a cadence, the ledger opens a `mandate_review` action
 * for every active mandate (self-funded from its escrow, metered under a
 * cap), and the engine executor runs this agent: the same Grantmaker that
 * designed the mandate, now reviewing it the way any person entrusted with
 * a budget and a mission would —
 *
 *  - survey its territory: the graph (search, scope survey) AND the open
 *    web (web_search) — finding the right sources is the agent's job, not
 *    a human's;
 *  - value the open ledger: write the mandate's own valuations, with
 *    rationale, over exactly the actions it judges relevant (its
 *    allocator spends against these);
 *  - grow its own plan: append ingest/assess items it has discovered
 *    (each priced, escrow-bounded, executed through the same ledger);
 *  - move money: regrant to a peer mandate, or spawn a new one with its
 *    own Grantmaker, when part of the mission belongs in other hands.
 *
 * Cost discipline lives in the mechanism, never in narrowed affordances:
 * the pass itself is capped and metered, everything it queues is priced
 * against the escrow, and daily rates pace the spend. The refusal duties
 * that govern mandate design govern this pass equally.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { getGrantmakerSystemPrompt } from "../prompts/grantmaker.js";
import { surveyScope } from "./grantor.js";
import { validateMandate, type GrantMandate } from "./grantmaker.js";
import type { PlanItem } from "../../services/grant-service.js";
import { stewardTierCostEstimates } from "../../services/cost-estimate-service.js";
import { microUsdToOwls, owlsToMicroUsd, capOwls } from "../../services/owl.js";
import {
  listOpenActions,
  setMandateValuations,
  type ValuationEntry,
} from "../../services/mandate-valuer-service.js";
import {
  createRegrant,
  spawnFundedMandate,
  grantCommittedMicroUsd,
} from "../../services/regrant-service.js";
import { refundUnspentBudget } from "../../services/budget-job-service.js";

export interface MandateReviewResult {
  note: string;
  valuationsWritten: number;
  planItemsAdded: number;
  /** The agent judged one pass wasn't enough: run another now (bounded by
   * the passes-per-day funding cap, not by refusing the request). */
  continueRequested: boolean;
}

/** Generous but bounded working memory: ~100KB of the agent's own notes. */
const WORKSPACE_MAX_CHARS = 100_000;

export function runMandateReview(
  input: Parameters<typeof runMandateReviewImpl>[0]
): ReturnType<typeof runMandateReviewImpl> {
  return withAgent("mandate_review", () => runMandateReviewImpl(input));
}

async function runMandateReviewImpl(input: {
  grantId: string;
  model?: string;
}): Promise<MandateReviewResult> {
  const config = loadConfig();
  const [grant] = await rawQuery<{
    id: string;
    name: string;
    policy: string;
    mandate: GrantMandate | null;
    plan: { strategy?: string; items?: PlanItem[] } | null;
    plan_cursor: number;
    daily_budget_micro_usd: number;
    budget_job_id: string;
    budget_micro_usd: number;
    workspace: string | null;
    funder_user_id: string;
  }>(
    `SELECT g.id, g.name, g.policy, g.mandate, g.plan, g.plan_cursor,
            g.daily_budget_micro_usd, g.budget_job_id, j.budget_micro_usd,
            g.workspace, g.funder_user_id
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [input.grantId]
  );
  if (!grant) throw new Error(`mandate ${input.grantId} not found or not active`);

  const committed = await grantCommittedMicroUsd({
    id: grant.id,
    budgetJobId: grant.budget_job_id,
  });

  const webSearchTool: Anthropic.Messages.WebSearchTool20260209 = {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
  };
  const tools: Tool[] = [
    {
      name: "search_claims",
      description:
        "Search the graph's claims by keywords. A search aid, not your " +
        "scope: your scope is your mandate's words, and you judge what " +
        "falls under them.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results, default 15." },
        },
        required: ["query"],
      },
    },
    {
      name: "survey_scope",
      description:
        "Survey a subtree and/or keyword slice of the graph with the " +
        "allocation signals: importance, contestation, assessment state " +
        "and age, expected gain from another pass. Paginate with offset.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "Subtree root (optional)." },
          query: { type: "string", description: "Keyword slice (optional)." },
          offset: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "list_open_actions",
      description:
        "Browse the open action ledger from your mandate's point of view: " +
        "every potential action, its cost, current backing, and your " +
        "current valuation if you hold one. Filter with query/kind, page " +
        "with offset; valued_only=true reviews your existing judgments.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          kind: {
            type: "string",
            enum: ["assess", "reassess", "ingest", "grant_planning"],
          },
          valued_only: { type: "boolean" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "set_valuations",
      description:
        "Write your mandate's valuations: for each action you judge " +
        "relevant, a value 0-10 (your definition of importance, in line " +
        "with your mandate) and a one-line rationale. Sparse by design — " +
        "value only what you know and care about; actions you skip simply " +
        "carry no opinion from you. Your allocator funds the best marginal " +
        "value per owl among these, so this IS your spending judgment.",
      input_schema: {
        type: "object" as const,
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action_id: { type: "string" },
                value: { type: "number" },
                rationale: { type: "string" },
              },
              required: ["action_id", "value"],
            },
          },
        },
        required: ["entries"],
      },
    },
    {
      name: "estimate_costs",
      description:
        "Quote expected costs in owls for a bundle of work, from live " +
        "metered averages (priors otherwise). Use before growing the plan.",
      input_schema: {
        type: "object" as const,
        properties: {
          assessments: { type: "number" },
          reassessments: { type: "number" },
          deepen_claims: { type: "number" },
          sources_to_ingest: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "extend_plan",
      description:
        "Append new items to your mandate's plan — the systems-building " +
        "move: sources you found that should be ingested, claims that " +
        "need passes. Each item is priced and bounded by your escrow, and " +
        "executes through the ledger like everything else. Appends only; " +
        "already-planned work stays.",
      input_schema: {
        type: "object" as const,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["assess", "reassess", "deepen", "ingest"],
                },
                claim_id: { type: "string" },
                url: { type: "string" },
                rationale: { type: "string" },
              },
              required: ["action", "rationale"],
            },
          },
          note: { type: "string", description: "One sentence: why." },
        },
        required: ["items", "note"],
      },
    },
    {
      name: "regrant",
      description:
        "Put part of this mandate's uncommitted budget behind another live " +
        "mandate (all mandates are peers; money, never command). Use when " +
        "part of the mission is better served by work someone else is " +
        "already running.",
      input_schema: {
        type: "object" as const,
        properties: {
          to_mandate_id: { type: "string" },
          owls: { type: "number" },
          note: { type: "string" },
        },
        required: ["to_mandate_id", "owls", "note"],
      },
    },
    {
      name: "spawn_mandate",
      description:
        "Carve part of the mission out into a NEW mandate with its own " +
        "budget and its own Grantmaker (a peer, separately fundable — not " +
        "a sub-unit). The new mandate starts in planning: its agent " +
        "surveys and drafts its own plan. Use when a slice of the work " +
        "deserves dedicated stewardship, e.g. a whole ingestion program.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string" },
          objective: {
            type: "string",
            description: "The new mandate's mission, in plain words.",
          },
          owls: { type: "number" },
          note: { type: "string" },
        },
        required: ["title", "objective", "owls", "note"],
      },
    },
    {
      name: "update_workspace",
      description:
        "Rewrite your workspace — your own durable working memory, read " +
        "back to you in full at the start of every pass. Keep here what a " +
        "person running this mission would keep in their working notes: " +
        "the map of the territory so far, the source backlog and what " +
        "each yielded, strategy, open questions, what the next pass " +
        "should do. Replaces the whole document; carry forward what " +
        "still matters.",
      input_schema: {
        type: "object" as const,
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
    {
      name: "set_daily_rate",
      description:
        "Set your mandate's own daily allocation rate, in owls per day — " +
        "your pacing knob. Pace the mission the way its evidence flow " +
        "deserves; the escrow is the hard bound either way.",
      input_schema: {
        type: "object" as const,
        properties: { owls_per_day: { type: "number" } },
        required: ["owls_per_day"],
      },
    },
    {
      name: "pipeline_report",
      description:
        "What your mandate's ingestion has actually produced: each source " +
        "brought in, extraction status, claims linked or minted, " +
        "importance and contestation statistics. Read this before " +
        "deciding what to ingest next.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "continue_review",
      description:
        "Declare this pass finished but the work not: another review pass " +
        "runs right away (funded from your escrow, bounded by the daily " +
        "pass cap). Use it when the mission genuinely needs more passes " +
        "today — enumerating a large source backlog, a territory survey " +
        "in progress. Update your workspace FIRST so the next pass starts " +
        "where this one stopped.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "One line: what's next." },
        },
        required: ["reason"],
      },
    },
 
    {
      name: "complete_mandate",
      description:
        "Close the mandate: the mission is fulfilled (or cannot be " +
        "usefully continued) and the unspent budget should refund to its " +
        "funders — user contributors and regranting mandates, pro rata. " +
        "This is your call to make; exhausting the current plan is a " +
        "waypoint, not by itself a reason to close.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "One line, recorded." },
        },
        required: ["reason"],
      },
    },
  ];

  const mandateText = grant.mandate
    ? JSON.stringify(grant.mandate, null, 2)
    : `(untitled mandate "${grant.name}")`;
  const items = grant.plan?.items ?? [];
  const briefing =
    `## Mandate review pass\n\n` +
    `You are taking your autonomous review of the live mandate you ` +
    `steward. Nobody is watching this run; act with the judgment of a ` +
    `person entrusted with the budget and the mission.\n\n` +
    `Your mandate:\n\n${mandateText}\n\n` +
    `Budget: ${microUsdToOwls(Number(grant.budget_micro_usd))} owls escrowed, ` +
    `${microUsdToOwls(committed)} committed (metered + allocated + regranted), ` +
    `daily rate ${microUsdToOwls(Number(grant.daily_budget_micro_usd))} owls ` +
    `(yours to set). Plan: ${items.length} items, ${grant.plan_cursor} executed.\n\n` +
    `Your workspace (your own notes from previous passes):\n\n` +
    (grant.workspace?.trim()
      ? grant.workspace
      : `(empty — this is your first pass, or you have not written notes ` +
        `yet. Start the map.)`) +
    `\n\n---\n\n` +
    `Do what the mandate needs this pass: survey (graph and web), revise ` +
    `your valuations over the open ledger, extend the plan with the work ` +
    `you discovered, adjust your pacing, regrant or spawn where part of ` +
    `the mission belongs in other hands. Skip what doesn't need doing. ` +
    `Before finishing, update your workspace so the next pass starts ` +
    `where this one stopped; call continue_review if the mission needs ` +
    `another pass today. Finish with a short note (recorded on the ` +
    `mandate) saying what you did and why.`;

  let valuationsWritten = 0;
  let planItemsAdded = 0;
  let continueRequested = false;

  const result = await toolUseLoop({
    initialMessages: [{ role: "user", content: briefing }],
    tools: [webSearchTool, ...tools],
    system: getGrantmakerSystemPrompt(),
    model: input.model ?? config.grantmakerModel,
    maxTokens: 4096,
    maxIterations: 24,
    executeTool: async (name, toolInput) => {
      if (name === "search_claims") {
        const limit = Math.min(30, Math.max(1, Number(toolInput.limit ?? 15)));
        const rows = await rawQuery(
          `SELECT c.id, c.text, c.importance, c.contestation, c.steward_state,
                  a.status AS assessment_status
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
          limit: 25,
        });
        return JSON.stringify(rows);
      }
      if (name === "list_open_actions") {
        const res = await listOpenActions({
          grantId: grant.id,
          query: typeof toolInput.query === "string" ? toolInput.query : null,
          kind: typeof toolInput.kind === "string" ? toolInput.kind : null,
          valuedOnly: toolInput.valued_only === true,
          offset: Number(toolInput.offset ?? 0),
          limit: Number(toolInput.limit ?? 25),
        });
        return JSON.stringify(res);
      }
      if (name === "set_valuations") {
        const entries = (toolInput.entries ?? []) as ValuationEntry[];
        const res = await setMandateValuations(grant.id, entries);
        valuationsWritten += res.written;
        return JSON.stringify(res);
      }
      if (name === "estimate_costs") {
        const tiers = await stewardTierCostEstimates();
        const passOwls = microUsdToOwls(tiers.strongMicroUsd);
        const n = (v: unknown) => Math.max(0, Number(v ?? 0) || 0);
        const subtotal =
          (n(toolInput.assessments) + n(toolInput.reassessments)) * passOwls +
          n(toolInput.deepen_claims) * passOwls * 3 +
          n(toolInput.sources_to_ingest) * capOwls("source_ingest");
        return JSON.stringify({
          assessment_each_owls: passOwls,
          ingest_each_owls: capOwls("source_ingest"),
          subtotal_owls: Math.round(subtotal * 100) / 100,
          note: "Estimates; actual spend is metered and unspent budget refunds.",
        });
      }
      if (name === "extend_plan") {
        const newItems = (toolInput.items ?? []) as PlanItem[];
        if (newItems.length === 0) {
          return JSON.stringify({ success: false, problem: "no items" });
        }
        const probe: GrantMandate = {
          title: "x",
          objective: "x",
          plan: { strategy: "x", items: newItems },
          expected_cost_owls: 1,
        };
        const problem = validateMandate(probe);
        if (problem) return JSON.stringify({ success: false, problem });
        await rawQuery(
          `UPDATE grants
              SET plan = jsonb_set(
                    COALESCE(plan, '{"items": []}'::jsonb), '{items}',
                    COALESCE(plan->'items', '[]'::jsonb) || $2::jsonb),
                  updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [grant.id, JSON.stringify(newItems)]
        );
        planItemsAdded += newItems.length;
        return JSON.stringify({ success: true, appended: newItems.length });
      }
      if (name === "regrant") {
        const res = await createRegrant({
          fromGrantId: grant.id,
          toGrantId: String(toolInput.to_mandate_id ?? ""),
          owls: Number(toolInput.owls ?? 0),
          note: String(toolInput.note ?? ""),
        });
        return JSON.stringify(res);
      }
      if (name === "spawn_mandate") {
        const res = await spawnFundedMandate({
          fromGrantId: grant.id,
          title: String(toolInput.title ?? ""),
          objective: String(toolInput.objective ?? ""),
          owls: Number(toolInput.owls ?? 0),
          note: String(toolInput.note ?? ""),
        });
        return JSON.stringify(res);
      }
      if (name === "update_workspace") {
        const content = String(toolInput.content ?? "").slice(
          0,
          WORKSPACE_MAX_CHARS
        );
        await rawQuery(
          `UPDATE grants SET workspace = $2, updated_at = now() WHERE id = $1`,
          [grant.id, content]
        );
        return JSON.stringify({ success: true, chars: content.length });
      }
      if (name === "set_daily_rate") {
        const owlsPerDay = Number(toolInput.owls_per_day);
        if (!Number.isFinite(owlsPerDay) || owlsPerDay < 0) {
          return JSON.stringify({
            success: false,
            problem: "owls_per_day must be a non-negative number",
          });
        }
        const micro = owlsToMicroUsd(owlsPerDay);
        await rawQuery(
          `UPDATE grants SET daily_budget_micro_usd = $2, updated_at = now()
            WHERE id = $1`,
          [grant.id, micro]
        );
        return JSON.stringify({ success: true, owls_per_day: owlsPerDay });
      }
      if (name === "pipeline_report") {
        const { getMandatePipeline } = await import(
          "../../services/mandate-service.js"
        );
        const pipeline = await getMandatePipeline(grant.id);
        return JSON.stringify({ sources: pipeline.length, pipeline });
      }
      if (name === "continue_review") {
        continueRequested = true;
        return JSON.stringify({
          success: true,
          note:
            "Another pass will run after this one (subject to the daily " +
            "pass cap). Make sure your workspace is current, then finish.",
        });
      }
      if (name === "complete_mandate") {
        const refunded = await refundUnspentBudget({
          id: grant.budget_job_id,
          userId: grant.funder_user_id,
          budgetMicroUsd: Number(grant.budget_micro_usd),
        });
        await rawQuery(
          `UPDATE budget_jobs SET status = 'completed', completed_at = now(),
                  updated_at = now() WHERE id = $1`,
          [grant.budget_job_id]
        );
        await rawQuery(
          `UPDATE grants SET status = 'completed', updated_at = now()
            WHERE id = $1`,
          [grant.id]
        );
        continueRequested = false;
        return JSON.stringify({
          success: true,
          refunded_owls: microUsdToOwls(refunded),
          note: "Mandate closed; finish with your closing note.",
        });
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
  });

  const note = (result.content ?? "").trim().slice(0, 2000);
  // The review note is part of the mandate's public record.
  await rawQuery(
    `UPDATE grants
        SET mandate = jsonb_set(
              COALESCE(mandate, '{}'::jsonb), '{last_review}',
              jsonb_build_object('at', to_jsonb(now()), 'note', $2::text)),
            updated_at = now()
      WHERE id = $1`,
    [grant.id, note || "(review completed without a note)"]
  );
  return { note, valuationsWritten, planItemsAdded, continueRequested };
}
