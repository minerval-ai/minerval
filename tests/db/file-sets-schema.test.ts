/**
 * The tables for sets of files an organization's agents explore in a
 * sandbox: a set, its manifest, the commands run against it, and the files
 * kept from it as sources.
 *
 * Nothing reads or writes them yet. This holds the schema to what its
 * comments say: empty on the public graph, defaults under which a set is
 * open and offered to no run, and no row that names a party, a label or a
 * set that does not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { seedUser } from "./helpers.js";

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

const INSERT = `INSERT INTO file_sets (name, slug, origin, storage_key, party_id, stake) VALUES ($1, $2, 'upload', $2, $3, $4) RETURNING id`;

async function fileSet(name: string, slug: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(INSERT, [name, slug, party, "A stake."]);
  return row!.id;
}

beforeAll(async () => {
  admin = await seedUser("file-sets-schema");
  [{ id: party }] = (await rawQuery<{ id: string }>(
    `INSERT INTO parties (name, created_by) VALUES ($1, $2) RETURNING id`,
    [`Halden Evaluations ${tag}`, admin]
  )) as [{ id: string }];
});

afterAll(async () => {
  await rawQuery(`DELETE FROM file_sets WHERE party_id = $1`, [party]);
  await rawQuery(`DELETE FROM parties WHERE id = $1`, [party]);
});

describe("on the public graph", () => {
  it("there are no file sets and no commands, and no view query_sql reads shows the tables", async () => {
    const [n] = await rawQuery<{ n: number }>(
      `SELECT (SELECT count(*) FROM file_sets)::int + (SELECT count(*) FROM file_set_files)::int
            + (SELECT count(*) FROM file_set_keeps)::int + (SELECT count(*) FROM sandbox_calls)::int AS n`
    );
    expect(n!.n).toBe(0);
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public_read' AND (table_name LIKE 'file_set%' OR table_name LIKE 'sandbox%')`
    );
    expect(exposed).toEqual([]);
  });
});

describe("a file set", () => {
  it("starts open, on, empty and with no hash, so no run is offered it until it is closed", async () => {
    const id = await fileSet(`Defaults ${tag}`, `defaults-${tag}`);
    const [row] = await rawQuery<Record<string, unknown>>(`SELECT * FROM file_sets WHERE id = $1`, [id]);
    expect(row).toMatchObject({
      description: "",
      sensitivity_label: "public",
      state: "open",
      problem: null,
      file_count: 0,
      manifest_hash: null,
      closed_at: null,
      enabled: true,
    });
    expect(Number(row!.total_bytes)).toBe(0);
  });

  it("needs a party that exists, a label that is defined, a stake, and where its files are", async () => {
    const values = (over: Record<string, unknown>) => {
      const row = { name: `Needs ${randomUUID()}`, slug: `s-${randomUUID().slice(0, 8)}`, party_id: party, stake: "s", ...over };
      return [row.name, row.slug, row.party_id, row.stake];
    };
    expect(await failure(INSERT, values({ party_id: null }))).toBe(NOT_NULL_VIOLATION);
    expect(await failure(INSERT, values({ party_id: randomUUID() }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await failure(INSERT, values({ stake: null }))).toBe(NOT_NULL_VIOLATION);
    expect(
      await failure(`INSERT INTO file_sets (name, slug, storage_key, party_id, stake) VALUES ($1, $2, $2, $3, 's')`, [
        `Needs ${randomUUID()}`,
        `s-${randomUUID().slice(0, 8)}`,
        party,
      ])
    ).toBe(NOT_NULL_VIOLATION);
    expect(
      await failure(
        `INSERT INTO file_sets (name, slug, origin, storage_key, party_id, stake, sensitivity_label)
         VALUES ($1, $2, 'upload', $2, $3, 's', 'no-such-label')`,
        [`Needs ${randomUUID()}`, `s-${randomUUID().slice(0, 8)}`, party]
      )
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("has a name and a slug no other set has, and each path in it once", async () => {
    const id = await fileSet(`Unique ${tag}`, `unique-${tag}`);
    // One set per name, however it is capitalized.
    expect(await failure(INSERT, [`UNIQUE ${tag}`, `other-${tag}`, party, "s"])).toBe(UNIQUE_VIOLATION);
    expect(await failure(INSERT, [`Another ${tag}`, `unique-${tag}`, party, "s"])).toBe(UNIQUE_VIOLATION);
    const file = `INSERT INTO file_set_files (file_set_id, path, bytes, sha256) VALUES ($1, $2, $3, $4)`;
    // A file larger than a 32-bit count of bytes is held.
    expect(await failure(file, [id, "data/rows.csv", 5_000_000_000, "a".repeat(64)])).toBeNull();
    expect(await failure(file, [id, "data/rows.csv", 1, "b".repeat(64)])).toBe(UNIQUE_VIOLATION);
    expect(await failure(file, [randomUUID(), "x", 1, "c".repeat(64)])).toBe(FOREIGN_KEY_VIOLATION);
    const [row] = await rawQuery<{ bytes: string | number; sensitivity_label: string }>(
      `SELECT bytes, sensitivity_label FROM file_set_files WHERE file_set_id = $1`,
      [id]
    );
    expect(Number(row!.bytes)).toBe(5_000_000_000);
    // A path can say as much as the file it names, so a manifest row carries
    // a label, and only one that is defined.
    expect(row!.sensitivity_label).toBe("public");
    expect(
      await failure(`INSERT INTO file_set_files (file_set_id, path, bytes, sha256, sensitivity_label) VALUES ($1, 'b', 1, $2, 'no-such-label')`, [
        id,
        "d".repeat(64),
      ])
    ).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("a command and a kept file", () => {
  it("carry the shared label default, name the source kept from them, and go with what they belong to", async () => {
    const id = await fileSet(`Calls ${tag}`, `calls-${tag}`);
    const [file] = await rawQuery<{ id: string }>(
      `INSERT INTO file_set_files (file_set_id, path, bytes, sha256) VALUES ($1, 'a.txt', 2, $2) RETURNING id`,
      [id, "a".repeat(64)]
    );

    // A command needs only its text: it has run nowhere yet and read no set.
    const source = await getOrCreateSource({ url: `https://example.org/file-sets-schema/${randomUUID()}`, title: "A document" });
    const [call] = await rawQuery<Record<string, unknown>>(
      `INSERT INTO sandbox_calls (command, source_id) VALUES ('ls', $1) RETURNING *`,
      [source.id]
    );
    expect(call).toMatchObject({ files: [], file_sets: [], sensitivity_label: "public", outcome: null, output: null, exit_code: null });
    expect(await failure(`INSERT INTO sandbox_calls (command, sensitivity_label) VALUES ('ls', 'no-such-label')`)).toBe(FOREIGN_KEY_VIOLATION);
    expect(await failure(`INSERT INTO sandbox_calls (run_id) VALUES ($1)`, [randomUUID()])).toBe(NOT_NULL_VIOLATION);
    // The commands that had a set mounted are found by the set's id.
    await rawQuery(`UPDATE sandbox_calls SET file_sets = $2::jsonb WHERE id = $1`, [call!.id, JSON.stringify([{ id, name: "Calls" }])]);
    const found = await rawQuery<{ id: string }>(
      `SELECT id FROM sandbox_calls WHERE file_sets @> jsonb_build_array(jsonb_build_object('id', $1::text))`,
      [id]
    );
    expect(found.map((r) => r.id)).toEqual([call!.id]);

    // A kept file is one row per source, of a file of this set.
    const keep = `INSERT INTO file_set_keeps (file_set_id, file_id, first_line, last_line, source_id) VALUES ($1, $2, $3, $4, $5)`;
    expect(await failure(keep, [id, file!.id, 4, 6, source.id])).toBeNull();
    const [keptRow] = await rawQuery<{ sensitivity_label: string }>(
      `SELECT sensitivity_label FROM file_set_keeps WHERE source_id = $1`,
      [source.id]
    );
    expect(keptRow!.sensitivity_label).toBe("public");
    expect(await failure(keep, [id, file!.id, null, null, source.id])).toBe(UNIQUE_VIOLATION);
    const other = await getOrCreateSource({ url: `https://example.org/file-sets-schema/${randomUUID()}`, title: "Another document" });
    expect(await failure(keep, [id, randomUUID(), null, null, other.id])).toBe(FOREIGN_KEY_VIOLATION);
    expect(await failure(keep, [randomUUID(), file!.id, null, null, other.id])).toBe(FOREIGN_KEY_VIOLATION);
    await rawQuery(`DELETE FROM sources WHERE id = $1`, [other.id]);

    // The source going leaves the command and takes the record of the kept
    // file; the set going takes its manifest.
    await rawQuery(`DELETE FROM sources WHERE id = $1`, [source.id]);
    const [kept] = await rawQuery<{ source_id: string | null }>(`SELECT source_id FROM sandbox_calls WHERE id = $1`, [call!.id]);
    expect(kept!.source_id).toBeNull();
    expect(await rawQuery(`SELECT 1 FROM file_set_keeps WHERE file_set_id = $1`, [id])).toEqual([]);
    await rawQuery(`DELETE FROM file_sets WHERE id = $1`, [id]);
    expect(await rawQuery(`SELECT 1 FROM file_set_files WHERE file_set_id = $1`, [id])).toEqual([]);
    await rawQuery(`DELETE FROM sandbox_calls WHERE id = $1`, [call!.id]);
  });
});
