/**
 * The tables for connections to an organization's own systems: a
 * connection, the tools its server lists and which of them agents are
 * offered, and the calls made through it.
 *
 * Nothing reads or writes them yet. This holds the schema to what its
 * comments say: empty on the public graph, defaults that offer nothing, and
 * no row that names a party or a label that does not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

let admin: string;
let party: string;
const tag = randomUUID().slice(0, 8);

const INSERT = `INSERT INTO connections (name, tool_prefix, url, party_id, stake) VALUES ($1, $2, $3, $4, $5) RETURNING id`;

async function connection(name: string, prefix: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(INSERT, [name, prefix, "https://warehouse.example/mcp", party, "A stake."]);
  return row!.id;
}

beforeAll(async () => {
  admin = await seedUser("connections-schema");
  [{ id: party }] = (await rawQuery<{ id: string }>(
    `INSERT INTO parties (name, created_by) VALUES ($1, $2) RETURNING id`,
    [`Halden Evaluations ${tag}`, admin]
  )) as [{ id: string }];
});

afterAll(async () => {
  await rawQuery(`DELETE FROM connections WHERE party_id = $1`, [party]);
  await rawQuery(`DELETE FROM parties WHERE id = $1`, [party]);
});

describe("on the public graph", () => {
  it("there are no connections, and no view query_sql reads shows the tables", async () => {
    const [n] = await rawQuery<{ n: number }>(
      `SELECT (SELECT count(*) FROM connections)::int + (SELECT count(*) FROM connection_tools)::int
            + (SELECT count(*) FROM connection_calls)::int AS n`
    );
    expect(n!.n).toBe(0);
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public_read' AND table_name LIKE 'connection%'`
    );
    expect(exposed).toEqual([]);
  });
});

describe("a connection", () => {
  it("starts on, with no rate, a two-minute timeout, and the credential expected in Authorization", async () => {
    const id = await connection(`Defaults ${tag}`, `defaults_${tag}`);
    const [row] = await rawQuery<Record<string, unknown>>(`SELECT * FROM connections WHERE id = $1`, [id]);
    expect(row).toMatchObject({
      transport: "streamable_http",
      credential_env: null,
      credential_header: "Authorization",
      sensitivity_label: "public",
      calls_per_minute: null,
      timeout_seconds: 120,
      enabled: true,
      last_checked_at: null,
      last_answered_at: null,
      last_error: null,
    });
  });

  it("needs a party that exists, a label that is defined, and a stake", async () => {
    const values = (over: Record<string, unknown>) => {
      const row = { name: `Needs ${randomUUID()}`, tool_prefix: `p_${randomUUID().slice(0, 8)}`, url: "https://x.example", party_id: party, stake: "s", ...over };
      return [row.name, row.tool_prefix, row.url, row.party_id, row.stake];
    };
    expect(await failure(INSERT, values({ party_id: null }))).toBe(NOT_NULL_VIOLATION);
    expect(await failure(INSERT, values({ party_id: randomUUID() }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await failure(INSERT, values({ stake: null }))).toBe(NOT_NULL_VIOLATION);
    expect(
      await failure(
        `INSERT INTO connections (name, tool_prefix, url, party_id, stake, sensitivity_label) VALUES ($1, $2, 'https://x.example', $3, 's', 'no-such-label')`,
        [`Needs ${randomUUID()}`, `p_${randomUUID().slice(0, 8)}`, party]
      )
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("has a name and a tool prefix no other connection has, and a rate and a timeout above zero", async () => {
    const id = await connection(`Unique ${tag}`, `unique_${tag}`);
    // One connection per name, however it is capitalized.
    expect(await failure(INSERT, [`UNIQUE ${tag}`, `other_${tag}`, "https://x.example", party, "s"])).toBe(UNIQUE_VIOLATION);
    expect(await failure(INSERT, [`Another ${tag}`, `unique_${tag}`, "https://x.example", party, "s"])).toBe(UNIQUE_VIOLATION);
    expect(await failure(`UPDATE connections SET calls_per_minute = 0 WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
    expect(await failure(`UPDATE connections SET timeout_seconds = 0 WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
    expect(await failure(`UPDATE connections SET calls_per_minute = 30, timeout_seconds = 5 WHERE id = $1`, [id])).toBeNull();
  });
});

describe("a connection's tools and calls", () => {
  it("offer nothing until picked, name each tool once, and go when the connection goes", async () => {
    const id = await connection(`Tools ${tag}`, `tools_${tag}`);
    const tool = `INSERT INTO connection_tools (connection_id, name, input_schema, definition_hash) VALUES ($1, $2, '{"type":"object"}'::jsonb, $3)`;
    expect(await failure(tool, [id, "run_query", "a".repeat(64)])).toBeNull();
    const [row] = await rawQuery<Record<string, unknown>>(`SELECT * FROM connection_tools WHERE connection_id = $1`, [id]);
    expect(row).toMatchObject({ description: "", annotations: null, listed: true, offered: false, offered_by: null, withdrawn_at: null });
    expect(await failure(tool, [id, "run_query", "b".repeat(64)])).toBe(UNIQUE_VIOLATION);
    // A tool's name and description are the organization's system describing
    // itself, so the row carries a label, and only one that is defined.
    expect(row!.sensitivity_label).toBe("public");
    expect(
      await failure(
        `INSERT INTO connection_tools (connection_id, name, input_schema, definition_hash, sensitivity_label)
         VALUES ($1, 'other', '{}'::jsonb, $2, 'no-such-label')`,
        [id, "c".repeat(64)]
      )
    ).toBe(FOREIGN_KEY_VIOLATION);

    // A call carries the shared label default, and may name the source kept from it.
    const source = await getOrCreateSource({ url: `https://example.org/connections-schema/${randomUUID()}`, title: "A document" });
    const [call] = await rawQuery<{ id: string; sensitivity_label: string; outcome: string | null }>(
      `INSERT INTO connection_calls (connection_id, tool, arguments, source_id) VALUES ($1, 'run_query', '{}'::jsonb, $2)
       RETURNING id, sensitivity_label, outcome`,
      [id, source.id]
    );
    expect(call).toMatchObject({ sensitivity_label: "public", outcome: null });
    expect(
      await failure(`INSERT INTO connection_calls (connection_id, tool, arguments, sensitivity_label) VALUES ($1, 't', '{}'::jsonb, 'no-such-label')`, [id])
    ).toBe(FOREIGN_KEY_VIOLATION);
    // The source going leaves the call; the connection going takes its tools and calls.
    await rawQuery(`DELETE FROM sources WHERE id = $1`, [source.id]);
    const [kept] = await rawQuery<{ source_id: string | null }>(`SELECT source_id FROM connection_calls WHERE id = $1`, [call!.id]);
    expect(kept!.source_id).toBeNull();
    await rawQuery(`DELETE FROM connections WHERE id = $1`, [id]);
    const [left] = await rawQuery<{ n: number }>(
      `SELECT (SELECT count(*) FROM connection_tools WHERE connection_id = $1)::int
            + (SELECT count(*) FROM connection_calls WHERE connection_id = $1)::int AS n`,
      [id]
    );
    expect(left!.n).toBe(0);
  });
});
