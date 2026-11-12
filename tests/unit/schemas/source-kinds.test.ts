/**
 * The one list of source kinds (SOURCE_KIND_DESCRIPTIONS). Three
 * vocabularies once sat around a free-text column and agreed on nothing, so
 * the origin rule checked for kinds no code wrote. These hold every other
 * statement of the list to the one in src/schemas/common.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GENERIC_SOURCE_KINDS,
  PRIMARY_SOURCE_KINDS,
  SOURCE_KIND_DESCRIPTIONS,
  SOURCE_KIND_GUIDANCE,
  SOURCE_KINDS,
  STATABLE_SOURCE_KINDS,
  statedSourceKind,
} from "../../../src/schemas/common.js";

const root = resolve(__dirname, "../../..");
const quoted = (text: string): string[] => [...text.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]!);

describe("source kinds", () => {
  it("the database constraint allows exactly the list", () => {
    const schema = readFileSync(resolve(root, "src/db/schema.ts"), "utf8");
    const check = schema.match(/"ck_sources_source_type",\s*sql`\$\{table\.sourceType\} IN \(([^)]*)\)`/);
    expect(check, "ck_sources_source_type in src/db/schema.ts").not.toBeNull();
    expect(quoted(check![1]!).sort()).toEqual([...SOURCE_KINDS].sort());
  });

  it("the web's SourceKind type is the same list", () => {
    const types = readFileSync(resolve(root, "web/lib/types.ts"), "utf8");
    const union = types.match(/export type SourceKind =([^;]*);/);
    expect(union, "SourceKind in web/lib/types.ts").not.toBeNull();
    expect(quoted(union![1]!).sort()).toEqual([...SOURCE_KINDS].sort());
  });

  it("the provenance skill's tools offer exactly the kinds an agent may state", () => {
    const tools = JSON.parse(readFileSync(resolve(root, "skills/provenance/tools.json"), "utf8")) as Array<{
      name: string;
      input_schema: { properties: Record<string, { enum?: string[]; description?: string }> };
    }>;
    const prop = (tool: string, field: string) => tools.find((t) => t.name === tool)!.input_schema.properties[field]!;
    expect(prop("provenance_record_reading", "source_kind").enum).toEqual(STATABLE_SOURCE_KINDS);
    expect(prop("provenance_record_edge", "to_source_kind").enum).toEqual(STATABLE_SOURCE_KINDS);
    // The reading's description is the shared guidance, so the two cannot drift.
    expect(prop("provenance_record_reading", "source_kind").description).toContain(SOURCE_KIND_GUIDANCE);
  });

  it("every primary and generic kind is on the list, and an agent states any kind but unknown", () => {
    for (const k of [...PRIMARY_SOURCE_KINDS, ...GENERIC_SOURCE_KINDS]) expect(SOURCE_KINDS).toContain(k);
    expect(STATABLE_SOURCE_KINDS).not.toContain("unknown");
    // Nor shown_page, which only the showing of a page records.
    expect(STATABLE_SOURCE_KINDS).not.toContain("shown_page");
    expect(STATABLE_SOURCE_KINDS).toHaveLength(SOURCE_KINDS.length - 2);
    expect(statedSourceKind(" court_record ")).toBe("court_record");
    expect(statedSourceKind("unknown")).toBeNull();
    expect(statedSourceKind("peer_reviewed")).toBeNull();
    expect(statedSourceKind(undefined)).toBeNull();
  });

  it("describes every kind an agent chooses from", () => {
    for (const k of STATABLE_SOURCE_KINDS) {
      expect(SOURCE_KIND_DESCRIPTIONS[k].length).toBeGreaterThan(5);
      expect(SOURCE_KIND_GUIDANCE).toContain(`'${k}': `);
    }
  });
});
