/**
 * GitHub issue filing for agent reports: the far end of the raise_issue
 * channel (#366), so a report the agents write lands where the maintainers
 * already look instead of in a table nobody opens.
 *
 * One report, one issue, filed on first sighting: raiseIssue() calls
 * fileIssueForReport() for every row it inserts (never for a repeat, which
 * collapses onto the row that already has an issue); sightings, notes, and
 * regressions reach the issue through syncSightingToIssue(); and
 * triageAgentReport() and a withdrawal call syncTriageToIssue() when the
 * status moves, so a wontfix closes its issue and a triage note reaches it.
 * The github-issue-sync worker (workers/github-issue-sync.ts) files the
 * backlog: reports raised before the sync existed, and any filing that
 * failed at raise time.
 *
 * Two commitments, inherited from the channel this serves:
 *
 *   - Fire-and-forget. Nothing here throws, and the callers do not await it:
 *     a GitHub outage, a bad token, a rate limit, all of it is logged and
 *     the report stays a report. The issue number is recorded on the row
 *     only once GitHub has confirmed it, so a filing that failed is visible
 *     as a null github_issue_number and can be retried by hand.
 *   - Off unless configured. A credential (the minerval-agents GitHub App's
 *     key, or a plain GITHUB_TOKEN; see github-app-auth.ts) and
 *     GITHUB_ISSUES_REPO must both be set; local runs and tests never reach
 *     the network.
 *
 * External-origin reports (the MCP surface) are testimony from someone
 * else's agent, and their bodies are not filed unless
 * GITHUB_ISSUES_INCLUDE_EXTERNAL is on: an outside caller must not be able
 * to write into the maintainers' tracker by default.
 *
 * Labels: every issue carries GITHUB_ISSUES_LABEL (agent-generated) plus
 * kind/… and severity/…, and origin/external where that applies. Missing
 * labels are created once per process before the first filing, so a fresh
 * repository needs no setup.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import {
  getGithubBearer,
  githubAuthConfigured,
  resetGithubAppTokenCache,
} from "./github-app-auth.js";
import type { AgentReportRow } from "./report-service.js";

const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "minerval-agent-reports";

/** Label colours: one per vocabulary, so the tracker reads at a glance. */
const LABEL_COLORS: Record<string, string> = {
  "kind/system_failure": "d73a4a",
  "kind/tool_gap": "fbca04",
  "kind/improvement": "0e8a16",
  "severity/blocking": "b60205",
  "severity/degraded": "d93f0b",
  "severity/annoyance": "fef2c0",
  "severity/idea": "c5def5",
  "origin/external": "5319e7",
};
const DEFAULT_LABEL_COLOR = "ededed";

/** Statuses that close the issue, and the state_reason GitHub records. */
const CLOSING_REASONS: Record<string, "completed" | "not_planned"> = {
  actioned: "completed",
  wontfix: "not_planned",
  duplicate: "not_planned",
  withdrawn: "not_planned",
};

/** Sighting comments: at these counts, then every thousand. */
const SIGHTING_MILESTONES = new Set([2, 5, 10, 25, 50, 100, 250, 500]);

export function isSightingMilestone(count: number): boolean {
  return SIGHTING_MILESTONES.has(count) || (count >= 1000 && count % 1000 === 0);
}

export interface GithubIssueRef {
  number: number;
  url: string;
}

export function githubIssuesConfigured(): boolean {
  const config = loadConfig();
  return githubAuthConfigured() && /^[^/\s]+\/[^/\s]+$/.test(config.githubIssuesRepo);
}

/** Labels the process has already confirmed exist in the repo. */
let ensuredLabels = new Set<string>();

/** Test hook. */
export function resetGithubLabelCache(): void {
  ensuredLabels = new Set<string>();
}

class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string
  ) {
    super(`GitHub ${status} for ${path}: ${body.slice(0, 300)}`);
  }
}

async function githubRequest<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<T> {
  const config = loadConfig();
  const bearer = await getGithubBearer();
  const res = await fetch(`${config.githubApiBaseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // An installation token GitHub no longer honours (key rotated, App
    // reinstalled) is not worth keeping; the next request mints afresh.
    if (res.status === 401) resetGithubAppTokenCache();
    throw new GithubApiError(res.status, path, await res.text().catch(() => ""));
  }
  return (await res.json()) as T;
}

/**
 * Create each label that is not yet known to exist. A 422 is "already
 * exists" and is the expected answer on every process after the first.
 */
async function ensureLabels(labels: string[]): Promise<void> {
  const repo = loadConfig().githubIssuesRepo;
  for (const name of labels) {
    if (ensuredLabels.has(name)) continue;
    try {
      await githubRequest("POST", `/repos/${repo}/labels`, {
        name,
        color: LABEL_COLORS[name] ?? DEFAULT_LABEL_COLOR,
        description: labelDescription(name),
      });
    } catch (err) {
      if (!(err instanceof GithubApiError && err.status === 422)) throw err;
    }
    ensuredLabels.add(name);
  }
}

function labelDescription(name: string): string {
  const config = loadConfig();
  if (name === config.githubIssuesLabel) {
    return "Filed automatically by an agent through raise_issue";
  }
  if (name === "origin/external") {
    return "Raised by an external agent on the MCP surface; testimony, not a finding";
  }
  const [group, value] = name.split("/");
  if (group === "status") return `Agent report triage status: ${value}`;
  return group && value ? `Agent report ${group}: ${value.replace(/_/g, " ")}` : "";
}

export function labelsForReport(row: AgentReportRow): string[] {
  const labels = [
    loadConfig().githubIssuesLabel,
    `kind/${row.kind}`,
    `severity/${row.severity}`,
  ];
  if (row.origin === "external") labels.push("origin/external");
  return labels;
}

function iso(d: Date | string | null | undefined): string {
  return d instanceof Date ? d.toISOString() : d ? String(d) : "";
}

/** Guard against a value in the report closing the fenced block it is in. */
function fence(text: string): string {
  return text.replace(/```/g, "` ` `");
}

/**
 * The issue body: the report's metadata as a table, its body as written,
 * and its context refs as a list. Ids only, as the report itself: the
 * write-time caps in report-service are what keep a report from becoming a
 * copy of whatever the agent was reading.
 */
export function renderIssueBody(row: AgentReportRow): string {
  const rows: Array<[string, string]> = [
    ["Kind", row.kind],
    ["Severity", row.severity],
    ["Agent", row.model ? `${row.agent} (${row.model})` : row.agent],
    ["Origin", row.origin],
    ["Surface", row.surface ? `\`${row.surface}\`` : "—"],
    ["First seen", iso(row.first_seen_at)],
    ["Report id", `\`${row.id}\``],
  ];
  const table =
    "| | |\n|---|---|\n" +
    rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`).join("\n");

  const refs = Object.entries(row.context_refs ?? {});
  const refList = refs.length
    ? "\n\n### Context refs\n\n" +
      refs.map(([k, v]) => `- \`${k}\`: \`${String(v)}\``).join("\n")
    : "";

  const attribution = [
    row.run_id ? `run \`${row.run_id}\`` : null,
    row.job_id ? `job \`${row.job_id}\`` : null,
    row.claim_id ? `claim \`${row.claim_id}\`` : null,
  ].filter(Boolean);
  const attributionLine = attribution.length
    ? `\n\n_Raised during ${attribution.join(", ")}._`
    : "";

  return (
    `${table}\n\n### Report\n\n${fence(row.body || "_(no body)_")}` +
    refList +
    attributionLine +
    `\n\n---\n_Filed automatically by \`raise_issue\` (the agents' own channel for ` +
    `problems with the machinery, #366). Repeats of this report collapse onto ` +
    `the same row; triage in the service-scoped \`/reports\` API or by the ` +
    `Audit Agent closes or annotates this issue._`
  );
}

/**
 * File the issue for a freshly inserted report and record its number on
 * the row. Never throws; returns the ref when GitHub confirmed the issue.
 */
export async function fileIssueForReport(
  row: AgentReportRow
): Promise<GithubIssueRef | null> {
  try {
    if (!githubIssuesConfigured()) return null;
    const config = loadConfig();
    if (row.origin === "external" && !config.githubIssuesIncludeExternal) {
      return null;
    }
    const labels = labelsForReport(row);
    await ensureLabels(labels);
    const issue = await githubRequest<{ number: number; html_url: string }>(
      "POST",
      `/repos/${config.githubIssuesRepo}/issues`,
      { title: row.title, body: renderIssueBody(row), labels }
    );
    const ref = { number: issue.number, url: issue.html_url };
    // Only the first filing wins: a racing second write (two processes
    // inserting the same dedupe key at once, one losing the conflict) must
    // not overwrite a recorded issue with a duplicate.
    await rawQuery(
      `UPDATE agent_reports
          SET github_issue_number = $2,
              github_issue_url = $3,
              github_synced_at = now()
        WHERE id = $1 AND github_issue_number IS NULL`,
      [row.id, ref.number, ref.url]
    );
    // A backlog filing of a report already triaged carries the decision
    // straight over, so the tracker never shows a closed matter as open.
    if (row.status !== "new") {
      await syncTriageToIssue({
        ...row,
        github_issue_number: ref.number,
        github_issue_url: ref.url,
      });
    }
    return ref;
  } catch (err) {
    console.error(
      `[reports] failed to file GitHub issue for report ${row.id}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Carry a triage decision to the issue: the note as a comment, and the
 * closing statuses close it with the matching state_reason. A report with
 * no issue (sync off when it was raised, or the filing failed) is a no-op.
 * Never throws.
 */
export async function syncTriageToIssue(row: AgentReportRow): Promise<void> {
  try {
    if (!githubIssuesConfigured() || row.github_issue_number == null) return;
    const repo = loadConfig().githubIssuesRepo;
    const issuePath = `/repos/${repo}/issues/${row.github_issue_number}`;
    const reason = CLOSING_REASONS[row.status];
    const who = row.triaged_by ? ` by \`${row.triaged_by}\`` : "";
    const duplicateOf =
      row.status === "duplicate" && row.duplicate_of_id
        ? `\n\nDuplicate of report \`${row.duplicate_of_id}\`.`
        : "";
    const heading =
      row.status === "withdrawn"
        ? `**Withdrawn**${who}: the reporter found this was not a defect.`
        : `**Triaged as \`${row.status}\`**${who}.`;
    await githubRequest("POST", `${issuePath}/comments`, {
      body:
        heading +
        (row.triage_note ? `\n\n${fence(row.triage_note)}` : "") +
        duplicateOf +
        `\n\n_Seen ${Number(row.occurrence_count)} time(s) as of ${iso(row.last_seen_at)}._`,
    });
    const labels = [...labelsForReport(row), `status/${row.status}`];
    await ensureLabels(labels);
    await githubRequest("PATCH", issuePath, {
      labels,
      ...(reason ? { state: "closed", state_reason: reason } : { state: "open" }),
    });
    await rawQuery(
      `UPDATE agent_reports SET github_synced_at = now() WHERE id = $1`,
      [row.id]
    );
  } catch (err) {
    console.error(
      `[reports] failed to sync triage of report ${row.id} to GitHub:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

export interface SightingSync {
  /** The sighting moved an actioned report back to new. */
  reopened: boolean;
  /** The reporter's account of this occurrence, when it gave one. */
  account: string;
  agent: string;
  /** True when the agent chose to speak (joins with a body, or a note). */
  explicit: boolean;
  /** An update_issue note rather than another occurrence. */
  note?: boolean;
  /** The severity was re-rated; the labels follow. */
  severityChanged?: boolean;
}

/**
 * Carry a sighting to the issue. Not every sighting: the same failure
 * recurs across thousands of runs and a comment per run would bury the
 * thread, so an exact repeat with nothing new to say is counted on the row
 * and surfaces here only at milestone counts. An agent that chose to speak
 * (a joins with its own account, a note) is always heard, and a regression
 * always reopens. Never throws.
 */
export async function syncSightingToIssue(
  row: AgentReportRow,
  sync: SightingSync
): Promise<void> {
  try {
    if (!githubIssuesConfigured() || row.github_issue_number == null) return;
    const count = Number(row.occurrence_count);
    const worthAComment =
      sync.reopened || sync.explicit || (!sync.note && isSightingMilestone(count));
    if (!worthAComment && !sync.severityChanged) return;

    const repo = loadConfig().githubIssuesRepo;
    const issuePath = `/repos/${repo}/issues/${row.github_issue_number}`;
    if (worthAComment) {
      const heading = sync.reopened
        ? `**Seen again after being actioned** — reopened as a regression.`
        : sync.note
          ? `**Note from \`${sync.agent}\`**`
          : `**Seen again** by \`${sync.agent}\` (${count} time(s) so far).`;
      const where = [
        row.run_id ? `run \`${row.run_id}\`` : null,
        row.job_id ? `job \`${row.job_id}\`` : null,
        row.claim_id ? `claim \`${row.claim_id}\`` : null,
      ].filter(Boolean);
      await githubRequest("POST", `${issuePath}/comments`, {
        body:
          heading +
          (sync.account ? `\n\n${fence(sync.account)}` : "") +
          (where.length ? `\n\n_${where.join(", ")}._` : ""),
      });
    }
    if (sync.reopened || sync.severityChanged) {
      const labels = [...labelsForReport(row), `status/${row.status}`];
      await ensureLabels(labels);
      await githubRequest("PATCH", issuePath, {
        labels,
        ...(sync.reopened ? { state: "open" } : {}),
      });
    }
    await rawQuery(
      `UPDATE agent_reports SET github_synced_at = now() WHERE id = $1`,
      [row.id]
    );
  } catch (err) {
    console.error(
      `[reports] failed to sync sighting of report ${row.id} to GitHub:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
