import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { syncFrontendContent } from "../../../scripts/sync-frontend-content.js";

/**
 * Prompt transparency as a CI property (docs/mathematics.md §3.7): what the
 * site shows under /docs/agents and /docs/skills must be what the agents
 * run. The vendored copy in web/content/ is regenerated into a temporary
 * directory and diffed file by file; a stale copy fails here rather than
 * quietly misdescribing the agents. Re-run `npx tsx
 * scripts/sync-frontend-content.ts` to bring it current.
 */

const here = dirname(fileURLToPath(import.meta.url));
const vendored = resolve(here, "../../../web/content");

describe.skipIf(!existsSync(vendored))("vendored frontend content", () => {
  it("matches a fresh regeneration for agents and skills", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minerval-content-"));
    try {
      const { agents, skills } = syncFrontendContent(tmp);
      expect(agents.length).toBeGreaterThan(0);
      expect(skills.length).toBeGreaterThan(0);

      for (const sub of ["agents", "skills"]) {
        const fresh = readdirSync(join(tmp, sub)).sort();
        const have = existsSync(join(vendored, sub))
          ? readdirSync(join(vendored, sub)).sort()
          : [];
        expect(have, `web/content/${sub} file list`).toEqual(fresh);
        for (const file of fresh) {
          const expected = readFileSync(join(tmp, sub, file), "utf-8");
          const actual = readFileSync(join(vendored, sub, file), "utf-8");
          expect(
            actual === expected,
            `web/content/${sub}/${file} has drifted from the prompt code; ` +
              `run: npx tsx scripts/sync-frontend-content.ts`
          ).toBe(true);
        }
      }
      // No file here may hold a figure over the whole set: one line that every
      // prompt change rewrites makes every open PR conflict whenever another
      // merges. The prompt set's hash is served live (GET /setup/prompt-set).
      expect(existsSync(join(vendored, "prompt-set.json")), "web/content/prompt-set.json").toBe(false);
      for (const a of JSON.parse(readFileSync(join(vendored, "agents/index.json"), "utf-8"))) {
        expect(Object.keys(a), `agents/index.json entry ${a.key}`).not.toContain("fullChars");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
