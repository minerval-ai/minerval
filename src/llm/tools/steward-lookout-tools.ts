/**
 * A Steward's own lookouts (docs/allocation.md, "A Steward's own lookout"):
 * post_lookout and amend_lookout, which every kind of Steward has (claim,
 * question, quantity, list), since every kind of node can be overtaken by
 * the world between passes.
 *
 * A Steward's attention ends with its pass. A lookout is how it keeps watch
 * after: over the sources its judgment rests on (the retraction record),
 * over its node and everything beneath it (the graph feed), and over the
 * open web, at a heartbeat it sets. The Steward pays for the watch the way
 * it pays for any other work, from its own budget: post_lookout puts up a
 * fund, which leaves this pass at once and keeps its payer
 * (services/lookout-fund.ts), and the lookout runs on it until it is spent
 * or retired. Nothing here names who pays (spend-tools.ts): the Steward
 * knows its budget, never its mandate.
 *
 * The lookouts are the node's, not the pass's: a later pass on the node
 * reads them in its task message (stewardLookoutNote) and may amend, top up
 * or retire them. Only the node's own Steward does (Part VIII).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getUsageContext } from "../usage-context.js";
import { debitRunBudget, runBudgetLeft, runPayer } from "../run-funding.js";
import {
  createLookout,
  updateLookout,
  getLookout,
  listNodeLookouts,
  lookoutPrecision,
  LOOKOUT_BOUNDS,
} from "../../services/lookout-service.js";
import {
  addToLookoutFund,
  lookoutFundLeftMicroUsd,
  lookoutRunCostMicroUsd,
} from "../../services/lookout-fund.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";
import { STANDING_ORDER_RETRY_MINUTES } from "../../services/standing-order-service.js";

type Tool = Anthropic.Tool;

export const POST_LOOKOUT = "post_lookout";
export const AMEND_LOOKOUT = "amend_lookout";
export const STEWARD_LOOKOUT_TOOL_NAMES = [POST_LOOKOUT, AMEND_LOOKOUT] as const;

/** What a Steward's lookout may wake on besides its heartbeat. Feeds are a mandate's. */
const STEWARD_TRIGGERS = ["retraction", "graph", "manual"] as const;

const owls = (micro: number) => microUsdToOwls(micro);

const TRIGGERS_DESCRIPTION =
  "What it also wakes on: 'retraction' (the daily Crossref poll matched a retraction, correction " +
  "or expression of concern to a source in the graph), 'graph' (the change stream has new entries " +
  "in its territory: work opened or finished, messages, verdicts moving, requests filed; read at " +
  "most every 15 minutes), 'manual' (someone queued it a note).";

const TERRITORY_PROPERTY = {
  type: "object" as const,
  properties: {
    claim_ids: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
  },
  description:
    "For the graph feed: the nodes it follows (each with everything beneath it) and tag slugs. " +
    "Defaults to your own node, with everything beneath it.",
};

export function getStewardLookoutToolDefinitions(): Tool[] {
  return [
    {
      name: POST_LOOKOUT,
      description:
        "Post a lookout: a cheap standing agent that keeps watch for your node after this pass ends " +
        "and tells you when something happens that bears on it. Use one when your judgment rests " +
        "on something the world can change before anyone looks again: a source that could be " +
        "retracted or corrected, a result awaiting replication, a fast-moving field, a subclaim " +
        "whose verdict would move yours. It runs on a heartbeat you set and on its triggers, reads " +
        "the retraction record, the graph and the open web as its brief says, and writes no " +
        "assessment. What it finds comes to your node's inbox for its next pass; with a " +
        "commission limit it may also pay for work itself, a pass on your node or another, or an " +
        "ingest.\n\n" +
        "You pay for it from your own budget: budget_owls leaves this run at once as the " +
        "lookout's fund, the only money it has. Each run is paid from the fund at " +
        `${owls(lookoutRunCostMicroUsd())} owls, the most a lookout run may spend; what a run does not ` +
        "spend goes back to the fund. What it commissions within its limit is paid from the fund " +
        "too. When the fund cannot pay " +
        "for another run the lookout pauses and your node's inbox is told; amend_lookout tops it " +
        "up, and retiring it returns what is left to whoever paid for this pass. Size the fund " +
        "to the watch: runs a week, times the weeks worth watching, times the run's figure, plus " +
        "what you would let it commission. Most nodes need " +
        "no lookout; a node your verdict holds on a live, checkable question may.\n\n" +
        "Write the brief as you would for a careful person paid to keep watch: what to watch, " +
        "where to look, what would warrant a fresh look at this node, and what to leave alone. " +
        `It runs first within about ${STANDING_ORDER_RETRY_MINUTES} minutes, then at its heartbeat. ` +
        "Later passes on this node see its lookouts, their funds and what they raised, and may " +
        "amend or retire them.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "A few words naming the watch." },
          brief: {
            type: "string",
            description:
              `The lookout's whole instruction set, in your words (at least ${LOOKOUT_BOUNDS.briefChars.min} ` +
              "characters): what it watches, where to look, what warrants a look, what to leave alone. " +
              "Say what your judgment rests on that it should watch.",
          },
          budget_owls: {
            type: "number",
            description: "The fund, from this run's budget: the most the lookout will ever spend unless topped up.",
          },
          heartbeat_hours: {
            type: "number",
            description:
              `How often it runs on its own (default 24; 0 = only on its triggers; at most ` +
              `${LOOKOUT_BOUNDS.heartbeatHours.max}). Each run is paid from the fund.`,
          },
          triggers: {
            type: "array",
            items: { type: "string", enum: [...STEWARD_TRIGGERS] },
            description: TRIGGERS_DESCRIPTION,
          },
          territory: TERRITORY_PROPERTY,
          commission_limit_owls: {
            type: "number",
            description:
              "The most it may commission on its own for one item (a pass, an ingest), from its fund " +
              "(default 0: it commissions nothing and everything it raises comes to your inbox). " +
              "Above it, it sends the item to your inbox with its reasons.",
          },
          model: {
            type: "string",
            description: "Optional model id for a stronger watch; default is the cheap tier.",
          },
        },
        required: ["title", "brief", "budget_owls"],
      },
    },
    {
      name: AMEND_LOOKOUT,
      description:
        "Change, top up, pause or retire a lookout posted for this node (your task message lists " +
        "them with their funds and what they raised). Only the fields you give change. " +
        "add_budget_owls moves more of this run's budget into its fund and resumes it if it paused " +
        "for want of money. status 'paused' keeps it and its fund for later; 'active' resumes it; " +
        "'retired' is final and returns what is left of its fund to whoever put it up. Retire a " +
        "watch whose flags have not moved anything, or whose question has been settled.",
      input_schema: {
        type: "object" as const,
        properties: {
          lookout_id: { type: "string" },
          add_budget_owls: { type: "number", description: "More for its fund, from this run's budget." },
          status: { type: "string", enum: ["active", "paused", "retired"] },
          title: { type: "string" },
          brief: { type: "string", description: "Replaces the whole brief." },
          heartbeat_hours: { type: "number" },
          triggers: {
            type: "array",
            items: { type: "string", enum: [...STEWARD_TRIGGERS] },
            description: "Replaces the list. " + TRIGGERS_DESCRIPTION,
          },
          territory: TERRITORY_PROPERTY,
          commission_limit_owls: { type: "number" },
          model: { type: "string", description: "\"\" returns it to the cheap default." },
        },
        required: ["lookout_id"],
      },
    },
  ];
}

const fail = (message: string) => JSON.stringify({ success: false, message });

function stewardTriggers(raw: unknown): string[] | string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return "triggers must be a list";
  const bad = raw.map(String).find((t) => !(STEWARD_TRIGGERS as readonly string[]).includes(t));
  return bad ? `"${bad}" is not a trigger a Steward's lookout can have; it can have ${STEWARD_TRIGGERS.join(", ")}` : raw.map(String);
}

function territoryFrom(raw: unknown): { claimIds?: unknown; tagSlugs?: unknown } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  return { claimIds: t.claim_ids, tagSlugs: t.tags };
}

/** Move `budget` of this run's money into a lookout's fund, after checking this run holds it. */
async function fundFromRun(
  lookoutId: string,
  nodeId: string,
  budget: number,
  title: string
): Promise<{ ok: true; leftMicroUsd: number } | { ok: false; message: string }> {
  const payer = runPayer();
  if (!payer) return { ok: false, message: "This run isn't paid in a way that can pay for other work, so it cannot fund a lookout." };
  const left = runBudgetLeft();
  if (left !== null && budget > left) {
    return {
      ok: false,
      message:
        `A fund of ${owls(budget)} owls is more than this run has left (${owls(left)}). ` +
        `Fund it with less, or petition for more and fund it once it is granted.`,
    };
  }
  const res = await addToLookoutFund({
    lookoutId,
    nodeId,
    payer,
    budgetMicroUsd: budget,
    reason: `The fund of the lookout "${title}", posted by this node's Steward.`,
  });
  if (!res.ok) return { ok: false, message: res.message };
  debitRunBudget(budget);
  return res;
}

export async function executeStewardLookoutTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name !== POST_LOOKOUT && name !== AMEND_LOOKOUT) return null;
  const nodeId = getUsageContext().claimId;
  if (!nodeId) return fail("Only a Steward's pass on a node can post or amend that node's lookouts.");
  const createdBy = `${getUsageContext().agent ?? "steward"}:${nodeId}`;

  if (name === POST_LOOKOUT) {
    const budget = owlsToMicroUsd(Number(input.budget_owls ?? 0));
    const runCost = lookoutRunCostMicroUsd();
    if (!(budget >= runCost)) {
      return fail(`budget_owls must pay for at least one run (${owls(runCost)} owls); a lookout runs on nothing else.`);
    }
    if (!runPayer()) return fail("This run isn't paid in a way that can pay for other work, so it cannot fund a lookout.");
    const left = runBudgetLeft();
    if (left !== null && budget > left) {
      return fail(`A fund of ${owls(budget)} owls is more than this run has left (${owls(left)}). Nothing was posted.`);
    }
    const triggers = stewardTriggers(input.triggers);
    if (typeof triggers === "string") return fail(triggers);
    const created = await createLookout({
      nodeId,
      title: String(input.title ?? ""),
      brief: String(input.brief ?? ""),
      heartbeatHours: input.heartbeat_hours === undefined ? undefined : Number(input.heartbeat_hours),
      triggers: triggers ?? [],
      model: typeof input.model === "string" ? input.model : null,
      commissionLimitOwls: Number(input.commission_limit_owls ?? 0),
      territory: territoryFrom(input.territory),
      createdBy,
    });
    if (!created.ok) return fail(created.message);
    const funded = await fundFromRun(created.lookoutId, nodeId, budget, String(input.title ?? ""));
    if (!funded.ok) {
      // Never leave a watch with no money behind it.
      await updateLookout({ nodeId, lookoutId: created.lookoutId, status: "retired" });
      return fail(`${funded.message} Nothing was posted.`);
    }
    const after = runBudgetLeft();
    return JSON.stringify({
      success: true,
      lookout_id: created.lookoutId,
      message:
        `Posted. Its fund holds ${owls(funded.leftMicroUsd)} owls, from your budget` +
        (after !== null ? ` (you have ${owls(after)} left)` : "") +
        `; a run costs ${owls(runCost)} owls, so it pays for about ${Math.floor(funded.leftMicroUsd / runCost)} runs ` +
        `less whatever it commissions. Its first run opens within about ${STANDING_ORDER_RETRY_MINUTES} minutes. ` +
        `What it raises comes to this node's inbox.`,
    });
  }

  // amend_lookout
  const lookoutId = String(input.lookout_id ?? "");
  const current = /^[0-9a-f-]{36}$/i.test(lookoutId) ? await getLookout(lookoutId) : null;
  if (!current || current.node_id !== nodeId) {
    return fail("No lookout with that id was posted for this node. Your task message lists the ones that were.");
  }
  if (current.status === "retired") return fail("That lookout is retired; post a new one.");
  const triggers = stewardTriggers(input.triggers);
  if (typeof triggers === "string") return fail(triggers);
  const changes = {
    title: input.title === undefined ? undefined : String(input.title),
    brief: input.brief === undefined ? undefined : String(input.brief),
    heartbeatHours: input.heartbeat_hours === undefined ? undefined : Number(input.heartbeat_hours),
    triggers,
    model: input.model === undefined ? undefined : String(input.model),
    commissionLimitOwls: input.commission_limit_owls === undefined ? undefined : Number(input.commission_limit_owls),
    territory: input.territory === undefined ? undefined : territoryFrom(input.territory),
  };
  const add = input.add_budget_owls === undefined ? 0 : owlsToMicroUsd(Number(input.add_budget_owls));
  if (add < 0 || Number.isNaN(add)) return fail("add_budget_owls must be above zero.");
  const retiring = input.status === "retired";
  if (retiring && add > 0) return fail("A lookout being retired takes no more money.");
  // The fields first, then the money, then the status: a refused top-up
  // changes nothing, and a retirement returns what is left only after the
  // rest is recorded.
  const amended = await updateLookout({ nodeId, lookoutId, ...changes });
  if (!amended.ok) return fail(amended.message);
  let topUp = "";
  if (add > 0) {
    const funded = await fundFromRun(lookoutId, nodeId, add, current.title);
    if (!funded.ok) return fail(`${funded.message} Its other changes were recorded.`);
    topUp = ` Its fund now holds ${owls(funded.leftMicroUsd)} owls.`;
  }
  let statusNote = "";
  if (typeof input.status === "string") {
    const before = retiring ? await lookoutFundLeftMicroUsd(lookoutId) : 0;
    const set = await updateLookout({ nodeId, lookoutId, status: input.status });
    if (!set.ok) return fail(set.message);
    statusNote = retiring
      ? ` Retired; ${owls(before)} owls left in its fund went back to whoever put them up.`
      : ` It is ${input.status}.`;
  }
  return JSON.stringify({ success: true, message: `Amended.${topUp}${statusNote}` });
}

/**
 * The lookouts posted for a node, for its Steward's task message: each with
 * its state, its fund, and what its flags came to. "" when there are none.
 */
export async function stewardLookoutNote(nodeId: string): Promise<string> {
  const rows = (await listNodeLookouts(nodeId)).filter((l) => l.status !== "retired");
  if (rows.length === 0) return "";
  const lines = await Promise.all(
    rows.map(async (l) => {
      const [left, p] = await Promise.all([lookoutFundLeftMicroUsd(l.id), lookoutPrecision(l.id)]);
      const state = l.status === "paused" ? (l.paused_for_fund ? "paused: its fund cannot pay for a run" : "paused") : "active";
      return (
        `- ${l.id} "${l.title}" (${state}): fund ${owls(left)} owls; heartbeat ` +
        `${l.heartbeat_hours > 0 ? `${l.heartbeat_hours}h` : "none"}; triggers ${(l.triggers ?? []).join(", ") || "none"}; ` +
        `commission limit ${owls(Number(l.commission_limit_micro_usd ?? 0))} owls; ${l.runs} run${l.runs === 1 ? "" : "s"}` +
        (l.last_run_at ? `, last ${new Date(l.last_run_at).toISOString().slice(0, 10)}` : "") +
        `. Raised ${p.flagged} pass${p.flagged === 1 ? "" : "es"} (${p.ran} ran, ${p.moved} moved a verdict), ` +
        `${p.ingests} ingest${p.ingests === 1 ? "" : "s"}, ${p.notes} note${p.notes === 1 ? "" : "s"}.` +
        (l.last_note ? ` Its last note: ${l.last_note.slice(0, 400)}` : "")
      );
    })
  );
  return (
    `Lookouts posted for this node (amend_lookout changes, tops up, pauses or retires one; ` +
    `a run costs ${owls(lookoutRunCostMicroUsd())} owls from its fund):\n` +
    lines.join("\n")
  );
}
