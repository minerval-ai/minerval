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
 *
 * Source text. A log holds what its run was handed and what its tools
 * returned, and for some agents and tools that is a source's stored text.
 * Opening raw sources is a permission of its own in a members-only
 * deployment (src/raw-sources.ts), so a reader who lacks it is served those
 * parts of a step as withheld, with the permission that opens them, and
 * everything else in the step as recorded. The run's label says what it
 * could have opened: sources at its own label and at every label that one
 * reads. Which source each step actually read is not worked out, so the
 * reader needs the permission at each of those labels; a run at `public`
 * read only public sources and nothing in it is withheld.
 */
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { AGENTS_GIVEN_SOURCE_TEXT, returnsSourceText } from "../llm/run-visibility.js";
import { withheldRunSourceText, type WithheldSourceText } from "../raw-sources.js";
import { labelsReadableFrom } from "./permission-service.js";
import { chainChecker, RUN_LOG_FORMAT, type ChainedStep, type ChainProblem } from "./run-log.js";
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
  log_hash: string | null;
  sealed_at: Date | null;
  sensitivity_label: string;
}

/** What a caller of these reads says about who is reading. */
export interface RunReader {
  isService?: boolean;
  /**
   * The labels whose raw sources the reader may open (rawSourceLabelsOf), or
   * null or absent where nothing is held: the public graph.
   */
  rawSourceLabels?: readonly string[] | null;
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
  /**
   * The seal on the run's log (services/run-log.ts): the hash its chain of
   * steps reached, and when the run closed with every step written. Both
   * null on a run still open, on one that lost a step, and on runs from
   * before steps were chained. verifyRunLog checks the steps against it.
   */
  log_hash: string | null;
  sealed_at: string | null;
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
  /** The step's hash in the run's chain; null on steps recorded before the chain. */
  hash: string | null;
}

/**
 * The run with this id. A request's work log and a research report name a
 * Researcher run by its research_runs id, which is not the id of the agent
 * run that did the work (research_runs.run_id is), so an id that is no
 * agent run's is tried as a research run's and resolved to its agent run
 * (#897): either id reads the same run, served under the same rules.
 */
async function loadRun(runId: string): Promise<RunRow | null> {
  const rows = await rawQuery<RunRow>(
    `SELECT id, agent, claim_id, started_at, finished_at, outcome, error, steps, skills,
            wrote_to_graph, commit_sha, private_reasons, log_hash, sealed_at, sensitivity_label
       FROM agent_runs
      WHERE id = COALESCE(
              (SELECT id FROM agent_runs WHERE id = $1),
              (SELECT run_id FROM research_runs WHERE id = $1))`,
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
 * The notice that stands in for source text in this run's log for this
 * reader, or null when the reader may read all of it. See the module
 * comment for why the run's label decides.
 */
async function sourceTextNotice(run: RunRow, reader: RunReader): Promise<WithheldSourceText | null> {
  const held = reader.rawSourceLabels;
  if (held === null || held === undefined || run.sensitivity_label === PUBLIC_LABEL) return null;
  const couldOpen = (await labelsReadableFrom([run.sensitivity_label])).filter((l) => l !== PUBLIC_LABEL);
  const missing = couldOpen.filter((l) => !held.includes(l));
  return missing.length > 0 ? withheldRunSourceText(run.sensitivity_label, missing) : null;
}

/**
 * A step's content with any source text in it replaced by `notice`: the
 * opening messages (or a single call's prompt) of an agent that is handed
 * a document, and the output of a tool that returns one. Everything else
 * is the content as recorded.
 */
export function withholdSourceText(agent: string, kind: string, content: unknown, notice: WithheldSourceText): unknown {
  if (kind === "tool_results" && Array.isArray(content)) {
    return content.map((result) =>
      result && typeof result === "object" && returnsSourceText(String((result as { name?: unknown }).name))
        ? { ...(result as Record<string, unknown>), output: notice }
        : result
    );
  }
  if (agent in AGENTS_GIVEN_SOURCE_TEXT && content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Record<string, unknown>;
    if (kind === "prompt" && "initialMessages" in c) return { ...c, initialMessages: notice };
    if (kind === "completion") {
      return {
        ...c,
        ...("messages" in c ? { messages: notice } : {}),
        ...("prompt" in c ? { prompt: notice } : {}),
        ...("input" in c ? { input: notice } : {}),
      };
    }
  }
  return content;
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
  // The agent run's own id from here on: `runId` may have named a research run.
  runId = run.id;

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
    log_hash: run.log_hash,
    sealed_at: run.sealed_at ? new Date(run.sealed_at).toISOString() : null,
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
      const opening = isWithheld(c.initialMessages)
        ? "(withheld: text from a source)"
        : preview(textOf(c.initialMessages), 120);
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
      const first = !results[0]
        ? ""
        : isWithheld(results[0].output)
          ? "(withheld: text from a source)"
          : preview(String(r0(results[0].output)), 120);
      return { summary: `${names.join(", ")} returned${first ? `: ${first}` : ""}`, tools: names };
    }
    case "completion":
      return { summary: `Completion by ${String(c.model ?? "?")}: ${preview(textOf(c.output) || JSON.stringify(c.output ?? ""))}`, tools: [] };
    default:
      return { summary: kind, tools: [] };
  }
}

/** Whether a part of a step is the notice that stands in for source text. */
function isWithheld(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { withheld?: unknown }).withheld === "source_text";
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
  opts: { after?: number; limit?: number; kind?: string; tool?: string } & RunReader = {}
): Promise<{ steps: StepSummary[]; next_after: number | null } | WithheldRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const run = await loadRun(runId);
  if (!run) return null;
  if (!servable(run, opts.isService ?? false)) return withheld(run);
  // The agent run's own id from here on: `runId` may have named a research run.
  runId = run.id;
  // A summary quotes the head of a step, so source text is taken out first.
  const notice = await sourceTextNotice(run, opts);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // A tool filter is applied after summarizing, so read in pages until the
  // page is full or the run ends.
  const out: StepSummary[] = [];
  let cursor = opts.after ?? -1;
  for (;;) {
    const rows = await rawQuery<{ seq: number; kind: string; content: unknown; created_at: Date; chars: number; hash: string | null }>(
      `SELECT seq, kind, content, created_at, length(content::text) AS chars, hash
         FROM agent_steps
        WHERE run_id = $1 AND seq > $2 AND ($3::text IS NULL OR kind = $3)
        ORDER BY seq LIMIT $4`,
      [runId, cursor, opts.kind ?? null, limit]
    );
    for (const r of rows) {
      cursor = r.seq;
      const { summary, tools } = summarizeStep(
        r.kind,
        notice ? withholdSourceText(run.agent, r.kind, r.content, notice) : r.content
      );
      if (opts.tool && !tools.includes(opts.tool)) continue;
      out.push({ seq: r.seq, kind: r.kind, created_at: new Date(r.created_at).toISOString(), summary, chars: r.chars, tools, hash: r.hash });
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
  opts: RunReader = {}
): Promise<
  | { seq: number; kind: string; created_at: string; content: unknown; prev_hash: string | null; hash: string | null }
  | WithheldRun
  | null
> {
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !Number.isInteger(seq)) return null;
  const run = await loadRun(runId);
  if (!run) return null;
  if (!servable(run, opts.isService ?? false)) return withheld(run);
  // The agent run's own id from here on: `runId` may have named a research run.
  runId = run.id;
  const rows = await rawQuery<{
    seq: number; kind: string; content: unknown; created_at: Date; prev_hash: string | null; hash: string | null;
  }>(
    `SELECT seq, kind, content, created_at, prev_hash, hash
       FROM agent_steps WHERE run_id = $1 AND seq = $2 ORDER BY created_at LIMIT 1`,
    [runId, seq]
  );
  const r = rows[0];
  if (!r) return null;
  const notice = await sourceTextNotice(run, opts);
  return {
    seq: r.seq,
    kind: r.kind,
    created_at: new Date(r.created_at).toISOString(),
    content: notice ? withholdSourceText(run.agent, r.kind, r.content, notice) : r.content,
    prev_hash: r.prev_hash,
    hash: r.hash,
  };
}

// --- checking the log -------------------------------------------------------

const VERIFY_PAGE = 25;

export interface RunLogCheck {
  run_id: string;
  format: typeof RUN_LOG_FORMAT;
  /** Whether the run closed with every step written, and with which hash. */
  sealed: boolean;
  sealed_at: string | null;
  log_hash: string | null;
  /** Steps the run counted at its close, steps recorded, and steps whose chain was recomputed. */
  steps_counted: number;
  steps_recorded: number;
  steps_checked: number;
  /** The hash the recomputed chain reaches. */
  head: string;
  /**
   * True when every recorded step follows from the one before it and, for a
   * sealed run, the chain ends at the sealed hash with no step missing. An
   * unsealed run can be intact so far and still be incomplete.
   */
  intact: boolean;
  /** The first thing wrong, when something is. */
  problem: ChainProblem | null;
}

/**
 * Recompute the run's hash chain from its stored steps and compare it with
 * the stored hashes and the seal (services/run-log.ts). This is the server
 * checking its own rows: it catches a step altered, dropped or added after
 * the seal. Anyone can repeat it from the steps get_run_step serves, which
 * carry the same content and hashes. Null when no run has this id; a
 * withheld notice when the run is not public.
 */
export async function verifyRunLog(
  runId: string,
  opts: { isService?: boolean } = {}
): Promise<RunLogCheck | WithheldRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const run = await loadRun(runId);
  if (!run) return null;
  if (!servable(run, opts.isService ?? false)) return withheld(run);
  // A page of steps at a time: a long run's content is large.
  const checker = chainChecker(run.id);
  let recorded = 0;
  let after = -1;
  for (let ok = true; ok; ) {
    const page = await rawQuery<ChainedStep>(
      `SELECT seq, kind, content, prev_hash, hash FROM agent_steps
        WHERE run_id = $1 AND seq > $2 ORDER BY seq, created_at LIMIT $3`,
      [run.id, after, VERIFY_PAGE]
    );
    for (const step of page) {
      after = step.seq;
      if (!(ok = checker.push(step))) break;
    }
    if (page.length < VERIFY_PAGE) break;
  }
  const counts = await rawQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_steps WHERE run_id = $1`,
    [run.id]
  );
  recorded = Number(counts[0]?.n ?? 0);
  const sealed = run.log_hash != null && run.sealed_at != null;
  const check = checker.finish(sealed ? { logHash: run.log_hash!, stepsCounted: run.steps } : null);
  return {
    run_id: run.id,
    format: RUN_LOG_FORMAT,
    sealed,
    sealed_at: run.sealed_at ? new Date(run.sealed_at).toISOString() : null,
    log_hash: run.log_hash,
    steps_counted: run.steps,
    steps_recorded: recorded,
    steps_checked: check.steps_checked,
    head: check.head,
    intact: check.problem === null,
    problem: check.problem,
  };
}
