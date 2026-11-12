/**
 * The tables for who may do what in a private deployment: parties,
 * permission grants, the groups a sign-in carried, the log of other
 * administrative changes, and whose material a source is.
 *
 * Nothing reads or writes them yet. This holds the schema to what its
 * comments say: empty and inert on the public graph, and unable to hold a
 * grant that reads as wider than it was meant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { seedUser } from "./helpers.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await rawQuery(sql, params);
    return null;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
}

let account: string;
let admin: string;
let party: string;

beforeAll(async () => {
  account = await seedUser("grantee");
  admin = await seedUser("administrator");
  [{ id: party }] = (await rawQuery<{ id: string }>(
    `INSERT INTO parties (name, created_by) VALUES ($1, $2) RETURNING id`,
    [`Orrin Labs ${randomUUID()}`, admin]
  )) as [{ id: string }];
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ('internal', 'Readable inside the organization.')
     ON CONFLICT (name) DO NOTHING`
  );
});

afterAll(async () => {
  await rawQuery(`DELETE FROM administrative_events WHERE actor_id = $1`, [admin]);
  await rawQuery(`DELETE FROM permission_grants WHERE account_id = $1 OR granted_by = $2 OR group_name LIKE 'schema-test-%'`, [account, admin]);
  await rawQuery(`DELETE FROM account_groups WHERE account_id = $1`, [account]);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IN (SELECT id FROM parties WHERE created_by = $1)`, [admin]);
  await rawQuery(`DELETE FROM parties WHERE created_by = $1`, [admin]);
});

describe("on the public graph", () => {
  it("a source belongs to no party, and no read of a source says anything of one", async () => {
    const source = await getOrCreateSource({ url: `https://example.org/schema/${randomUUID()}`, title: "A report" });
    const [row] = await rawQuery<{ party_id: string | null }>(`SELECT party_id FROM sources WHERE id = $1`, [source.id]);
    expect(row!.party_id).toBeNull();

    const columns = await rawQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public_read' AND table_name = 'sources'`
    );
    expect(columns.map((c) => c.column_name)).not.toContain("party_id");

    process.env.LOG_LEVEL = "fatal";
    const { buildApp } = await import("../../src/server/app.js");
    const app: FastifyInstance = await buildApp();
    await app.ready();
    try {
      for (const path of ["", "/document", "/context", "/examinations"]) {
        const res = await app.inject({ url: `/sources/${source.id}${path}` });
        expect(res.statusCode, path).toBe(200);
        expect(res.body, path).not.toMatch(/party_id/);
      }
    } finally {
      await app.close();
    }
  });
});

describe("a permission grant", () => {
  const grant = (columns: Record<string, unknown>) => {
    const names = Object.keys(columns);
    return failure(
      `INSERT INTO permission_grants (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(columns)
    );
  };

  it("names one of the six permissions", async () => {
    expect(await grant({ permission: "own", account_id: account, granted_by: admin })).toBe(CHECK_VIOLATION);
    for (const permission of ["direct", "fund", "administer"]) {
      expect(await grant({ permission, group_name: `schema-test-${randomUUID()}`, granted_by: admin }), permission).toBeNull();
    }
  });

  it("is to an account or to a group, never both and never neither", async () => {
    expect(await grant({ permission: "fund", granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "fund", account_id: account, group_name: "schema-test-both", granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "fund", account_id: randomUUID(), granted_by: admin })).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("carries the scope its permission is held at, and no other", async () => {
    // Reading is held at a label that exists.
    expect(await grant({ permission: "read", account_id: account, granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "read", account_id: account, label: "no-such-label", granted_by: admin })).toBe(FOREIGN_KEY_VIOLATION);
    expect(await grant({ permission: "read", account_id: account, label: "internal", party_id: party, granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "read", account_id: account, label: "internal", granted_by: admin })).toBeNull();
    expect(await grant({ permission: "read_sources", account_id: account, label: "internal", granted_by: admin })).toBeNull();
    // Releasing is held for one party.
    expect(await grant({ permission: "release", account_id: account, granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "release", account_id: account, label: "internal", granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "release", account_id: account, party_id: party, granted_by: admin })).toBeNull();
    // The rest have none.
    expect(await grant({ permission: "direct", account_id: account, label: "internal", granted_by: admin })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "administer", account_id: account, party_id: party, granted_by: admin })).toBe(CHECK_VIOLATION);
  });

  it("says who made it, or how it was made when no administrator did", async () => {
    const group = `schema-test-${randomUUID()}`;
    expect(await grant({ permission: "fund", group_name: group })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "fund", group_name: group, granted_by: admin, granted_via: "first_administrator" })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "fund", group_name: group, granted_via: "someone" })).toBe(CHECK_VIOLATION);
    expect(await grant({ permission: "fund", group_name: group, granted_via: "first_administrator" })).toBeNull();
    expect(await grant({ permission: "direct", group_name: group, granted_via: "operator" })).toBeNull();
  });

  it("is held once while it is live, and can be held again after it is removed", async () => {
    const group = `schema-test-${randomUUID()}`;
    expect(await grant({ permission: "fund", group_name: group, granted_by: admin })).toBeNull();
    expect(await grant({ permission: "fund", group_name: group, granted_by: admin })).toBe(UNIQUE_VIOLATION);
    // The same permission at another scope is another grant.
    expect(await grant({ permission: "read", group_name: group, label: "internal", granted_by: admin })).toBeNull();
    expect(await grant({ permission: "read", group_name: group, label: "public", granted_by: admin })).toBeNull();
    expect(await grant({ permission: "read", group_name: group, label: "internal", granted_by: admin })).toBe(UNIQUE_VIOLATION);

    // A removal is recorded on the row: who without when is refused.
    expect(
      await failure(`UPDATE permission_grants SET removed_by = $2 WHERE group_name = $1 AND permission = 'fund'`, [group, admin])
    ).toBe(CHECK_VIOLATION);
    expect(
      await failure(
        `UPDATE permission_grants SET removed_by = $2, removed_at = now() WHERE group_name = $1 AND permission = 'fund'`,
        [group, admin]
      )
    ).toBeNull();
    expect(await grant({ permission: "fund", group_name: group, granted_by: admin })).toBeNull();
    const rows = await rawQuery(`SELECT 1 FROM permission_grants WHERE group_name = $1 AND permission = 'fund'`, [group]);
    expect(rows.length).toBe(2);
  });
});

describe("parties, groups and the log", () => {
  it("keeps one party per name however it is capitalized, and at most one that is the organization itself", async () => {
    const name = `Halden Evaluations ${randomUUID()}`;
    const own = () =>
      failure(`INSERT INTO parties (name, is_own_organization, created_by) VALUES ($1, true, $2)`, [`${name} ${randomUUID()}`, admin]);
    expect(await failure(`INSERT INTO parties (name, created_by) VALUES ($1, $2)`, [name, admin])).toBeNull();
    expect(await failure(`INSERT INTO parties (name, created_by) VALUES ($1, $2)`, [name.toUpperCase(), admin])).toBe(UNIQUE_VIOLATION);
    expect(await own()).toBeNull();
    expect(await own()).toBe(UNIQUE_VIOLATION);
  });

  it("records each group of a sign-in once per account, with when it was asserted", async () => {
    expect(await failure(`INSERT INTO account_groups (account_id, group_name) VALUES ($1, 'staff')`, [account])).toBeNull();
    expect(await failure(`INSERT INTO account_groups (account_id, group_name) VALUES ($1, 'staff')`, [account])).toBe(UNIQUE_VIOLATION);
    const [row] = await rawQuery<{ asserted_at: Date }>(`SELECT asserted_at FROM account_groups WHERE account_id = $1`, [account]);
    expect(row!.asserted_at).toBeInstanceOf(Date);
  });

  it("logs an administrative act with what was changed and who did it, if a person did", async () => {
    const event = (action: string | null, actor: string | null, detail: string | null) =>
      failure(`INSERT INTO administrative_events (action, actor_id, detail) VALUES ($1, $2, $3::jsonb)`, [action, actor, detail]);
    expect(await event("label_defined", admin, '{"label":"internal"}')).toBeNull();
    // An act's name is the code's to give, so a later kind needs no migration.
    expect(await event("a_later_kind_of_act", admin, "{}")).toBeNull();
    expect(await event("label_defined", randomUUID(), "{}")).toBe(FOREIGN_KEY_VIOLATION);
    expect(await event(null, admin, "{}")).toBe(NOT_NULL_VIOLATION);
    expect(await event("label_defined", admin, null)).toBe(NOT_NULL_VIOLATION);
    const [row] = await rawQuery<{ created_at: Date }>(
      `SELECT created_at FROM administrative_events WHERE actor_id = $1 ORDER BY created_at LIMIT 1`,
      [admin]
    );
    expect(row!.created_at).toBeInstanceOf(Date);
  });

  it("holds a source to a party that exists", async () => {
    const source = await getOrCreateSource({ url: `https://example.org/schema/${randomUUID()}`, title: "A report" });
    expect(await failure(`UPDATE sources SET party_id = $2 WHERE id = $1`, [source.id, randomUUID()])).toBe(FOREIGN_KEY_VIOLATION);
    expect(await failure(`UPDATE sources SET party_id = $2 WHERE id = $1`, [source.id, party])).toBeNull();
  });
});
