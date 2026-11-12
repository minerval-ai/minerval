/**
 * Parties: whose material a source is (src/permissions.ts; the `parties`
 * table in db/schema.ts).
 *
 * A party is added by an administrator and never removed: sources and
 * release grants refer to it. Whose material a source is can be changed,
 * and each change is logged with what it was before, because the party
 * decides who holds the gate for anything that rests on the source.
 */
import { runAtSourceLabel } from "./label-service.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { logAdministrativeEvent } from "./permission-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

/** A party's name is shown wherever its material is, so it is kept to a name. */
export const PARTY_NAME_MAX_CHARS = 200;

export interface PartyView {
  id: string;
  name: string;
  /** True for the one party that is the organization running the deployment. */
  is_own_organization: boolean;
  created_at: string;
}

interface PartyRow {
  id: string;
  name: string;
  is_own_organization: boolean;
  created_at: Date;
}

function partyView(r: PartyRow): PartyView {
  return {
    id: r.id,
    name: r.name,
    is_own_organization: r.is_own_organization,
    created_at: r.created_at.toISOString(),
  };
}

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string }; constraint?: string } | null;
  return e?.code ?? e?.cause?.code;
}

function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.constraint ?? e?.cause?.constraint;
}

/** Every party, the organization itself first, then by name. */
export async function listParties(): Promise<PartyView[]> {
  const rows = await rawQuery<PartyRow>(
    `SELECT id, name, is_own_organization, created_at FROM parties
      ORDER BY is_own_organization DESC, lower(name)`
  );
  return rows.map(partyView);
}

export type AddPartyFailure = "INVALID_NAME" | "NAME_TAKEN" | "OWN_ORGANIZATION_EXISTS";

export async function addParty(input: {
  name: string;
  isOwnOrganization?: boolean;
  actorId: string;
}): Promise<{ ok: true; party: PartyView } | { ok: false; code: AddPartyFailure; message: string }> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > PARTY_NAME_MAX_CHARS) {
    return {
      ok: false,
      code: "INVALID_NAME",
      message: `A party needs a name of at most ${PARTY_NAME_MAX_CHARS} characters.`,
    };
  }
  try {
    const party = await withTransaction(async (tx) => {
      const [row] = await tx.query<PartyRow>(
        `INSERT INTO parties (name, is_own_organization, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, name, is_own_organization, created_at`,
        [name, input.isOwnOrganization === true, input.actorId]
      );
      await logAdministrativeEvent(tx, "party_added", input.actorId, { party_id: row!.id });
      return row!;
    });
    return { ok: true, party: partyView(party) };
  } catch (err) {
    if (sqlState(err) !== UNIQUE_VIOLATION) throw err;
    if (constraintOf(err) === "uq_parties_own_organization") {
      return {
        ok: false,
        code: "OWN_ORGANIZATION_EXISTS",
        message: "This deployment already has the party that is the organization itself.",
      };
    }
    return { ok: false, code: "NAME_TAKEN", message: `A party named "${name}" already exists.` };
  }
}

export type SetSourcePartyFailure = "SOURCE_NOT_FOUND" | "UNKNOWN_PARTY";

/**
 * Say whose material a source is, or with a null party that it is nobody's
 * on record. The change and what the party was before go in the log in the
 * same transaction.
 */
export async function setSourceParty(input: {
  sourceId: string;
  partyId: string | null;
  actorId: string;
}): Promise<
  | { ok: true; source_id: string; party: PartyView | null }
  | { ok: false; code: SetSourcePartyFailure; message: string }
> {
  if (!UUID_RE.test(input.sourceId)) {
    return { ok: false, code: "SOURCE_NOT_FOUND", message: "Source not found" };
  }
  if (input.partyId !== null && !UUID_RE.test(input.partyId)) {
    return { ok: false, code: "UNKNOWN_PARTY", message: "No party has that id." };
  }
  // Whose material a source is, is a column of the source's own row, and
  // a row is changed by work at its own label (db/clearance.ts): the change
  // is made at the source's label, for a source the administrator may read.
  return runAtSourceLabel(input.sourceId, () => withTransaction(async (tx) => {
    const [source] = await tx.query<{ party_id: string | null }>(
      `SELECT party_id FROM sources WHERE id = $1 FOR UPDATE`,
      [input.sourceId]
    );
    if (!source) return { ok: false as const, code: "SOURCE_NOT_FOUND" as const, message: "Source not found" };
    let party: PartyRow | null = null;
    if (input.partyId !== null) {
      [party = null] = await tx.query<PartyRow>(
        `SELECT id, name, is_own_organization, created_at FROM parties WHERE id = $1`,
        [input.partyId]
      );
      if (!party) return { ok: false as const, code: "UNKNOWN_PARTY" as const, message: "No party has that id." };
    }
    if (source.party_id !== input.partyId) {
      await tx.query(`UPDATE sources SET party_id = $2 WHERE id = $1`, [input.sourceId, input.partyId]);
      await logAdministrativeEvent(tx, "source_party_set", input.actorId, {
        source_id: input.sourceId,
        party_id: input.partyId,
        previous_party_id: source.party_id,
      });
    }
    return { ok: true as const, source_id: input.sourceId, party: party ? partyView(party) : null };
  }));
}
