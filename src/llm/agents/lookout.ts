/**
 * The Lookout run — a mandate's standing watch, woken by a trigger.
 *
 * A Lookout is the cheapest agent in the system with the narrowest
 * question: has anything happened, in the scope its brief describes, that
 * warrants work on the graph? Its Grantmaker wrote the brief (scope in
 * words, where to look, what to look out for), chose its triggers (a
 * heartbeat, the retraction poller, a manual poke) and delegated a bounded
 * slice of the mandate's spending judgment: a ceiling on the valuation a
 * flag or an ingest may carry (#695). The ledger funds each run
 * from the mandate's escrow (`lookout_run`, fundGrantSelfActions) and the
 * engine executor runs this agent with the affordances a watcher needs —
 *
 *  - its brief, its own durable workspace, and the inputs queued for it;
 *  - the graph reads (search, open, walk down, walk up) and a scope survey;
 *  - the retraction record (Crossref: check_doi, recent_retractions) and
 *    the sources behind the claims in scope;
 *  - the open web (web_search, and read_page for one page in full);
 *  - its feeds (#305): an inbox of new items from the RSS/Atom feeds it
 *    follows, read at whatever depth it judges right (read_item), triaged
 *    many at a time (triage_items), and its own feeds' wake rules
 *    (set_feed_rule); read_listing for an archive or index;
 *  - three ways to raise a candidate: flag_reassessment (a valued reassess
 *    row), propose_ingest (a valued ingest row), leave_note (for the next
 *    review);
 *  - submit_contribution: what it found, through the Contribution Reviewer
 *    like anyone's, the review paid from the mandate's escrow (§19).
 *
 * What it cannot do is the point: it writes no assessment, sets no
 * importance, moves no money. Everything it raises is a candidate the
 * mechanism prices and the mandate's allocator funds or not, and its flags
 * are recorded so its precision can be read (lookout-service.ts).
 */
import { RUN_TURN_GUARD, runBudgetSentence } from "../prompts/turn-budget.js";
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { GRAPH_CHANGE_KINDS, listGraphChanges } from "../../services/graph-change-service.js";
import { getSqlToolDefinition, executeSqlTool } from "../tools/sql-tools.js";

/** How many change-stream entries one run reads; the rest wait for the next. */
const GRAPH_FEED_PER_RUN = 60;
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createGrantContributionTools } from "../tools/grant-contribution-tools.js";
import { getLookoutSystemPromptBlocks } from "../prompts/lookout.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import { createMandateTools } from "../tools/mandate-tools.js";
import {
  consumeLookoutEvents,
  countPendingLookoutEvents,
  flagIngest,
  flagNote,
  flagReassessment,
  listLookoutFlags,
  lookoutFeedSummaries,
  pendingLookoutEvents,
  updateLookoutWorkspace,
  LOOKOUT_BOUNDS,
  type LookoutEventRow,
  type LookoutRow,
} from "../../services/lookout-service.js";
import { createLookoutFeedTools, getReadListingToolDefinition } from "../tools/feed-tools.js";
import {
  checkDoi,
  claimsRestingOnSources,
  recentRetractionsPage,
  scopeSources,
} from "../../services/source-watch-service.js";

/** Events read per run; the rest wait for the next run, and the briefing says how many. */
const EVENTS_PER_RUN = 50;
/** Recent flags shown in the briefing, with the total beside them. */
const RECENT_FLAGS_SHOWN = 20;
/**
 * Queued inputs are shown in full in the briefing up to about this many
 * characters; past it the rest are listed one line each and read_event
 * reads any of them in full (#685). Nothing is withheld: this only keeps a
 * burst of large events from filling the briefing before the brief is read.
 */
const EVENTS_FULL_CHARS = 40_000;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * One queued input as text, every field shown (#685). A retraction event
 * lists the claims that assert the source and, one per line, the claims
 * that rest on it through recorded provenance; it used to be a JSON string
 * cut at 1,500 characters, which on any well-cited source dropped the
 * second list entirely.
 */
export function renderLookoutEvent(e: LookoutEventRow): string {
  const when = new Date(e.created_at).toISOString().slice(0, 16);
  const head = `- [${e.kind}] ${when} (event ${e.id})`;
  const p = e.payload ?? {};
  if (e.kind === "retraction") {
    const claimIds = Array.isArray(p.claim_ids) ? p.claim_ids.map(str) : [];
    const resting = Array.isArray(p.resting_claims)
      ? (p.resting_claims as Array<Record<string, unknown>>)
      : [];
    const lines = [
      `${head}: ${str(p.notice_type) || "retraction"} notice` +
        (p.notice_doi ? ` ${str(p.notice_doi)}` : "") +
        (p.notice_title ? ` "${str(p.notice_title)}"` : "") +
        (p.notice_source ? ` (${str(p.notice_source)})` : ""),
      `  against DOI ${str(p.doi)}: source ${str(p.source_id)} "${str(p.source_title)}" ${str(p.source_url)}`,
      `  claims asserting it (${claimIds.length}): ${claimIds.join(", ") || "none"}`,
      `  claims resting on it through provenance (${resting.length}):` + (resting.length ? "" : " none"),
      ...resting.map(
        (r) =>
          `    - ${str(r.claim_id)} via ${str(r.via)}` +
          (r.relation_type ? ` (${str(r.relation_type)})` : "") +
          ` through source ${str(r.through_source_id)} "${str(r.through_source_title)}"`
      ),
    ];
    if (p.note) lines.push(`  ${str(p.note)}`);
    return lines.join("\n");
  }
  if (e.kind === "manual" && typeof p.note === "string") {
    return `${head} from ${str(p.from) || "your Grantmaker"}: ${p.note}`;
  }
  return `${head}: ${JSON.stringify(p)}`;
}

/** One line for an event the briefing does not show in full. */
function summarizeLookoutEvent(e: LookoutEventRow): string {
  const when = new Date(e.created_at).toISOString().slice(0, 16);
  const p = e.payload ?? {};
  const what =
    e.kind === "retraction"
      ? `${str(p.notice_type) || "retraction"} against "${str(p.source_title)}" ` +
        `(${Array.isArray(p.claim_ids) ? p.claim_ids.length : 0} asserting, ` +
        `${Array.isArray(p.resting_claims) ? p.resting_claims.length : 0} resting)`
      : e.kind;
  return `- [${e.kind}] ${when} (event ${e.id}): ${what}`;
}

export interface LookoutRunResult {
  note: string;
  flagsRaised: number;
  ingestsProposed: number;
  notesLeft: number;
  eventsConsumed: number;
}


export function runLookout(
  input: Parameters<typeof runLookoutImpl>[0]
): ReturnType<typeof runLookoutImpl> {
  return withAgent("lookout", () => runLookoutImpl(input));
}

async function runLookoutImpl(input: {
  lookoutId: string;
  model?: string;
}): Promise<LookoutRunResult> {
  const config = loadConfig();
  const [lookout] = await rawQuery<
    LookoutRow & {
      grant_skills: string[] | null;
      mandate_title: string | null;
      mandate_objective: string | null;
      grant_status: string;
      scope_claim_id: string | null;
      scope_query: string | null;
    }
  >(
    `SELECT l.*, g.skills AS grant_skills, g.status AS grant_status,
            COALESCE(g.mandate->>'title', g.name) AS mandate_title,
            g.mandate->>'objective' AS mandate_objective,
            g.scope_claim_id, g.scope_query
       FROM lookouts l JOIN grants g ON g.id = l.grant_id
      WHERE l.id = $1`,
    [input.lookoutId]
  );
  if (!lookout || lookout.status !== "active" || lookout.grant_status !== "active") {
    throw new Error(`lookout ${input.lookoutId} not found, not active, or its mandate is not active`);
  }

  // Skills load on demand; the mandate's skills point the lookout to the
  // ones its watch may need, as they do the review pass.
  const skillLoader = createSkillLoadTools("lookout", { names: lookout.grant_skills ?? [] });
  const system = getLookoutSystemPromptBlocks();

  // Model: the lookout's own pin, else the cheap default. Web search comes
  // with either (tools/web-search-tool.ts).
  const model = input.model ?? lookout.model ?? config.lookoutModel;
  const webSearch = createWebSearch(model);

  const events = await pendingLookoutEvents(lookout.id, EVENTS_PER_RUN);
  const pendingEvents =
    events.length < EVENTS_PER_RUN ? events.length : await countPendingLookoutEvents(lookout.id);
  const recentFlags = await listLookoutFlags(lookout.id, { limit: RECENT_FLAGS_SHOWN });
  const reportTools = createReportTools({ model });
  const feeds = await lookoutFeedSummaries(lookout.id);
  // The graph feed: what changed in the lookout's territory since it last
  // read the change stream, every kind (graph-change-service.ts).
  const graphFeed = (lookout.triggers ?? []).includes("graph")
    ? await listGraphChanges({
        after: lookout.changes_cursor,
        since: lookout.changes_cursor ? null : lookout.last_run_at ?? new Date(Date.now() - 86_400_000),
        scope: { under: lookout.territory_claim_ids ?? [], tagIds: lookout.territory_tag_ids ?? [] },
        kinds: [...GRAPH_CHANGE_KINDS],
        materialOnly: true,
        limit: GRAPH_FEED_PER_RUN,
      })
    : null;
  const graphFeedText = graphFeed
    ? graphFeed.changes.length === 0
      ? "(nothing new in your territory)"
      : graphFeed.changes
          .map(
            (c, i) =>
              `[c${i + 1}] ${c.kind} · ${c.claim_id} ("${c.claim_text.slice(0, 100)}") · ${c.at.slice(0, 16).replace("T", " ")}` +
              (c.summary ? ` · ${c.summary}` : c.status ? ` · ${c.prev_status ? `${c.prev_status} → ` : ""}${c.status}` : "")
          )
          .join("\n") +
        (graphFeed.has_more ? `\n(more changes wait; the next run reads on from the last one here)` : "")
    : "";
  // What bounds a run is its metered cost against the budget its action
  // carries; the turn cap only halts a loop that has stopped spending.
  const maxIterations = RUN_TURN_GUARD;

  let flagsRaised = 0;
  let ingestsProposed = 0;
  let notesLeft = 0;
  const feedTools = createLookoutFeedTools({
    lookoutId: lookout.id,
    grantId: lookout.grant_id,
    commissionLimitMicroUsd: Number(lookout.commission_limit_micro_usd ?? 0),
    onIngested: (n) => {
      ingestsProposed += n;
      flagsRaised += n;
    },
  });

  // Contributions through the Reviewer, paid from the mandate's escrow (§19).
  const contributionTools = createGrantContributionTools(lookout.grant_id);
  // survey_scope and read_page are the mandate toolbox's, one implementation
  // in every mode (#691). No grantId: the lookout's workspace is its own,
  // not the mandate's, and is written by its own tool below.
  const mandateTools = createMandateTools({
    surveyLimit: 25,
    scopeClaimId: lookout.scope_claim_id,
    scopeQuery: lookout.scope_query,
  });

  // Queued inputs in full, up to EVENTS_FULL_CHARS; the rest one line each.
  const shownInFull: string[] = [];
  const summarized: string[] = [];
  let briefingChars = 0;
  for (const e of events) {
    const full = renderLookoutEvent(e);
    if (summarized.length === 0 && (shownInFull.length === 0 || briefingChars + full.length <= EVENTS_FULL_CHARS)) {
      shownInFull.push(full);
      briefingChars += full.length;
    } else {
      summarized.push(summarizeLookoutEvent(e));
    }
  }
  const eventsById = new Map(events.map((e) => [e.id, e]));

  const tools: Tool[] = [
    ...reportTools.definitions,
    ...getGraphReadToolDefinitions(),
    getSqlToolDefinition(),
    ...contributionTools.definitions,
    ...mandateTools.definitions,
    ...(summarized.length > 0
      ? [
          {
            name: "read_event",
            description:
              "Read one of this run's queued inputs in full, by the event id " +
              "the briefing lists. The briefing shows the first inputs in full " +
              "and lists the rest one line each.",
            input_schema: {
              type: "object" as const,
              properties: { event_id: { type: "string" } },
              required: ["event_id"],
            },
          },
        ]
      : []),
    {
      name: "scope_sources",
      description:
        "The sources behind a set of claims (a subtree root and/or explicit " +
        "claim ids), or named sources (source_ids, e.g. the source a " +
        "retraction notice names): URL, title, when the graph last fetched " +
        "it, the DOIs its URL carries, and which claims assert it. A source " +
        "named by id comes back with every claim that asserts it, and " +
        "resting_claims lists the claims that rest on it through recorded " +
        "provenance (a copy or version of the work, or a source that draws " +
        "on it). This is what a retraction or change watch has to check. " +
        "Most-cited first.",
      input_schema: {
        type: "object" as const,
        properties: {
          root_claim_id: { type: "string", description: "Subtree root (optional)." },
          claim_ids: { type: "array", items: { type: "string" }, maxItems: 100, description: "At most 100 per call." },
          source_ids: { type: "array", items: { type: "string" }, maxItems: 50, description: "At most 50 per call." },
          limit: { type: "number", description: "Sources returned: default 50, max 200." },
        },
        required: [],
      },
    },
    {
      name: "check_doi",
      description:
        "One paper's standing on the Crossref record, which carries the " +
        "Retraction Watch database: its title, type and date, its citation " +
        "count, and every notice that updates it (retractions, " +
        "corrections, expressions of concern), each with the notice's DOI " +
        "and date. Accepts a bare DOI or a doi.org URL. An empty `updates` list " +
        "means nothing is on record against it.",
      input_schema: {
        type: "object" as const,
        properties: { doi: { type: "string" } },
        required: ["doi"],
      },
    },
    {
      name: "recent_retractions",
      description:
        "Retraction notices (optionally corrections and expressions of " +
        "concern too) added to Crossref in the last N days, newest first, " +
        "optionally narrowed by a free-text query, 50 a page with the total " +
        "and next_offset. Each entry names the retracted DOI(s), so you can " +
        "check them against scope_sources. Use this for a field-wide watch; " +
        "for one paper use check_doi.",
      input_schema: {
        type: "object" as const,
        properties: {
          days: { type: "number", description: "Look back this many days (default 30, max 365)." },
          query: { type: "string", description: "Free-text narrowing, e.g. a field or a journal." },
          include_corrections: { type: "boolean" },
          offset: { type: "number", description: "From next_offset of the previous call (Crossref serves up to 10,000)." },
        },
        required: [],
      },
    },
    // read_listing is every lookout's; the inbox tools only matter with feeds.
    ...(feeds.length > 0 ? feedTools.definitions : [getReadListingToolDefinition()]),
    {
      name: "flag_reassessment",
      description:
        "Raise a claim for a fresh Steward pass because something you saw " +
        "bears on it. With budget_owls within the limit your task message " +
        "states, the pass is commissioned from the mandate at once; " +
        "otherwise it is raised to the mandate's program officers, who " +
        "decide under its operating policy. Your rationale reaches the " +
        "Steward as its brief, so say concretely what happened, where you " +
        "saw it, and why it bears on this claim; never name the mandate. A " +
        "claim you already flagged and that is still waiting counts as a " +
        "repeat, not a new flag.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          rationale: { type: "string" },
          budget_owls: {
            type: "number",
            description:
              "Optional: the pass's budget, from cost_sheet's high end for a pass " +
              "on such a node. Leave it out to raise the claim to the officers.",
          },
        },
        required: ["claim_id", "rationale"],
      },
    },
    {
      name: "propose_ingest",
      description:
        "Raise a source you have actually seen for ingestion (extract and " +
        "match its claims into the graph). It becomes open work on the " +
        "ledger; with budget_owls within the limit your task message states " +
        "it is commissioned at once, and otherwise it is raised to the " +
        "mandate's program officers. Refused for a URL already in the graph, already on " +
        "the plan, or already ingested; one you raised that still waits is " +
        "a repeat. A focus scopes the ingest: the " +
        "extractor reads the whole document but proposes only the claims " +
        "bearing on that subject. Use one when your brief wants one subject " +
        "from a document that ranges wider.",
      input_schema: {
        type: "object" as const,
        properties: {
          url: { type: "string" },
          rationale: { type: "string" },
          budget_owls: {
            type: "number",
            description:
              "Optional: the ingest's budget, from cost_sheet. Leave it out to " +
              "raise the source to the officers.",
          },
          focus: {
            type: "string",
            description: "Optional: the subject to read the document for, in your brief's words. Omit for the whole document.",
          },
        },
        required: ["url", "rationale"],
      },
    },
    {
      name: "leave_note",
      description:
        "Leave a note for your Grantmaker's next review pass: a pattern " +
        "across several claims, a source you could not read, a happening " +
        "that needs a judgment above your pay grade, a suggestion for your " +
        "own brief or triggers. No ledger effect. Optionally anchor it to a " +
        "claim id or a URL.",
      input_schema: {
        type: "object" as const,
        properties: {
          text: { type: "string" },
          claim_id: { type: "string" },
          url: { type: "string" },
        },
        required: ["text"],
      },
    },
    {
      name: "update_workspace",
      description:
        "Rewrite your workspace: your own memory between runs, read back " +
        "in full at the start of every run. Keep here what you have already " +
        "checked and when, what you have flagged and is still waiting (so " +
        "you do not raise it again), sources or DOIs to watch, what the " +
        "next run should look at first. Replaces the whole document, up to " +
        `${LOOKOUT_BOUNDS.workspaceChars.toLocaleString("en-US")} characters; keep it short and current.`,
      input_schema: {
        type: "object" as const,
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  ];

  const eventsText =
    events.length === 0
      ? `(none — this run is your heartbeat)`
      : shownInFull.join("\n") +
        (summarized.length > 0
          ? `\n\nThe rest of this run's inputs, one line each (read_event reads any in full):\n` +
            summarized.join("\n")
          : "") +
        (pendingEvents > events.length
          ? `\n\n${pendingEvents - events.length} more input${pendingEvents - events.length === 1 ? " waits" : "s wait"} ` +
            `beyond these ${events.length}; they are read on your next run.`
          : "");
  const feedsText = feeds
    .map(
      (f) =>
        `- ${f.feed_id} "${f.title ?? f.url}" (${f.url}): wake ${f.wake}; ` +
        (f.ingest_focus ? `ingests read for "${f.ingest_focus}"; ` : "") +
        `${f.waiting} waiting${f.deferred ? `, ${f.deferred} deferred` : ""}` +
        (f.oldest_waiting ? `, oldest since ${f.oldest_waiting.slice(0, 16)}` : "") +
        (f.status !== "active" ? `; feed ${f.status}${f.last_error ? ` (${f.last_error.slice(0, 120)})` : ""}` : "")
    )
    .join("\n");
  const openFlagsText =
    recentFlags.length === 0
      ? `(none yet)`
      : recentFlags
          .map((f) => {
            const target = f.claim_id
              ? `claim ${f.claim_id}${f.claim_text ? ` ("${f.claim_text.slice(0, 80)}")` : ""}`
              : f.url ?? "";
            const state =
              f.kind === "reassess"
                ? f.moved
                  ? "pass ran and moved the assessment"
                  : f.ran
                    ? "pass ran, assessment unchanged"
                    : f.action_status === "open" || f.action_status === "running"
                      ? "still waiting for its pass"
                      : "closed without a pass"
                : f.kind === "ingest" && f.action_status
                  ? f.action_status === "open"
                    ? "ingest waiting on the ledger"
                    : f.action_status === "done"
                      ? "ingested"
                      : `ingest ${f.action_status}`
                  : f.kind;
            return `- ${new Date(f.created_at).toISOString().slice(0, 10)} ${f.kind} ${target}: ${state}${f.repeats > 0 ? ` (repeated ${f.repeats}x)` : ""}`;
          })
          .join("\n");

  const briefing =
    `## Lookout run\n\n` +
    `You are "${lookout.title}", a lookout posted by the mandate ` +
    `"${lookout.mandate_title ?? ""}". Nobody is watching this run; act with ` +
    `the judgment of a careful person paid to keep watch over one thing.\n\n` +
    (lookout.mandate_objective?.trim()
      ? `The mandate's objective, for context (your brief is your scope): ${lookout.mandate_objective.trim()}\n\n`
      : "") +
    `### Your brief\n\n${lookout.brief}\n\n` +
    `### Your delegated bounds\n\n` +
    (Number(lookout.commission_limit_micro_usd ?? 0) > 0
      ? `- You may commission work yourself up to ${Number(lookout.commission_limit_micro_usd ?? 0) / 1_000_000} owls an item ` +
        `(name budget_owls); anything above that, or without a budget, goes to the mandate's program officers.\n`
      : `- Everything you raise goes to the mandate's program officers, who decide under its operating policy.\n`) +
    `- ${runBudgetSentence() || "This run has no budget of its own."} Each tool result shows what you have spent.\n` +
    `- Heartbeat: ${lookout.heartbeat_hours > 0 ? `every ${lookout.heartbeat_hours}h` : "none (event-driven)"}; triggers: ${(lookout.triggers ?? []).join(", ") || "none"}.\n\n` +
    `### Inputs queued for this run\n\n${eventsText}\n\n` +
    (graphFeed
      ? `### What changed in your territory since your last run (${graphFeed.changes.length} entries)\n\n${graphFeedText}\n\n`
      : "") +
    (feeds.length > 0
      ? `### Your feeds and what is waiting in your inbox\n\n${feedsText}\n\n`
      : "") +
    `### Your recent flags and what became of them\n\n` +
    (recentFlags.length >= RECENT_FLAGS_SHOWN && Number(lookout.flags) > recentFlags.length
      ? `The ${recentFlags.length} most recent of the ${lookout.flags} you have raised; keep what matters about older ones in your workspace.\n\n`
      : "") +
    `${openFlagsText}\n\n` +
    `### Your workspace\n\n` +
    (lookout.workspace?.trim()
      ? lookout.workspace
      : `(empty — this is your first run. Start it: what you checked, what to watch.)`) +
    `\n\n---\n\n` +
    `Do what the brief needs this run and nothing more. Read the queued ` +
    `inputs first; then look where the brief says to look; raise what ` +
    `warrants work; update your workspace; finish with a short note ` +
    `(recorded on the mandate's page) saying what you checked and what, if ` +
    `anything, you raised. Finding nothing is the common outcome and a ` +
    `fine one.`;

  const result = await withSkills(
    [],
    () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: briefing + skillLoader.pointerNote }],
        tools: [webSearch.tool, ...tools, ...skillLoader.definitions],
        system,
        model,
        // Room to rewrite a full workspace (up to 50,000 characters) in one
        // call; at 2048 a workspace past about 8k characters was cut off
        // mid-write (#689).
        maxTokens: 16384,
        maxIterations,
        iterationBudgetNotice: {
          warnWithin: 3,
          message: (remaining) =>
            `You have ${remaining} tool turn${remaining === 1 ? "" : "s"} left. ` +
            `Raise anything you are sure of, update your workspace, and finish with your note.`,
        },
        executeTool: async (name, toolInput) => {
          if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
          const loaded = await skillLoader.execute(name, toolInput);
          if (loaded !== null) return loaded;
          const report = await reportTools.execute(name, toolInput);
          if (report !== null) return report;
          const contributed = await contributionTools.execute(name, toolInput);
          if (contributed !== null) return contributed;
          const graphRead = await executeGraphReadTool(name, toolInput);
          if (graphRead !== null) return graphRead;
          const sqlOut = await executeSqlTool(name, toolInput);
          if (sqlOut !== null) return sqlOut;

          const mandateTool = await mandateTools.execute(name, toolInput);
          if (mandateTool !== null) return mandateTool;

          if (name === "read_event") {
            const e = eventsById.get(String(toolInput.event_id ?? ""));
            return e
              ? renderLookoutEvent(e)
              : JSON.stringify({ ok: false, problem: "no such input queued for this run" });
          }
          if (name === "scope_sources") {
            const claimIds = Array.isArray(toolInput.claim_ids)
              ? toolInput.claim_ids.map(String).slice(0, 100)
              : [];
            const sourceIds = Array.isArray(toolInput.source_ids)
              ? toolInput.source_ids.map(String).slice(0, 50)
              : [];
            const rows = await scopeSources({
              claimIds,
              sourceIds,
              rootClaimId:
                typeof toolInput.root_claim_id === "string" && toolInput.root_claim_id
                  ? toolInput.root_claim_id
                  : null,
              limit: Number(toolInput.limit ?? 50),
            });
            const resting = sourceIds.length > 0 ? await claimsRestingOnSources(sourceIds) : [];
            return JSON.stringify({
              sources: rows.length,
              rows,
              ...(sourceIds.length > 0 ? { resting_claims: resting } : {}),
            });
          }
          if (name === "check_doi") {
            return JSON.stringify(await checkDoi(String(toolInput.doi ?? "")));
          }
          if (name === "recent_retractions") {
            const days = Math.min(365, Math.max(1, Number(toolInput.days ?? 30) || 30));
            const page = await recentRetractionsPage({
              since: new Date(Date.now() - days * 86_400_000),
              query: typeof toolInput.query === "string" ? toolInput.query : null,
              types:
                toolInput.include_corrections === true
                  ? ["retraction", "correction", "expression_of_concern"]
                  : ["retraction"],
              rows: 50,
              offset: Number(toolInput.offset ?? 0),
            });
            if (!page) {
              return JSON.stringify({ ok: false, problem: "Crossref could not be read just now; try again or leave a note." });
            }
            return JSON.stringify({ days, ...page });
          }
          const feedResult = await feedTools.execute(name, toolInput);
          if (feedResult !== null) return feedResult;
          if (name === "flag_reassessment") {
            const res = await flagReassessment({
              lookoutId: lookout.id,
              grantId: lookout.grant_id,
              commissionLimitMicroUsd: Number(lookout.commission_limit_micro_usd ?? 0),
              claimId: String(toolInput.claim_id ?? ""),
              rationale: String(toolInput.rationale ?? ""),
              budgetMicroUsd: Math.round(Number(toolInput.budget_owls ?? 0) * 1_000_000),
            });
            if (res.ok && !res.duplicate) flagsRaised++;
            return JSON.stringify(res);
          }
          if (name === "propose_ingest") {
            const res = await flagIngest({
              lookoutId: lookout.id,
              grantId: lookout.grant_id,
              url: String(toolInput.url ?? ""),
              rationale: String(toolInput.rationale ?? ""),
              focus: typeof toolInput.focus === "string" ? toolInput.focus : null,
              commissionLimitMicroUsd: Number(lookout.commission_limit_micro_usd ?? 0),
              budgetMicroUsd: Math.round(Number(toolInput.budget_owls ?? 0) * 1_000_000),
            });
            if (res.ok && !res.duplicate) {
              ingestsProposed++;
              flagsRaised++;
            }
            return JSON.stringify(res);
          }
          if (name === "leave_note") {
            const res = await flagNote({
              lookoutId: lookout.id,
              text: String(toolInput.text ?? ""),
              claimId: typeof toolInput.claim_id === "string" ? toolInput.claim_id : null,
              url: typeof toolInput.url === "string" ? toolInput.url : null,
            });
            if (res.ok) {
              notesLeft++;
              flagsRaised++;
            }
            return JSON.stringify(res);
          }
          if (name === "update_workspace") {
            const chars = await updateLookoutWorkspace(
              lookout.id,
              String(toolInput.content ?? "")
            );
            return JSON.stringify({
              success: true,
              chars,
              cap: LOOKOUT_BOUNDS.workspaceChars,
            });
          }
          return JSON.stringify({ error: `unknown tool ${name}` });
        },
      })
  );

  // The inputs were read whatever the run made of them.
  await consumeLookoutEvents(
    lookout.id,
    events.map((e) => e.id)
  );
  // So were the graph feed's entries: the next run reads on from here.
  if (graphFeed?.next_cursor) {
    await rawQuery(`UPDATE lookouts SET changes_cursor = $2 WHERE id = $1`, [lookout.id, graphFeed.next_cursor]);
  }

  const note = (result.content ?? "").trim().slice(0, LOOKOUT_BOUNDS.noteChars);
  return {
    note,
    flagsRaised,
    ingestsProposed,
    notesLeft,
    eventsConsumed: events.length,
  };
}
