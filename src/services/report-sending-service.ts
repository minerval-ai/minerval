/**
 * An agent's report, sent to Minerval's maintainers
 * (docs/outward-acts.md, "An agent's report, sent to Minerval's
 * maintainers").
 *
 * On the public graph an agent's report of a problem is filed where the
 * maintainers read it. In a deployment that keeps things inside, a report
 * stays inside, at the label of the run that wrote it, so Minerval would
 * never hear that a tool fails there. This file is how it can.
 *
 * A report has two parts.
 *
 *   The facts of the failure, in fixed vocabulary (factsOf): which of
 *   Minerval's own tools, by its name in the code; the kind of report and
 *   its severity, from the two fixed lists a report is filed under; the
 *   version of Minerval the deployment runs; and how often it was seen. No
 *   word an agent wrote is among them. A tool the code does not know by
 *   name, such as one of the organization's own connections, is not named.
 *
 *   The agent's words: the report's title and body.
 *
 * Audit's triage says what a report is about (report-tools and
 * audit-tools: `about`): Minerval's machinery, or this deployment's own
 * setup. Only the first kind is offered for sending. For those the
 * Redactor's pass over the agent's words is done ahead, as a ledger row at
 * the report's label under the policy for what leaves that label
 * (llm/agents/report-redactor.ts), so that the page shows the words as
 * they would go. One act by a person then sends them: a person who reads
 * the report's label and holds `release` for the organization's own
 * material, since releasing words written at a label is what `release` is.
 * They go to the public graph's ordinary report route under the
 * organization's account, marked private, which keeps them to the
 * maintainers' own view.
 *
 * Two standing choices, both off until a person turns them on
 * (outward-acts-service.ts, STANDING_CHOICES): send the facts of tool
 * failures with nobody acting, and send redacted reports with nobody
 * reading them first.
 *
 * What came back is read from the organization's own report on the public
 * graph (GET /reports/mine/:id) and shown on the report here, to people.
 * It is words from outside, and no agent is given it.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { migrationHead } from "../db/migration-head.js";
import { membersOnly } from "../permissions.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";
import { OutboundError, answerOf, call, publicGraph } from "./outbound-service.js";
import { NO_ACCOUNT_WORDS, OutwardError, logOutwardAct, standingChoiceOn, type Actor } from "./outward-acts-service.js";
import { RemovalError, applyRemovals, locate, overlaps } from "./page-parts.js";
import { getPromptSet } from "./prompt-set.js";
import { ensureBoundaryPolicy, policyById } from "./redaction-policy.js";
import { ownOrganizationParty } from "./showing-service.js";

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

const REPORT_GROUP = (reportId: string) => `report:${reportId}`;

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

/** The facts as the public graph's report route takes them: ids and fixed words only. */
function factsAsRefs(facts: ReportFacts): Record<string, string | number> {
  return {
    minerval_migration: facts.minerval.migration,
    minerval_prompt_set: facts.minerval.prompt_set,
    seen: facts.seen,
    first_seen: facts.first_seen,
    last_seen: facts.last_seen,
  };
}

// ---- Audit's triage says what a report is about ----------------------------------------------

/**
 * Record what a report is about, and where it is about Minerval's
 * machinery, open the Redactor's pass over its words. Called from Audit's
 * triage, at the report's label.
 */
export async function setReportAbout(reportId: string, about: string): Promise<{ about: ReportAbout; offered: boolean } | null> {
  if (!(about in REPORT_ABOUT)) throw new ReportSendingError("UNKNOWN_ABOUT", `about is one of: ${Object.keys(REPORT_ABOUT).join(", ")}.`, 422);
  const [row] = await rawQuery<{ id: string }>(`UPDATE agent_reports SET about = $2 WHERE id = $1 AND sensitivity_label = $3 RETURNING id`, [reportId, about, currentLabel()]);
  if (!row) return null;
  if (about !== "minerval") return { about: about as ReportAbout, offered: false };
  await ensureReportSending(reportId);
  return { about: "minerval", offered: true };
}

/** The sending of a report, made the first time it is offered: the words as they stand, the policy, and the ledger row for the Redactor's pass. At the report's label. */
export async function ensureReportSending(reportId: string): Promise<string> {
  const [existing] = await rawQuery<{ id: string }>(`SELECT id FROM report_sendings WHERE report_id = $1`, [reportId]);
  if (existing) return existing.id;
  const [report] = await rawQuery<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE id = $1`, [reportId]);
  if (!report) throw new ReportSendingError("REPORT_NOT_FOUND", "No report with that id is read at this label.", 404);
  const policy = await ensureBoundaryPolicy({ from: report.label, to: null });
  const { estimateLedgerKindCostMicroUsd } = await import("./cost-estimate-service.js");
  const cost = await estimateLedgerKindCostMicroUsd("redact_report");
  const [action] = await rawQuery<{ id: string }>(
    `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('redact_report', $1, 'standard', $2, 'Redact an agent''s report that is offered for sending to Minerval''s maintainers', $3, $4)
     ON CONFLICT (exclusion_group, variant) DO UPDATE SET updated_at = now() RETURNING id`,
    [REPORT_GROUP(report.id), report.id, Math.max(1, Math.round(cost)), report.label]
  );
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO report_sendings (report_id, title, body, policy_id, action_id, sensitivity_label) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (report_id) DO UPDATE SET report_id = EXCLUDED.report_id RETURNING id`,
    [report.id, report.title, report.body, policy.id, action!.id, report.label]
  );
  return row!.id;
}

// ---- the Redactor's pass (work at the report's label) ---------------------------------------

interface StoredRemoval {
  id: string;
  field: "title" | "body";
  start: number;
  end: number;
  category: string;
  note: string;
}

interface SendingRow {
  id: string;
  report_id: string;
  title: string;
  body: string;
  policy_id: string | null;
  removals: StoredRemoval[];
  action_id: string | null;
  state: "to_redact" | "redacted" | "sent" | "not_sent";
  redacted_at: Date | null;
  sent_at: Date | null;
  sent_under_standing_choice: boolean;
  public_report_id: string | null;
  came_back: Record<string, unknown> | null;
  facts_sent_at: Date | null;
  facts_seen: number | null;
  label: string;
}

const SENDING_COLUMNS = `id, report_id, title, body, policy_id, removals, action_id, state, redacted_at, sent_at, sent_under_standing_choice, public_report_id, came_back, facts_sent_at, facts_seen, sensitivity_label AS label`;

async function sendingAtOwnLabel(sendingId: string): Promise<SendingRow> {
  const [row] = await rawQuery<SendingRow>(`SELECT ${SENDING_COLUMNS} FROM report_sendings WHERE id = $1 AND sensitivity_label = $2`, [sendingId, currentLabel()]);
  if (!row) throw new ReportSendingError("NOT_FOUND", "No report waiting to be redacted has that id at this run's label.", 404);
  return row;
}

/** The words as they would go: each removed span replaced by its mark. */
export function wordsAsRedacted(s: Pick<SendingRow, "title" | "body" | "removals">): { title: string; body: string } {
  const of = (field: "title" | "body") => applyRemovals(s[field], s.removals.filter((r) => r.field === field)).text;
  return { title: of("title"), body: of("body") };
}

export async function reportToRedact(sendingId: string): Promise<Record<string, unknown>> {
  const s = await sendingAtOwnLabel(sendingId);
  const [report] = await rawQuery<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE id = $1`, [s.report_id]);
  const policy = s.policy_id ? await policyById(s.policy_id) : null;
  return {
    as_written: { title: s.title, body: s.body },
    as_it_would_go: wordsAsRedacted(s),
    removals: s.removals.map((r) => ({ removal_id: r.id, field: r.field, category: r.category, passage: s[r.field].slice(r.start, r.end), note: r.note })),
    sent_with_it_in_fixed_words: report ? await factsOf(report) : null,
    category_names: policy?.categories.map((c) => c.name) ?? [],
    state: s.state,
  };
}

export async function redactReportPassage(input: { sendingId: string; field: string; passage: string; occurrence?: number; category: string; note: string }): Promise<{ removal_id: string; now_reads: string }> {
  const s = await sendingAtOwnLabel(input.sendingId);
  if (s.state !== "to_redact") throw new ReportSendingError("NOT_REDACTING", "This report's redaction is finished; nothing more is removed from it.");
  if (input.field !== "title" && input.field !== "body") throw new ReportSendingError("NO_SUCH_FIELD", "field is title or body.", 422);
  const policy = s.policy_id ? await policyById(s.policy_id) : null;
  const category = policy?.categories.find((c) => c.name === input.category.trim());
  if (!category) {
    throw new ReportSendingError(
      "NO_SUCH_CATEGORY",
      `"${input.category}" is not a category of this boundary's policy. Its categories are: ${(policy?.categories ?? []).map((c) => `"${c.name}"`).join(", ")}. A passage no category covers stays.`,
      422
    );
  }
  if (!input.note?.trim()) throw new ReportSendingError("NOTE_NEEDED", "Say in the note why the category covers this passage. The person who sends the report reads it.", 422);
  const mine = s.removals.filter((r) => r.field === input.field);
  let span: { start: number; end: number };
  try {
    span = locate(s[input.field], input.passage, input.occurrence);
  } catch (err) {
    if (err instanceof RemovalError) throw new ReportSendingError("PASSAGE_NOT_FOUND", err.message, 422);
    throw err;
  }
  if (overlaps(mine, span)) throw new ReportSendingError("OVERLAPS", "That passage overlaps one already removed. Restore the earlier removal first, or give a passage that does not overlap it.", 422);
  const { randomUUID } = await import("node:crypto");
  const removal: StoredRemoval = { id: randomUUID(), field: input.field, start: span.start, end: span.end, category: category.name, note: input.note.trim() };
  const removals = [...s.removals, removal];
  await rawQuery(`UPDATE report_sendings SET removals = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(removals)]);
  return { removal_id: removal.id, now_reads: wordsAsRedacted({ ...s, removals })[input.field] };
}

export async function restoreReportPassage(input: { sendingId: string; removalId: string }): Promise<{ now_reads: { title: string; body: string } }> {
  const s = await sendingAtOwnLabel(input.sendingId);
  if (s.state !== "to_redact") throw new ReportSendingError("NOT_REDACTING", "This report's redaction is finished.");
  const removals = s.removals.filter((r) => r.id !== input.removalId);
  if (removals.length === s.removals.length) throw new ReportSendingError("NO_SUCH_REMOVAL", "No removal on this report has that id.", 422);
  await rawQuery(`UPDATE report_sendings SET removals = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(removals)]);
  return { now_reads: wordsAsRedacted({ ...s, removals }) };
}

export async function finishReportRedaction(input: { sendingId: string; model?: string | null }): Promise<{ removals: number }> {
  const s = await sendingAtOwnLabel(input.sendingId);
  if (s.state !== "to_redact") throw new ReportSendingError("NOT_REDACTING", "This report's redaction is already finished.");
  await rawQuery(`UPDATE report_sendings SET state = 'redacted', redacted_at = now(), redacted_by_model = $2 WHERE id = $1`, [s.id, input.model ?? null]);
  return { removals: s.removals.length };
}

// ---- sending ------------------------------------------------------------------------------

/** What a person is shown before they send a report. */
export const SEND_REPORT_TOLD =
  "Sending puts this report in front of Minerval's maintainers, under your organization's account on the public graph and marked private, so " +
  "that it is kept to the maintainers' own view. What goes is below: the facts in fixed words, and the agent's words with each passage the " +
  "Redactor removed replaced by its mark. Nothing else of the report goes: not the run, the node it was working on, or its label. Sending " +
  "releases these words from the label they were written at, which is why it takes release for the organization's own material. It is not " +
  "taken back.";

async function graphOrRefuse() {
  try {
    return publicGraph();
  } catch (err) {
    if (err instanceof OutboundError) throw new OutwardError("NO_ROUTE_OUT", NO_ACCOUNT_WORDS);
    throw err;
  }
}

/** What leaves when a report is sent: built here and nowhere else, and logged as built. */
export async function reportPayload(s: SendingRow, report: ReportRow): Promise<Record<string, unknown>> {
  const facts = await factsOf(report);
  const words = wordsAsRedacted(s);
  return {
    kind: facts.kind,
    severity: facts.severity,
    title: words.title,
    body: words.body,
    ...(facts.tool ? { surface: facts.tool } : {}),
    context_refs: factsAsRefs(facts),
    private: true,
  };
}

/**
 * Send a redacted report. A person sends it (`by.actor`), having been
 * checked by the route: they read the report's label, since the row is read
 * as them, and hold release for the organization's own material. Or the
 * standing choice sends it.
 */
export async function sendReport(input: { sendingId: string; by: Actor }): Promise<Record<string, unknown>> {
  const graph = await graphOrRefuse();
  // Read as whoever acts: a person who does not read the report's label finds nothing.
  const [s] = await rawQuery<SendingRow>(`SELECT ${SENDING_COLUMNS} FROM report_sendings WHERE id = $1`, [input.sendingId]);
  if (!s) throw new ReportSendingError("NOT_FOUND", "No report offered for sending has that id at a label you read.", 404);
  if (s.state === "to_redact") throw new ReportSendingError("NOT_REDACTED", "The Redactor's pass over this report has not been made yet. It runs when it is paid for, like any work.");
  if (s.state === "sent") throw new ReportSendingError("ALREADY_SENT", "This report has already been sent.");
  const [report] = await rawQuery<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE id = $1`, [s.report_id]);
  if (!report || report.about !== "minerval") throw new ReportSendingError("NOT_OFFERED", "Only a report that Audit's triage found to be about Minerval's machinery is offered for sending.");
  if ("actor" in input.by) {
    const own = await ownOrganizationParty();
    if (!own || !input.by.actor.releaseParties.includes(own.id)) {
      throw new ReportSendingError("RELEASE_NEEDED", "Sending a report releases words written at its label, so it takes release for the organization's own material, which an administrator grants.", 403);
    }
  }
  const payload = await reportPayload(s, report);
  let res: { status: number; json: Record<string, any> };
  try {
    res = await call(graph, "POST", "/reports", payload);
  } catch (err) {
    const said = err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached.";
    await logOutwardAct({ kind: "send_report", by: input.by, sent: payload, result: "failed", said });
    throw new OutwardError("PUBLIC_GRAPH_UNREACHABLE", `The public graph could not be reached, so nothing was sent: ${said}`, 502);
  }
  const fine = res.status === 200 || res.status === 201;
  const publicId = fine && typeof res.json.report?.id === "string" ? (res.json.report.id as string) : null;
  await logOutwardAct({ kind: "send_report", by: input.by, publicRef: publicId, sent: payload, result: fine ? "done" : "refused", said: fine ? `Recorded as ${res.json.report?.status ?? "new"}.` : `${res.status}: ${answerOf(res.json)}` });
  if (!fine) throw new OutwardError("PUBLIC_GRAPH_REFUSED", `The public graph did not take the report, and said: ${answerOf(res.json) || res.status}`);
  const person = "actor" in input.by ? input.by.actor : null;
  await runAtLabel(s.label, `recording that report ${s.report_id} was sent`, () =>
    rawQuery(
      `UPDATE report_sendings SET state = 'sent', sent_by = $2, sent_holding = $3, sent_under_standing_choice = $4, sent_at = now(), public_report_id = $5 WHERE id = $1`,
      [s.id, person?.id ?? null, person?.holding ?? [], person === null, publicId]
    )
  );
  return { sent: true, on_the_public_graph: publicId, what_went: payload };
}

/** Send the facts of one report alone. No word an agent wrote is in what goes. */
export async function sendFacts(input: { sendingId: string; by: Actor }): Promise<Record<string, unknown>> {
  const graph = await graphOrRefuse();
  const [s] = await rawQuery<SendingRow>(`SELECT ${SENDING_COLUMNS} FROM report_sendings WHERE id = $1`, [input.sendingId]);
  if (!s) throw new ReportSendingError("NOT_FOUND", "No report offered for sending has that id at a label you read.", 404);
  const [report] = await rawQuery<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE id = $1`, [s.report_id]);
  if (!report || report.about !== "minerval") throw new ReportSendingError("NOT_OFFERED", "Only a report that Audit's triage found to be about Minerval's machinery is offered for sending.");
  const facts = await factsOf(report);
  if (!facts.tool) {
    throw new ReportSendingError("NO_TOOL_NAMED", "This report names none of Minerval's own tools, so its facts say nothing a maintainer could act on. Its words can still be sent once redacted.");
  }
  const payload = {
    kind: facts.kind,
    severity: facts.severity,
    // Fixed words and a tool's name from the code: nothing an agent wrote.
    title: `${facts.tool}: ${facts.kind.replace(/_/g, " ")} reported in a private deployment`,
    body: "",
    surface: facts.tool,
    context_refs: factsAsRefs(facts),
    private: true,
  };
  let res: { status: number; json: Record<string, any> };
  try {
    res = await call(graph, "POST", "/reports", payload);
  } catch (err) {
    const said = err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached.";
    await logOutwardAct({ kind: "send_failure_facts", by: input.by, sent: payload, result: "failed", said });
    throw new OutwardError("PUBLIC_GRAPH_UNREACHABLE", `The public graph could not be reached, so nothing was sent: ${said}`, 502);
  }
  const fine = res.status === 200 || res.status === 201;
  const publicId = fine && typeof res.json.report?.id === "string" ? (res.json.report.id as string) : null;
  await logOutwardAct({ kind: "send_failure_facts", by: input.by, publicRef: publicId, sent: payload, result: fine ? "done" : "refused", said: fine ? `Recorded as ${res.json.report?.status ?? "new"}.` : `${res.status}: ${answerOf(res.json)}` });
  if (!fine) throw new OutwardError("PUBLIC_GRAPH_REFUSED", `The public graph did not take the facts, and said: ${answerOf(res.json) || res.status}`);
  await runAtLabel(s.label, `recording that the facts of report ${s.report_id} were sent`, () =>
    rawQuery(`UPDATE report_sendings SET facts_sent_at = now(), facts_seen = $2, facts_public_report_id = $3 WHERE id = $1`, [s.id, facts.seen, publicId])
  );
  return { sent: true, on_the_public_graph: publicId, what_went: payload };
}

const REASON_STANDING =
  "The standing choices about agents' reports are followed for reports at every label: each sending is read and marked at its own label, and what goes was fixed by the Redactor's pass and the fixed vocabulary of the facts.";

const atEveryLabel = <T>(fn: () => Promise<T>) => withSystemClearance(REASON_STANDING, fn);

/** The scheduler's step: follow the two standing choices, and ask after what was sent. */
export async function followReports(): Promise<{ facts: number; reports: number; asked_after: number }> {
  if (!membersOnly()) return { facts: 0, reports: 0, asked_after: 0 };
  const sendFactsOn = await standingChoiceOn("send_failure_facts");
  const sendReportsOn = await standingChoiceOn("send_redacted_reports");
  let facts = 0;
  let reports = 0;
  await atEveryLabel(async () => {
    if (sendFactsOn) {
      const due = await rawQuery<{ id: string }>(
        `SELECT s.id FROM report_sendings s JOIN agent_reports r ON r.id = s.report_id
          WHERE r.about = 'minerval' AND r.kind = 'system_failure' AND (s.facts_seen IS NULL OR s.facts_seen < r.occurrence_count) ORDER BY s.created_at LIMIT 20`
      );
      for (const d of due) {
        try {
          await sendFacts({ sendingId: d.id, by: { standingChoice: "send_failure_facts" } });
          facts++;
        } catch (err) {
          if (err instanceof ReportSendingError && err.code === "NO_TOOL_NAMED") {
            // Nothing to say for this one: mark it as looked at, so it is not tried again until it is seen again.
            await rawQuery(`UPDATE report_sendings s SET facts_seen = r.occurrence_count FROM agent_reports r WHERE r.id = s.report_id AND s.id = $1`, [d.id]);
          } else if (!(err instanceof OutwardError)) throw err;
          else break;
        }
      }
    }
    if (sendReportsOn) {
      const due = await rawQuery<{ id: string }>(
        `SELECT s.id FROM report_sendings s JOIN agent_reports r ON r.id = s.report_id WHERE s.state = 'redacted' AND r.about = 'minerval' ORDER BY s.redacted_at LIMIT 20`
      );
      for (const d of due) {
        try {
          await sendReport({ sendingId: d.id, by: { standingChoice: "send_redacted_reports" } });
          reports++;
        } catch (err) {
          if (!(err instanceof OutwardError)) throw err;
          break;
        }
      }
    }
  });
  return { facts, reports, asked_after: await askAfterSentReports() };
}

/** Read, for each report sent, what the maintainers' record of it says now: the organization's own reports, by their ids. */
export async function askAfterSentReports(): Promise<number> {
  let graph;
  try {
    graph = publicGraph();
  } catch {
    return 0;
  }
  return atEveryLabel(async () => {
    const sent = await rawQuery<{ id: string; public_report_id: string; label: string }>(
      `SELECT id, public_report_id, sensitivity_label AS label FROM report_sendings
        WHERE state = 'sent' AND public_report_id IS NOT NULL AND COALESCE(came_back->>'status', '') NOT IN ('actioned', 'wontfix', 'duplicate')
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

/**
 * The agents' reports the reader may read (those at labels they read),
 * each with what it is about, its facts, its words as written and as they
 * would go, and what became of its sending. Read with the caller's own
 * clearance.
 */
export async function reportsOverview(opts: { limit?: number } = {}): Promise<Record<string, unknown>> {
  const reports = await rawQuery<ReportRow & { triage_note: string | null }>(
    `SELECT ${REPORT_COLUMNS}, triage_note FROM agent_reports ORDER BY (about = 'minerval') DESC NULLS LAST, last_seen_at DESC LIMIT $1`,
    [Math.min(200, Math.max(1, opts.limit ?? 100))]
  );
  const sendings = await rawQuery<SendingRow & { sent_by_name: string | null; cost: string | null }>(
    `SELECT ${SENDING_COLUMNS.split(", ").map((c) => (c.startsWith("sensitivity_label") ? "s.sensitivity_label AS label" : `s.${c}`)).join(", ")},
            c.display_name AS sent_by_name, a.cost_est_micro_usd AS cost
       FROM report_sendings s LEFT JOIN contributors c ON c.id = s.sent_by LEFT JOIN actions a ON a.id = s.action_id
      WHERE s.report_id = ANY($1::uuid[])`,
    [reports.map((r) => r.id)]
  );
  const out: Array<Record<string, unknown>> = [];
  for (const r of reports) {
    const s = sendings.find((x) => x.report_id === r.id);
    out.push({
      report_id: r.id,
      filed_by: r.agent,
      triage: r.status,
      audit_note: r.triage_note,
      about: r.about ? REPORT_ABOUT[r.about as ReportAbout] ?? null : "not yet said by Audit's triage",
      offered_for_sending: r.about === "minerval",
      facts: await factsOf(r),
      as_written: { title: r.title, body: r.body },
      ...(s
        ? {
            sending: {
              sending_id: s.id,
              state:
                s.state === "to_redact"
                  ? "waiting for the Redactor's pass, which runs when it is paid for"
                  : s.state === "redacted"
                    ? "redacted, and waiting to be sent"
                    : s.state === "sent"
                      ? "sent"
                      : "not sent",
              ...(s.state === "to_redact" ? { redaction_action_id: s.action_id, redaction_expected_cost_owls: s.cost ? Math.round(Number(s.cost) / 10_000) / 100 : null } : {}),
              ...(s.state !== "to_redact"
                ? { as_it_would_go: wordsAsRedacted(s), removed: s.removals.map((x) => ({ from: x.field, category: x.category, note: x.note })) }
                : {}),
              ...(s.sent_at
                ? { sent_at: s.sent_at.toISOString(), sent_by: s.sent_under_standing_choice ? "the standing choice to send redacted reports without asking" : s.sent_by_name }
                : {}),
              ...(s.facts_sent_at ? { facts_sent_at: s.facts_sent_at.toISOString(), facts_said_seen: s.facts_seen } : {}),
              ...(s.came_back ? { came_back: s.came_back } : {}),
            },
          }
        : {}),
    });
  }
  return {
    reports: out,
    listed: "The reports written at labels you read.",
    what_sending_shows: SEND_REPORT_TOLD,
    who_may_send: "A person who reads the report's label and holds release for the organization's own material.",
  };
}
