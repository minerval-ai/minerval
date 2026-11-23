/**
 * docs/settings.md lists every setting, and the list is made from the
 * registry (scripts/settings-docs.ts), so the page cannot say something the
 * code does not. A failure means a setting was added or its row changed:
 * run `npx tsx scripts/settings-docs.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFieldDefault } from "../../src/config.js";
import { SETTINGS } from "../../src/settings-registry.js";
import { settingsTable, withSettingsTable } from "../../scripts/settings-docs-lib.js";

const page = readFileSync(join(resolve(__dirname, "..", ".."), "docs", "settings.md"), "utf8");

describe("docs/settings.md", () => {
  it("carries the table of settings as the registry makes it", () => {
    expect(
      withSettingsTable(page, settingsTable(configFieldDefault)) === page,
      "docs/settings.md is out of date with src/settings-registry.ts. Run: npx tsx scripts/settings-docs.ts"
    ).toBe(true);
  });

  it("names every setting, with its environment variable, who changes it and when a change applies", () => {
    for (const row of SETTINGS) {
      expect(page, row.env).toContain(`\`${row.env}\``);
      if (!row.retired) expect(page, row.key).toContain(`| \`${row.key}\` | \`${row.env}\` |`);
    }
    expect(page).toContain("| `models.steward` | `STEWARD_MODEL` | administrators | live |");
    expect(page).toContain("| `hosting.port` | `PORT` | the machine | restart |");
    expect(page).toContain("| `model_providers.anthropic_api_key` | `ANTHROPIC_API_KEY` | administrators (sealed) | live |");
  });

  it("never shows a secret's default", () => {
    for (const row of SETTINGS.filter((s) => s.secret && !s.retired)) {
      const line = page.split("\n").find((l) => l.startsWith(`| \`${row.key}\` | \`${row.env}\` |`));
      // The fifth cell is the default's.
      expect(line?.split(" | ")[4], row.key).toBe("");
    }
  });
});
