/**
 * An agent's report, sent to Minerval's maintainers (docs/the-gate.md,
 * "Outside"; docs/outward-acts.md, "An agent's report").
 *
 * On the public graph an agent's report of a problem is filed where the
 * maintainers read it. In a deployment that keeps things inside, a report
 * stays inside, at the label of the run that wrote it, so Minerval would
 * never hear that a tool fails there. This file is how it can.
 *
 * A report is words written at a label going to readers who do not read
 * it, so it goes the way everything of that kind goes: as an item at the
 * gate to outside (gate-service.ts, kind `report`). Audit's triage says
 * what a report is about (`about`): Minerval's machinery, or this
 * deployment's own setup. Only the first kind is offered. The item has two
 * parts of a kind.
 *
 *   What is always shown of it: the facts of the failure, in fixed
 *   vocabulary (factsOf): which of Minerval's own tools, by its name in
 *   the code; the kind of report and its severity, from the two fixed
 *   lists a report is filed under; and the version of Minerval the
 *   deployment runs. No word an agent wrote is among them. A tool the code
 *   does not know by name, such as one of the organization's own
 *   connections, is not named.
 *
 *   Its parts: the agent's words, the title and each paragraph of the
 *   body.
 *
 * The Redactor works on it under the policy for what leaves the report's
 * label, Audit checks that work, and the gate's setting says whether a
 * person decides as well. A report is the one kind of thing whose gate
 * starts with a person deciding (gate-kinds.ts, STARTING_MODE), because
 * nobody outside asked for it. A person at the gate can let the facts go
 * and hold the words. What the gate lets through is filed on the public
 * graph's ordinary report route under the organization's account, marked
 * private, which keeps it to the maintainers' own view (gate-outside.ts).
 *
 * What came back is read from the organization's own report on the public
 * graph (GET /reports/mine/:id) and shown on the report here, to people.
 * It is words from outside, and no agent is given it.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { migrationHead } from "../db/migration-head.js";
import { membersOnly } from "../permissions.js";
import { currentLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { call, publicGraph } from "./outbound-service.js";
import { getPromptSet } from "./prompt-set.js";

export class ReportSendingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

export { REPORT_ABOUT, type ReportAbout } from "./report-about.js";
import { REPORT_ABOUT, type ReportAbout } from "./report-about.js";

// ---- the facts -------------------------------------------------------------------------

let toolNames: Set<string> | null = null;

/**
 * The names of Minerval's own tools, from the code: the agents' tools and
 * the account's. A report's `surface` is free text an agent wrote, so it is
 * sent only when it is exactly one of these. A connection's tool, which an
 * organization names, is never among them.
 */
export async function minervalToolNames(): Promise<Set<string>> {
  if (toolNames) return toolNames;
  const names = new Set<string>(["web_search", "code_execution"]);
  const add = (defs: Array<{ name?: string }>) => defs.forEach((d) => typeof d.name === "string" && names.add(d.name));
  const t = "../llm/tools/";
  add((await import(`${t}steward-tools.js`)).getStewardToolDefinitions());
  add((await import(`${t}steward-structure-tools.js`)).getStewardStructureToolDefinitions());
  add((await import(`${t}curator-tools.js`)).getCuratorToolDefinitions());
  add((await import(`${t}audit-tools.js`)).getAuditToolDefinitions());
  add((await import(`${t}reviewer-tools.js`)).getReviewerToolDefinitions());
  add((await import(`${t}governance-tools.js`)).getGovernanceToolDefinitions());
  add((await import(`${t}arbitrator-tools.js`)).getArbitratorToolDefinitions());
  add((await import(`${t}graph-tools.js`)).getGraphToolDefinitions());
  add((await import(`${t}graph-read-tools.js`)).getGraphReadToolDefinitions());
  add((await import(`${t}redactor-tools.js`)).getRedactorToolDefinitions() as Array<{ name?: string }>);
  add((await import(`${t}report-tools.js`)).getReportToolDefinitions());
  add((await import(`${t}inbox-tools.js`)).getInboxToolDefinitions());
  add((await import(`${t}spend-tools.js`)).getSpendToolDefinitions());
  add((await import(`${t}kind-tools.js`)).getQuantityToolDefinitions());
  add((await import(`${t}kind-tools.js`)).getQuestionToolDefinitions());
  add([(await import(`${t}matcher-tools.js`)).getMatcherToolDefinition(), (await import(`${t}read-page-tool.js`)).getReadPageToolDefinition(), (await import(`${t}sql-tools.js`)).getSqlToolDefinition()]);
  const routes = await import("../mcp/route-tools.js");
  for (const r of Object.values(routes.ROUTE_TOOLS)) names.add(r.name);
  for (const list of Object.values(routes.NATIVE_TOOL_ROUTES)) list.forEach((n) => names.add(n));
  toolNames = names;
  return names;
}

export interface ReportFacts {
  /** One of Minerval's own tools by its name in the code, or null where the report names none of them. */
  tool: string | null;
  kind: string;
  severity: string;
  minerval: { migration: number; prompt_set: string };
  seen: number;
  first_seen: string;
  last_seen: string;
}

interface ReportRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  surface: string | null;
  agent: string;
  status: string;
  about: string | null;
  occurrence_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
  label: string;
}

const REPORT_COLUMNS = `id, kind, severity, title, body, surface, agent, status, about, occurrence_count, first_seen_at, last_seen_at, sensitivity_label AS label`;

const KINDS = ["system_failure", "tool_gap", "improvement"];
const SEVERITIES = ["blocking", "degraded", "annoyance", "idea"];

/** The facts of a report, in fixed vocabulary. Dates are days, so that a time of day does not say when a run happened. */
export async function factsOf(report: Pick<ReportRow, "kind" | "severity" | "surface" | "occurrence_count" | "first_seen_at" | "last_seen_at">): Promise<ReportFacts> {
  const surface = (report.surface ?? "").trim();
  const known = await minervalToolNames();
  return {
    tool: known.has(surface) ? surface : null,
    kind: KINDS.includes(report.kind) ? report.kind : "system_failure",
    severity: SEVERITIES.includes(report.severity) ? report.severity : "degraded",
    minerval: { migration: migrationHead().number, prompt_set: getPromptSet().hash },
    seen: Number(report.occurrence_count),
    first_seen: report.first_seen_at.toISOString().slice(0, 10),
    last_seen: report.last_seen_at.toISOString().slice(0, 10),
  };
}

// ---- Audit's triage says what a report is about ----------------------------------------------

/**
 * Record what a report is about, and where it is about Minerval's
 * machinery, offer it to the gate to outside. Called from Audit's triage,
 * at the report's label.
 */
export async function setReportAbout(reportId: string, about: string): Promise<{ about: ReportAbout; offered: boolean } | null> {
  if (!(about in REPORT_ABOUT)) throw new ReportSendingError("UNKNOWN_ABOUT", `about is one of: ${Object.keys(REPORT_ABOUT).join(", ")}.`, 422);
  const [row] = await rawQuery<{ id: string }>(`UPDATE agent_reports SET about = $2 WHERE id = $1 AND sensitivity_label = $3 RETURNING id`, [reportId, about, currentLabel()]);
  if (!row) return null;
  if (about !== "minerval") return { about: about as ReportAbout, offered: false };
  return { about: "minerval", offered: (await offerReport(reportId, currentLabel())) !== null };
}

/** Offer one report to the gate between its label and outside. Null where there is nothing to offer (one label; no party is the organization itself). */
async function offerReport(reportId: string, label: string): Promise<{ item_id: string } | null> {
  if (oneLabelOnly()) return null;
  const { offerToGate } = await import("./gate-service.js");
  return offerToGate({ kind: "report", fromLabel: label, toLabel: null, subject: { reportId } }).catch((err: unknown) => {
    console.error(`[gate] could not offer report ${reportId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
}

const REASON_EVERY_LABEL =
  "Agents' reports about Minerval's machinery are offered to the gate to outside from every label, each at its own, and what the maintainers' record says of one that was sent is written back at its label.";
const atEveryLabel = <T>(fn: () => Promise<T>) => withSystemClearance(REASON_EVERY_LABEL, fn);

/**
 * The scheduler's step: offer the reports Audit found to be about
 * Minerval's machinery that have not been offered. Offering one that says
 * what it said before changes nothing.
 */
export async function offerReportsToGate(): Promise<number> {
  if (!membersOnly() || oneLabelOnly()) return 0;
  return atEveryLabel(async () => {
    const due = await rawQuery<{ id: string; label: string }>(
      `SELECT r.id, r.sensitivity_label AS label FROM agent_reports r
        WHERE r.about = 'minerval'
          AND NOT EXISTS (SELECT 1 FROM showings s WHERE s.kind = 'report' AND s.subject_ref = r.id)
          AND NOT EXISTS (SELECT 1 FROM report_sendings d WHERE d.report_id = r.id AND d.sent_at IS NOT NULL)
        ORDER BY r.last_seen_at LIMIT 50`
    );
    let offered = 0;
    for (const r of due) if (await offerReport(r.id, r.label)) offered++;
    return offered;
  });
}

/** Read, for each report sent, what the maintainers' record of it says now: the organization's own reports, by their ids. */
export async function askAfterSentReports(): Promise<number> {
  if (!membersOnly() || oneLabelOnly()) return 0;
  let graph;
  try {
    graph = publicGraph();
  } catch {
    return 0;
  }
  return atEveryLabel(async () => {
    const sent = await rawQuery<{ id: string; public_report_id: string }>(
      `SELECT id, public_report_id FROM report_sendings
        WHERE public_report_id IS NOT NULL AND COALESCE(came_back->>'status', '') NOT IN ('actioned', 'wontfix', 'duplicate')
        ORDER BY sent_at LIMIT 50`
    );
    let asked = 0;
    for (const s of sent) {
      try {
        const res = await call(graph, "GET", `/reports/mine/${s.public_report_id}`);
        if (res.status !== 200 || !res.json.report) continue;
        const r = res.json.report as Record<string, unknown>;
        const cameBack = {
          status: String(r.status ?? ""),
          maintainers_note: typeof r.maintainers_note === "string" ? r.maintainers_note.slice(0, 4000) : null,
          issue_url: typeof r.issue_url === "string" ? r.issue_url.slice(0, 500) : null,
          asked_at: new Date().toISOString(),
        };
        await rawQuery(`UPDATE report_sendings SET came_back = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(cameBack)]);
        asked++;
      } catch {
        break;
      }
    }
    return asked;
  });
}

// ---- what a member reads -------------------------------------------------------------------

/** What a person is told about where a report goes. */
export const REPORT_AT_GATE_TOLD =
  "A report that Audit's triage finds to be about Minerval's machinery is offered to the gate to outside, like anything else written at a label " +
  "that goes to readers who do not read it. What is always shown of it is the facts in fixed words. Its parts are the agent's words, which the " +
  "Redactor works on under the policy for what leaves the report's label. This kind of thing starts with a person deciding as well: someone who " +
  "holds release for the organization's own material approves it at the gate, and may let the facts go and hold the words. An administrator can " +
  "leave it to the Redactor on Gates. What goes is filed with Minerval's maintainers under your organization's account on the public graph, " +
  "marked private. Nothing else of the report goes: not the run, the node it was working on, or its label.";

/**
 * The agents' reports the reader may read (those at labels they read),
 * each with what it is about, its facts, its words as written, where it
 * stands at the gate and what became of it. Read with the caller's own
 * clearance.
 */
export async function reportsOverview(opts: { limit?: number } = {}): Promise<Record<string, unknown>> {
  const reports = await rawQuery<ReportRow & { triage_note: string | null }>(
    `SELECT ${REPORT_COLUMNS}, triage_note FROM agent_reports ORDER BY (about = 'minerval') DESC NULLS LAST, last_seen_at DESC LIMIT $1`,
    [Math.min(200, Math.max(1, opts.limit ?? 100))]
  );
  const ids = reports.map((r) => r.id);
  const items = await rawQuery<{ report_id: string; item_id: string; stage: string; opened_at: Date }>(
    `SELECT s.subject_ref AS report_id, p.id AS item_id, p.stage, p.opened_at
       FROM showings s JOIN showing_pages p ON p.showing_id = s.id
      WHERE s.kind = 'report' AND s.subject_ref = ANY($1::uuid[]) AND p.stage <> 'overtaken' ORDER BY p.opened_at DESC`,
    [ids]
  );
  const sendings = await rawQuery<{ report_id: string; sent_at: Date | null; public_report_id: string | null; seen: number | null; came_back: Record<string, unknown> | null }>(
    `SELECT report_id, sent_at, public_report_id, seen, came_back FROM report_sendings WHERE report_id = ANY($1::uuid[])`,
    [ids]
  );
  const AT_GATE: Record<string, string> = {
    to_redact: "at the gate, waiting for the Redactor's run",
    to_check: "at the gate, redacted, and waiting for Audit's check of the redaction",
    at_gate: "at the gate",
    cannot_cross: "held at the gate",
  };
  const out: Array<Record<string, unknown>> = [];
  for (const r of reports) {
    const item = items.find((x) => x.report_id === r.id);
    const s = sendings.find((x) => x.report_id === r.id);
    out.push({
      report_id: r.id,
      filed_by: r.agent,
      triage: r.status,
      audit_note: r.triage_note,
      about: r.about ? REPORT_ABOUT[r.about as ReportAbout] ?? null : "not yet said by Audit's triage",
      offered_to_the_gate: r.about === "minerval",
      facts: await factsOf(r),
      as_written: { title: r.title, body: r.body },
      ...(item ? { at_the_gate: { item_id: item.item_id, offered_at: item.opened_at.toISOString(), stands: s?.sent_at ? "through the gate, and sent" : (AT_GATE[item.stage] ?? item.stage) } } : {}),
      ...(s?.sent_at ? { sent: { at: s.sent_at.toISOString(), on_the_public_graph: s.public_report_id, said_seen: s.seen, ...(s.came_back ? { came_back: s.came_back } : {}) } } : {}),
    });
  }
  return {
    reports: out,
    listed: "The reports written at labels you read.",
    how_a_report_goes: REPORT_AT_GATE_TOLD,
  };
}
