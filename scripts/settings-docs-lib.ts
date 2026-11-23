/**
 * The table of every setting in docs/settings.md, made from the registry
 * (src/settings-registry.ts) so that the page and the code cannot say
 * different things. `npx tsx scripts/settings-docs.ts` writes it between
 * the two markers; tests/unit/settings-docs.test.ts fails when the page's
 * copy is not what this makes.
 */
import { SETTINGS, settingGroup, type Setting } from "../src/settings-registry.js";

export const SETTINGS_TABLE_START = "<!-- settings-table:start (made by scripts/settings-docs.ts; do not edit by hand) -->";
export const SETTINGS_TABLE_END = "<!-- settings-table:end -->";

const WHO: Record<Setting["where"], string> = {
  machine: "the machine",
  app: "administrators",
  app_secret: "administrators (sealed)",
};

const cell = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

function defaultWords(row: Setting, defaultOf: (field: string) => string | null): string {
  if (row.secret) return "";
  const value = row.field ? defaultOf(row.field) : null;
  if (value === null) return "none";
  if (value === "") return "empty";
  return `\`${cell(value.length > 60 ? `${value.slice(0, 57)}...` : value)}\``;
}

/** The table, one section a group, in the registry's order. */
export function settingsTable(defaultOf: (field: string) => string | null): string {
  const groups: Array<{ group: string; rows: Setting[] }> = [];
  for (const row of SETTINGS) {
    if (row.retired) continue;
    const group = settingGroup(row.key) || row.key;
    const last = groups[groups.length - 1];
    if (last && last.group === group) last.rows.push(row);
    else groups.push({ group, rows: [row] });
  }
  const lines: string[] = [SETTINGS_TABLE_START, ""];
  for (const { group, rows } of groups) {
    lines.push(`#### \`${group}\``, "", "| Setting | Environment variable | Changed by | Applies | Default | What it decides |", "|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| \`${row.key}\` | \`${row.env}\` | ${WHO[row.where]} | ${row.where === "machine" ? "restart" : row.applies} | ${defaultWords(row, defaultOf)} | ${cell(row.about)} |`
      );
    }
    lines.push("");
  }
  const retired = SETTINGS.filter((row) => row.retired);
  lines.push("#### Retired", "", "| Environment variable | Retired in | In its place |", "|---|---|---|");
  for (const row of retired) lines.push(`| \`${row.env}\` | ${row.retired!.in} | ${cell(row.retired!.replacedBy)} |`);
  lines.push("", SETTINGS_TABLE_END);
  return lines.join("\n");
}

/** A page's text with the table between its markers replaced. Throws where the markers are not there. */
export function withSettingsTable(page: string, table: string): string {
  const start = page.indexOf(SETTINGS_TABLE_START);
  const end = page.indexOf(SETTINGS_TABLE_END);
  if (start < 0 || end < start) throw new Error("docs/settings.md has lost the markers the table of settings is written between.");
  return page.slice(0, start) + table + page.slice(end + SETTINGS_TABLE_END.length);
}
