/**
 * The Correspondent run (#563) — a mandate's reader for an audience, woken
 * by its heartbeat, a material change in its scope, or a poke.
 *
 * Its Grantmaker wrote the brief (what it covers, who reads it, what
 * matters to them, how to present it); the ledger funds each run from the
 * mandate's escrow (`correspondent_run`, fundGrantSelfActions); the engine
 * executor runs this agent with:
 *
 *  - its brief, audience and scope, its own workspace, and what woke it;
 *  - its window: the material changes in scope since its last update, read
 *    from the change stream at its cursor (services/graph-change-service.ts);
 *  - the graph reads every agent has (search, open, walk down, walk up) and
 *    list_graph_changes for history. These are exactly what MCP serves an
 *    outside client: a Graph Correspondent has no read an outside one lacks;
 *  - publish_update: one update a run, its items validated against the
 *    window and the graph, its "not covered" changes computed here, never
 *    by the agent;
 *  - update_workspace, and the issue tools.
 *
 * It runs under the constitution, like every role the graph runs. It writes
 * no assessment, changes no page, and moves no money.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { RUN_TURN_GUARD, runBudgetSentence } from "../prompts/turn-budget.js";
import { getSpendToolDefinitions, executeSpendTool } from "../tools/spend-tools.js";
import { getSqlToolDefinition, executeSqlTool } from "../tools/sql-tools.js";
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { executeGraphReadTool, getGraphReadToolDefinitions } from "../tools/graph-read-tools.js";
import { getCorrespondentSystemPromptBlocks } from "../prompts/correspondent.js";
import { graphChangeDefinition, runGraphChanges, type GraphChange } from "../../services/graph-change-service.js";
import {
  computeNotCovered,
  consumeCorrespondentEvents,
  correspondentWindow,
  mandateRoom,
  pendingCorrespondentEvents,
  publishCorrespondentUpdate,
  updateCorrespondentWorkspace,
  listCorrespondentUpdates,
  listPlanItems,
  updateCorrespondentPlan,
  validateUpdateItems,
  CORRESPONDENT_BOUNDS,
  type CorrespondentEventRow,
  type CorrespondentRow,
} from "../../services/correspondent-service.js";

/** The window's changes shown in full in the briefing; the rest one line each. */
const WINDOW_SHOWN_IN_FULL = 120;
/** Its own recent updates listed in the briefing; list_my_updates reads the rest. */
const RECENT_UPDATES_SHOWN = 5;
/** Recently closed plan items shown, so it remembers what it finished or gave up. */
const RECENT_CLOSED_PLAN_SHOWN = 5;

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** One change as a line of the briefing. */
export function renderChange(c: GraphChange): string {
  const move =
    c.kind === "first_assessment"
      ? `first assessed ${c.status}`
      : c.kind === "status_moved"
        ? `${c.prev_status} → ${c.status}`
        : c.kind === "credence_moved"
          ? `${c.status}, credence ${c.prev_credence ?? "none"} → ${c.credence ?? "none"}`
          : `reassessed, ${c.status}`;
  return (
    `- change ${c.change_id} (${c.at.slice(0, 16)}): claim ${c.claim_id} "${c.claim_text.slice(0, 160)}" — ` +
    `${move} (confidence ${c.confidence}` +
    (c.credence_delta !== null ? `, credence Δ ${c.credence_delta}` : "") +
    (c.trigger ? `; pass triggered by ${c.trigger}` : "") +
    `)`
  );
}

function renderEvent(e: CorrespondentEventRow): string {
  const when = new Date(e.created_at).toISOString().slice(0, 16);
  const p = e.payload ?? {};
  if (e.kind === "manual") {
    return `- [manual] ${when}: poked by ${String(p.from ?? "your Grantmaker")}` + (p.note ? `: ${String(p.note)}` : "");
  }
  if (e.kind === "graph_change") return `- [graph_change] ${when}: a material change in your scope woke you`;
  return `- [${e.kind}] ${when}: ${JSON.stringify(p)}`;
}

export interface CorrespondentRunResult {
  note: string;
  published: boolean;
  updateId: string | null;
  /** Where the change cursor moves: the end of the window read. */
  cursorTo: string;
  eventsConsumed: number;
}

export function runCorrespondent(
  input: Parameters<typeof runCorrespondentImpl>[0]
): ReturnType<typeof runCorrespondentImpl> {
  return withAgent("correspondent", () => runCorrespondentImpl(input));
}

async function runCorrespondentImpl(input: { correspondentId: string; model?: string }): Promise<CorrespondentRunResult> {
  const config = loadConfig();
  const [c] = await rawQuery<
    CorrespondentRow & {
      grant_skills: string[] | null;
      mandate_title: string | null;
      grant_status: string;
      scope_tag_slugs: string[] | null;
    }
  >(
    `SELECT c.*, g.skills AS grant_skills, g.status AS grant_status,
            COALESCE(g.mandate->>'title', g.name) AS mandate_title,
            ARRAY(SELECT t.slug FROM tags t WHERE t.id = ANY(c.scope_tag_ids)) AS scope_tag_slugs
       FROM correspondents c JOIN grants g ON g.id = c.grant_id
      WHERE c.id = $1`,
    [input.correspondentId]
  );
  if (!c || c.status !== "active" || c.grant_status !== "active") {
    throw new Error(`correspondent ${input.correspondentId} not found, not active, or its mandate is not active`);
  }

  const skillLoader = createSkillLoadTools("correspondent", { names: c.grant_skills ?? [] });
  const system = getCorrespondentSystemPromptBlocks();
  const model = input.model ?? c.model ?? config.correspondentModel;
  const reportTools = createReportTools({ model });

  const events = await pendingCorrespondentEvents(c.id, 50);
  const window = await correspondentWindow(c);
  const windowIds = new Set(window.changes.map((x) => x.change_id));
  const room = await mandateRoom(c.grant_id).catch(() => null);
  const scopeClaims =
    (c.scope_claim_ids?.length ?? 0) > 0
      ? await rawQuery<{ id: string; text: string }>(
          `SELECT id, left(text, 200) AS text FROM claims WHERE id = ANY($1::uuid[])`,
          [c.scope_claim_ids]
        )
      : [];
  // What it has already done: its recent updates, and its plan.
  const { updates: recent, total: updatesTotal } = await listCorrespondentUpdates(c.id, { limit: RECENT_UPDATES_SHOWN });
  const last = recent[0];
  const openPlan = await listPlanItems(c.id, { status: "open", limit: 200 });
  const closedPlan = await listPlanItems(c.id, { status: "closed", limit: RECENT_CLOSED_PLAN_SHOWN });

  let published: { updateId: string } | null = null;
  const changesDef = graphChangeDefinition("agent");

  const tools: Tool[] = [
    ...reportTools.definitions,
    ...getGraphReadToolDefinitions(),
    ...getSpendToolDefinitions(),
    getSqlToolDefinition(),
    { name: changesDef.name, description: changesDef.description, input_schema: changesDef.input_schema },
    {
      name: "publish_update",
      description:
        "Publish this run's output to your feed (at most one a run), in whatever form your " +
        "brief asks for. `title` and `body` (Markdown) are what people read. `items` are the " +
        "nodes it draws on, for agents and for the record: each with why it is there and the " +
        "change ids from your window behind it, if any; leave it empty when the form has no " +
        "use for it. `unexamined` is what in your scope you have not looked at or could not " +
        "judge. Every change in your window that no item cites, by change id or by its node, " +
        "is listed on the output as not covered. The output is public and says which mandate " +
        "funded it.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: `Up to ${CORRESPONDENT_BOUNDS.updateTitleChars} characters` },
          body: { type: "string", description: "The prose rendering, in Markdown" },
          items: {
            type: "array",
            maxItems: CORRESPONDENT_BOUNDS.updateItems,
            items: {
              type: "object",
              properties: {
                claim_id: { type: "string" },
                reason: { type: "string", description: "Why this node is in the output" },
                change_ids: { type: "array", items: { type: "string" } },
              },
              required: ["claim_id", "reason"],
            },
          },
          unexamined: { type: "string", description: "What in your scope you have not looked at, or could not judge" },
        },
        required: ["title", "body", "items", "unexamined"],
      },
    },
    {
      name: "update_plan",
      description:
        "Keep your plan: what you mean to do across runs (follow a question until it settles, " +
        "write a summary once a subtree is assessed, ask your Grantmaker for a wider scope). " +
        "`add` new items; `update` items by id to mark them done or dropped, amend their text, " +
        "or note what became of them. Every open item is shown in your briefing on every run, " +
        "so each costs a little on every run until you close it; closed items stay on the record. " +
        `An item is a sentence or two, at most ${CORRESPONDENT_BOUNDS.planItemChars} characters.`,
      input_schema: {
        type: "object" as const,
        properties: {
          add: { type: "array", items: { type: "string" } },
          update: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                status: { type: "string", enum: ["open", "done", "dropped"] },
                note: { type: "string" },
                text: { type: "string" },
              },
              required: ["id"],
            },
          },
        },
        required: [],
      },
    },
    {
      name: "list_my_updates",
      description:
        "Your own published updates, newest first, in full: items, prose, and what each did " +
        "not cover. Your briefing lists the most recent; read further back here.",
      input_schema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Default 5, max 20." },
          offset: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "update_workspace",
      description:
        "Rewrite your workspace: your memory between runs, read back in full at the start " +
        "of every run. Keep your notes here (what you have done and when, what you are " +
        "following, what your readers asked for) and any standing instructions you want " +
        "your future runs to follow. Replaces the whole " +
        `document, up to ${CORRESPONDENT_BOUNDS.workspaceChars.toLocaleString("en-US")} characters.`,
      input_schema: {
        type: "object" as const,
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  ];

  const shown = window.changes.slice(0, WINDOW_SHOWN_IN_FULL);
  const rest = window.changes.length - shown.length;
  const seenIds = new Set(window.seen.map((x) => x.change_id));
  const windowText =
    window.changes.length === 0
      ? "(no material changes in your scope since your last update)"
      : (window.seen.length > 0
          ? `The first ${window.seen.length} you read on an earlier run without publishing (marked "seen"); ` +
            `they still belong to this update's account.\n\n`
          : "") +
        shown.map((x) => (seenIds.has(x.change_id) ? renderChange(x).replace(/^- /, "- (seen) ") : renderChange(x))).join("\n") +
        (rest > 0
          ? `\n\n${rest} more change${rest === 1 ? "" : "s"} in this window are not listed here; ` +
            `read them with list_graph_changes (after: "${shown[shown.length - 1]!.cursor}").`
          : "") +
        (window.more
          ? `\n\nMore changes followed than one run reads (${CORRESPONDENT_BOUNDS.windowChanges}); ` +
            `your window ends at the last of these, and the rest begin your next run.`
          : "");
  const scopeText =
    scopeClaims.length === 0 && (c.scope_tag_slugs ?? []).length === 0
      ? "(no linked claims or tags: your brief's words are your scope, and your window is the whole graph's stream)"
      : [
          ...scopeClaims.map((s) => `- claim ${s.id} "${s.text}" and everything beneath it`),
          ...(c.scope_tag_slugs ?? []).map((t) => `- tag ${t}`),
        ].join("\n");
  const scopeArgs = {
    under: c.scope_claim_ids ?? [],
    tags: c.scope_tag_slugs ?? [],
  };

  const briefing =
    `## Correspondent run\n\n` +
    `You are "${c.title}", a Correspondent posted by the mandate "${c.mandate_title ?? ""}". ` +
    `Nobody is watching this run; act with the judgment of a careful person paid to do ` +
    `this work well for these readers.\n\n` +
    `### Your readers\n\n${c.audience}\n\n` +
    `### Your brief\n\n${c.brief}\n\n` +
    `### Your scope\n\n${scopeText}\n\n` +
    (scopeArgs.under.length + scopeArgs.tags.length > 0
      ? `To read your scope's history, call list_graph_changes with under ${JSON.stringify(scopeArgs.under)}` +
        ` and tags ${JSON.stringify(scopeArgs.tags)}.\n\n`
      : "") +
    `### Your bounds\n\n` +
    `- ${runBudgetSentence({ canSpend: true }) || "This run has no budget of its own."} Each tool result shows what you have spent.\n` +
    (room
      ? `- Your mandate has ${usd(room.headroomMicroUsd)} uncommitted in escrow` +
        (room.dayRoomMicroUsd !== null ? ` and ${usd(room.dayRoomMicroUsd)} left of today's rate` : "") +
        `. Your runs are paid from it alongside the mandate's other work; when it runs short, a run waits ` +
        `until it is funded, and your next update starts from wherever you left off.\n`
      : "") +
    `- Heartbeat: ${c.heartbeat_hours > 0 ? `every ${c.heartbeat_hours}h` : "none (event-driven)"}; ` +
    `triggers: ${(c.triggers ?? []).join(", ") || "none"}` +
    ((c.triggers ?? []).includes("graph_change")
      ? `; a change in scope wakes you at most once every ${c.min_wake_hours}h, so your readers are not sent ` +
        `an update every few minutes`
      : "") +
    `.\n- At most one update a run.\n\n` +
    `### What woke you\n\n${events.length === 0 ? "(your heartbeat)" : events.map(renderEvent).join("\n")}\n\n` +
    `### Your window: material changes in scope since your last update\n\n` +
    (last
      ? `Your last update was "${last.title}" on ${new Date(last.created_at).toISOString().slice(0, 10)}.\n\n`
      : `This is your first update. Your window starts when you were posted; for where things stand, read ` +
        `your scope's nodes and their history.\n\n`) +
    `${windowText}\n\n` +
    `### What you have done\n\n` +
    (recent.length === 0
      ? `(no updates published yet)\n\n`
      : `${updatesTotal} update${updatesTotal === 1 ? "" : "s"} published; the most recent:\n` +
        recent
          .map(
            (u) =>
              `- ${new Date(u.created_at).toISOString().slice(0, 10)} "${u.title}": ${u.items.length} item` +
              `${u.items.length === 1 ? "" : "s"}, ${u.not_covered?.changes_total ?? 0} change` +
              `${(u.not_covered?.changes_total ?? 0) === 1 ? "" : "s"} not covered`
          )
          .join("\n") +
        (updatesTotal > recent.length ? `\n(list_my_updates reads them in full and further back)` : "") +
        `\n\n`) +
    `### Your plan\n\n` +
    (openPlan.length === 0
      ? `(no open items)`
      : openPlan.map((p) => `- [open] ${p.id}: ${p.text}${p.note ? ` (${p.note})` : ""}`).join("\n")) +
    (closedPlan.length > 0
      ? `\n\nRecently closed:\n` +
        closedPlan.map((p) => `- [${p.status}] ${p.text}${p.note ? ` (${p.note})` : ""}`).join("\n")
      : "") +
    `\n\n` +
    `### Your workspace\n\n` +
    (c.workspace?.trim() ? c.workspace : `(empty — this is your first run)`) +
    `\n\n---\n\n` +
    `Do what your brief asks; publish one output if the work calls for it (or nothing, if ` +
    `not); update your workspace and plan; finish with a short note for the mandate's page ` +
    `saying what you did and whether you published.`;

  const result = await withSkills([], () =>
    toolUseLoop({
      initialMessages: [{ role: "user", content: briefing + skillLoader.pointerNote }],
      tools: [...tools, ...skillLoader.definitions],
      system,
      model,
      maxTokens: 16384,
      // What bounds a run is its metered cost against its budget; the turn
      // cap only halts a loop that has stopped spending.
      maxIterations: RUN_TURN_GUARD,
      iterationBudgetNotice: {
        warnWithin: 3,
        message: (remaining) =>
          `You have ${remaining} tool turn${remaining === 1 ? "" : "s"} left. ` +
          `Publish your update if you have one, update your workspace, and finish with your note.`,
      },
      executeTool: async (name, toolInput) => {
        const loaded = await skillLoader.execute(name, toolInput);
        if (loaded !== null) return loaded;
        const report = await reportTools.execute(name, toolInput);
        if (report !== null) return report;
        const graphRead = await executeGraphReadTool(name, toolInput);
        if (graphRead !== null) return graphRead;
        const spend = await executeSpendTool(name, toolInput);
        if (spend !== null) return spend;
        const sql = await executeSqlTool(name, toolInput);
        if (sql !== null) return sql;
        if (name === changesDef.name) {
          const res = await runGraphChanges(toolInput);
          return JSON.stringify(res.ok ? res.payload : { error: res.message, code: res.code });
        }
        if (name === "publish_update") {
          if (published) {
            return JSON.stringify({ ok: false, problem: "You have already published this run's update." });
          }
          const title = String(toolInput.title ?? "").trim();
          const body = String(toolInput.body ?? "").trim();
          if (title.length < 3 || body.length < 20) {
            return JSON.stringify({ ok: false, problem: "An update needs a title and a body readers can read." });
          }
          const rawItems = Array.isArray(toolInput.items) ? toolInput.items : [];
          const claimIds = [
            ...new Set(
              rawItems.map((i) => String((i as Record<string, unknown>)?.claim_id ?? "")).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
            ),
          ];
          const known =
            claimIds.length > 0
              ? new Set(
                  (
                    await rawQuery<{ id: string }>(
                      `SELECT id FROM claims WHERE id = ANY($1::uuid[]) AND state = 'active'`,
                      [claimIds]
                    )
                  ).map((r) => r.id)
                )
              : new Set<string>();
          const checked = validateUpdateItems(rawItems, windowIds, known);
          if ("problem" in checked) return JSON.stringify({ ok: false, problem: checked.problem });
          const notCovered = computeNotCovered(
            window.changes,
            checked.items,
            window.more,
            String(toolInput.unexamined ?? "")
          );
          published = await publishCorrespondentUpdate({
            correspondentId: c.id,
            grantId: c.grant_id,
            title,
            body,
            items: checked.items,
            notCovered,
            changesFrom: window.from,
            changesTo: window.to,
          });
          return JSON.stringify({
            ok: true,
            update_id: published.updateId,
            items: checked.items.length,
            not_covered: { changes_total: notCovered.changes_total, more_after_window: notCovered.more_after_window },
          });
        }
        if (name === "update_plan") {
          const res = await updateCorrespondentPlan({
            correspondentId: c.id,
            add: toolInput.add,
            update: toolInput.update,
          });
          return JSON.stringify(res);
        }
        if (name === "list_my_updates") {
          const page = await listCorrespondentUpdates(c.id, {
            limit: Math.min(20, Math.max(1, Number(toolInput.limit ?? 5) || 5)),
            offset: Math.max(0, Number(toolInput.offset ?? 0) || 0),
          });
          return JSON.stringify({
            total: page.total,
            updates: page.updates.map((u) => ({
              id: u.id,
              at: new Date(u.created_at).toISOString(),
              title: u.title,
              body: u.body,
              items: u.items,
              not_covered: u.not_covered,
            })),
          });
        }
        if (name === "update_workspace") {
          const chars = await updateCorrespondentWorkspace(c.id, String(toolInput.content ?? ""));
          return JSON.stringify({ success: true, chars, cap: CORRESPONDENT_BOUNDS.workspaceChars });
        }
        return JSON.stringify({ error: `unknown tool ${name}` });
      },
    })
  );

  await consumeCorrespondentEvents(
    c.id,
    events.map((e) => e.id)
  );
  const note = (result.content ?? "").trim().slice(0, CORRESPONDENT_BOUNDS.noteChars);
  const done = published as { updateId: string } | null;
  return {
    note,
    published: done !== null,
    updateId: done?.updateId ?? null,
    cursorTo: window.to,
    eventsConsumed: events.length,
  };
}
