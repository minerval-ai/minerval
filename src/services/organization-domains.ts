/**
 * A verified domain for an organization (docs/organizations.md, "A verified
 * domain").
 *
 * An admin adds a domain, and is shown a TXT record to put at
 * `_minerval.<domain>`: `minerval-organization=<token>`, the token made for
 * this organization and this domain. The public graph checks it when the
 * admin asks, and once a day after that. While it checks out, the
 * organization's pages show the domain beside its name with when it was last
 * confirmed. After a check fails it stays shown for seven days, marked as
 * unconfirmed since then, and the admins are told on the organization's
 * page and log; after seven days of failures it is not shown. The record of
 * when it was verified stays.
 *
 * One organization holds a domain at a time: a check that finds the record
 * while another organization's claim to the domain is still shown is refused.
 *
 * A domain says the organization controls DNS for it, and nothing more. It is
 * not a reason to believe anything the organization says, and no agent is
 * told to weigh it.
 */
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { rawQuery } from "../db/client.js";
import { OrganizationError, isLiveAdmin, requireMember } from "./organization-service.js";

/** How long a confirmed domain stays shown, as unconfirmed, after its checks start failing. */
export const DOMAIN_GRACE_DAYS = 7;
/** How often each domain is checked again. */
export const DOMAIN_CHECK_EVERY_HOURS = 24;
const RECORD_PREFIX = "_minerval.";
const VALUE_PREFIX = "minerval-organization=";

/** How TXT records are read; a test sets its own. */
let txtResolver: (name: string) => Promise<string[][]> = (name) => resolveTxt(name);
export function setTxtResolver(impl: ((name: string) => Promise<string[][]>) | null): void {
  txtResolver = impl ?? ((name) => resolveTxt(name));
}

/** A domain as a person may write it (with a scheme, a path, a trailing dot, capitals), as it is kept, or null where it is not one. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  if (d.startsWith("www.")) d = d.slice(4);
  if (d.length > 253 || !d.includes(".")) return null;
  const labels = d.split(".");
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  // An address is not a domain, and the last label is a name, not a number.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return d;
}

interface DomainRow {
  id: string;
  organization_id: string;
  domain: string;
  token: string;
  added_at: Date;
  verified_at: Date | null;
  confirmed_at: Date | null;
  failing_since: Date | null;
  last_checked_at: Date | null;
  last_error: string | null;
}

const COLUMNS = `id, organization_id, domain, token, added_at, verified_at, confirmed_at, failing_since, last_checked_at, last_error`;

export interface DomainView {
  id: string;
  domain: string;
  /** The record to put in DNS. */
  record: { name: string; type: "TXT"; value: string };
  /** 'waiting' (never found), 'confirmed', 'unconfirmed' (failing, still shown), or 'lapsed' (failing too long, not shown). */
  state: "waiting" | "confirmed" | "unconfirmed" | "lapsed";
  added_at: string;
  verified_at: string | null;
  confirmed_at: string | null;
  unconfirmed_since: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  in_words: string;
}

function graceEnds(row: Pick<DomainRow, "failing_since">): number {
  return row.failing_since ? new Date(row.failing_since).getTime() + DOMAIN_GRACE_DAYS * 86_400_000 : Infinity;
}

function stateOf(row: DomainRow, now = Date.now()): DomainView["state"] {
  if (!row.confirmed_at) return "waiting";
  if (!row.failing_since) return "confirmed";
  return now < graceEnds(row) ? "unconfirmed" : "lapsed";
}

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

function view(row: DomainRow): DomainView {
  const state = stateOf(row);
  return {
    id: row.id,
    domain: row.domain,
    record: { name: `${RECORD_PREFIX}${row.domain}`, type: "TXT", value: `${VALUE_PREFIX}${row.token}` },
    state,
    added_at: new Date(row.added_at).toISOString(),
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    confirmed_at: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    unconfirmed_since: row.failing_since ? new Date(row.failing_since).toISOString() : null,
    last_checked_at: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    last_error: row.last_error,
    in_words:
      state === "waiting"
        ? `Not yet found. Put a TXT record at ${RECORD_PREFIX}${row.domain} saying ${VALUE_PREFIX}${row.token}, then check it.`
        : state === "confirmed"
          ? `Shown beside the organization's name: last confirmed ${day(row.confirmed_at)}.`
          : state === "unconfirmed"
            ? `Shown as unconfirmed since ${day(row.failing_since)}: the record was not found. It stops being shown on ${day(new Date(graceEnds(row)))} unless a check finds it again.`
            : `Not shown: the record has not been found since ${day(row.failing_since)}. Put it back and check it, and it is shown again.`,
  };
}

async function row(organizationId: string, domainId: string): Promise<DomainRow> {
  const [r] = await rawQuery<DomainRow>(
    `SELECT ${COLUMNS} FROM organization_domains WHERE id = $1 AND organization_id = $2 AND removed_at IS NULL`,
    [domainId, organizationId]
  );
  if (!r) throw new OrganizationError("DOMAIN_NOT_FOUND", "The organization has no such domain.", 404);
  return r;
}

async function log(organizationId: string, actorId: string | null, kind: string, detail: Record<string, unknown>): Promise<void> {
  await rawQuery(
    `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [organizationId, actorId, actorId ? "session" : "operator", kind, JSON.stringify(detail)]
  );
}

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** An organization's domains, for its members. */
export async function listDomains(organizationId: string, by: string): Promise<DomainView[]> {
  await requireMember(organizationId, by);
  const rows = await rawQuery<DomainRow>(
    `SELECT ${COLUMNS} FROM organization_domains WHERE organization_id = $1 AND removed_at IS NULL ORDER BY added_at`,
    [organizationId]
  );
  return rows.map(view);
}

async function requireAdmin(organizationId: string, by: string): Promise<void> {
  if (!isUuid(organizationId) || !(await isLiveAdmin(organizationId, by))) {
    throw new OrganizationError("ADMIN_REQUIRED", "Only an admin of the organization adds, checks or removes its domains.", 403);
  }
}

/** An admin adds a domain, and is answered the record to put in DNS. */
export async function addDomain(organizationId: string, domain: unknown, by: string): Promise<DomainView> {
  await requireAdmin(organizationId, by);
  const d = normalizeDomain(domain);
  if (!d) throw new OrganizationError("BAD_DOMAIN", "Give a domain name, such as acme.com.", 422);
  const token = randomBytes(18).toString("base64url");
  const rows = await rawQuery<DomainRow>(
    `INSERT INTO organization_domains (organization_id, domain, token, added_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, domain) WHERE removed_at IS NULL DO NOTHING
     RETURNING ${COLUMNS}`,
    [organizationId, d, token, by]
  );
  if (rows.length === 0) throw new OrganizationError("DOMAIN_ADDED", `${d} is added already. Its record is below.`, 409);
  await log(organizationId, by, "domain_added", { domain: d });
  return view(rows[0]!);
}

/** An admin removes a domain: it is no longer shown or checked. The record of it stays. */
export async function removeDomain(organizationId: string, domainId: string, by: string): Promise<void> {
  await requireAdmin(organizationId, by);
  if (!isUuid(domainId)) throw new OrganizationError("DOMAIN_NOT_FOUND", "The organization has no such domain.", 404);
  const r = await row(organizationId, domainId);
  await rawQuery(`UPDATE organization_domains SET removed_at = now() WHERE id = $1`, [r.id]);
  await log(organizationId, by, "domain_removed", { domain: r.domain });
}

/** Whether DNS holds this domain's record now, and if not, why, in words. */
async function lookUp(r: DomainRow): Promise<{ found: boolean; error: string | null }> {
  let records: string[][];
  try {
    records = await txtResolver(`${RECORD_PREFIX}${r.domain}`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    return {
      found: false,
      error:
        code === "ENOTFOUND" || code === "ENODATA"
          ? `No TXT record at ${RECORD_PREFIX}${r.domain}.`
          : `DNS could not be read for ${RECORD_PREFIX}${r.domain} (${code ?? (err instanceof Error ? err.message : "no answer")}).`,
    };
  }
  const want = `${VALUE_PREFIX}${r.token}`;
  if (records.some((parts) => parts.join("").trim() === want)) return { found: true, error: null };
  return {
    found: false,
    error: records.some((parts) => parts.join("").startsWith(VALUE_PREFIX))
      ? `The TXT record at ${RECORD_PREFIX}${r.domain} names another token. Put this one: ${want}.`
      : `The TXT records at ${RECORD_PREFIX}${r.domain} do not include ${want}.`,
  };
}

/**
 * Check one domain now, and keep what was found. A found record confirms it,
 * unless another organization's claim to the same domain is still shown.
 */
async function check(r: DomainRow, by: string | null): Promise<DomainRow> {
  const before = stateOf(r);
  let { found, error } = await lookUp(r);
  if (found) {
    const [other] = await rawQuery<{ name: string }>(
      `SELECT c.display_name AS name FROM organization_domains d JOIN contributors c ON c.id = d.organization_id
        WHERE d.domain = $1 AND d.organization_id <> $2 AND d.removed_at IS NULL AND d.confirmed_at IS NOT NULL
          AND (d.failing_since IS NULL OR d.failing_since > now() - ($3 || ' days')::interval)`,
      [r.domain, r.organization_id, String(DOMAIN_GRACE_DAYS)]
    );
    if (other) {
      found = false;
      error = `${r.domain} is shown for another organization, ${other.name}, whose record was found there. One organization holds a domain at a time.`;
    }
  }
  const [after] = found
    ? await rawQuery<DomainRow>(
        `UPDATE organization_domains SET verified_at = COALESCE(verified_at, now()), confirmed_at = now(), failing_since = NULL,
           last_checked_at = now(), last_error = NULL WHERE id = $1 RETURNING ${COLUMNS}`,
        [r.id]
      )
    : await rawQuery<DomainRow>(
        `UPDATE organization_domains SET failing_since = CASE WHEN confirmed_at IS NULL THEN NULL ELSE COALESCE(failing_since, now()) END,
           last_checked_at = now(), last_error = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
        [r.id, error]
      );
  const now = stateOf(after!);
  if (now !== before) {
    const kind = now === "confirmed" ? "domain_confirmed" : now === "unconfirmed" ? "domain_unconfirmed" : now === "lapsed" ? "domain_lapsed" : null;
    if (kind) await log(r.organization_id, by, kind, { domain: r.domain, ...(error ? { said: error } : {}) });
  }
  return after!;
}

/** An admin asks for a domain to be checked now. */
export async function checkDomain(organizationId: string, domainId: string, by: string): Promise<DomainView> {
  await requireAdmin(organizationId, by);
  if (!isUuid(domainId)) throw new OrganizationError("DOMAIN_NOT_FOUND", "The organization has no such domain.", 404);
  return view(await check(await row(organizationId, domainId), by));
}

/** The daily check: every domain checked once before that is due again. Answers how many were checked. */
export async function checkDueDomains(): Promise<number> {
  const due = await rawQuery<DomainRow>(
    `SELECT ${COLUMNS} FROM organization_domains
      WHERE removed_at IS NULL AND last_checked_at IS NOT NULL AND last_checked_at < now() - ($1 || ' hours')::interval
      ORDER BY last_checked_at LIMIT 500`,
    [String(DOMAIN_CHECK_EVERY_HOURS)]
  );
  for (const r of due) await check(r, null).catch(() => undefined);
  return due.length;
}

/**
 * The domain shown beside an organization's name, where one is: confirmed,
 * or unconfirmed within its seven days, the most lately confirmed first.
 */
export async function shownDomain(organizationId: string): Promise<{ domain: string; confirmed_at: string; unconfirmed_since: string | null } | null> {
  const [r] = await rawQuery<{ domain: string; confirmed_at: Date; failing_since: Date | null }>(
    `SELECT domain, confirmed_at, failing_since FROM organization_domains
      WHERE organization_id = $1 AND removed_at IS NULL AND confirmed_at IS NOT NULL
        AND (failing_since IS NULL OR failing_since > now() - ($2 || ' days')::interval)
      ORDER BY failing_since IS NOT NULL, confirmed_at DESC LIMIT 1`,
    [organizationId, String(DOMAIN_GRACE_DAYS)]
  );
  if (!r) return null;
  return {
    domain: r.domain,
    confirmed_at: new Date(r.confirmed_at).toISOString(),
    unconfirmed_since: r.failing_since ? new Date(r.failing_since).toISOString() : null,
  };
}
