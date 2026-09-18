/**
 * docs/monitors.md must carry every monitor query verbatim (#334 S9): the
 * evals page shows readers exactly what a signal computes, so the doc and
 * the code cannot drift. Whitespace-insensitive so a re-indent is not a
 * failure; any token change is.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn() }));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => ({}) }));

import { MONITOR_SQL, MONITOR_SIGNALS } from "../../../src/services/monitor-service.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(here, "../../../docs/monitors.md"), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("docs/monitors.md", () => {
  it("carries every monitor query verbatim", () => {
    const flat = squash(doc);
    for (const [key, sql] of Object.entries(MONITOR_SQL)) {
      expect(flat, `query ${key} missing or changed in docs/monitors.md`).toContain(squash(sql));
    }
  });

  it("has a section per signal", () => {
    for (const signal of MONITOR_SIGNALS) {
      expect(doc).toContain(`## ${signal}`);
    }
  });
});
