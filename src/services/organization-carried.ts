/**
 * What a deployment the network does not join to minerval.ai sends and
 * receives as files, carried by a person of its organization
 * (docs/organizations.md, "Connecting by hand"). Two kinds go two ways,
 * because one is public and the other is not:
 *
 * - feed batches come in: a member downloads, from the deployment's row on
 *   the organization's Deployments tab, the next batch after one they name,
 *   never a choice among nodes, so the download shows no more than a pull
 *   over the network does. Each is on the organization's log as a pull;
 * - usage reports go out: an admin uploads them on the Billing tab, and they
 *   are recorded against the organization as if sent, and published nowhere.
 *
 * Page packages go out too, and are submitted on the ordinary route by a
 * member acting as the organization (server/organization-routes.ts).
 */
import { rawQuery } from "../db/client.js";
import { batchFileName } from "./mirror-batch.js";
import { OrganizationError, isLiveAdmin, requireMember } from "./organization-service.js";
import { receiveUsageReport, type ReceiveResult } from "./usage-report-service.js";

function isUuid(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * The next feed batch after `after`, exactly as it was signed, for a member
 * to carry to one of the organization's deployments that holds read_feed.
 * Null where the feed has no later batch.
 */
export async function nextFeedBatch(input: {
  organizationId: string;
  deploymentId: string;
  after: number;
  by: string;
}): Promise<{ sequence: number; file_name: string; body: string } | null> {
  await requireMember(input.organizationId, input.by);
  if (!isUuid(input.deploymentId)) throw new OrganizationError("DEPLOYMENT_NOT_FOUND", "The organization has no deployment with that id.", 404);
  const [dep] = await rawQuery<{ name: string; holds: boolean }>(
    `SELECT d.name, EXISTS (SELECT 1 FROM organization_grants g WHERE g.deployment_id = d.id AND g.permission = 'read_feed' AND g.withdrawn_at IS NULL) AS holds
       FROM deployments d WHERE d.id = $1 AND d.organization_id = $2 AND d.retired_at IS NULL`,
    [input.deploymentId, input.organizationId]
  );
  if (!dep) throw new OrganizationError("DEPLOYMENT_NOT_FOUND", "The organization has no live deployment with that id.", 404);
  if (!dep.holds) {
    throw new OrganizationError(
      "GRANT_NOT_HELD",
      `${dep.name} does not hold read_feed, so its batches are not downloaded for it. An admin gives it read_feed above.`,
      403
    );
  }
  const after = Number.isSafeInteger(input.after) && input.after >= 0 ? input.after : 0;
  const [row] = await rawQuery<{ sequence: string; body: string }>(
    `SELECT sequence::text AS sequence, body FROM mirror_feed_batches WHERE sequence > $1 ORDER BY sequence LIMIT 1`,
    [after]
  );
  if (!row) return null;
  const sequence = Number(row.sequence);
  await rawQuery(
    `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail)
     VALUES ($1, $2, 'session', 'feed_downloaded', $3::jsonb)`,
    [input.organizationId, input.by, JSON.stringify({ deployment_id: input.deploymentId, name: dep.name, after, sequence })]
  );
  return { sequence, file_name: batchFileName(sequence), body: row.body };
}

/**
 * An admin uploads a usage report a deployment wrote as a file
 * (USAGE_REPORT_DIR), and it is recorded against the organization exactly as
 * one sent over the network is.
 */
export async function uploadUsageReport(input: { organizationId: string; report: unknown; by: string }): Promise<ReceiveResult> {
  if (!(await isLiveAdmin(input.organizationId, input.by))) {
    throw new OrganizationError("ADMIN_REQUIRED", "Only an admin of the organization uploads its usage reports.", 403);
  }
  let payload: unknown = input.report;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new OrganizationError("NOT_A_REPORT", "This is not a usage report: it is not JSON. Upload the file the deployment wrote, as it is.", 422);
    }
  }
  const result = await receiveUsageReport(input.organizationId, payload, new Date(), { uploadedBy: input.by });
  if (result.ok) {
    await rawQuery(
      `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail)
       VALUES ($1, $2, 'session', 'usage_report_uploaded', $3::jsonb)`,
      [input.organizationId, input.by, JSON.stringify({ period: result.period, revision: result.revision, recorded: result.recorded })]
    );
  }
  return result;
}

export interface ReceivedReportView {
  period: string;
  revision: number;
  /** The day's total, in owls with six decimal places, as the report states it. */
  owls_spent: string;
  /** The identifier the deployment made for itself, which the report carries. */
  deployment_identifier: string;
  /** The connected deployment it belongs to, by name, where one is known. */
  deployment: { id: string; name: string } | null;
  via: "signed" | "uploaded" | "account_key";
  received_at: string;
  /** The report exactly as received. */
  body: string;
}

/**
 * What Minerval has recorded against the organization (its admins only),
 * newest day first: exactly what its deployments' Budget pages show their
 * administrators as sent, so nothing new leaves anyone. What it will be
 * billed on, once a price per owl is decided, from the latest revision of
 * each day.
 */
export async function receivedUsageReports(input: { organizationId: string; by: string; limit?: number }): Promise<ReceivedReportView[]> {
  if (!(await isLiveAdmin(input.organizationId, input.by))) {
    throw new OrganizationError("ADMIN_REQUIRED", "Only an admin of the organization reads the usage reports recorded against it.", 403);
  }
  const rows = await rawQuery<{
    period: string; revision: number; body: string; deployment_id: string; received_via: ReceivedReportView["via"]; received_at: Date;
    dep_id: string | null; dep_name: string | null;
  }>(
    `SELECT to_char(r.period, 'YYYY-MM-DD') AS period, r.revision, r.body, r.deployment_id, r.received_via, r.received_at,
            d.id AS dep_id, d.name AS dep_name
       FROM usage_reports_received r
       LEFT JOIN LATERAL (
         SELECT id, name FROM deployments
          WHERE organization_id = r.account_id AND (id = r.connected_deployment_id OR report_identifier = r.deployment_id)
          ORDER BY id = r.connected_deployment_id DESC LIMIT 1
       ) d ON true
      WHERE r.account_id = $1
      ORDER BY r.period DESC, r.revision DESC
      LIMIT $2`,
    [input.organizationId, Math.min(Math.max(1, Math.trunc(input.limit ?? 400)), 2000)]
  );
  return rows.map((r) => {
    let owls = "";
    try {
      owls = String((JSON.parse(r.body) as { owls_spent?: unknown }).owls_spent ?? "");
    } catch {
      owls = "";
    }
    return {
      period: r.period,
      revision: r.revision,
      owls_spent: owls,
      deployment_identifier: r.deployment_id,
      deployment: r.dep_id ? { id: r.dep_id, name: r.dep_name ?? "" } : null,
      via: r.received_via,
      received_at: r.received_at.toISOString(),
      body: r.body,
    };
  });
}
