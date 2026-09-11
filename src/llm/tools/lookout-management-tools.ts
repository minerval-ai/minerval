/**
 * The Grantmaker's lookout tools: standing up, reading, amending, and
 * poking the standing watches its mandate funds (docs/allocation.md,
 * "Lookouts"). Shared by the owner-driven management chat and the
 * autonomous review pass, as the bounty tools are: one definition list,
 * one executor with the null-delegate convention (null means "not my
 * tool"), so each agent wires it with one spread and one early return.
 *
 * Nothing here moves money. A lookout's runs are self-funded from the
 * mandate's escrow through the ledger (fundGrantSelfActions, bounded per
 * day), and what a lookout raises is a candidate the mandate's allocator
 * funds or not. What the Grantmaker delegates with spawn_lookout is
 * judgment — the brief — under bounds it sets: the ceiling on a flag's
 * value, the ingests per run, the cadence.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LOOKOUT_MANAGEMENT_TOOL_NAMES = [
  "spawn_lookout",
  "list_lookouts",
  "lookout_report",
  "update_lookout",
  "poke_lookout",
] as const;

export function getLookoutManagementToolDefinitions(): Tool[] {
  return [
    {
      name: "spawn_lookout",
      description:
        "Post a LOOKOUT: a cheap standing watch over part of your mission, " +
        "run from your escrow on a heartbeat and on triggers, that reads " +
        "the graph, the retraction record, and the open web and raises " +
        "CANDIDATES — a claim for reassessment (valued on your behalf up to " +
        "the ceiling you set), a source to ingest (appended to your plan, " +
        "up to a per-run limit), a note for your next review pass. It " +
        "never writes an assessment or moves money. Write the brief as you " +
        "would for a careful person paid to keep watch over one thing: the " +
        "scope in your words (a claim and what it turns on, a literature, " +
        "a set of sources, a question), where to look, what kinds of " +
        "happening warrant work and what to leave alone. Use it wherever " +
        "the mission needs to notice things between your review passes: a " +
        "retraction watch over the sources behind your assessed claims, a " +
        "new-results watch on a live crux, a feed to keep an eye on. Each " +
        "run costs a small fraction of an assessment; the ledger bounds " +
        "runs per day.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "A few words, for the mandate page." },
          brief: {
            type: "string",
            description:
              "The lookout's whole instruction set, in your words: scope, " +
              "where to look, what to look out for, what not to raise.",
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
              "graph), 'manual' (you or the funder poke it with a note).",
          },
          max_value: {
            type: "number",
            description:
              "The ceiling (0–10) on the valuation a flag may write on your " +
              "behalf. This is how much of your spending judgment you " +
              "delegate; default 6. Your allocator still ranks the flag " +
              "against everything else you value.",
          },
          max_ingests_per_run: {
            type: "number",
            description: "Ingest items one run may append to your plan (default 3).",
          },
          model: {
            type: "string",
            description:
              "Optional model id for a stronger watch; default is the cheap tier. " +
              "Web search needs an Anthropic model.",
          },
        },
        required: ["title", "brief"],
      },
    },
    {
      name: "list_lookouts",
      description:
        "Your mandate's lookouts: brief, cadence, triggers, bounds, runs so " +
        "far, pending inputs, the last note, and each one's PRECISION — of " +
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
          max_value: { type: "number" },
          max_ingests_per_run: { type: "number" },
          model: { type: "string" },
          note: { type: "string", description: "One line: why." },
        },
        required: ["lookout_id"],
      },
    },
    {
      name: "poke_lookout",
      description:
        "Queue an input for a lookout so its next run reads it: something " +
        "you learned that it should check, a source to look at, a question. " +
        "The run is funded like any other (bounded per day); the note is " +
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
    const res = await createLookout({
      grantId,
      title: String(toolInput.title ?? ""),
      brief: String(toolInput.brief ?? ""),
      heartbeatHours:
        toolInput.heartbeat_hours === undefined ? undefined : Number(toolInput.heartbeat_hours),
      triggers: toolInput.triggers,
      model: typeof toolInput.model === "string" ? toolInput.model : null,
      maxValue: toolInput.max_value === undefined ? undefined : Number(toolInput.max_value),
      maxIngestsPerRun:
        toolInput.max_ingests_per_run === undefined
          ? undefined
          : Number(toolInput.max_ingests_per_run),
      createdBy: opts.createdBy,
    });
    return JSON.stringify(
      res.ok
        ? {
            success: true,
            lookout_id: res.lookoutId,
            note:
              "Posted. Its first run is due now (the ledger funds it from your " +
              "escrow on the next sweep); it will leave a note on the mandate " +
              "page each run and its flags reach you in your review briefing.",
          }
        : { success: false, code: res.code, problem: res.message }
    );
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
      ...(toolInput.max_value !== undefined ? { maxValue: Number(toolInput.max_value) } : {}),
      ...(toolInput.max_ingests_per_run !== undefined
        ? { maxIngestsPerRun: Number(toolInput.max_ingests_per_run) }
        : {}),
      ...(toolInput.model !== undefined ? { model: String(toolInput.model) } : {}),
    });
    return JSON.stringify(
      res.ok ? { success: true, lookout_id: res.lookoutId } : { success: false, code: res.code, problem: res.message }
    );
  }
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
