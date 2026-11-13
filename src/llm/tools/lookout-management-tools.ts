/**
 * The Grantmaker's lookout tools: standing up, reading, amending, and
 * poking the standing watches its mandate funds (docs/allocation.md,
 * "Lookouts"). Shared by the owner-driven management chat and the
 * autonomous review pass, as the bounty tools are: one definition list,
 * one executor with the null-delegate convention (null means "not my
 * tool"), so each agent wires it with one spread and one early return.
 *
 * Nothing here moves money. A lookout's runs are self-funded from the
 * mandate's escrow through the ledger (fundGrantSelfActions), out of the
 * mandate's day like the rest of its work, with no count of runs (#689).
 * What the Grantmaker delegates with spawn_lookout is judgment (the brief)
 * under bounds it sets: the territory its graph feed follows, the most it
 * may commission alone for one item (the rest goes to the mandate's
 * program officers), and the cadence.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  createLookout,
  updateLookout,
  summarizeLookouts,
  listLookoutFlags,
  queueLookoutEvent,
  getLookout,
  LOOKOUT_BOUNDS,
  LOOKOUT_TRIGGER_KINDS,
} from "../../services/lookout-service.js";
import {
  addFeed,
  feedReport,
  getFeed,
  updateFeed,
  FEED_BOUNDS,
  FEED_WAKE_RULES,
  type FeedRuleInput,
} from "../../services/feed-service.js";
import { executeReadListing, getReadListingToolDefinition } from "./feed-tools.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LOOKOUT_MANAGEMENT_TOOL_NAMES = [
  "spawn_lookout",
  "list_lookouts",
  "lookout_report",
  "update_lookout",
  "poke_lookout",
  "add_feed",
  "update_feed",
  "feed_report",
  "read_listing",
] as const;

const B = FEED_BOUNDS;
const FEED_RULE_PROPERTIES = {
  wake: { type: "string", enum: [...FEED_WAKE_RULES] },
  batch_size: { type: "number", description: `batch: wake after this many new items (${B.batchSize.min}–${B.batchSize.max}, default ${B.batchSize.dflt}).` },
  max_wait_hours: { type: "number", description: `batch: or once the oldest new item has waited this long (default ${B.maxWaitHours.dflt}).` },
  min_wake_hours: { type: "number", description: `Never wake more often than this (default ${B.minWakeHours.dflt}).` },
  poll_hours: { type: "number", description: `How often the feed is checked (${B.pollHours.min}–${B.pollHours.max}, default ${B.pollHours.dflt}).` },
  retain_days: { type: "number", description: `Untriaged items expire after this many days (default ${B.retainDays.dflt}).` },
  ingest_focus: {
    type: "string",
    description:
      "Optional: the subject this feed's items are ingested for, in your words " +
      "(e.g. \"the author's claims about housing policy\"). Every ingest from " +
      "the feed (auto_ingest, and the lookout's triage unless it gives its own) " +
      "then extracts only the claims bearing on it. \"\" clears it.",
  },
} as const;

function feedRuleFrom(input: Record<string, unknown>): FeedRuleInput {
  return {
    wake: input.wake,
    batchSize: input.batch_size,
    maxWaitHours: input.max_wait_hours,
    minWakeHours: input.min_wake_hours,
    pollHours: input.poll_hours,
    retainDays: input.retain_days,
  };
}

export function getLookoutManagementToolDefinitions(): Tool[] {
  return [
    {
      name: "spawn_lookout",
      description:
        "Post a lookout: a standing agent that keeps watch over part of your " +
        "mission and brings what it finds to your program officers. It runs " +
        "from your money, on a heartbeat and on triggers. It can look outward " +
        "(the retraction record, feeds, the open web) and inward: with the " +
        "graph feed it reads the change stream for its territory from where it " +
        "last stopped (new and reopened work on the ledger, messages arriving " +
        "on nodes, accepted contributions, rulings, finished runs and what they " +
        "changed, verdicts moving, requests filed), and queries the graph with " +
        "SQL as it needs. It raises what deserves your money to your program " +
        "officers' inbox, with its reasons, and may commission work itself up " +
        "to the limit you give it. It never writes an assessment. Write the " +
        "brief as you would for a careful person paid to keep watch: the " +
        "territory in your words, what kinds of happening warrant work, and " +
        "what to leave alone. A lookout that reads only what changed since its " +
        "last run costs a small fraction of an assessment.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "A few words, for the mandate page." },
          brief: {
            type: "string",
            description:
              "The lookout's whole instruction set, in your words: scope, " +
              "where to look, what to look out for.",
          },
          heartbeat_hours: {
            type: "number",
            description:
              `How often it runs on its own (default 24; 0 = only on triggers; ` +
              `at most ${LOOKOUT_BOUNDS.heartbeatHours.max}).`,
          },
          triggers: {
            type: "array",
            items: { type: "string", enum: [...LOOKOUT_TRIGGER_KINDS] },
            description:
              "Inputs it also wakes on: 'retraction' (the daily Crossref " +
              "poll matched a retraction or correction to a source in the " +
              "graph), 'manual' (you or the funder poke it with a note), " +
              "'feed' (a feed it follows has new items; added for you with feeds), " +
              "'graph' (the change stream has new entries in its territory).",
          },
          territory: {
            type: "object",
            properties: {
              claim_ids: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
            },
            description:
              "For the graph feed: the part of the graph it follows, as node ids " +
              "(each with everything beneath it) and tag slugs. The brief still " +
              "says what falls under the mission; draw the territory wider than " +
              "the mission rather than narrower. A mandate whose scope is the " +
              "whole graph may leave it out to follow everything.",
          },
          commission_limit_owls: {
            type: "number",
            description:
              "The most it may commission on its own for one item, from your " +
              "money. Above that, or at 0 (the default), it raises the item to " +
              "your program officers.",
          },
          model: {
            type: "string",
            description:
              "Optional model id for a stronger watch; default is the cheap " +
              "tier. Every model has web search.",
          },
          feeds: {
            type: "array",
            items: { type: "string" },
            description:
              "URLs to follow: a feed, or any page that leads to one (a " +
              "Substack, a LessWrong user or tag page, a blog, an arXiv " +
              "listing). Each is added with the default wake rule (batch); " +
              "tune or set auto_ingest with update_feed.",
          },
        },
        required: ["title", "brief"],
      },
    },
    {
      name: "add_feed",
      description:
        "Have a lookout follow an RSS or Atom feed: an author, a " +
        "publication, a tag, a category. Give the feed URL or any page that " +
        "leads to one; it is discovered. Polling is free; new items land in " +
        "the lookout's inbox, and the WAKE RULE decides when they are worth " +
        "a funded run: batch (default: batch_size new items, or the oldest " +
        "has waited max_wait_hours), each (any new item), heartbeat (items " +
        "wait for the lookout's heartbeat), paused (keeps polling, never " +
        "wakes), or auto_ingest (no run at all: each new item becomes a " +
        "ingest, commissioned at the ingest's cap within the lookout's " +
        "commission limit and otherwise raised to your program officers, " +
        "for a source you already trust wholesale). min_wake_hours spaces wakes " +
        "out. The first poll records what the feed already carries without " +
        "queueing it; for the back-catalogue, read it with read_listing and " +
        "plan what matters. The brief, not the feed, decides relevance: a " +
        "topic is a broad feed plus a brief saying what is in scope. When " +
        "you want one subject from a source that writes about many, set " +
        "ingest_focus: its ingests then extract only the claims on that " +
        "subject, not every aside the articles carry.",
      input_schema: {
        type: "object" as const,
        properties: {
          lookout_id: { type: "string" },
          url: { type: "string" },
          ...FEED_RULE_PROPERTIES,
        },
        required: ["lookout_id", "url"],
      },
    },
    {
      name: "update_feed",
      description:
        "Change a feed's wake rule, cadence, retention, or default focus, " +
        "or remove it (status=removed) or bring it back (status=active). " +
        "Only the fields you give change.",
      input_schema: {
        type: "object" as const,
        properties: {
          lookout_id: { type: "string" },
          feed_id: { type: "string" },
          status: { type: "string", enum: ["active", "removed"] },
          ...FEED_RULE_PROPERTIES,
        },
        required: ["lookout_id", "feed_id"],
      },
    },
    {
      name: "feed_report",
      description:
        "A lookout's feeds, one row each: the rule, poll health, and how its " +
        "items fared (seen at subscribe, waiting, deferred, ingested, " +
        "auto-ingested, skipped, expired unread), and what its ingests " +
        "produced in the graph (sources, claims). The evidence for keeping, " +
        "retuning, or cutting a feed: many expired items mean the lookout " +
        "cannot keep up; ingests that yield no claims mean the feed is noise.",
      input_schema: {
        type: "object" as const,
        properties: { lookout_id: { type: "string" } },
        required: ["lookout_id"],
      },
    },
    getReadListingToolDefinition(),
    {
      name: "list_lookouts",
      description:
        "Your mandate's lookouts: brief, cadence, triggers, bounds, runs so " +
        "far, pending inputs, the last note, and each one's precision: of " +
        "the reassessments it asked for, how many ran and how many changed " +
        "a verdict or moved credence. A watch that raises noise is spending " +
        "your attention; tighten its brief or retire it.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "lookout_report",
      description:
        "One lookout's recent flags in full: what it raised, the rationale, " +
        "the value it wrote, and what became of each (waiting, ran and " +
        "moved, ran and unchanged). Read this before rewriting a brief.",
      input_schema: {
        type: "object" as const,
        properties: {
          lookout_id: { type: "string" },
          limit: { type: "number", description: "Default 30." },
        },
        required: ["lookout_id"],
      },
    },
    {
      name: "update_lookout",
      description:
        "Amend a lookout you posted: its brief, title, cadence, triggers, " +
        "bounds, model, or status (active | paused | retired). Only the " +
        "fields you give change. Retiring is final; pausing keeps its " +
        "workspace for a later resume.",
      input_schema: {
        type: "object" as const,
        properties: {
          lookout_id: { type: "string" },
          title: { type: "string" },
          brief: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "retired"] },
          heartbeat_hours: { type: "number" },
          triggers: { type: "array", items: { type: "string", enum: [...LOOKOUT_TRIGGER_KINDS] } },
          territory: {
            type: "object",
            properties: {
              claim_ids: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
            },
          },
          commission_limit_owls: { type: "number" },
          model: { type: "string" },
        },
        required: ["lookout_id"],
      },
    },
    {
      name: "poke_lookout",
      description:
        "Queue an input for a lookout so its next run reads it: something " +
        "you learned that it should check, a source to look at, a question. " +
        "The run is paid from your escrow like any other; the note is " +
        "data to the lookout, not an instruction that bypasses its brief.",
      input_schema: {
        type: "object" as const,
        properties: {
          lookout_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["lookout_id", "note"],
      },
    },
  ];
}

/**
 * Execute one of the lookout management tools for `grantId`; null for any
 * other tool name. `createdBy` records which path stood a lookout up.
 */
export async function executeLookoutManagementTool(
  grantId: string,
  name: string,
  toolInput: Record<string, unknown>,
  opts: { createdBy: string }
): Promise<string | null> {
  if (name === "spawn_lookout") {
    const feedUrls = Array.isArray(toolInput.feeds)
      ? toolInput.feeds.map(String).filter(Boolean).slice(0, FEED_BOUNDS.feedsPerLookout)
      : [];
    const triggers =
      feedUrls.length > 0
        ? [...new Set([...(Array.isArray(toolInput.triggers) ? toolInput.triggers.map(String) : []), "feed"])]
        : toolInput.triggers;
    const res = await createLookout({
      grantId,
      title: String(toolInput.title ?? ""),
      brief: String(toolInput.brief ?? ""),
      heartbeatHours:
        toolInput.heartbeat_hours === undefined ? undefined : Number(toolInput.heartbeat_hours),
      triggers,
      model: typeof toolInput.model === "string" ? toolInput.model : null,
      commissionLimitOwls:
        toolInput.commission_limit_owls === undefined ? undefined : Number(toolInput.commission_limit_owls),
      territory: territoryOf(toolInput.territory),
      createdBy: opts.createdBy,
    });
    if (!res.ok) return JSON.stringify({ success: false, code: res.code, problem: res.message });
    const feeds = [];
    for (const url of feedUrls) {
      const f = await addFeed({ grantId, lookoutId: res.lookoutId, url, createdBy: opts.createdBy });
      feeds.push(
        f.ok
          ? { url, success: true, feed_id: f.feed_id, feed_url: f.feed_url, title: f.title, items_now: f.items_now }
          : { url, success: false, code: f.code, problem: f.problem }
      );
    }
    return JSON.stringify({
      success: true,
      lookout_id: res.lookoutId,
      ...(feeds.length > 0 ? { feeds } : {}),
      note:
        "Posted. Its first run is due now (the ledger funds it from your " +
        "escrow on the next sweep); it will leave a note on the mandate " +
        "page each run and its flags reach you in your session's briefing." +
        (feeds.length > 0
          ? " Each feed's current items are recorded as already seen; new ones wake it by the feed's rule."
          : ""),
    });
  }
  if (name === "list_lookouts") {
    const lookouts = await summarizeLookouts(grantId);
    return JSON.stringify({ lookouts: lookouts.length, rows: lookouts });
  }
  if (name === "lookout_report") {
    const lookoutId = String(toolInput.lookout_id ?? "");
    const lookout = UUID_RE.test(lookoutId) ? await getLookout(lookoutId) : null;
    if (!lookout || lookout.grant_id !== grantId) {
      return JSON.stringify({ success: false, problem: "no such lookout on this mandate" });
    }
    const flags = await listLookoutFlags(lookoutId, {
      limit: Math.min(100, Math.max(1, Number(toolInput.limit ?? 30) || 30)),
    });
    return JSON.stringify({
      lookout: { id: lookout.id, title: lookout.title, status: lookout.status, workspace: lookout.workspace },
      flags: flags.length,
      rows: flags,
    });
  }
  if (name === "update_lookout") {
    const res = await updateLookout({
      grantId,
      lookoutId: String(toolInput.lookout_id ?? ""),
      ...(toolInput.title !== undefined ? { title: String(toolInput.title) } : {}),
      ...(toolInput.brief !== undefined ? { brief: String(toolInput.brief) } : {}),
      ...(toolInput.status !== undefined ? { status: String(toolInput.status) } : {}),
      ...(toolInput.heartbeat_hours !== undefined
        ? { heartbeatHours: Number(toolInput.heartbeat_hours) }
        : {}),
      ...(toolInput.triggers !== undefined ? { triggers: toolInput.triggers } : {}),
      ...(toolInput.commission_limit_owls !== undefined
        ? { commissionLimitOwls: Number(toolInput.commission_limit_owls) }
        : {}),
      ...(toolInput.territory !== undefined ? { territory: territoryOf(toolInput.territory) } : {}),
      ...(toolInput.model !== undefined ? { model: String(toolInput.model) } : {}),
    });
    return JSON.stringify(
      res.ok ? { success: true, lookout_id: res.lookoutId } : { success: false, code: res.code, problem: res.message }
    );
  }
  if (name === "add_feed") {
    const res = await addFeed({
      grantId,
      lookoutId: String(toolInput.lookout_id ?? ""),
      url: String(toolInput.url ?? ""),
      rule: feedRuleFrom(toolInput),
      ...(typeof toolInput.ingest_focus === "string" ? { ingestFocus: toolInput.ingest_focus } : {}),
      createdBy: opts.createdBy,
    });
    return JSON.stringify(res.ok ? { success: true, ...res } : { success: false, code: res.code, problem: res.problem });
  }
  if (name === "update_feed" || name === "feed_report") {
    const lookoutId = String(toolInput.lookout_id ?? "");
    const lookout = UUID_RE.test(lookoutId) ? await getLookout(lookoutId) : null;
    if (!lookout || lookout.grant_id !== grantId) {
      return JSON.stringify({ success: false, problem: "no such lookout on this mandate" });
    }
    if (name === "feed_report") {
      const rows = await feedReport(lookoutId);
      return JSON.stringify({ lookout: { id: lookout.id, title: lookout.title }, feeds: rows.length, rows });
    }
    const feed = await getFeed(String(toolInput.feed_id ?? ""));
    if (!feed || feed.lookout_id !== lookoutId) {
      return JSON.stringify({ success: false, problem: "no such feed on this lookout" });
    }
    const res = await updateFeed({
      lookoutId,
      feedId: feed.id,
      by: "grantmaker",
      rule: feedRuleFrom(toolInput),
      ...(toolInput.status !== undefined ? { status: String(toolInput.status) } : {}),
      ...(typeof toolInput.ingest_focus === "string" ? { ingestFocus: toolInput.ingest_focus } : {}),
    });
    return JSON.stringify(res.ok ? { success: true, feed_id: res.feed_id } : { success: false, code: res.code, problem: res.problem });
  }
  const listing = await executeReadListing(name, toolInput);
  if (listing !== null) return listing;
  if (name === "poke_lookout") {
    const lookoutId = String(toolInput.lookout_id ?? "");
    const lookout = UUID_RE.test(lookoutId) ? await getLookout(lookoutId) : null;
    if (!lookout || lookout.grant_id !== grantId) {
      return JSON.stringify({ success: false, problem: "no such lookout on this mandate" });
    }
    const note = String(toolInput.note ?? "").trim().slice(0, LOOKOUT_BOUNDS.noteChars);
    if (!note) return JSON.stringify({ success: false, problem: "say something" });
    const res = await queueLookoutEvent({
      lookoutId,
      kind: "manual",
      payload: { note, from: opts.createdBy },
    });
    return JSON.stringify(
      res.queued
        ? { success: true, note: "Queued; the lookout reads it on its next funded run." }
        : { success: false, problem: "the lookout is not active" }
    );
  }
  return null;
}

/** A tool's territory input, as the service takes it. */
function territoryOf(raw: unknown): { claimIds?: unknown; tagSlugs?: unknown } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as { claim_ids?: unknown; tags?: unknown };
  return { claimIds: t.claim_ids, tagSlugs: t.tags };
}
