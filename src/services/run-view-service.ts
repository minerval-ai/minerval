/**
 * Reading an agent run (#553): the run, its setup, and its steps, as the
 * API, MCP and the run viewer serve them.
 *
 * What is served. A run whose private_reasons is empty (llm/run-visibility.ts)
 * is public in full: its setup, its opening messages, every model turn and
 * every tool result. A run with reasons is withheld: the response says so and
 * lists the reasons, which name what made it private without repeating it.
 * Direct service callers read every run. The account a run was attributed to
 * (user_id) and its job are never served: funding is disclosed on the
 * verdict, by name, not through the run.
 *
 * Shape, for agents that fetch only what they need: the run's summary first,
 * then its steps as one-line summaries with a cursor, then any step in full.
 */
import { rawQuery } from "../db/client.js";
import type { SetupRecord } from "./setup-split.js";

const REPO_URL = "https://github.com/minerval-ai/minerval";

export const STEP_KINDS = ["prompt", "assistant", "tool_results", "completion"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

interface RunRow {
  id: string;
  agent: string;
  claim_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  error: string | null;
  steps: number;
  skills: string[] | null;
  wrote_to_graph: boolean;
  commit_sha: string | null;
  private_reasons: string[];
}

export interface RunSetupPartView {
  kind: string;
  name: string | null;
  hash: string;
  version: number | null;
}

export interface RunSummary {
  id: string;
  agent: string;
  claim_id: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  error: string | null;
  /** Steps the run counted at finish, and steps recorded: fewer means some were lost. */
  steps_counted: number;
  steps_recorded: number;
  skills: string[] | null;
  wrote_to_graph: boolean;
  commit: string | null;
  commit_url: string | null;
  /** Model calls and their cost, as llm_usage records them. */
  model_calls: number;
  cost_usd: number;
  /** The setup of the run's first prompt step, with part versions resolved. */
  setup: (Omit<SetupRecord, "parts"> & { parts: RunSetupPartView[] }) | null;
  /** Whether the run is public; false only in a service read of a private run. */
  public: boolean;
  private_reasons: string[];
}

export interface WithheldRun {
  id: string;
  agent: string;
  withheld: true;
  public: false;
  /** Why the run is not public: e.g. "agent:grantmaker", "tool:grant_overview". */
  private_reasons: string[];
}

export interface StepSummary {
  seq: number;
  kind: string;
  created_at: string;
  /** One line: what happened in the step. */
  summary: string;
  /** Size of the step's content as stored, in characters. */
  chars: number;
  /** Tools called (assistant) or whose results these are (tool_results). */
  tools: string[];
}

async function loadRun(runId: string): Promise<RunRow | null> {
  const rows = await rawQuery<RunRow>(
    `SELECT id, agent, claim_id, started_at, finished_at, outcome, error, steps, skills,
            wrote_to_graph, commit_sha, private_reasons
       FROM agent_runs WHERE id = $1`,
    [runId]
  );
  return rows[0] ?? null;
}

/** Whether `run` may be served to this caller. */
function servable(run: RunRow, isService: boolean): boolean {
  return isService || run.private_reasons.length === 0;
}

function withheld(run: RunRow): WithheldRun {
  return { id: run.id, agent: run.agent, withheld: true, public: false, private_reasons: run.private_reasons };
}

/**
 * The run's summary, a withheld notice, or null when no run has this id.
 * A malformed id is no run.
 */
export async function getRunSummary(
  runId: string,
  opts: { isService?: boolean } = {}
): Promise<RunSummary | WithheldRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const run = await loadRun(runId);
  if (!run) return null;
  if (!servable(run, opts.isService ?? false)) return withheld(run);

  const [counts, usage, promptRows] = await Promise.all([
    rawQuery<{ n: string }>(`SELECT count(*)::text AS n FROM agent_steps WHERE run_id = $1`, [runId]),
    rawQuery<{ calls: string; cost: string | null }>(
      `SELECT count(*)::text AS calls, (sum(cost_micro_usd) / 1e6)::text AS cost FROM llm_usage WHERE run_id = $1`,
      [runId]
    ),
    rawQuery<{ setup: SetupRecord | null }>(
      `SELECT content->'setup' AS setup FROM agent_steps
        WHERE run_id = $1 AND kind = 'prompt' ORDER BY seq LIMIT 1`,
      [runId]
    ),
  ]);

  const setup = promptRows[0]?.setup ?? null;
  let parts: RunSetupPartView[] = [];
  if (setup?.parts?.length) {
    const hashes = setup.parts.map((p) => p.hash);
    const versions = await rawQuery<{ kind: string; name: string; hash: string; version: number }>(
      `SELECT kind, name, hash, version FROM setup_parts WHERE hash = ANY($1::text[])`,
      [hashes]
    );
    parts = setup.parts.map((p) => {
      const v = versions.find((r) => r.kind === p.kind && r.hash === p.hash && (p.name == null || r.name === p.name));
      return { kind: p.kind, name: v?.name ?? p.name ?? null, hash: p.hash, version: v?.version ?? null };
    });
  }

  return {
    id: run.id,
    agent: run.agent,
    claim_id: run.claim_id,
    started_at: new Date(run.started_at).toISOString(),
    finished_at: run.finished_at ? new Date(run.finished_at).toISOString() : null,
    outcome: run.outcome,
    error: run.error,
    steps_counted: run.steps,
    steps_recorded: Number(counts[0]?.n ?? 0),
    skills: run.skills,
    wrote_to_graph: run.wrote_to_graph,
    commit: run.commit_sha,
    commit_url: run.commit_sha ? `${REPO_URL}/commit/${run.commit_sha}` : null,
    model_calls: Number(usage[0]?.calls ?? 0),
    cost_usd: Number(usage[0]?.cost ?? 0),
    setup: setup ? { ...setup, parts } : null,
    public: run.private_reasons.length === 0,
    private_reasons: run.private_reasons,
  };
}

// --- step summaries ---------------------------------------------------------

function preview(text: string, n = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text;
    if ("content" in v) return textOf(v.content);
  }
  return "";
}

/** One line and the tool names for a step's content, by kind. */
export function summarizeStep(kind: string, content: unknown): { summary: string; tools: string[] } {
  const c = (content ?? {}) as Record<string, unknown>;
  if (c.truncated === true) {
    return { summary: `Content cut off at the storage cap (${String(c.originalChars)} characters).`, tools: [] };
  }
  switch (kind) {
    case "prompt": {
      const tools = Array.isArray(c.tools) ? (c.tools as Array<{ name?: string }>).map((t) => t.name ?? "?") : [];
      const opening = preview(textOf(c.initialMessages), 120);
      return {
        summary: `Setup: ${String(c.model ?? "model unknown")}, ${tools.length} tool(s). Opening: ${opening || "(none)"}`,
        tools: [],
      };
    }
    case "assistant": {
      const blocks = Array.isArray(c.content) ? (c.content as Array<Record<string, unknown>>) : [];
      const calls = blocks.filter((b) => b.type === "tool_use" || b.type === "server_tool_use").map((b) => String(b.name));
      const said = preview(blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join(" "));
      const parts = [said ? `"${said}"` : null, calls.length ? `calls ${calls.join(", ")}` : null].filter(Boolean);
      return { summary: `${parts.join("; ") || "(no text)"} [${String(c.stopReason ?? "")}]`, tools: calls };
    }
    case "tool_results": {
      const results = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
      const names = results.map((r) => String(r.name));
      const first = results[0] ? preview(String(r0(results[0].output)), 120) : "";
      return { summary: `${names.join(", ")} returned${first ? `: ${first}` : ""}`, tools: names };
    }
    case "completion":
      return { summary: `Completion by ${String(c.model ?? "?")}: ${preview(textOf(c.output) || JSON.stringify(c.output ?? ""))}`, tools: [] };
    default:
      return { summary: kind, tools: [] };
  }
}

function r0(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

/**
 * A page of the run's steps as summaries, after `after` (a seq), filtered by
 * kind or by a tool called or returning. Null when no run has this id; a
 * withheld notice when the run is not public.
 */
export async function listRunSteps(
  runId: string,
  opts: { after?: number; limit?: number; kind?: string; tool?: string; isService?: boolean } = {}
): Promise<{ steps: StepSummary[]; next_after: number | null } | WithheldRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const run = await loadRun(runId);
  if (!run) return null;
  if (!servable(run, opts.isService ?? false)) return withheld(run);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // A tool filter is applied after summarizing, so read in pages until the
  // page is full or the run ends.
  const out: StepSummary[] = [];
  let cursor = opts.after ?? -1;
  for (;;) {
    const rows = await rawQuery<{ seq: number; kind: string; content: unknown; created_at: Date; chars: number }>(
      `SELECT seq, kind, content, created_at, length(content::text) AS chars
         FROM agent_steps
        WHERE run_id = $1 AND seq > $2 AND ($3::text IS NULL OR kind = $3)
        ORDER BY seq LIMIT $4`,
      [runId, cursor, opts.kind ?? null, limit]
    );
    for (const r of rows) {
      cursor = r.seq;
      const { summary, tools } = summarizeStep(r.kind, r.content);
      if (opts.tool && !tools.includes(opts.tool)) continue;
      out.push({ seq: r.seq, kind: r.kind, created_at: new Date(r.created_at).toISOString(), summary, chars: r.chars, tools });
      if (out.length === limit) return { steps: out, next_after: r.seq };
    }
    if (rows.length < limit || !opts.tool) {
      return { steps: out, next_after: rows.length === limit ? cursor : null };
    }
  }
}

/** One step in full. Null when the run or the step does not exist. */
export async function getRunStep(
  runId: string,
  seq: number,
  opts: { isService?: boolean } = {}
): Promise<({ seq: number; kind: string; created_at: string; content: unknown }) | WithheldRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !Number.isInteger(seq)) return null;
  const run = await loadRun(runId);
  if (!run) return null;
  if (!servable(run, opts.isService ?? false)) return withheld(run);
  const rows = await rawQuery<{ seq: number; kind: string; content: unknown; created_at: Date }>(
    `SELECT seq, kind, content, created_at FROM agent_steps WHERE run_id = $1 AND seq = $2 LIMIT 1`,
    [runId, seq]
  );
  const r = rows[0];
  if (!r) return null;
  return { seq: r.seq, kind: r.kind, created_at: new Date(r.created_at).toISOString(), content: r.content };
}
