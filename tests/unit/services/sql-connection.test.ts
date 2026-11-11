/**
 * Read-only SQL connects the way the main pool does (TLS against the RDS CA
 * bundle in production, #870), and a fault on the database's side reaches
 * the caller as UNAVAILABLE with a fixed message: never the raw error, which
 * names internal hosts and roles, and never as a problem with their query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pg from "pg";

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    env: "production",
    sqlAgentDatabaseUrl: "postgresql://minerval_sql_agent:pw@replica.internal:5432/episteme",
    sqlAgentTimeoutSeconds: 20,
    sqlMaxPlanCost: 1_000_000,
  }),
}));

import { runReadOnlyQuery, SqlRefusal } from "../../../src/services/sql-service.js";

const RAW =
  'no pg_hba.conf entry for host "10.0.0.1", user "minerval_sql_agent", database "episteme", no encryption';

function dbError(code: string, message = RAW): pg.DatabaseError {
  const err = new pg.DatabaseError(message, 0, "error");
  err.code = code;
  return err;
}

let configs: pg.ClientConfig[] = [];
let connectError: unknown = null;
let explainError: unknown = null;

class FakeClient {
  constructor(config: pg.ClientConfig) {
    configs.push(config);
  }
  async connect() {
    if (connectError) throw connectError;
  }
  async query(q: unknown) {
    if (typeof q === "string" && q.startsWith("EXPLAIN") && explainError) throw explainError;
    return { rows: [], fields: [] };
  }
  async end() {}
}

async function refusal(): Promise<SqlRefusal> {
  try {
    await runReadOnlyQuery("SELECT id FROM nodes", [], { audience: "agent" });
  } catch (err) {
    if (err instanceof SqlRefusal) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("read-only SQL connections", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    configs = [];
    connectError = null;
    explainError = null;
    vi.spyOn(pg, "Client").mockImplementation(function (config: pg.ClientConfig) {
      return new FakeClient(config);
    } as never);
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the main pool's TLS in production", async () => {
    await runReadOnlyQuery("SELECT id FROM nodes", [], { audience: "agent" });
    const ssl = configs[0]!.ssl as { ca?: string; rejectUnauthorized?: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain("BEGIN CERTIFICATE");
  });

  it("answers a refused connection as UNAVAILABLE, logs the raw error, and leaks nothing", async () => {
    connectError = dbError("28000");
    const r = await refusal();
    expect(r.code).toBe("UNAVAILABLE");
    expect(r.message).toMatch(/not a problem with your query/);
    expect(r.message).not.toMatch(/pg_hba|minerval_sql_agent|10\.0\.0\.1|replica/);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("[sql]"), connectError);
  });

  it("treats a network failure on connect the same way", async () => {
    connectError = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
    const r = await refusal();
    expect(r.code).toBe("UNAVAILABLE");
    expect(r.message).not.toMatch(/10\.0\.0\.1/);
  });

  it("still answers BUSY when the role's connection limit is reached", async () => {
    connectError = dbError("53300", "too many connections for role");
    expect((await refusal()).code).toBe("BUSY");
  });

  it("answers auth, connection and shutdown faults after connecting as UNAVAILABLE", async () => {
    for (const code of ["28P01", "08006", "57P01", "57P03", "42501"]) {
      explainError = dbError(code);
      expect((await refusal()).code, code).toBe("UNAVAILABLE");
    }
  });

  it("keeps the query's own errors as SQL_ERROR, with the server's message", async () => {
    for (const code of ["42703", "22P02", "08P01"]) {
      explainError = dbError(code, `column "nope" does not exist (${code})`);
      const r = await refusal();
      expect(r.code, code).toBe("SQL_ERROR");
      expect(r.message).toContain(code);
    }
    expect(logged).not.toHaveBeenCalled();
  });
});
