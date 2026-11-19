/**
 * Naming the person who acted for an organization, on the public record
 * (docs/organizations.md, "Who acted"). Off unless the organization chose it:
 *
 * - on minerval.ai, an admin turns it on on the organization's Overview
 *   (organization_settings.names_people), and the words a member puts on
 *   the record as the organization carry their name, as written on their
 *   account here;
 * - in a deployment, it is the administrators' setting for its acts outside
 *   (outside_naming), and the deployment sends the name of the person who
 *   made an act, as written on their account there (x-acting-person-name).
 *
 * The public graph puts the name on the words an organization puts on the
 * record (contributions, stated views and proposals). Funding, taking up a
 * request and the rest stay the organization's alone.
 *
 * With it off, the public record says the organization's name and nothing
 * else. Which person acted is always on the organization's own log.
 *
 * The name rides the request in an AsyncLocalStorage, set by the plugin that
 * wraps every route that writes (server/plugins/organization-spending.ts), and
 * is read where a contribution or a stated view is written.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { rawQuery } from "../db/client.js";
import { OrganizationError, isLiveAdmin } from "./organization-service.js";

const named = new AsyncLocalStorage<string>();

export function runNamed<T>(name: string | null, fn: () => T): T {
  return name ? named.run(name, fn) : fn();
}

/** The person to name on what this request puts on the record, or null. */
export function namedPerson(): string | null {
  return named.getStore() ?? null;
}

/** A name as a deployment sends it (percent-encoded): trimmed, one line, at most 120 characters, or null. */
export function readSentName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const name = decoded.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, 120);
  return name || null;
}

/** Whether an organization names the person on what its members put on the record. */
export async function namesPeople(organizationId: string): Promise<boolean> {
  const [row] = await rawQuery<{ names_people: boolean }>(`SELECT names_people FROM organization_settings WHERE organization_id = $1`, [organizationId]);
  return row?.names_people ?? false;
}

/** An admin chooses whether the organization names the person on what its members put on the record. */
export async function setNamesPeople(input: { organizationId: string; on: boolean; by: string }): Promise<{ names_people: boolean }> {
  if (!(await isLiveAdmin(input.organizationId, input.by))) {
    throw new OrganizationError("ADMIN_REQUIRED", "Only an admin of the organization chooses whether its public record names who acted.", 403);
  }
  await rawQuery(
    `INSERT INTO organization_settings (organization_id, names_people, set_by, set_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (organization_id) DO UPDATE SET names_people = EXCLUDED.names_people, set_by = EXCLUDED.set_by, set_at = now()`,
    [input.organizationId, input.on, input.by]
  );
  await rawQuery(
    `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail) VALUES ($1, $2, 'session', 'names_people_set', $3::jsonb)`,
    [input.organizationId, input.by, JSON.stringify({ names_people: input.on })]
  );
  return { names_people: input.on };
}

// ---- in a deployment ---------------------------------------------------------------

/** Whether this deployment's acts outside send the name of the person who made them. */
export async function sendsPersonName(): Promise<boolean> {
  const [row] = await rawQuery<{ names_person: boolean }>(`SELECT names_person FROM outside_naming WHERE id = 'this'`);
  return row?.names_person ?? false;
}

/** An administrator chooses whether this deployment's acts outside send the person's name. */
export async function setSendsPersonName(on: boolean, by: string): Promise<{ names_person: boolean }> {
  await rawQuery(
    `INSERT INTO outside_naming (id, names_person, set_by, set_at) VALUES ('this', $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET names_person = EXCLUDED.names_person, set_by = EXCLUDED.set_by, set_at = now()`,
    [on, by]
  );
  return { names_person: on };
}
