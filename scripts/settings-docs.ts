/**
 * Write the table of every setting into docs/settings.md, from the registry.
 *
 *   npx tsx scripts/settings-docs.ts
 *
 * Run it after adding a setting or changing one's row. The page's prose is
 * not touched: only what lies between the two markers.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFieldDefault } from "../src/config.js";
import { settingsTable, withSettingsTable } from "./settings-docs-lib.js";

const path = join(resolve(import.meta.dirname, ".."), "docs", "settings.md");
const before = readFileSync(path, "utf8");
const after = withSettingsTable(before, settingsTable(configFieldDefault));
if (after === before) {
  console.log("docs/settings.md already lists the settings as the registry has them.");
} else {
  writeFileSync(path, after);
  console.log("docs/settings.md: the table of settings was rewritten from the registry.");
}
