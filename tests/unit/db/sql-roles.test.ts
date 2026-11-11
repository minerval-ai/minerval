import { describe, it, expect } from "vitest";
import { ensureSqlRoles, hasSqlRoleCredentials, type RoleQuery } from "../../../src/db/sql-roles.js";

const CREDS = { agentUser: "minerval_sql_agent", agentPassword: "a-pw", callerUser: "minerval_sql_caller", callerPassword: "c'pw" };

/** A fake database: which roles exist, and every statement it was sent. */
function fakeDb(existing: string[], opts: { createRaces?: boolean } = {}) {
  const roles = new Set(existing);
  const sent: string[] = [];
  const query: RoleQuery = async (text, params) => {
    sent.push(text);
    if (text.startsWith("SELECT count(*)")) return [{ n: roles.has(String(params?.[0])) ? 1 : 0 }];
    const created = /^CREATE ROLE (\w+)/.exec(text);
    if (created) {
      if (opts.createRaces) throw Object.assign(new Error("role already exists"), { code: "42710" });
      roles.add(created[1]!);
    }
    return [];
  };
  return { query, sent, roles };
}

describe("ensureSqlRoles", () => {
  it("creates both roles in minerval_sql when neither exists", async () => {
    const db = fakeDb([]);
    const lines = await ensureSqlRoles(db.query, CREDS);
    expect(lines).toEqual([
      "+ role minerval_sql_agent (connection limit 4)",
      "+ role minerval_sql_caller (connection limit 4)",
    ]);
    expect(db.sent.filter((s) => s.startsWith("CREATE ROLE")).every((s) => s.endsWith("IN ROLE minerval_sql"))).toBe(true);
    // A quote in a password is doubled, never left to end the literal.
    expect(db.sent.some((s) => s.includes("PASSWORD 'c''pw'"))).toBe(true);
  });

  it("sets an existing role's password, limit and membership again", async () => {
    const db = fakeDb(["minerval_sql_agent", "minerval_sql_caller"]);
    const lines = await ensureSqlRoles(db.query, CREDS);
    expect(lines.every((l) => l.startsWith("~"))).toBe(true);
    expect(db.sent.some((s) => s.startsWith("CREATE ROLE"))).toBe(false);
    expect(db.sent.filter((s) => s.startsWith("ALTER ROLE"))).toHaveLength(2);
    expect(db.sent.filter((s) => s.startsWith("GRANT minerval_sql TO"))).toHaveLength(2);
  });

  it("falls through to ALTER when another task created the role first", async () => {
    const db = fakeDb([], { createRaces: true });
    const lines = await ensureSqlRoles(db.query, CREDS);
    expect(lines.every((l) => l.startsWith("~"))).toBe(true);
    expect(db.sent.filter((s) => s.startsWith("ALTER ROLE"))).toHaveLength(2);
  });

  it("refuses a role name that isn't a plain identifier", async () => {
    const db = fakeDb([]);
    await expect(ensureSqlRoles(db.query, { ...CREDS, agentUser: "x; DROP ROLE y" })).rejects.toThrow(/plain role name/);
    expect(db.sent).toHaveLength(0);
  });

  it("needs all four credentials before startup tries", () => {
    expect(hasSqlRoleCredentials(CREDS)).toBe(true);
    expect(hasSqlRoleCredentials({ ...CREDS, callerPassword: undefined })).toBe(false);
    expect(hasSqlRoleCredentials({})).toBe(false);
  });
});
