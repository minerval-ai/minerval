/**
 * The usage report (docs/usage-report.md).
 *
 * Every private graph pays toward the public graph it reads. By default the
 * price is metered: a deployment reports the owls its agents' runs spent,
 * whoever hosts it and whoever runs its models, and pays in proportion. A
 * flat price for the feed is the alternative, and a deployment on it
 * reports nothing (PUBLIC_GRAPH_PRICE).
 *
 * A report is one total for one closed UTC day. It never says which claims,
 * mandates, sources or people the work was for, how many runs there were or
 * which models ran, so it shows nothing about what the organization cares
 * about. Number of runs and the code version were considered and left out:
 * neither is needed to bill, and each says a little about how the
 * organization works.
 *
 * Both sides are here.
 *
 *  - The sending side, in a members-only deployment on the metered price:
 *    prepare a report for each closed day (prepareUsageReports), and send
 *    what has not been sent (sendUsageReports), online to the public graph
 *    under the organization's account or as files to be handed over. A
 *    report's text is fixed when it is prepared, so an administrator reads
 *    before sending exactly what will leave. A day's report is never
 *    rewritten: a recount that differs is a new report with the next
 *    revision. A deployment that was offline sends late, in order.
 *
 *  - The receiving side, on every deployment and of use on the public
 *    graph: record a report against the account that sent it
 *    (receiveUsageReport). The same report again changes nothing. Nothing
 *    is billed from it yet: the price per owl is not decided.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { membersOnly } from "../permissions.js";
import { canonicalContent } from "./run-log.js";

export const USAGE_REPORT_KIND = "minerval-usage-report";
export const USAGE_REPORT_FORMAT = 1;

/** A usage report: everything that is sent, and all of it. */
export interface UsageReport {
  format: typeof USAGE_REPORT_FORMAT;
  kind: typeof USAGE_REPORT_KIND;
  /** An identifier minted with the deployment's first report. It says nothing else about it. */
  deployment: string;
  /** The UTC day the report is of, YYYY-MM-DD. */
  period: string;
  /** 0 for the day's first report; a correction takes the next number. */
  revision: number;
  /** The owls the deployment's runs spent that day, to six decimal places. */
  owls_spent: string;
}

/** What is sent, as the administrators' page says it. */
export const WHAT_IS_SENT =
  "For each UTC day that has ended, this deployment reports one figure to the public graph: " +
  "the owls its agents' runs spent that day, one owl for each dollar of metered cost. " +
  "With the figure go the day, the report's revision number (0, or higher for a correction), " +
  "the report format's name and number, and an identifier of this deployment that was made at " +
  "random and says nothing else about it. The report is sent under the organization's account " +
  "on the public graph, because the metered price for reading the public graph is in " +
  "proportion to this total. Each report is shown here exactly as it is sent, before it is " +
  "sent and after.";

/** What is never sent. */
export const WHAT_IS_NEVER_SENT =
  "A report never says which claims, questions, sources, mandates or people the work was for, " +
  "how many runs there were, which models ran, or anything an agent read or wrote. The one " +
  "total is all of it.";

/** What the page says in a deployment on the flat price. */
export const FLAT_PRICE_SENDS_NOTHING =
  "This deployment pays a flat price for the public graph's feed (PUBLIC_GRAPH_PRICE=flat), " +
  "so it reports nothing: no usage report is prepared and none is sent.";

/** How a day's report is corrected. */
export const HOW_A_REPORT_IS_CORRECTED =
  "A day's report is not changed once it is written. If a later count of the same day " +
  "differs, the correction is a new report for that day with the next revision number, and " +
  "both stay on this page.";

type ReportingConfig = Pick<Config, "publicGraphPrice"> & { reads?: "open" | "members" };

/**
 * Whether this deployment reports its usage: it is members-only and on the
 * metered price. The public graph reports to no one.
 */
export function usageReporting(config: ReportingConfig = loadConfig()): boolean {
  return membersOnly(config) && config.publicGraphPrice !== "flat";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The UTC day a moment falls in, YYYY-MM-DD. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

/** Millionths of an owl as the report writes them: owls to six decimal places. */
export function formatOwls(microOwls: number): string {
  const whole = Math.floor(microOwls / 1_000_000);
  const rest = microOwls - whole * 1_000_000;
  return `${whole}.${String(rest).padStart(6, "0")}`;
}

/** The report as it is sent: canonical JSON, keys sorted, no spaces. */
export function usageReportBody(report: UsageReport): string {
  return canonicalContent(report);
}

// ---- the sending side --------------------------------------------------------

/** Serializes the workers and requests that prepare reports. */
const PREPARE_LOCK = `SELECT pg_advisory_xact_lock(hashtext('minerval:usage-reports'))`;

/**
 * How many closed days before the newest report a preparation recounts.
 * The meter's rows carry the time they were written, so a closed day's
 * total does not move in ordinary running; a recount catches the unusual
 * cases (a restored backup, a repair by hand, a call that was metered
 * across midnight). A week is recounted on every pass because a pass over
 * the whole meter would grow with it. An administrator can ask for any
 * range to be recounted (`recountFrom`).
 */
const RECOUNT_DAYS = 7;

export interface UsageReportRow {
  id: string;
  period: string;
  revision: number;
  body: string;
  body_hash: string;
  prepared_at: string;
  sent_at: string | null;
  sent_via: "online" | "file" | null;
  receipt: unknown;
  last_attempt_at: string | null;
  last_error: string | null;
}

const REPORT_COLUMNS = `id, to_char(period, 'YYYY-MM-DD') AS period, revision, body, body_hash,
  created_at, sent_at, sent_via, receipt, last_attempt_at, last_error`;

interface ReportDbRow {
  id: string;
  period: string;
  revision: number;
  body: string;
  body_hash: string;
  created_at: Date;
  sent_at: Date | null;
  sent_via: "online" | "file" | null;
  receipt: unknown;
  last_attempt_at: Date | null;
  last_error: string | null;
}

function reportRow(r: ReportDbRow): UsageReportRow {
  return {
    id: r.id,
    period: r.period,
    revision: r.revision,
    body: r.body,
    body_hash: r.body_hash,
    prepared_at: r.created_at.toISOString(),
    sent_at: r.sent_at?.toISOString() ?? null,
    sent_via: r.sent_via,
    receipt: r.receipt ?? null,
    last_attempt_at: r.last_attempt_at?.toISOString() ?? null,
    last_error: r.last_error,
  };
}

/**
 * Write a report for every closed UTC day that has none, and a correction
 * for any recently reported day whose count has changed. Returns the
 * reports written. Does nothing where the deployment does not report.
 *
 * The first day reported is the first day anything was metered, or
 * USAGE_REPORT_FROM where the deployment names a later one. From there
 * every day gets a report, a day with no spend included, so that the
 * record has no gaps to be asked about.
 */
export async function prepareUsageReports(
  now: Date = new Date(),
  options: { recountFrom?: string } = {}
): Promise<UsageReportRow[]> {
  const config = loadConfig();
  if (!usageReporting(config)) return [];
  const today = utcDay(now);
  const lastClosed = addDays(today, -1);
  const owlCost = config.owlCostMicroUsd;

  return withTransaction(async (tx) => {
    await tx.query(PREPARE_LOCK);
    const [state] = await tx.query<{
      deployment_id: string | null;
      newest: string | null;
      oldest: string | null;
    }>(
      `SELECT (SELECT deployment_id::text FROM usage_reports ORDER BY created_at ASC LIMIT 1) AS deployment_id,
              to_char(MAX(period), 'YYYY-MM-DD') AS newest,
              to_char(MIN(period), 'YYYY-MM-DD') AS oldest
         FROM usage_reports`
    );
    const [meter] = await tx.query<{ first_day: string | null }>(
      `SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first_day FROM llm_usage`
    );

    // Where new reports start: the day after the newest one, or the first
    // metered day, and never before the day the deployment names.
    const from = config.usageReportFrom || null;
    let start = state?.newest ? addDays(state.newest, 1) : (meter?.first_day ?? from);
    if (start && from && from > start) start = from;

    // Where the recount starts: a week back, or where the caller asks, and
    // never before the oldest report.
    let recountStart: string | null = null;
    if (state?.newest && state.oldest) {
      const asked =
        options.recountFrom && DAY.test(options.recountFrom) ? options.recountFrom : null;
      const earliest = asked ?? addDays(lastClosed, -(RECOUNT_DAYS - 1));
      recountStart = earliest < state.oldest ? state.oldest : earliest;
      if (recountStart > state.newest) recountStart = null;
    }

    const countFrom = [start, recountStart].filter((d): d is string => !!d && d <= lastClosed).sort()[0];
    if (!countFrom) return [];

    const totals = new Map(
      (
        await tx.query<{ day: string; total: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                  SUM(cost_micro_usd)::bigint AS total
             FROM llm_usage
            WHERE created_at >= $1::date AT TIME ZONE 'UTC'
              AND created_at < $2::date AT TIME ZONE 'UTC'
            GROUP BY 1`,
          [countFrom, today]
        )
      ).map((r) => [r.day, Number(r.total)])
    );
    // One owl covers OWL_COST_MICRO_USD of metered cost, a dollar unless
    // the deployment has set otherwise.
    const microOwlsOn = (day: string) =>
      Math.round(((totals.get(day) ?? 0) * 1_000_000) / owlCost);

    const deployment = state?.deployment_id ?? randomUUID();
    const written: UsageReportRow[] = [];
    const write = async (period: string, revision: number) => {
      const microOwls = microOwlsOn(period);
      const body = usageReportBody({
        format: USAGE_REPORT_FORMAT,
        kind: USAGE_REPORT_KIND,
        deployment,
        period,
        revision,
        owls_spent: formatOwls(microOwls),
      });
      const [row] = await tx.query<ReportDbRow>(
        `INSERT INTO usage_reports (deployment_id, period, revision, body, body_hash, spent_micro_owls)
         VALUES ($1, $2::date, $3, $4, $5, $6)
         RETURNING ${REPORT_COLUMNS}`,
        [deployment, period, revision, body, sha256(body), microOwls]
      );
      written.push(reportRow(row!));
    };

    if (recountStart) {
      const latest = await tx.query<{ period: string; revision: number; spent: string }>(
        `SELECT DISTINCT ON (period) to_char(period, 'YYYY-MM-DD') AS period, revision,
                spent_micro_owls::bigint AS spent
           FROM usage_reports
          WHERE period >= $1::date
          ORDER BY period, revision DESC`,
        [recountStart]
      );
      for (const report of latest) {
        if (Number(report.spent) !== microOwlsOn(report.period)) {
          await write(report.period, report.revision + 1);
        }
      }
    }
    if (start) {
      for (let day = start; day <= lastClosed; day = addDays(day, 1)) await write(day, 0);
    }
    return written;
  });
}

/** Where this deployment's reports go, as configured. */
export function usageReportDestination(
  config: Pick<Config, "usageReportUrl" | "usageReportApiKey" | "usageReportDir"> = loadConfig()
):
  | { kind: "online"; url: string; ready: boolean }
  | { kind: "file"; directory: string }
  | { kind: "none" } {
  if (config.usageReportDir) return { kind: "file", directory: config.usageReportDir };
  if (config.usageReportUrl) {
    return { kind: "online", url: config.usageReportUrl, ready: config.usageReportApiKey.length > 0 };
  }
  return { kind: "none" };
}

/** The name of the file a report is written to for handing over. */
export function usageReportFileName(period: string, revision: number): string {
  return `usage-report-${period}-r${revision}.json`;
}

export interface SendOutcome {
  sent: number;
  /** Why sending stopped, when it stopped before the end. */
  stopped: string | null;
}

/** How long one report may take to reach the public graph before the attempt is given up. */
const SEND_TIMEOUT_MS = 30_000;

/**
 * Send every report that has not been sent, oldest first: online to the
 * public graph, or as files where the deployment hands them over. Stops at
 * the first that fails and leaves the rest for the next pass, so a
 * deployment that was offline sends late and in order. A report's text is
 * what was prepared; nothing here changes it.
 */
export async function sendUsageReports(
  dependencies: { fetch?: typeof fetch } = {}
): Promise<SendOutcome> {
  const config = loadConfig();
  if (!usageReporting(config)) return { sent: 0, stopped: null };
  const destination = usageReportDestination(config);
  if (destination.kind === "none") {
    return {
      sent: 0,
      stopped:
        "No destination is set. Set USAGE_REPORT_URL and USAGE_REPORT_API_KEY to send reports to " +
        "the public graph, or USAGE_REPORT_DIR to write them as files to hand over.",
    };
  }
  if (destination.kind === "online" && !destination.ready) {
    return {
      sent: 0,
      stopped:
        "USAGE_REPORT_URL is set and USAGE_REPORT_API_KEY is not. A report is sent under an API " +
        "key of the organization's account on the public graph.",
    };
  }

  const unsent = await rawQuery<ReportDbRow>(
    `SELECT ${REPORT_COLUMNS} FROM usage_reports WHERE sent_at IS NULL ORDER BY period, revision`
  );
  let sent = 0;
  for (const report of unsent) {
    try {
      let via: "online" | "file";
      let receipt: unknown;
      if (destination.kind === "file") {
        await mkdir(destination.directory, { recursive: true });
        const file = usageReportFileName(report.period, report.revision);
        await writeFile(path.join(destination.directory, file), report.body, "utf8");
        via = "file";
        receipt = { file };
      } else {
        const response = await (dependencies.fetch ?? fetch)(destination.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": config.usageReportApiKey },
          body: report.body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`The public graph answered ${response.status}: ${text.slice(0, 500)}`);
        }
        via = "online";
        try {
          receipt = JSON.parse(text);
        } catch {
          receipt = { answer: text.slice(0, 500) };
        }
      }
      await rawQuery(
        `UPDATE usage_reports
            SET sent_at = now(), sent_via = $2, receipt = $3::jsonb,
                last_attempt_at = now(), last_error = NULL
          WHERE id = $1 AND sent_at IS NULL`,
        [report.id, via, JSON.stringify(receipt ?? null)]
      );
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await rawQuery(
        `UPDATE usage_reports SET last_attempt_at = now(), last_error = $2 WHERE id = $1`,
        [report.id, message.slice(0, 1000)]
      );
      return { sent, stopped: message };
    }
  }
  return { sent, stopped: null };
}

export interface OutgoingUsageReports {
  price: "metered" | "flat";
  reporting: boolean;
  /** What is sent and what is never sent, or that nothing is. */
  what_is_sent: string;
  what_is_never_sent: string | null;
  corrections: string | null;
  destination:
    | { kind: "online"; url: string; ready: boolean }
    | { kind: "file"; directory: string }
    | { kind: "none" };
  /** Every report, newest day first, each exactly as it is sent. */
  reports: UsageReportRow[];
}

/** Everything the administrators' page shows: the setting in force and every report as sent. */
export async function outgoingUsageReports(limit = 400): Promise<OutgoingUsageReports> {
  const config = loadConfig();
  const reporting = usageReporting(config);
  const rows = await rawQuery<ReportDbRow>(
    `SELECT ${REPORT_COLUMNS} FROM usage_reports ORDER BY period DESC, revision DESC LIMIT $1`,
    [Math.min(Math.max(1, Math.trunc(limit)), 2000)]
  );
  return {
    price: config.publicGraphPrice,
    reporting,
    what_is_sent: reporting ? WHAT_IS_SENT : FLAT_PRICE_SENDS_NOTHING,
    what_is_never_sent: reporting ? WHAT_IS_NEVER_SENT : null,
    corrections: reporting ? HOW_A_REPORT_IS_CORRECTED : null,
    destination: usageReportDestination(config),
    reports: rows.map(reportRow),
  };
}

// ---- the receiving side ------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWLS = /^\d{1,15}\.\d{6}$/;
const REPORT_FIELDS = ["format", "kind", "deployment", "period", "revision", "owls_spent"];

export type ReceiveFailure = "NOT_A_USAGE_REPORT" | "PERIOD_NOT_CLOSED" | "REPORT_DIFFERS";

export type ReceiveResult =
  | {
      ok: true;
      /** False when this exact report was already recorded. */
      recorded: boolean;
      period: string;
      revision: number;
      body_hash: string;
      received_at: string;
    }
  | { ok: false; code: ReceiveFailure; message: string };

/**
 * A received body as a usage report, or what is wrong with it. A field the
 * format does not have is refused, so that a report can never carry more
 * than the format says it does.
 */
export function readUsageReport(
  value: unknown
): { ok: true; report: UsageReport } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return bad("A usage report is a JSON object.");
  }
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !REPORT_FIELDS.includes(k));
  if (extra.length > 0) {
    return bad(
      `A usage report carries ${REPORT_FIELDS.join(", ")} and nothing else. This one also has ` +
        `${extra.map((k) => `"${k}"`).join(", ")}.`
    );
  }
  if (v.kind !== USAGE_REPORT_KIND || v.format !== USAGE_REPORT_FORMAT) {
    return bad(`A usage report has kind "${USAGE_REPORT_KIND}" and format ${USAGE_REPORT_FORMAT}.`);
  }
  if (typeof v.deployment !== "string" || !UUID_RE.test(v.deployment)) {
    return bad('"deployment" is the identifier the deployment made with its first report.');
  }
  if (typeof v.period !== "string" || !DAY.test(v.period) || Number.isNaN(Date.parse(`${v.period}T00:00:00Z`))) {
    return bad('"period" is the UTC day the report is of, written YYYY-MM-DD.');
  }
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 0) {
    return bad('"revision" is 0 for a day\'s first report and the next whole number for each correction.');
  }
  if (typeof v.owls_spent !== "string" || !OWLS.test(v.owls_spent)) {
    return bad('"owls_spent" is the day\'s total in owls, written with six decimal places, for example "12.500000".');
  }
  return {
    ok: true,
    report: {
      format: USAGE_REPORT_FORMAT,
      kind: USAGE_REPORT_KIND,
      deployment: v.deployment.toLowerCase(),
      period: v.period,
      revision: v.revision,
      owls_spent: v.owls_spent,
    },
  };
}

/**
 * Record a report against the account that sent it. One row per account,
 * deployment, day and revision. The same report again is recognized and
 * changes nothing; a different report for a day and revision already
 * recorded is refused, because a report is not changed after it is sent
 * and a correction is the next revision. Rows are kept per account: what
 * one account reports never touches another's, whatever identifier it
 * names.
 */
export async function receiveUsageReport(
  accountId: string,
  payload: unknown,
  now: Date = new Date()
): Promise<ReceiveResult> {
  const read = readUsageReport(payload);
  if (!read.ok) return { ok: false, code: "NOT_A_USAGE_REPORT", message: read.message };
  const report = read.report;
  if (report.period >= utcDay(now)) {
    return {
      ok: false,
      code: "PERIOD_NOT_CLOSED",
      message:
        `A usage report is of a UTC day that has ended. ${report.period} has not: today is ` +
        `${utcDay(now)} (UTC).`,
    };
  }
  const body = usageReportBody(report);
  const hash = sha256(body);
  const [whole, fraction] = report.owls_spent.split(".");
  const microOwls = Number(whole) * 1_000_000 + Number(fraction);

  const inserted = await rawQuery<{ received_at: Date }>(
    `INSERT INTO usage_reports_received
       (account_id, deployment_id, period, revision, body, body_hash, spent_micro_owls)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7)
     ON CONFLICT (account_id, deployment_id, period, revision) DO NOTHING
     RETURNING received_at`,
    [accountId, report.deployment, report.period, report.revision, body, hash, microOwls]
  );
  if (inserted.length > 0) {
    return {
      ok: true,
      recorded: true,
      period: report.period,
      revision: report.revision,
      body_hash: hash,
      received_at: inserted[0]!.received_at.toISOString(),
    };
  }
  const [existing] = await rawQuery<{ body_hash: string; received_at: Date }>(
    `SELECT body_hash, received_at FROM usage_reports_received
      WHERE account_id = $1 AND deployment_id = $2 AND period = $3::date AND revision = $4`,
    [accountId, report.deployment, report.period, report.revision]
  );
  if (existing?.body_hash === hash) {
    return {
      ok: true,
      recorded: false,
      period: report.period,
      revision: report.revision,
      body_hash: hash,
      received_at: existing.received_at.toISOString(),
    };
  }
  return {
    ok: false,
    code: "REPORT_DIFFERS",
    message:
      `A different report for ${report.period}, revision ${report.revision}, is already recorded ` +
      `for this deployment under this account, and a recorded report is not changed. Send a ` +
      `correction as the next revision.`,
  };
}
