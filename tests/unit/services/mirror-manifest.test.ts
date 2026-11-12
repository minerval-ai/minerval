/**
 * The list of what the mirror feed carries (src/services/mirror-manifest.ts),
 * held against the schema. A failure here usually means a column was added
 * to a replicated table without deciding whether it travels: either let it
 * be replicated (do nothing in the manifest, and this test still fails if it
 * points to a table that is not mirrored), or name it in the table's
 * `leftOut` with the reason and its kind.
 */
import { describe, it, expect } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../src/db/schema.js";
import {
  NOT_MIRRORED,
  replicatedShape,
  replicatedTables,
} from "../../../src/services/mirror-manifest.js";

const tables = replicatedTables();
const names = tables.map((t) => t.name);

/** Every table the schema declares, by SQL name. */
const declared = new Map<string, ReturnType<typeof getTableConfig>>();
for (const value of Object.values(schema)) {
  try {
    const config = getTableConfig(value as PgTable);
    if (config?.name && config.columns.length > 0) declared.set(config.name, config);
  } catch {
    // Not a table.
  }
}

describe("the mirror manifest", () => {
  it("replicates these tables, parents first", () => {
    expect(names).toEqual([
      "claims",
      "quantity_definitions",
      "quantity_cuts",
      "claim_relationships",
      "claim_links",
      "answer_relations",
      "sources",
      "source_segments",
      "arguments",
      "argument_subclaims",
      "claim_instances",
      "argument_instances",
      "quantity_readings",
      "assessments",
      "quantity_estimates",
      "question_assessments",
      "argument_evaluations",
      "source_interests",
      "judgment_inputs",
    ]);
    for (const table of tables) {
      const at = names.indexOf(table.name);
      for (const parent of table.parents) {
        expect(names.indexOf(parent.table), `${table.name}.${parent.column} -> ${parent.table}`).toBeLessThan(at);
      }
      for (const parent of Object.values(table.parentByKind?.tables ?? {})) {
        expect(names.indexOf(parent), `${table.name} -> ${parent}`).toBeGreaterThanOrEqual(0);
        expect(names.indexOf(parent)).toBeLessThan(at);
      }
    }
  });

  it("decides every column of a replicated table: it travels, or it is left out with a reason", () => {
    for (const table of tables) {
      const columns = declared.get(table.name)!.columns.map((c) => c.name);
      const decided = new Set([...table.columns, ...Object.keys(table.leftOut), "origin", "sensitivity_label"]);
      expect(columns.filter((c) => !decided.has(c)), table.name).toEqual([]);
      // Nothing is both, and nothing left out is a column that does not exist.
      expect(table.columns.filter((c) => c in table.leftOut), table.name).toEqual([]);
      expect(Object.keys(table.leftOut).filter((c) => !columns.includes(c)), table.name).toEqual([]);
      for (const [column, why] of Object.entries(table.leftOut)) {
        expect(why.reason.trim().length, `${table.name}.${column}`).toBeGreaterThan(20);
      }
      // The two columns handled for every table at once never travel as data.
      expect(table.columns).not.toContain("origin");
      expect(table.columns).not.toContain("sensitivity_label");
    }
  });

  it("carries the origin column on every replicated table", () => {
    // (Two other tables have a column of the same name that says where a
    // report or a conversation came from; it is unrelated.)
    for (const name of names) {
      const origin = declared.get(name)!.columns.find((c) => c.name === "origin");
      expect(origin, name).toBeDefined();
      expect(origin!.notNull, name).toBe(true);
      expect(origin!.default, name).toBe("local");
    }
  });

  it("replicates no column that points to a table outside the list", () => {
    for (const table of tables) {
      for (const fk of declared.get(table.name)!.foreignKeys) {
        const ref = fk.reference();
        const column = ref.columns[0]!.name;
        const target = getTableConfig(ref.foreignTable as PgTable).name;
        if (!table.columns.includes(column)) continue;
        expect(names, `${table.name}.${column} points to ${target}`).toContain(target);
      }
    }
  });

  it("keys every table that others point to by one uuid", () => {
    const pointedTo = new Set(tables.flatMap((t) => [...t.parents.map((p) => p.table), ...(t.selfReferences.length > 0 ? [t.name] : [])]));
    for (const table of tables) {
      expect(table.key.length, table.name).toBeGreaterThan(0);
      for (const key of table.key) expect(table.columns, `${table.name}.${key}`).toContain(key);
      if (!pointedTo.has(table.name)) continue;
      expect(table.key, table.name).toEqual(["id"]);
      expect(table.shape.find((c) => c.name === "id")!.type).toBe("uuid");
    }
  });

  it("leaves a claim's queue state to the deployment, and sets it once so the claim joins no drain", () => {
    const claims = tables.find((t) => t.name === "claims")!;
    expect(claims.localColumns).toEqual([
      "queue_priority",
      "steward_state",
      "steward_trigger",
      "steward_context",
      "steward_error",
      "steward_error_reason",
      "stewarded_at",
      "steward_requeued",
      "steward_attempts",
      "tagged_at",
      "tagging_leased_at",
      "tagging_attempts",
      "updated_at",
    ]);
    expect(claims.unguardedColumns).toEqual([...claims.localColumns, "text_search"]);
    expect(claims.onInsert).toEqual({ steward_state: "'deferred'", tagged_at: "now()" });
    for (const column of [...Object.keys(claims.onInsert), claims.touchOnWrite!]) {
      expect(claims.localColumns).toContain(column);
    }
    // The text, the kind, the state, the merge pointer, importance,
    // contestation, the domains and the vector all travel.
    for (const column of ["text", "kind", "state", "merged_into", "importance", "contestation", "domains", "embedding"]) {
      expect(claims.columns).toContain(column);
    }
    // No other table has working state of this deployment's own.
    for (const table of tables) {
      if (table.name !== "claims") expect(table.localColumns, table.name).toEqual([]);
    }
  });

  it("leaves out money and what points outside the mirror, and keeps a judgment's run as a bare id", () => {
    const leftOut = Object.fromEntries(tables.map((t) => [t.name, Object.keys(t.leftOut)]));
    expect(leftOut.assessments).toEqual(["funded_by_job_id"]);
    expect(leftOut.quantity_estimates).toEqual(["funded_by_job_id"]);
    expect(leftOut.question_assessments).toEqual(["funded_by_job_id"]);
    expect(leftOut.arguments).toEqual(["lean_check_id"]);
    expect(tables.find((t) => t.name === "assessments")!.columns).toContain("run_id");
    // The run tables themselves are not mirrored.
    expect(names).not.toContain("agent_runs");
    expect(names).not.toContain("agent_steps");
  });

  it("names what is not mirrored, and none of it is in the list", () => {
    const mentioned = Object.keys(NOT_MIRRORED).flatMap((group) => group.split(",").map((s) => s.trim()));
    for (const name of mentioned) expect(names, name).not.toContain(name);
    for (const reason of Object.values(NOT_MIRRORED)) expect(reason.trim().length).toBeGreaterThan(20);
  });

  it("writes the judgment that stopped being current before the one that became it", () => {
    for (const name of ["assessments", "quantity_estimates", "question_assessments", "argument_evaluations"]) {
      expect(tables.find((t) => t.name === name)!.writeOrder).toBe("is_current ASC, id ASC");
    }
  });

  it("states the shape of the mirrored tables as one hash", () => {
    expect(replicatedShape()).toMatch(/^[0-9a-f]{64}$/);
    expect(replicatedShape()).toBe(replicatedShape());
  });
});
