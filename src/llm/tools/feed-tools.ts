/**
 * Feed tools (#305): the lookout's inbox of items from the feeds it
 * follows, and read_listing, shared with the Grantmaker.
 *
 * The lookout reads at whatever depth it judges the job needs — a lead, an
 * outline, one section, or the whole document in pages. Nothing here
 * narrows that; what bounds a run's spending is the mechanism around it
 * (the per-run cost cap, the daily run cap, the mandate's escrow). What a
 * read costs is reported back on every call so the lookout can weigh it.
 *
 * Null-delegate convention: `execute` returns null for any other tool
 * name, so an agent wires these with one spread and one early return.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  feedInbox,
  readItem,
  readListing,
  triageItems,
  updateFeed,
  LOOKOUT_SETTABLE_WAKE_RULES,
  READ_VIEWS,
  TRIAGE_DECISIONS,
} from "../../services/feed-service.js";
import { flagNote } from "../../services/lookout-service.js";

export const READ_LISTING_TOOL_NAME = "read_listing";

export function getReadListingToolDefinition(): Tool {
  return {
    name: READ_LISTING_TOOL_NAME,
    description:
      "List the links a listing points to — an archive page, an author's " +
      "post index, a sitemap, a feed — 100 at a time (page with offset). " +
      "For a page it also names any RSS/Atom feeds the page advertises. " +
      "Use it to explore what a source has published before deciding what " +
      "to watch or ingest. Nothing is ingested; the listing is data.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        offset: { type: "number", description: "From next_offset of the previous call." },
      },
      required: ["url"],
    },
  };
}

export async function executeReadListing(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  if (name !== READ_LISTING_TOOL_NAME) return null;
  return JSON.stringify(await readListing(String(input.url ?? ""), Number(input.offset ?? 0)));
}

export function getLookoutFeedToolDefinitions(): Tool[] {
  return [
    {
      name: "feed_inbox",
      description:
        "Your inbox: items from the feeds you follow, as short rows (title, " +
        "author, date, one-line summary, link, status), newest first unless " +
        "you ask for oldest. Defaults to items waiting for you (new and " +
        "deferred); ask for 'seen' to see what a feed carried when it was " +
        "first followed, or 'skipped'/'expired'/'ingested' to review. Filter " +
        "by feed_id; page with offset.",
      input_schema: {
        type: "object" as const,
        properties: {
          feed_id: { type: "string" },
          statuses: {
            type: "array",
            items: { type: "string", enum: ["new", "deferred", "seen", "ingested", "skipped", "expired"] },
          },
          order: { type: "string", enum: ["newest", "oldest"] },
          limit: { type: "number", description: "Default 30, max 100." },
          offset: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "read_item",
      description:
        "Read one inbox item at the depth you want. view=lead: the opening " +
        "text, the headings, and the outbound links (what the post cites or " +
        "answers). view=outline: its sections and their lengths. " +
        "view=section with section=n: one section. view=full with page=n: " +
        "the whole document, about 12,000 characters a page. Text comes " +
        "from the feed's own copy when that is the whole item, else from " +
        "the page (fetched once and cached, so ingesting it later reuses " +
        "the fetch); from='page' or 'feed' forces one. Every result says " +
        "whether the URL is already a source in the graph, and how much " +
        "you have read this run.",
      input_schema: {
        type: "object" as const,
        properties: {
          item_id: { type: "string" },
          view: { type: "string", enum: [...READ_VIEWS] },
          section: { type: "number" },
          page: { type: "number" },
          from: { type: "string", enum: ["feed", "page"] },
        },
        required: ["item_id"],
      },
    },
    {
      name: "triage_items",
      description:
        "Record your decision on inbox items, many per call. ingest: put the " +
        "item's URL on the mandate's plan (priced against the escrow; counts " +
        "toward your per-run ingest limit, shared with propose_ingest; " +
        "refused for a URL already in the graph or on the plan). skip: not " +
        "worth ingesting. defer: come back to it on a later run. A reason " +
        "is optional, and for an ingest it becomes the plan item's " +
        "rationale. skip_rest skips everything still waiting from one " +
        "feed (optionally only items that arrived before a time). Untriaged " +
        "items stay in the inbox until the feed's retention expires them.",
      input_schema: {
        type: "object" as const,
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item_id: { type: "string" },
                decision: { type: "string", enum: [...TRIAGE_DECISIONS] },
                reason: { type: "string" },
              },
              required: ["item_id", "decision"],
            },
          },
          skip_rest: {
            type: "object",
            properties: {
              feed_id: { type: "string" },
              before: { type: "string", description: "ISO time; only items that arrived before it." },
              reason: { type: "string" },
            },
            required: ["feed_id"],
          },
        },
        required: [],
      },
    },
    {
      name: "set_feed_rule",
      description:
        "Change when one of your feeds wakes you, in either direction. " +
        "wake=batch: when batch_size new items have arrived since you were " +
        "last woken for it, or the oldest has waited max_wait_hours; " +
        "wake=each: on any new item; wake=heartbeat: never, its items wait " +
        "for your heartbeat; wake=paused: never, it keeps polling. " +
        "min_wake_hours spaces wakes out; poll_hours is how often it is " +
        "checked; retain_days is how long an untriaged item waits before it " +
        "expires. A feed your Grantmaker set to auto_ingest is theirs to " +
        "change. Say why in note: it reaches your Grantmaker's next review.",
      input_schema: {
        type: "object" as const,
        properties: {
          feed_id: { type: "string" },
          wake: { type: "string", enum: [...LOOKOUT_SETTABLE_WAKE_RULES] },
          batch_size: { type: "number" },
          max_wait_hours: { type: "number" },
          min_wake_hours: { type: "number" },
          poll_hours: { type: "number" },
          retain_days: { type: "number" },
          note: { type: "string" },
        },
        required: ["feed_id"],
      },
    },
    getReadListingToolDefinition(),
  ];
}

/**
 * The executor for one run. `ingestsLeft` reads the run's remaining ingest
 * allowance (shared with propose_ingest), `onIngested` spends it.
 */
export function createLookoutFeedTools(ctx: {
  lookoutId: string;
  grantId: string;
  ingestsLeft: () => number;
  onIngested: (n: number) => void;
}): {
  definitions: Tool[];
  execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
  charsRead: () => number;
} {
  let charsRead = 0;
  return {
    definitions: getLookoutFeedToolDefinitions(),
    charsRead: () => charsRead,
    execute: async (name, input) => {
      const listing = await executeReadListing(name, input);
      if (listing !== null) return listing;
      if (name === "feed_inbox") {
        return JSON.stringify(
          await feedInbox({
            lookoutId: ctx.lookoutId,
            feedId: typeof input.feed_id === "string" ? input.feed_id : null,
            statuses: Array.isArray(input.statuses) ? input.statuses.map(String) : undefined,
            order: input.order === "oldest" ? "oldest" : "newest",
            limit: Number(input.limit ?? 30),
            offset: Number(input.offset ?? 0),
          })
        );
      }
      if (name === "read_item") {
        const res = await readItem({
          lookoutId: ctx.lookoutId,
          itemId: String(input.item_id ?? ""),
          view: typeof input.view === "string" ? input.view : "lead",
          section: input.section === undefined ? undefined : Number(input.section),
          page: input.page === undefined ? undefined : Number(input.page),
          from: input.from === "page" || input.from === "feed" ? input.from : undefined,
        });
        if (!res.ok) return JSON.stringify(res);
        charsRead += res.chars_returned;
        return JSON.stringify({
          ...res,
          // About four characters a token: what this run's reading has cost in context.
          read_this_run: { chars: charsRead, approx_tokens: Math.round(charsRead / 4) },
        });
      }
      if (name === "triage_items") {
        const skip = input.skip_rest as Record<string, unknown> | undefined;
        const res = await triageItems({
          lookoutId: ctx.lookoutId,
          grantId: ctx.grantId,
          decisions: Array.isArray(input.decisions)
            ? (input.decisions as Array<Record<string, unknown>>)
            : [],
          skipRest:
            skip && typeof skip.feed_id === "string"
              ? {
                  feedId: skip.feed_id,
                  before: typeof skip.before === "string" ? skip.before : null,
                  reason: typeof skip.reason === "string" ? skip.reason : null,
                }
              : null,
          ingestAllowance: ctx.ingestsLeft(),
        });
        if (res.ingested > 0) ctx.onIngested(res.ingested);
        return JSON.stringify({ ...res, ingests_left_this_run: ctx.ingestsLeft() });
      }
      if (name === "set_feed_rule") {
        const res = await updateFeed({
          lookoutId: ctx.lookoutId,
          feedId: String(input.feed_id ?? ""),
          by: "lookout",
          rule: {
            wake: input.wake,
            batchSize: input.batch_size,
            maxWaitHours: input.max_wait_hours,
            minWakeHours: input.min_wake_hours,
            pollHours: input.poll_hours,
            retainDays: input.retain_days,
          },
        });
        // The why reaches the Grantmaker's next review pass with the change.
        const note = typeof input.note === "string" ? input.note.trim() : "";
        if (res.ok && note.length >= 10) {
          await flagNote({
            lookoutId: ctx.lookoutId,
            text: `Changed the wake rule of feed ${res.feed_id}: ${note}`,
          });
        }
        return JSON.stringify(res);
      }
      return null;
    },
  };
}
