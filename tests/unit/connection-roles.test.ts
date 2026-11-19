import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  CONNECTION_ROLES,
  CONNECTION_ROLE_INFO,
  DEFAULT_CONNECTION_ROLES,
} from "../../src/connections.js";

/**
 * The roles a connection may be offered to (src/connections.ts;
 * docs/connections.md, "What agents get"): that each is wired in an agent,
 * that the database's default for a new connection is the list's, and that
 * a role a new connection is not offered to says why.
 */

const ROOT = join(__dirname, "..", "..");
const AGENTS = join(ROOT, "src", "llm", "agents");

/** Every role an agent file asks createConnectionTools for, by the literal it names. */
function wiredRoles(): Set<string> {
  const roles = new Set<string>();
  for (const file of readdirSync(AGENTS).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(AGENTS, file), "utf8");
    for (const m of text.matchAll(/createConnectionTools\(\{[^}]*?role: "([a-z_]+)"/gs)) roles.add(m[1]!);
  }
  return roles;
}

describe("the roles a connection may be offered to", () => {
  it("are each asked for by an agent, and no agent asks for one that is not listed", () => {
    expect([...wiredRoles()].sort()).toEqual([...CONNECTION_ROLES].sort());
  });

  it("start unticked on a new connection only with a reason, and the database's default is the same list", () => {
    for (const role of CONNECTION_ROLES) {
      const info = CONNECTION_ROLE_INFO[role];
      expect(info.name.length, role).toBeGreaterThan(0);
      if (info.offFirst !== undefined) expect(info.offFirst.length, role).toBeGreaterThan(20);
    }
    const migration = readFileSync(join(ROOT, "src", "db", "migrations", "0190_connection_roles.sql"), "utf8");
    const set = migration.match(/SET DEFAULT '\{([^}]*)\}'/);
    expect(set, "the migration sets the default for new connections").not.toBeNull();
    expect(set![1]!.split(",").map((r) => r.replace(/"/g, ""))).toEqual([...DEFAULT_CONNECTION_ROLES]);
    // A connection that existed keeps the three roles it had.
    expect(migration).toMatch(/ADD COLUMN "offered_to" text\[\] DEFAULT '\{"steward","researcher","lookout"\}' NOT NULL/);
  });

  it("let only the Stewards, and a Researcher whose work records, keep a reading", () => {
    const keeps = CONNECTION_ROLES.filter((role) => CONNECTION_ROLE_INFO[role].keeps !== "no");
    expect(keeps).toEqual(["steward", "researcher"]);
  });

  it("are asked for not to keep by every agent but the Steward and the Researcher", () => {
    for (const file of readdirSync(AGENTS).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(AGENTS, file), "utf8");
      for (const m of text.matchAll(/createConnectionTools\(\{([^}]*)\}\)/gs)) {
        const role = m[1]!.match(/role: "([a-z_]+)"/)?.[1];
        if (role === "steward" || role === "researcher") continue;
        expect(m[1], `${file} (${role})`).toMatch(/keeps: false/);
      }
    }
  });
});
