import { describe, it, expect } from "vitest";
import {
  adminUrlOf,
  assertSnapshotName,
  assertSnapshotSafe,
  dbNameOf,
  snapshotDbName,
} from "../../../scripts/corpus/snapshot-core.js";

// The pure guards of the snapshot primitive: the mechanics run only in the
// DB suite (tests/db/corpus-snapshot.test.ts); what the unit suite pins is
// that the main graph can never be a snapshot target, by name.
describe("snapshot-core guards", () => {
  it("derives db and admin URLs", () => {
    const url = "postgresql://u:p@localhost:5432/episteme_corpus";
    expect(dbNameOf(url)).toBe("episteme_corpus");
    expect(new URL(adminUrlOf(url)).pathname).toBe("/postgres");
  });

  it("hard-refuses the main database, by name", () => {
    expect(() => assertSnapshotSafe("episteme")).toThrow(/main 'episteme'/);
    expect(() => assertSnapshotSafe("episteme_corpus")).not.toThrow();
  });

  it("refuses suspicious database names", () => {
    expect(() => assertSnapshotSafe("epi;DROP")).toThrow(/Suspicious/);
    expect(() => assertSnapshotSafe("Episteme")).toThrow(/Suspicious/);
  });

  it("bounds snapshot names to a safe identifier subset", () => {
    expect(() => assertSnapshotName("baseline_2026_08")).not.toThrow();
    expect(() => assertSnapshotName("has space")).toThrow();
    expect(() => assertSnapshotName("")).toThrow();
    expect(() => assertSnapshotName("x".repeat(41))).toThrow();
  });

  it("namespaces snapshot databases under the base name", () => {
    expect(snapshotDbName("episteme_corpus", "baseline")).toBe(
      "episteme_corpus_snap_baseline"
    );
  });
});
