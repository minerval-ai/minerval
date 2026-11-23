/**
 * Release notes (docs/releases.md, "Release notes").
 *
 * Each release has one file, `releases/<version>.md`: a block of facts at
 * the top and prose below. The facts are what a deployment acts on, so they
 * are checked against the code (tests/unit/release-notes.test.ts): every
 * setting they name is one the registry has or had, and no setting is
 * added, retired or given a new default without a line saying so.
 *
 * `releases/next.md` holds the notes of the release that is not cut yet. A
 * pull request that changes a setting adds its line there. Cutting a
 * release (`npm run release:cut`) turns next.md into the release's file and
 * starts a new one.
 *
 * `releases/settings.json` is every setting's name, environment variable
 * and default as of the last release, written by the same command. What the
 * registry holds now and that file does not is what the next release
 * changes, and next.md must say each of them.
 *
 * `releases/` is copied into the API's image, so a deployment knows the
 * notes of every release up to its own without asking anyone.
 *
 * This module reads files and parses them. It asks nothing of the database.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { SETTINGS, findSetting, type Setting } from "./settings-registry.js";
import { VERSION_PATTERN, compareVersions } from "./version.js";

export interface SettingAdded {
  /** The setting, by its name in the config file or its environment variable. */
  key: string;
  note: string;
}

export interface SettingRetired {
  key: string;
  replaced_by: string;
  note: string;
}

export interface DefaultChanged {
  key: string;
  /** The default before and after, as the environment would hold each. */
  from: string;
  to: string;
  why: string;
}

/** What a deployment acts on. */
export interface ReleaseFacts {
  version: string;
  /** The day the release was cut, YYYY-MM-DD. */
  date: string;
  /** Whether it fixes a fault that exposes material, credentials or the machine. */
  security: boolean;
  /** The oldest version it can be reached from directly; null where any earlier one will do. */
  upgrades_from: string | null;
  settings: {
    added: SettingAdded[];
    retired: SettingRetired[];
    defaults_changed: DefaultChanged[];
  };
  /** Anything beyond the upgrade's own commands that the operator must do on the machine. Usually empty. */
  operator_steps: string[];
}

export interface ReleaseNotes {
  facts: ReleaseFacts;
  /** What a person reads, as Markdown. */
  prose: string;
}

/** The notes of the release that is not cut yet: the same facts, with no version or day. */
export type NextNotes = { facts: Omit<ReleaseFacts, "version" | "date">; prose: string };

/** Notes that could not be used, with everything wrong with them. */
export class ReleaseNotesError extends Error {
  readonly problems: readonly string[];
  constructor(where: string, problems: readonly string[]) {
    super(`${where} cannot be used:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ReleaseNotesError";
    this.problems = problems;
  }
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A day as text, whether the YAML reader read it as text or as a date. */
function dayOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return typeof value === "string" && DAY.test(value) ? value : null;
}

/** A default as the notes write it, in the text the environment holds: `90`, `true`, a list joined by commas. */
function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(",");
  return null;
}

function listOf<T>(
  value: unknown,
  where: string,
  problems: string[],
  read: (entry: Record<string, unknown>, at: string) => T | null
): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list.`);
    return [];
  }
  const out: T[] = [];
  value.forEach((entry, i) => {
    const at = `${where}[${i + 1}]`;
    if (!isRecord(entry)) {
      problems.push(`${at} must be a group with a key.`);
      return;
    }
    const item = read(entry, at);
    if (item) out.push(item);
  });
  return out;
}

function textOf(entry: Record<string, unknown>, name: string, at: string, problems: string[], required = true): string {
  const value = entry[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (required) problems.push(`${at} needs \`${name}\`, in words.`);
  return "";
}

function factsOf(front: unknown, next: boolean, problems: string[]): ReleaseFacts {
  const facts: ReleaseFacts = {
    version: "",
    date: "",
    security: false,
    upgrades_from: null,
    settings: { added: [], retired: [], defaults_changed: [] },
    operator_steps: [],
  };
  if (!isRecord(front)) {
    problems.push("The block of facts at the top must be a group of settings.");
    return facts;
  }
  const known = new Set(["version", "date", "security", "upgrades_from", "settings", "operator_steps"]);
  for (const name of Object.keys(front)) {
    if (!known.has(name)) problems.push(`\`${name}\` is not one of the facts. They are: ${[...known].join(", ")}.`);
  }
  if (next) {
    if (front.version !== undefined || front.date !== undefined) {
      problems.push("The notes of the release not yet cut carry no `version` and no `date`: cutting the release gives them.");
    }
  } else {
    const version = typeof front.version === "string" ? front.version : String(front.version ?? "");
    if (!VERSION_PATTERN.test(version) || version.includes("-dev")) {
      problems.push(`\`version\` must be a release, written MAJOR.MINOR.PATCH; it is ${JSON.stringify(front.version ?? null)}.`);
    }
    facts.version = version;
    const date = dayOf(front.date);
    if (!date) problems.push("`date` must be the day the release was cut, written YYYY-MM-DD.");
    facts.date = date ?? "";
  }
  if (typeof front.security !== "boolean") problems.push("`security` must be true or false.");
  else facts.security = front.security;
  if (front.upgrades_from !== undefined && front.upgrades_from !== null) {
    const from = String(front.upgrades_from);
    if (!VERSION_PATTERN.test(from) || from.includes("-dev")) {
      problems.push(`\`upgrades_from\` must be a release, written MAJOR.MINOR.PATCH; it is ${JSON.stringify(front.upgrades_from)}.`);
    } else {
      facts.upgrades_from = from;
    }
  }
  if (front.settings !== undefined && front.settings !== null) {
    if (!isRecord(front.settings)) {
      problems.push("`settings` must hold `added`, `retired` and `defaults_changed`.");
    } else {
      const settings = front.settings;
      for (const name of Object.keys(settings)) {
        if (!["added", "retired", "defaults_changed"].includes(name)) {
          problems.push(`\`settings.${name}\` is not one of added, retired and defaults_changed.`);
        }
      }
      facts.settings.added = listOf(settings.added, "settings.added", problems, (entry, at) => {
        const key = textOf(entry, "key", at, problems);
        const note = textOf(entry, "note", at, problems);
        return key ? { key, note } : null;
      });
      facts.settings.retired = listOf(settings.retired, "settings.retired", problems, (entry, at) => {
        const key = textOf(entry, "key", at, problems);
        const replaced_by = textOf(entry, "replaced_by", at, problems);
        const note = textOf(entry, "note", at, problems);
        return key ? { key, replaced_by, note } : null;
      });
      facts.settings.defaults_changed = listOf(settings.defaults_changed, "settings.defaults_changed", problems, (entry, at) => {
        const key = textOf(entry, "key", at, problems);
        const from = asText(entry.from);
        const to = asText(entry.to);
        if (from === null) problems.push(`${at} needs \`from\`: the default before.`);
        if (to === null) problems.push(`${at} needs \`to\`: the default now.`);
        const why = textOf(entry, "why", at, problems);
        return key && from !== null && to !== null ? { key, from, to, why } : null;
      });
    }
  }
  if (front.operator_steps !== undefined && front.operator_steps !== null) {
    if (!Array.isArray(front.operator_steps) || front.operator_steps.some((s) => typeof s !== "string" || s.trim() === "")) {
      problems.push("`operator_steps` must be a list of sentences.");
    } else {
      facts.operator_steps = (front.operator_steps as string[]).map((s) => s.trim());
      const twice = facts.operator_steps.filter((s, i, all) => all.indexOf(s) !== i);
      if (twice.length > 0) problems.push(`\`operator_steps\` says the same step twice: ${JSON.stringify(twice[0])}.`);
    }
  }
  return facts;
}

function parse(text: string, where: string, next: boolean): { facts: ReleaseFacts; prose: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    throw new ReleaseNotesError(where, ["It must begin with the block of facts, between two lines of `---`."]);
  }
  let front: unknown;
  try {
    front = parseYaml(match[1]!);
  } catch (err) {
    throw new ReleaseNotesError(where, [`Its block of facts is not valid YAML: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const problems: string[] = [];
  const facts = factsOf(front, next, problems);
  if (problems.length > 0) throw new ReleaseNotesError(where, problems);
  return { facts, prose: match[2]!.trim() };
}

/** A release's notes, from its file's text. Throws ReleaseNotesError with everything wrong. */
export function parseReleaseNotes(text: string, where = "These release notes"): ReleaseNotes {
  return parse(text, where, false);
}

/** The notes of the release not yet cut, from next.md's text. */
export function parseNextNotes(text: string, where = "releases/next.md"): NextNotes {
  const { facts, prose } = parse(text, where, true);
  const { version: _version, date: _date, ...rest } = facts;
  return { facts: rest, prose };
}

/** The facts as the block at the top of a file, and the prose below it. */
export function renderReleaseNotes(facts: ReleaseFacts | NextNotes["facts"], prose: string): string {
  const q = (text: string) => JSON.stringify(text);
  const lines: string[] = ["---"];
  if ("version" in facts) lines.push(`version: ${facts.version}`, `date: ${facts.date}`);
  lines.push(`security: ${facts.security}`);
  if (facts.upgrades_from) lines.push(`upgrades_from: ${facts.upgrades_from}`);
  lines.push("settings:");
  const group = <T,>(name: string, items: T[], write: (item: T) => string[]) => {
    if (items.length === 0) {
      lines.push(`  ${name}: []`);
      return;
    }
    lines.push(`  ${name}:`);
    for (const item of items) {
      const [first, ...rest] = write(item);
      lines.push(`    - ${first}`, ...rest.map((line) => `      ${line}`));
    }
  };
  group("added", facts.settings.added, (s) => [`key: ${s.key}`, `note: ${q(s.note)}`]);
  group("retired", facts.settings.retired, (s) => [`key: ${s.key}`, `replaced_by: ${q(s.replaced_by)}`, `note: ${q(s.note)}`]);
  group("defaults_changed", facts.settings.defaults_changed, (s) => [
    `key: ${s.key}`,
    `from: ${q(s.from)}`,
    `to: ${q(s.to)}`,
    `why: ${q(s.why)}`,
  ]);
  if (facts.operator_steps.length === 0) lines.push("operator_steps: []");
  else lines.push("operator_steps:", ...facts.operator_steps.map((s) => `  - ${q(s)}`));
  lines.push("---", "", prose.trim(), "");
  return lines.join("\n");
}

// ---- the folder ---------------------------------------------------------------

/** Where the notes are: beside the code in an image, at the repository's root in a checkout. Null where there are none. */
export function releasesFolder(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, "..", "releases"), join(process.cwd(), "releases")]) {
    if (existsSync(path)) return path;
  }
  return null;
}

const RELEASE_FILE = /^(\d+\.\d+\.\d+)\.md$/;

/**
 * Every release's notes in a folder, oldest first. A file that cannot be
 * read is left out and named in `problems`: one bad file must not hide the
 * rest from a deployment.
 */
export function readReleaseNotes(folder: string | null = releasesFolder()): { notes: ReleaseNotes[]; problems: string[] } {
  if (!folder) return { notes: [], problems: [] };
  const notes: ReleaseNotes[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(folder)) {
    const match = RELEASE_FILE.exec(name);
    if (!match) continue;
    try {
      const parsed = parseReleaseNotes(readFileSync(join(folder, name), "utf8"), `releases/${name}`);
      if (parsed.facts.version !== match[1]) {
        problems.push(`releases/${name} says it is version ${parsed.facts.version}.`);
        continue;
      }
      notes.push(parsed);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  notes.sort((a, b) => compareVersions(a.facts.version, b.facts.version));
  return { notes, problems };
}

// ---- the settings as of the last release ----------------------------------------

export interface SettingSnapshot {
  key: string;
  env: string;
  /** The default as the environment would hold it; null where there is none, and for a secret. */
  default: string | null;
}

export interface SettingsSnapshot {
  /** The release this is the settings of; null before the first one. */
  version: string | null;
  settings: SettingSnapshot[];
}

/** The registry's settings as a snapshot: every one that is read, by name. */
export function snapshotSettings(
  version: string | null,
  defaultOf: (field: string) => string | null,
  rows: readonly Setting[] = SETTINGS
): SettingsSnapshot {
  return {
    version,
    settings: rows
      .filter((row) => !row.retired)
      .map((row) => ({ key: row.key, env: row.env, default: row.field && !row.secret ? defaultOf(row.field) : null }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
}

export interface SettingsDifference {
  added: SettingSnapshot[];
  /** Settings the last release had that are retired now, or gone. */
  retired: SettingSnapshot[];
  defaults_changed: Array<{ key: string; env: string; from: string | null; to: string | null }>;
}

/** What differs between the settings of the last release and the settings now. */
export function settingsDifference(before: SettingsSnapshot, now: SettingsSnapshot): SettingsDifference {
  const was = new Map(before.settings.map((s) => [s.env, s]));
  const is = new Map(now.settings.map((s) => [s.env, s]));
  return {
    added: now.settings.filter((s) => !was.has(s.env)),
    retired: before.settings.filter((s) => !is.has(s.env)),
    defaults_changed: now.settings
      .filter((s) => was.has(s.env) && was.get(s.env)!.default !== s.default)
      .map((s) => ({ key: s.key, env: s.env, from: was.get(s.env)!.default, to: s.default })),
  };
}

/** Whether a name in the notes is this setting: its name in the file or its environment variable. */
const names = (setting: { key: string; env: string }, name: string): boolean => name === setting.key || name === setting.env;

/**
 * What the next release's notes leave unsaid or say wrongly about the
 * settings: each difference between the last release's settings and the
 * registry must have its line, and every setting a line names must be one.
 */
export function unsaidSettingChanges(
  difference: SettingsDifference,
  facts: Pick<ReleaseFacts, "settings">,
  before: SettingsSnapshot
): string[] {
  const problems: string[] = [];
  for (const s of difference.added) {
    if (!facts.settings.added.some((line) => names(s, line.key))) {
      problems.push(`${s.key} (${s.env}) is a new setting, and releases/next.md does not list it under settings.added.`);
    }
  }
  for (const s of difference.retired) {
    if (!facts.settings.retired.some((line) => names(s, line.key))) {
      problems.push(`${s.key} (${s.env}) is no longer read, and releases/next.md does not list it under settings.retired.`);
    }
  }
  for (const s of difference.defaults_changed) {
    const line = facts.settings.defaults_changed.find((l) => names(s, l.key));
    if (!line) {
      problems.push(
        `The default of ${s.key} (${s.env}) changed from ${JSON.stringify(s.from)} to ${JSON.stringify(s.to)}, and releases/next.md does not list it under settings.defaults_changed.`
      );
    } else if (line.from !== (s.from ?? "") || line.to !== (s.to ?? "")) {
      problems.push(
        `releases/next.md says the default of ${s.key} went from ${JSON.stringify(line.from)} to ${JSON.stringify(line.to)}; it went from ${JSON.stringify(s.from ?? "")} to ${JSON.stringify(s.to ?? "")}.`
      );
    }
  }
  // Every key named is a setting: one the registry has, or for a retired one, one the last release had.
  const known = (name: string) => findSetting(name) !== undefined;
  const had = (name: string) => before.settings.some((s) => names(s, name));
  for (const line of facts.settings.added) {
    if (!known(line.key) || findSetting(line.key)?.retired) problems.push(`settings.added names ${line.key}, which is not a setting.`);
  }
  for (const line of facts.settings.defaults_changed) {
    if (!known(line.key)) problems.push(`settings.defaults_changed names ${line.key}, which is not a setting.`);
  }
  for (const line of facts.settings.retired) {
    if (!had(line.key) && !findSetting(line.key)?.retired) {
      problems.push(`settings.retired names ${line.key}, which is not a setting the last release had.`);
    }
  }
  return problems;
}
