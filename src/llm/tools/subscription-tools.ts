/**
 * subscribe, unsubscribe, list_subscriptions: how an agent that runs in a
 * session says what it wants to be told of, and when it wants to look again
 * (services/subscription-service.ts). The subscriber is always the calling
 * run's own session. Descriptions are fixed for every role (the prompt
 * cache); what varies is in the results.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getUsageContext } from "../usage-context.js";
import { EVENT_KINDS } from "../../services/event-service.js";
import {
  createSubscription,
  describeSubscription,
  endSubscription,
  hasRefs,
  listSubscriptions,
  validateFilter,
} from "../../services/subscription-service.js";
import { owlsToMicroUsd } from "../../services/owl.js";

type Tool = Anthropic.Tool;

export const SUBSCRIBE = "subscribe";
export const UNSUBSCRIBE = "unsubscribe";
export const LIST_SUBSCRIPTIONS = "list_subscriptions";

export function getSubscriptionToolDefinitions(): Tool[] {
  return [
    {
      name: SUBSCRIBE,
      description:
        "Say what you want to be told of, or when you want to look again, so you can end your turn and wait " +
        "for it rather than check repeatedly. Four kinds, one per call: an event (name kinds and/or refs: " +
        "runs by action id, nodes, everything beneath a node, the nodes resting on a node, tags, sources, " +
        "mandates, or other refs such as a petition or research run), a time (at, or in_hours: a check-in), " +
        "money committed (when_committed_owls: owls committed by your mandate from now), or your mandate's " +
        "work settling (when_work_settled: once, when none of the passes, ingests and other runs your mandate " +
        "commissioned is waiting to run or running, and no plan item waits for its ingests: one delivery for a " +
        "whole wave rather than one per run). delivery wake (the " +
        "default) resumes your session when it fires; queue holds it for your next turn without waking you. " +
        "once ends it at its first delivery. While you hold a subscription that wakes you, ending your turn " +
        "pauses your session instead of ending it, and it waits at least until your latest check-in. Each " +
        "wake is a resumption paid like any other: it re-reads this conversation, so prefer a few subscriptions " +
        "that matter over many that do not, and queue what can wait. Event kinds: " +
        `${EVENT_KINDS.join(", ")}.`,
      input_schema: {
        type: "object" as const,
        properties: {
          kinds: { type: "array", items: { type: "string", enum: [...EVENT_KINDS] } },
          action_ids: { type: "array", items: { type: "string" }, description: "Runs on the ledger, by action id: told when each settles." },
          node_ids: { type: "array", items: { type: "string" } },
          under: { type: "array", items: { type: "string" }, description: "Nodes: events on them or anything beneath them." },
          over: { type: "array", items: { type: "string" }, description: "Nodes: events on the nodes resting on them." },
          tags: { type: "array", items: { type: "string" }, description: "Tag slugs." },
          source_ids: { type: "array", items: { type: "string" } },
          grant_ids: { type: "array", items: { type: "string" }, description: "Mandates." },
          refs: {
            type: "object",
            description: "Other refs by name, each a list of ids: petition, research_run, item, request.",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
          at: { type: "string", description: "A time (ISO 8601, UTC) to look again." },
          in_hours: { type: "number", description: "Or: look again this many hours from now." },
          when_committed_owls: { type: "number", description: "Wake when your mandate has committed this many more owls." },
          when_work_settled: {
            type: "boolean",
            description: "Wake once, when all the work your mandate has commissioned has settled (nothing waiting to run or running).",
          },
          delivery: { type: "string", enum: ["wake", "queue"] },
          once: { type: "boolean" },
          reason: { type: "string", description: "Why you want it: shown back to you with every delivery." },
        },
        required: ["reason"],
      },
    },
    {
      name: UNSUBSCRIBE,
      description: "End one of your subscriptions, by its id.",
      input_schema: {
        type: "object" as const,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: LIST_SUBSCRIPTIONS,
      description: "Your subscriptions in force: what each watches, whether it wakes you, and why you made it.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
  ];
}

/** Run one of the subscription tools, or null when `name` is not one. */
export async function executeSubscriptionTool(
  name: string,
  input: Record<string, unknown>,
  opts: { role: string; grantId?: string | null } = { role: "agent" }
): Promise<string | null> {
  if (name !== SUBSCRIBE && name !== UNSUBSCRIBE && name !== LIST_SUBSCRIPTIONS) return null;
  const session = getUsageContext().session;
  if (!session) {
    return JSON.stringify({ success: false, message: "This run has no session to hold a subscription, so nothing was made." });
  }
  const me = { kind: "session" as const, ref: session.id };
  // A session row exists once the run first waits on something; make sure
  // it does, so a subscription made before any other wait has a holder.
  const { ensureSessionRow } = await import("../../services/session-service.js");
  await ensureSessionRow();
  if (name === LIST_SUBSCRIPTIONS) {
    const subs = await listSubscriptions(me);
    return JSON.stringify({ success: true, subscriptions: subs.map(describeSubscription) });
  }
  if (name === UNSUBSCRIBE) {
    const ok = await endSubscription(String(input.id ?? ""), me);
    return JSON.stringify({ success: ok, message: ok ? "Ended." : "No such subscription of yours." });
  }
  const reason = String(input.reason ?? "").trim();
  if (!reason) return JSON.stringify({ success: false, message: "reason is required: it is shown back to you with every delivery." });
  const delivery = input.delivery === "queue" ? "queue" : "wake";
  const once = input.once === true;
  // A time.
  if (input.at !== undefined || input.in_hours !== undefined) {
    const at = input.at !== undefined ? new Date(String(input.at)) : new Date(Date.now() + Number(input.in_hours) * 3_600_000);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      return JSON.stringify({ success: false, message: "at must be a time in the future (or in_hours above zero)." });
    }
    const s = await createSubscription({ subscriberKind: "session", subscriberRef: session.id, dueAt: at, delivery, once: true, reason, createdBy: opts.role });
    return JSON.stringify({ success: true, id: s.id, message: describeSubscription(s) });
  }
  // A money threshold.
  if (input.when_committed_owls !== undefined) {
    const owls = Number(input.when_committed_owls);
    if (!opts.grantId) return JSON.stringify({ success: false, message: "when_committed_owls is for a mandate's agents; this run serves no mandate." });
    if (!(owls > 0)) return JSON.stringify({ success: false, message: "when_committed_owls must be above zero." });
    const s = await createSubscription({
      subscriberKind: "session",
      subscriberRef: session.id,
      condition: { kind: "committed_owls", grant_id: opts.grantId, at_least_micro_usd: owlsToMicroUsd(owls), since: new Date().toISOString() },
      delivery,
      once: true,
      reason,
      createdBy: opts.role,
    });
    return JSON.stringify({ success: true, id: s.id, message: describeSubscription(s) });
  }
  // A mandate's work settling.
  if (input.when_work_settled === true) {
    if (!opts.grantId) return JSON.stringify({ success: false, message: "when_work_settled is for a mandate's agents; this run serves no mandate." });
    const s = await createSubscription({
      subscriberKind: "session",
      subscriberRef: session.id,
      condition: { kind: "work_settled", grant_id: opts.grantId, since: new Date().toISOString() },
      delivery,
      once: true,
      reason,
      createdBy: opts.role,
    });
    return JSON.stringify({ success: true, id: s.id, message: describeSubscription(s) });
  }
  // An event.
  const v = validateFilter(input);
  if (!v.ok) return JSON.stringify({ success: false, message: v.problem });
  if (!hasRefs(v.filter) && !v.filter.kinds?.length) {
    return JSON.stringify({ success: false, message: "Name what to watch: kinds, refs, or both; or a time or a money threshold." });
  }
  const s = await createSubscription({ subscriberKind: "session", subscriberRef: session.id, filter: v.filter, delivery, once, reason, createdBy: opts.role });
  return JSON.stringify({ success: true, id: s.id, message: describeSubscription(s) });
}
