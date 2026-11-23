/**
 * The config file: a deployment's settings, written down in one place
 * (docs/deployment.md).
 *
 * A deployment may name one TOML file (MINERVAL_CONFIG, or `minerval.toml`
 * in the working directory when that exists). loadConfig reads it as a layer
 * under the environment: the file sets a value, and an environment variable
 * of the same setting still overrides it, so an operator keeps the override
 * they have today and secrets stay out of the file. With no file nothing
 * here does anything.
 *
 * The layer works the way `.env` does (src/load-env.ts): each setting in the
 * file becomes its environment variable, unless the environment already has
 * one. So there is still one place a value is turned into a setting, which
 * is loadConfig, reading the variables it always read.
 *
 * Every key the file may hold is a row of the registry
 * (src/settings-registry.ts): its name in the file, the environment variable
 * it stands for, and the config field that variable fills. The registry
 * holds names only. What a value may be (which
 * model ids resolve, which modes exist, which numbers are in range) is asked
 * of the config schema itself through the `check` a caller passes
 * (configFieldProblem in src/config.ts), so the schema is written once.
 *
 * There are no named profiles. A file lists the settings a deployment has
 * chosen, one by one, and everything it leaves out keeps its default.
 *
 * Secrets never live in the file. The secret settings are rows too, marked
 * `secret`, so that a file holding one is refused with the name of the
 * environment variable to use instead, and so the writer can never emit one.
 *
 * Two settings are structured, and the file writes them as TOML's own
 * structures and not as JSON inside a text value: the model endpoints a
 * deployment declares are a list of groups ([[model_providers.endpoints]]),
 * and the labels each provider is cleared for are a group of lists
 * ([provider_labels]). Each becomes the JSON its environment variable holds
 * (MODEL_ENDPOINTS, PROVIDER_LABELS), so the schema that reads the variable
 * is still the one place that says what an endpoint or a clearance may be.
 * An endpoint's key is named by its environment variable (key_env), never
 * written, so neither holds a secret.
 *
 * This module imports nothing from the rest of the code but the registry,
 * which imports nothing, so config.ts can load it first.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";

/** The environment variable that names a deployment's config file. */
export const CONFIG_FILE_ENV = "MINERVAL_CONFIG";

/** Read from the working directory when it exists and MINERVAL_CONFIG is not set. */
export const DEFAULT_CONFIG_FILE = "minerval.toml";

import { SETTINGS, editDistance, type Setting, type SettingKind } from "./settings-registry.js";

export type ConfigFileKind = SettingKind;

/** One group of a "groups" setting, by the names its settings have in the file. */
export type ConfigFileGroupValue = Record<string, string | number | boolean>;

export type ConfigFileValue = string | number | boolean | string[] | ConfigFileGroupValue[] | Record<string, string[]>;

/** A file's settings, keyed by the dotted name of each (`run_log.mode`). */
export type ConfigFileSettings = Record<string, ConfigFileValue>;

/** A row of the registry (src/settings-registry.ts), which is where every setting is listed. */
export type ConfigFileKey = Setting;

/**
 * Asks the config schema whether `value`, as the environment would hold it,
 * is acceptable for `field`. Null when it is; otherwise what is wrong with
 * it, as a sentence fragment that follows "which is not accepted:".
 */
export type FieldCheck = (field: string, value: string) => string | null;

/**
 * Every setting a config file may hold, in the order a written file lists
 * them, every secret a file may not hold, and every retired setting a file
 * should no longer hold. It is the registry itself.
 */
export const CONFIG_FILE_KEYS: readonly ConfigFileKey[] = SETTINGS;

/**
 * A connection's credential (docs/connections.md): any number of them, each
 * in an environment variable the connection names, all beginning with this.
 * They are secrets with no row above, since a deployment chooses their
 * names, so a file that holds one is refused by the name's shape.
 */
export const CONNECTION_CREDENTIAL_PREFIX = "CONNECTION_";

/**
 * One line on each group, written above it in a file this code writes, so a
 * file made by a setup page explains itself the way the checked-in example
 * does (deploy/minerval.example.toml).
 */
export const CONFIG_FILE_GROUPS: Readonly<Record<string, string>> = {
  features: "The optional parts of the product this deployment switches off. Everything not named is on.",
  models: "Which model serves each role. A model's provider needs its key in the environment.",
  model_providers: "How the model providers are called. Their keys are secrets and stay in the environment.",
  "model_providers.endpoints":
    "A model server this deployment runs itself. A model id \"endpoint:<name>/<model>\" is served by it. " +
    "key_env names the environment variable that holds its key, if it takes one.",
  "outside_services.elicit": "Elicit, a paid scholarly search the Steward can use. Its key is ELICIT_API_KEY.",
  "outside_services.pangram":
    "Pangram, paid detection of machine-written text and of a text's original source. Its key is PANGRAM_API_KEY.",
  "outside_services.payments":
    "Selling owls through Stripe. Its keys are STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.",
  "outside_services.github_issues":
    "Filing the agents' problem reports as GitHub issues. An empty repo files nothing. " +
    "Its credential is GITHUB_APP_PRIVATE_KEY or GITHUB_TOKEN.",
  provider_labels:
    "The labels each model provider and outside service may be sent text at. Left out, the administrators " +
    "choose this on the labels page; written, it fixes it and overrides their choice. " +
    "One that is not named here is cleared for \"public\" alone.",
  run_log: "How much a run depends on its log, and how long logs of runs that wrote nothing are kept.",
  hosting: "Where this deployment is reached and how the API listens.",
  database: "Where the database is. Its password is DB_PASSWORD.",
  pricing:
    "What an owl costs, whether owls are sold or created here, what is given away, and the most each paid operation can cost.",
  "pricing.model_prices":
    "A price this deployment states for a model, in US dollars per million tokens: for a model the price catalog " +
    "does not know, or in place of the catalog's. Where owls are created, a run on a model with no price is refused.",
  private_runs:
    "Runs that read a private label. fetches is \"any\" (the starting value: a tool takes any address, as on the " +
    "public graph) or \"given\": a tool takes only an address the deployment was given from outside, which guards " +
    "against text a run read telling it to fetch an address with private material written into it. It narrows " +
    "that way out and does not close it, and a run can then not write an address for something it knows of.",
  publishing:
    "Releasing pages outside. hosting says where this deployment runs (own_machines, minerval or third_party) and is " +
    "stated in every package. The signing key is PUBLISH_SIGNING_KEY.",
  public_graph:
    "The public graph as this deployment reaches it: its API, which permission's holders may act there in the " +
    "organization's name, and how the deployment pays toward it (metered or flat). It reaches it over its connection, made on the Overview.",
  usage_report:
    "Where a metered deployment's usage reports go, where not over its connection: another address, or a directory, never both.",
  file_sets: "Where uploaded sets of files are kept, and the directory that directories are registered from.",
  sandbox: "The sandbox agents run commands over file sets in. Its token is SANDBOX_TOKEN.",
  releases: "Whether this deployment learns of new releases from the public graph, and where it reads the list.",
  accounts: "Who this deployment serves, and who sets it up. Read before anyone can sign in.",
  budgets: "What a run of each kind works to. Each is a ceiling: a run returns what it does not spend.",
  allocation: "What the ledger prices and paces work with, and the switches on each kind of funded work.",
  sessions: "How long a run waits on an answer it asked for.",
  limits: "Limits on what no price covers, and the timeouts of calls outside.",
  sql: "Read-only SQL: how long a query may run and what a caller's database time costs.",
  processing: "How documents are read and nodes are made.",
  sweeps: "The schedulers and sweeps: how often each runs and what it takes.",
  researcher: "The researcher, which an administrator or a mandate launches for one bounded investigation.",
  mathematics: "Mathematics: the Lean checker, the solver, bounties and prizes.",
  mirror: "The mirror feed: publishing this deployment's public rows, and following another's.",
  queues: "Where the queues are. Empty, work is queued in the database and in the process.",
  build: "What the image was built from. Set when it is built, never by hand.",
};

const KEYS_BY_NAME = new Map(CONFIG_FILE_KEYS.map((k) => [k.key, k]));

/** The group a setting is in; "" for a setting that is a group of its own at the top of the file. */
function groupOf(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot < 0 ? "" : key.slice(0, dot);
}

/** A setting written as groups of its own, under its own heading, and not as `name = value`. */
function isStructured(key: ConfigFileKey): boolean {
  return key.kind === "groups" || key.kind === "lists";
}

/** Every group and every group that holds one, e.g. "outside_services" for "outside_services.elicit". */
const GROUPS: ReadonlySet<string> = (() => {
  const groups = new Set<string>();
  for (const { key } of CONFIG_FILE_KEYS) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i++) groups.add(parts.slice(0, i).join("."));
  }
  return groups;
})();

/** The settings a file may hold: every row that is not a secret. */
export function settableConfigFileKeys(): ConfigFileKey[] {
  return CONFIG_FILE_KEYS.filter((k) => !k.secret && !k.retired);
}

/** The secrets: settings a file may not hold, each with its environment variable. */
export function secretConfigFileKeys(): ConfigFileKey[] {
  return CONFIG_FILE_KEYS.filter((k) => k.secret && !k.retired);
}

/** A config file that could not be used, with everything wrong with it. */
export class ConfigFileError extends Error {
  readonly path: string | null;
  readonly problems: readonly string[];

  constructor(path: string | null, problems: readonly string[]) {
    const subject = path ? `The config file ${path}` : "These settings";
    super(
      problems.length === 1
        ? `${subject} cannot be used. ${problems[0]}`
        : `${subject} cannot be used, for ${problems.length} reasons:\n` +
            problems.map((p) => `  - ${p}`).join("\n")
    );
    this.name = "ConfigFileError";
    this.path = path;
    this.problems = problems;
  }
}

/** What a value of each kind looks like, for the sentence that says a value is of the wrong kind. */
function expected(key: ConfigFileKey): string {
  switch (key.kind) {
    case "text":
      return 'text in quotes (for example "value")';
    case "number":
      return "a number (for example 30)";
    case "boolean":
      return "true or false";
    case "list":
      return 'a list of text in square brackets (for example ["one", "two"])';
    case "groups":
      return `one or more groups, each headed [[${key.key}]]`;
    case "lists":
      return `a group, headed [${key.key}], of lists of text (for example anthropic = ["public"])`;
  }
}

/** What a value in the file is, in the words an installer would use. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `the text ${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "bigint") return `the number ${value}`;
  if (typeof value === "boolean") return `${value}`;
  if (Array.isArray(value)) return "a list";
  if (value instanceof Date) return "a date";
  if (value && typeof value === "object") return "a group of settings";
  return String(value);
}

function isGroupValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/** The names directly inside a group: its settings and the groups it holds. */
function membersOf(group: string): string[] {
  const prefix = group ? `${group}.` : "";
  const names = new Set<string>();
  for (const { key, secret: isSecret } of CONFIG_FILE_KEYS) {
    if (isSecret || !key.startsWith(prefix)) continue;
    names.add(key.slice(prefix.length).split(".")[0]!);
  }
  return [...names];
}

function unknownKeyProblem(path: string): string {
  const name = path.slice(path.lastIndexOf(".") + 1);
  // A name copied from the environment: say where it goes instead.
  const byEnv = CONFIG_FILE_KEYS.find((k) => k.env === name);
  if (byEnv?.secret) return secretProblem(path, byEnv);
  if (name.toUpperCase().startsWith(CONNECTION_CREDENTIAL_PREFIX)) {
    return (
      `${path} looks like a connection's credential, which is a secret, and secrets are not kept in the config file. ` +
      `Set the environment variable ${name.toUpperCase()} instead.`
    );
  }
  if (byEnv) {
    return `${path} is an environment variable's name, not a setting in the file. In the file it is ${byEnv.key}.`;
  }
  const parent = path.includes(".") ? groupOf(path) : "";
  const members = membersOf(parent);
  const near = CONFIG_FILE_KEYS.filter((k) => !k.secret)
    .map((k) => ({ key: k.key, distance: editDistance(path, k.key) }))
    .concat([...GROUPS].map((g) => ({ key: g, distance: editDistance(path, g) })))
    .filter((c) => c.distance <= 2)
    .sort((a, b) => a.distance - b.distance)[0];
  const hint = near ? ` Did you mean ${near.key}?` : "";
  if (!parent) {
    return `${path} is not a group of settings.${hint} The groups are: ${members.join(", ")}.`;
  }
  return `${path} is not a setting.${hint} [${parent}] holds: ${members.join(", ")}.`;
}

function secretProblem(path: string, key: ConfigFileKey): string {
  if (key.retired) {
    return (
      `${path} is no longer a setting: ${key.env} was retired in ${key.retired.in} and nothing reads it. ` +
      `In its place: ${key.retired.replacedBy}. Remove it.`
    );
  }
  return (
    `${path} is a secret, and secrets are not kept in the config file. ` +
    `Set the environment variable ${key.env} instead.`
  );
}

/** The text a value becomes in the environment, or what is wrong with it for its kind. */
function toEnvironmentText(key: ConfigFileKey, value: unknown): { text: string } | { problem: string } {
  const wrong = { problem: `${key.key} must be ${expected(key)}, but the file has ${describeValue(value)}.` };
  switch (key.kind) {
    case "text":
      return typeof value === "string" ? { text: value } : wrong;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? { text: String(value) } : wrong;
    case "boolean":
      return typeof value === "boolean" ? { text: String(value) } : wrong;
    case "list": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return wrong;
      const withComma = (value as string[]).find((item) => item.includes(","));
      if (withComma !== undefined) {
        return {
          problem: `${key.key} has the item ${JSON.stringify(withComma)}, and an item of this list cannot contain a comma.`,
        };
      }
      return { text: (value as string[]).join(",") };
    }
    case "groups": {
      if (!Array.isArray(value) || value.some((entry) => !isGroupValue(entry))) return wrong;
      const members = key.members ?? {};
      const entries: Array<Record<string, unknown>> = [];
      for (const [i, entry] of (value as Array<Record<string, unknown>>).entries()) {
        const unknown = Object.keys(entry).filter((name) => !Object.hasOwn(members, name));
        if (unknown.length > 0) {
          return {
            problem:
              `${key.key} entry ${i + 1} has ${unknown.map((name) => `"${name}"`).join(", ")}, which ` +
              `${unknown.length === 1 ? "is not a setting" : "are not settings"} of one. ` +
              `Each holds: ${Object.keys(members).join(", ")}.`,
          };
        }
        const structured = Object.entries(entry).find(([, v]) => typeof v === "object" && v !== null);
        if (structured) {
          return {
            problem:
              `${key.key} entry ${i + 1} gives "${structured[0]}" ${describeValue(structured[1])}, ` +
              `and each of its settings is text or a number.`,
          };
        }
        entries.push(Object.fromEntries(Object.entries(entry).map(([name, v]) => [members[name]!, v])));
      }
      return { text: JSON.stringify(entries) };
    }
    case "lists": {
      if (!isGroupValue(value)) return wrong;
      for (const [name, labels] of Object.entries(value)) {
        if (Array.isArray(labels) && labels.some((item) => typeof item === "string" && item.trim().length === 0)) {
          return { problem: `${key.key} gives ${JSON.stringify(name)} a list with an empty name in it.` };
        }
        if (!Array.isArray(labels) || labels.some((item) => typeof item !== "string")) {
          return {
            problem:
              `${key.key} gives ${JSON.stringify(name)} ${describeValue(labels)}, and what each name has is a ` +
              `list of text in square brackets (for example ["public"], or [] for none).`,
          };
        }
      }
      return { text: JSON.stringify(value) };
    }
  }
}

/**
 * A setting's value as the file writes it, from the text its environment
 * variable holds: the inverse of the conversion above, for showing a
 * setting in the app in the same form a person gives it.
 */
export function fromEnvironmentText(key: ConfigFileKey, text: string): ConfigFileValue {
  switch (key.kind) {
    case "text":
      return text;
    case "number":
      return Number(text);
    case "boolean":
      return text.trim() === "true";
    case "list":
      return text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    case "groups": {
      const inFile = Object.fromEntries(Object.entries(key.members ?? {}).map(([file, json]) => [json, file]));
      let entries: unknown;
      try {
        entries = JSON.parse(text || "[]");
      } catch {
        return [];
      }
      if (!Array.isArray(entries)) return [];
      return entries.map((entry) =>
        Object.fromEntries(
          Object.entries(entry as Record<string, string | number | boolean>).map(([name, v]) => [inFile[name] ?? name, v])
        )
      );
    }
    case "lists":
      try {
        return JSON.parse(text || "{}") as Record<string, string[]>;
      } catch {
        return {};
      }
  }
}

/**
 * What the config schema said about a structured setting, in the file's
 * words: the schema speaks of the environment variable and its JSON names,
 * and a reader of the file knows the setting by the names it has there.
 */
function inTheFilesWords(key: ConfigFileKey, said: string): string {
  let text = said.split(key.env).join(key.key);
  for (const [inFile, inJson] of Object.entries(key.members ?? {})) {
    text = text.split(`"${inJson}"`).join(`"${inFile}"`);
  }
  return text;
}

/** Each setting as its environment variable would hold it, and everything wrong with the settings. */
function checkSettings(
  settings: ConfigFileSettings,
  check: FieldCheck
): { env: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(settings)) {
    const key = KEYS_BY_NAME.get(name);
    if (!key) {
      problems.push(unknownKeyProblem(name));
      continue;
    }
    if (key.secret) {
      problems.push(secretProblem(name, key));
      continue;
    }
    const converted = toEnvironmentText(key, value);
    if ("problem" in converted) {
      problems.push(converted.problem);
      continue;
    }
    const refused = key.field ? check(key.field, converted.text) : null;
    if (refused && isStructured(key)) {
      // What is wrong already names the setting and the entry in it. The
      // schema's findings arrive as sentences joined by "; ", one each here.
      problems.push(...inTheFilesWords(key, refused).split(/(?<=\.); /));
      continue;
    }
    if (refused) {
      // A list is not repeated back: what is wrong with it names the item.
      const shown = Array.isArray(value) ? "is not accepted" : `is ${JSON.stringify(value)}, which is not accepted`;
      problems.push(`${name} ${shown}: ${refused}`);
      continue;
    }
    env[key.env] = converted.text;
  }
  return { env, problems };
}

/**
 * Check settings handed over to be applied or written: every key is one the
 * file may hold, no secret is among them, each value is of its kind, and the
 * config schema accepts it. Returns each setting as its environment variable
 * would hold it. Throws ConfigFileError naming everything wrong.
 */
export function settingsToEnvironment(
  settings: ConfigFileSettings,
  check: FieldCheck,
  path: string | null = null
): Record<string, string> {
  const { env, problems } = checkSettings(settings, check);
  if (problems.length > 0) throw new ConfigFileError(path, problems);
  return env;
}

/**
 * A file's text as its settings, checked. Throws ConfigFileError when the
 * text is not TOML, and otherwise with everything wrong in it at once: a
 * group or setting the file does not have, a secret, a value of the wrong
 * kind, a value the config schema does not accept.
 */
export function parseConfigFile(text: string, check: FieldCheck, path: string | null = null): ConfigFileSettings {
  let document: Record<string, unknown>;
  try {
    document = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof TomlError) {
      // The parser's message shows the line and points at the place.
      const said = err.message.replace(/^Invalid TOML document: /, "").trimEnd();
      throw new ConfigFileError(path, [`It is not valid TOML: ${said}`]);
    }
    throw err;
  }
  const problems: string[] = [];
  const settings: ConfigFileSettings = {};
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [name, value] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (KEYS_BY_NAME.has(full)) {
        settings[full] = value as ConfigFileValue;
      } else if (GROUPS.has(full)) {
        if (isGroupValue(value)) walk(value, full);
        else {
          problems.push(
            `${full} is a group of settings, written [${full}], but the file gives it ${describeValue(value)}.`
          );
        }
      } else {
        problems.push(unknownKeyProblem(full));
      }
    }
  };
  walk(document, "");
  problems.push(...checkSettings(settings, check).problems);
  if (problems.length > 0) throw new ConfigFileError(path, problems);
  return settings;
}

/**
 * The file a deployment names, or null when it names none: MINERVAL_CONFIG
 * when set, else `minerval.toml` in the working directory when there is one.
 * A file that MINERVAL_CONFIG names and that is not there is an error, not
 * "no file": the deployment said its settings are in it.
 */
export function configFilePath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const named = env[CONFIG_FILE_ENV]?.trim();
  if (named) {
    const path = resolve(cwd, named);
    if (!existsSync(path)) {
      throw new ConfigFileError(path, [`${CONFIG_FILE_ENV} names it, but there is no file there.`]);
    }
    return path;
  }
  // The unit tests read no `.env`, and for the same reason do not pick up a
  // developer's own minerval.toml: they test the code's defaults.
  if (env.VITEST) return null;
  const conventional = resolve(cwd, DEFAULT_CONFIG_FILE);
  return existsSync(conventional) ? conventional : null;
}

/** Read and check a config file. Throws ConfigFileError with everything wrong with it. */
export function readConfigFile(path: string, check: FieldCheck): ConfigFileSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigFileError(path, [`It could not be read: ${err instanceof Error ? err.message : String(err)}.`]);
  }
  return parseConfigFile(text, check, path);
}

export interface AppliedConfigFile {
  /** The file that was read. */
  path: string;
  /** The settings it holds, by their names in the file. */
  settings: string[];
  /** The settings among them that an environment variable overrides. */
  overridden: Array<{ key: string; env: string }>;
}

/** The variables the last application put in the environment, so a second one can tell them from the operator's. */
let placed = new Map<string, string>();
let applied: AppliedConfigFile | null = null;

/**
 * Read the deployment's config file, if it names one, into the environment:
 * each setting becomes its environment variable unless the environment
 * already has that variable, which then stands. Returns what was read, or
 * null with no file, in which case the environment is not touched.
 */
export function applyConfigFile(check: FieldCheck, env: NodeJS.ProcessEnv = process.env): AppliedConfigFile | null {
  // What an earlier load put there is not the operator's override.
  for (const [name, value] of placed) {
    if (env[name] === value) delete env[name];
  }
  placed = new Map();
  applied = null;

  const path = configFilePath(env);
  if (!path) return null;
  const settings = readConfigFile(path, check);
  const fromFile = settingsToEnvironment(settings, check, path);
  const overridden: AppliedConfigFile["overridden"] = [];
  for (const name of Object.keys(settings)) {
    const key = KEYS_BY_NAME.get(name)!;
    if (env[key.env] !== undefined) {
      overridden.push({ key: name, env: key.env });
      continue;
    }
    env[key.env] = fromFile[key.env]!;
    placed.set(key.env, fromFile[key.env]!);
  }
  applied = { path, settings: Object.keys(settings), overridden };
  return applied;
}

/** Whether the config file, as last applied, is what set this environment variable. */
export function setByConfigFile(env: string): boolean {
  return placed.has(env);
}

/** What the last load read from the deployment's config file; null when it named none. */
export function appliedConfigFile(): AppliedConfigFile | null {
  return applied;
}

function tomlText(value: string): string {
  // A TOML basic string takes JSON's escapes; DEL is the one control
  // character JSON leaves bare and TOML does not allow.
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

function tomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === "string") return tomlText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const items = value.map(tomlText);
  const inline = `[${items.join(", ")}]`;
  return inline.length <= 72 ? inline : `[\n${items.map((item) => `  ${item},`).join("\n")}\n]`;
}

/** A name on the left of `=`: bare where TOML allows it, in quotes otherwise ("endpoint:local"). */
function tomlName(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlText(name);
}

/** A structured setting as the lines of its own groups. */
function structuredLines(key: ConfigFileKey, value: ConfigFileValue): string[] {
  const lines = [""];
  const about = CONFIG_FILE_GROUPS[key.key];
  if (about) lines.push(`# ${about}`);
  if (key.kind === "lists") {
    lines.push(`[${key.key}]`);
    for (const [name, labels] of Object.entries(value as Record<string, string[]>)) {
      lines.push(`${tomlName(name)} = ${tomlValue(labels)}`);
    }
    return lines;
  }
  const entries = value as ConfigFileGroupValue[];
  entries.forEach((entry, i) => {
    if (i > 0) lines.push("");
    lines.push(`[[${key.key}]]`);
    for (const name of Object.keys(key.members ?? {})) {
      if (entry[name] !== undefined) lines.push(`${name} = ${tomlValue(entry[name]!)}`);
    }
  });
  return lines;
}

/**
 * Settings as the text of a config file: the groups in the table's order,
 * each under a line saying what it is. The settings are checked first, so
 * what is written can be read back, and a secret can never be written.
 * Throws ConfigFileError when a setting is not acceptable.
 */
export function renderConfigFile(settings: ConfigFileSettings, check: FieldCheck): string {
  settingsToEnvironment(settings, check);
  const lines: string[] = [
    "# Minerval: this deployment's settings (docs/deployment.md).",
    "# A setting left out keeps its default. An environment variable of the same",
    "# setting overrides the file. Secrets are never written here.",
  ];
  let group: string | null = null;
  for (const key of settableConfigFileKeys()) {
    const value = settings[key.key];
    if (value === undefined) continue;
    // A list of groups with none in it has no heading to be written under,
    // so it is written as the empty list it is, among the plain settings.
    const empty = key.kind === "groups" && (value as unknown[]).length === 0;
    if (isStructured(key) && !empty) {
      lines.push(...structuredLines(key, value));
      // Its heading ended the group above, so a plain setting after it opens its group again.
      group = null;
      continue;
    }
    if (groupOf(key.key) !== group) {
      group = groupOf(key.key);
      lines.push("");
      const about = CONFIG_FILE_GROUPS[group];
      if (about) lines.push(`# ${about}`);
      lines.push(`[${group}]`);
    }
    lines.push(`${key.key.slice(group.length + 1)} = ${empty ? "[]" : tomlValue(value as string[])}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Write settings to a config file, whole: the file is replaced by one that
 * holds exactly these settings. Written beside the file and moved over it,
 * so a reader never sees half a file.
 */
export function writeConfigFile(path: string, settings: ConfigFileSettings, check: FieldCheck): void {
  const text = renderConfigFile(settings, check);
  const partial = `${path}.writing`;
  writeFileSync(partial, text, "utf8");
  renameSync(partial, path);
}
