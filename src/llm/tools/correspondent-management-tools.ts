/**
 * The Grantmaker's Correspondent tools (#563; docs/allocation.md,
 * "Correspondents"): posting, reading, amending and poking the readers its
 * mandate funds for an audience. Shared by the owner's management chat and
 * the autonomous review pass, as the lookout tools are: one definition
 * list, one executor that returns null for a tool it does not own.
 *
 * Nothing here moves money. A correspondent's runs are self-funded from the
 * mandate's escrow through the ledger (fundGrantSelfActions), out of the
 * mandate's day, with no count of runs.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  createCorrespondent,
  getCorrespondent,
  listCorrespondentUpdates,
  listCorrespondents,
  listPlanItems,
  listPracticeVersions,
  queueCorrespondentEvent,
  reviseCorrespondentPractice,
  updateCorrespondent,
  CORRESPONDENT_BOUNDS,
  CORRESPONDENT_TRIGGER_KINDS,
} from "../../services/correspondent-service.js";

export const CORRESPONDENT_MANAGEMENT_TOOL_NAMES = [
  "spawn_correspondent",
  "list_correspondents",
  "correspondent_report",
  "update_correspondent",
  "poke_correspondent",
] as const;

const B = CORRESPONDENT_BOUNDS;

const SHARED_PROPERTIES = {
  audience: {
    type: "string",
    description:
      "Who its output is for, in words: \"evaluators reviewing the X safety case\", " +
      "\"the public following Y\", \"the mandate's own Grantmaker\". It is shown to the " +
      "correspondent and on its feed.",
  },
  scope_claim_ids: {
    type: "array",
    items: { type: "string" },
    maxItems: B.scopeClaims,
    description:
      "Claims the brief covers, each with everything beneath it. They answer " +
      "\"which correspondents cover this claim?\" and are what graph_change watches.",
  },
  scope_tags: {
    type: "array",
    items: { type: "string" },
    maxItems: B.scopeTags,
    description: "Topic tag slugs the brief covers, as search results give them.",
  },
  heartbeat_hours: {
    type: "number",
    description:
      `How often it runs on its own: 168 for weekly (the default), 24 ` +
      `for a daily one, 0 for only on triggers; at most ${B.heartbeatHours.max}.`,
  },
  triggers: {
    type: "array",
    items: { type: "string", enum: [...CORRESPONDENT_TRIGGER_KINDS] },
    description:
      "Inputs it also wakes on: 'graph_change' (a material change in its scope: " +
      "a first assessment, a status move, a credence move past the material " +
      "threshold; needs scope claims or tags), 'manual' (you or the funder poke it).",
  },
  min_wake_hours: {
    type: "number",
    description:
      "With graph_change: the least time between two runs a change can wake, set " +
      "for the readers' attention (default 24). The heartbeat and a poke are not held by it.",
  },
  model: {
    type: "string",
    description: "Optional model id; the default is the standard tier, chosen for judgment and prose.",
  },
} as const;

export function getCorrespondentManagementToolDefinitions(): Tool[] {
  return [
    {
      name: "spawn_correspondent",
      description:
        "Post a CORRESPONDENT: an agent that draws on the graph and produces something " +
        "from it for someone, in whatever form serves them. It is the Lookout's " +
        "counterpart: a lookout brings " +
        "material into the graph; a correspondent makes something of what is there. " +
        "Each run is told what woke it and the material changes in its scope since its " +
        "last output, reads whatever else the work needs, and publishes at most one " +
        "output (title, Markdown body, and structured items where they fit) to its " +
        "feed, with the changes it did not mention listed. It runs under the " +
        "constitution, writes no assessment and moves no money, and keeps a plan and a " +
        "practice of its own that improve with use. Its runs are paid from your escrow " +
        "out of the mandate's day. The brief is yours to design for the need: what it " +
        "makes, for whom, from what, when, and how. Its brief and outputs are public, " +
        "and each output names this mandate as its funder.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "A few words: the feed's title." },
          brief: { type: "string", description: "Its whole instruction set, in your words." },
          ...SHARED_PROPERTIES,
        },
        required: ["title", "brief", "audience"],
      },
    },
    {
      name: "list_correspondents",
      description:
        "The correspondents this mandate funds: brief, audience, scope, cadence, " +
        "runs, updates published, last run and its note.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "correspondent_report",
      description:
        "One correspondent's recent updates, with how many changes each left " +
        "uncovered; its practice (the standing instructions it has written for itself) " +
        "and how it got there; its plan; and its workspace. Read it before you tighten " +
        "its brief or retire it.",
      input_schema: {
        type: "object" as const,
        properties: {
          correspondent_id: { type: "string" },
          limit: { type: "number", description: "Updates returned, default 10, max 50." },
        },
        required: ["correspondent_id"],
      },
    },
    {
      name: "update_correspondent",
      description:
        "Amend a correspondent: its brief, audience, scope, cadence, triggers, model, " +
        "or status (active, paused, retired; retiring is final). Only the fields you give change. " +
        "`practice` replaces the standing instructions it wrote for itself (\"\" clears them), " +
        "with `practice_reason` saying why; do this only when its practice works against its " +
        "brief or the constitution, since its practice is how it learns.",
      input_schema: {
        type: "object" as const,
        properties: {
          correspondent_id: { type: "string" },
          title: { type: "string" },
          brief: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "retired"] },
          practice: { type: "string" },
          practice_reason: { type: "string" },
          ...SHARED_PROPERTIES,
        },
        required: ["correspondent_id"],
      },
    },
    {
      name: "poke_correspondent",
      description:
        "Ask a correspondent for an update now, with a note it reads (what to look " +
        "at, what its readers asked). Wakes it on the next funded run.",
      input_schema: {
        type: "object" as const,
        properties: {
          correspondent_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["correspondent_id", "note"],
      },
    },
  ];
}

/** Execute one of these tools for `grantId`; null for any other tool name. */
export async function executeCorrespondentManagementTool(
  grantId: string,
  name: string,
  toolInput: Record<string, unknown>,
  opts: { createdBy: string }
): Promise<string | null> {
  if (!(CORRESPONDENT_MANAGEMENT_TOOL_NAMES as readonly string[]).includes(name)) return null;
  const num = (v: unknown) => (v === undefined ? undefined : Number(v));
  if (name === "spawn_correspondent") {
    const res = await createCorrespondent({
      grantId,
      title: String(toolInput.title ?? ""),
      brief: String(toolInput.brief ?? ""),
      audience: String(toolInput.audience ?? ""),
      scopeClaimIds: toolInput.scope_claim_ids,
      scopeTags: toolInput.scope_tags,
      heartbeatHours: num(toolInput.heartbeat_hours),
      minWakeHours: num(toolInput.min_wake_hours),
      triggers: toolInput.triggers,
      model: typeof toolInput.model === "string" ? toolInput.model : null,
      createdBy: opts.createdBy,
    });
    if (!res.ok) return JSON.stringify({ success: false, code: res.code, problem: res.message });
    return JSON.stringify({
      success: true,
      correspondent_id: res.correspondentId,
      feed: `/correspondents/${res.correspondentId}/feed`,
      ...(res.unknownTags ? { unknown_tags: res.unknownTags } : {}),
      note:
        "Posted. With a heartbeat its first run is due now (the ledger funds it from " +
        "your escrow on the next sweep); its updates are public at its feed, and its " +
        "runs and notes show on the mandate page.",
    });
  }
  const id = String(toolInput.correspondent_id ?? "");
  if (name === "list_correspondents") {
    const rows = await listCorrespondents(grantId);
    return JSON.stringify({
      correspondents: rows.length,
      rows: rows.map((c) => ({
        id: c.id,
        title: c.title,
        audience: c.audience,
        status: c.status,
        scope_claim_ids: c.scope_claim_ids,
        scope_tag_ids: c.scope_tag_ids,
        heartbeat_hours: c.heartbeat_hours,
        triggers: c.triggers,
        min_wake_hours: c.min_wake_hours,
        runs: c.runs,
        updates: c.updates,
        last_run_at: c.last_run_at ? new Date(c.last_run_at).toISOString() : null,
        last_note: c.last_note,
      })),
    });
  }
  const current = await getCorrespondent(id);
  if (!current || current.grant_id !== grantId) {
    return JSON.stringify({ success: false, problem: "no such correspondent on this mandate" });
  }
  if (name === "correspondent_report") {
    const { updates, total } = await listCorrespondentUpdates(id, {
      limit: Math.min(50, Math.max(1, Number(toolInput.limit ?? 10) || 10)),
    });
    const [plan, practiceHistory] = await Promise.all([listPlanItems(id, { limit: 50 }), listPracticeVersions(id, 10)]);
    return JSON.stringify({
      correspondent: { id: current.id, title: current.title, status: current.status, workspace: current.workspace, last_note: current.last_note },
      practice: current.practice,
      practice_history: practiceHistory.map((v) => ({
        at: new Date(v.created_at).toISOString(),
        by: v.revised_by,
        reason: v.reason,
        chars: v.text.length,
      })),
      plan: plan.map((p) => ({ id: p.id, status: p.status, text: p.text, note: p.note })),
      updates_total: total,
      rows: updates.map((u) => ({
        id: u.id,
        at: new Date(u.created_at).toISOString(),
        title: u.title,
        items: u.items.length,
        not_covered: u.not_covered?.changes_total ?? 0,
        unexamined: u.not_covered?.unexamined ?? "",
      })),
    });
  }
  if (name === "update_correspondent") {
    if (toolInput.practice !== undefined) {
      const revised = await reviseCorrespondentPractice({
        correspondentId: id,
        text: String(toolInput.practice),
        reason: String(toolInput.practice_reason ?? ""),
        revisedBy: opts.createdBy,
      });
      if (!revised.ok) return JSON.stringify({ success: false, code: "PRACTICE", problem: revised.problem });
    }
    const res = await updateCorrespondent({
      grantId,
      correspondentId: id,
      ...(toolInput.title !== undefined ? { title: String(toolInput.title) } : {}),
      ...(toolInput.brief !== undefined ? { brief: String(toolInput.brief) } : {}),
      ...(toolInput.audience !== undefined ? { audience: String(toolInput.audience) } : {}),
      ...(toolInput.status !== undefined ? { status: String(toolInput.status) } : {}),
      ...(toolInput.scope_claim_ids !== undefined ? { scopeClaimIds: toolInput.scope_claim_ids } : {}),
      ...(toolInput.scope_tags !== undefined ? { scopeTags: toolInput.scope_tags } : {}),
      ...(toolInput.heartbeat_hours !== undefined ? { heartbeatHours: Number(toolInput.heartbeat_hours) } : {}),
      ...(toolInput.min_wake_hours !== undefined ? { minWakeHours: Number(toolInput.min_wake_hours) } : {}),
      ...(toolInput.triggers !== undefined ? { triggers: toolInput.triggers } : {}),
      ...(toolInput.model !== undefined ? { model: String(toolInput.model) } : {}),
    });
    return JSON.stringify(
      res.ok
        ? { success: true, correspondent_id: res.correspondentId, ...(res.unknownTags ? { unknown_tags: res.unknownTags } : {}) }
        : { success: false, code: res.code, problem: res.message }
    );
  }
  // poke_correspondent
  const note = String(toolInput.note ?? "").trim().slice(0, B.noteChars);
  if (!note) return JSON.stringify({ success: false, problem: "say what you want it to look at" });
  const res = await queueCorrespondentEvent({ correspondentId: id, kind: "manual", payload: { note, from: opts.createdBy } });
  return JSON.stringify(
    res.queued
      ? { success: true, note: "Queued; it reads your note on its next funded run." }
      : { success: false, problem: "the correspondent is not active" }
  );
}
