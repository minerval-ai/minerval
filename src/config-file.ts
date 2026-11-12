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
 * Every key the file may hold is a row of CONFIG_FILE_KEYS below: its name
 * in the file, the environment variable it stands for, and the config field
 * that variable fills. The table holds names only. What a value may be (which
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
 * This module imports nothing from the rest of the code, so config.ts can
 * load it first.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";

/** The environment variable that names a deployment's config file. */
export const CONFIG_FILE_ENV = "MINERVAL_CONFIG";

/** Read from the working directory when it exists and MINERVAL_CONFIG is not set. */
export const DEFAULT_CONFIG_FILE = "minerval.toml";

/**
 * What a value is in the file. The environment holds only text, so each kind
 * has one way of being written there: a number in digits, a boolean as
 * "true" or "false", a list as its items joined by commas. The two
 * structured kinds are written there as JSON: "groups" is a list of groups
 * that each hold the same few settings (a JSON list of objects), and "lists"
 * is one group whose names the deployment chooses, each with a list of text
 * (a JSON object of lists).
 */
export type ConfigFileKind = "text" | "number" | "boolean" | "list" | "groups" | "lists";

/** One group of a "groups" setting, by the names its settings have in the file. */
export type ConfigFileGroupValue = Record<string, string | number | boolean>;

export type ConfigFileValue = string | number | boolean | string[] | ConfigFileGroupValue[] | Record<string, string[]>;

/** A file's settings, keyed by the dotted name of each (`run_log.mode`). */
export type ConfigFileSettings = Record<string, ConfigFileValue>;

export interface ConfigFileKey {
  /** The setting's name in the file: its group, a dot, its name in the group. */
  key: string;
  /** The environment variable the setting stands for. */
  env: string;
  kind: ConfigFileKind;
  /**
   * The field of the config schema (src/config.ts) the variable fills.
   * Absent only on secrets, which the file never carries.
   */
  field?: string;
  /** A secret: refused in a file and never written to one. */
  secret?: true;
  /**
   * For "groups": the settings each group holds, in the order they are
   * written, from the name in the file to the name in the variable's JSON.
   */
  members?: Readonly<Record<string, string>>;
}

/**
 * Asks the config schema whether `value`, as the environment would hold it,
 * is acceptable for `field`. Null when it is; otherwise what is wrong with
 * it, as a sentence fragment that follows "which is not accepted:".
 */
export type FieldCheck = (field: string, value: string) => string | null;

const model = (name: string, env: string, field: string): ConfigFileKey => ({
  key: `models.${name}`,
  env,
  kind: "text",
  field,
});

const secret = (key: string, env: string): ConfigFileKey => ({ key, env, kind: "text", secret: true });

/**
 * Every setting a config file may hold, in the order a written file lists
 * them, and every secret a file may not hold. Not every setting the code has
 * is here: the rest are tuning that a deployment rarely decides, and they
 * stay environment variables (docs/deployment.md lists which, and why).
 */
export const CONFIG_FILE_KEYS: readonly ConfigFileKey[] = [
  { key: "features.off", env: "FEATURES_OFF", kind: "list", field: "featuresOff" },

  // Which model serves which role. The roles are the config schema's.
  model("steward", "STEWARD_MODEL", "stewardModel"),
  model("steward_strong", "STEWARD_STRONG_MODEL", "stewardStrongModel"),
  model("curator", "CURATOR_MODEL", "curatorModel"),
  model("extractor", "EXTRACTOR_MODEL", "extractorModel"),
  model("extractor_fallback", "EXTRACTOR_FALLBACK_MODEL", "extractorFallbackModel"),
  model("matcher", "MATCHER_MODEL", "matcherModel"),
  model("tagger", "TAGGER_MODEL", "taggerModel"),
  model("contribution_reviewer", "GOVERNANCE_MODEL", "governanceModel"),
  model("audit", "AUDIT_MODEL", "auditModel"),
  model("arbitration", "ARBITRATION_MODEL", "arbitrationModel"),
  model("grantmaker", "GRANTMAKER_MODEL", "grantmakerModel"),
  model("program_officer", "PROGRAM_OFFICER_MODEL", "programOfficerModel"),
  model("lookout", "LOOKOUT_MODEL", "lookoutModel"),
  model("correspondent", "CORRESPONDENT_MODEL", "correspondentModel"),
  model("consistency", "CONSISTENCY_MODEL", "consistencyModel"),
  model("consistency_strong", "CONSISTENCY_STRONG_MODEL", "consistencyStrongModel"),
  model("assistant", "ASSISTANT_MODEL", "assistantModel"),
  model("assistant_standard", "ASSISTANT_STANDARD_MODEL", "assistantStandardModel"),
  model("assistant_title", "ASSISTANT_TITLE_MODEL", "assistantTitleModel"),
  model("extension", "EXTENSION_MODEL", "extensionModel"),
  model("researcher_strong", "RESEARCHER_STRONG_MODEL", "researcherStrongModel"),
  model("researcher_standard", "RESEARCHER_STANDARD_MODEL", "researcherStandardModel"),
  model("researcher_cheap", "RESEARCHER_CHEAP_MODEL", "researcherCheapModel"),
  model("solver", "SOLVER_MODEL", "solverModel"),
  model("judge", "JUDGE_MODEL", "judgeModel"),

  {
    key: "model_providers.openrouter_provider_sort",
    env: "OPENROUTER_PROVIDER_SORT",
    kind: "text",
    field: "openrouterProviderSort",
  },
  secret("model_providers.anthropic_api_key", "ANTHROPIC_API_KEY"),
  secret("model_providers.openai_api_key", "OPENAI_API_KEY"),
  secret("model_providers.openrouter_api_key", "OPENROUTER_API_KEY"),
  // The deployment's own model endpoints (src/llm/providers/endpoint-config.ts).
  // Written last in its group: a [[...]] heading ends the plain settings above it.
  {
    key: "model_providers.endpoints",
    env: "MODEL_ENDPOINTS",
    kind: "groups",
    field: "modelEndpoints",
    members: {
      name: "name",
      base_url: "baseUrl",
      key_env: "keyEnv",
      input_usd_per_mtok: "inputUsdPerMtok",
      output_usd_per_mtok: "outputUsdPerMtok",
    },
  },

  { key: "outside_services.elicit.use", env: "ELICIT_ENABLED", kind: "boolean", field: "elicitEnabled" },
  { key: "outside_services.elicit.url", env: "ELICIT_MCP_URL", kind: "text", field: "elicitMcpUrl" },
  {
    key: "outside_services.elicit.usd_per_call",
    env: "ELICIT_USD_PER_CALL",
    kind: "number",
    field: "elicitUsdPerCall",
  },
  secret("outside_services.elicit.api_key", "ELICIT_API_KEY"),

  { key: "outside_services.pangram.use", env: "PANGRAM_ENABLED", kind: "boolean", field: "pangramEnabled" },
  { key: "outside_services.pangram.url", env: "PANGRAM_API_URL", kind: "text", field: "pangramApiUrl" },
  {
    key: "outside_services.pangram.plagiarism_url",
    env: "PANGRAM_PLAGIARISM_API_URL",
    kind: "text",
    field: "pangramPlagiarismApiUrl",
  },
  { key: "outside_services.pangram.model", env: "PANGRAM_MODEL", kind: "text", field: "pangramModel" },
  {
    key: "outside_services.pangram.ai_usd_per_word",
    env: "PANGRAM_AI_USD_PER_WORD",
    kind: "number",
    field: "pangramAiUsdPerWord",
  },
  {
    key: "outside_services.pangram.plagiarism_usd_per_word",
    env: "PANGRAM_PLAGIARISM_USD_PER_WORD",
    kind: "number",
    field: "pangramPlagiarismUsdPerWord",
  },
  { key: "outside_services.pangram.max_words", env: "PANGRAM_MAX_WORDS", kind: "number", field: "pangramMaxWords" },
  secret("outside_services.pangram.api_key", "PANGRAM_API_KEY"),

  { key: "outside_services.payments.use", env: "PAYMENTS_ENABLED", kind: "boolean", field: "paymentsEnabled" },
  secret("outside_services.payments.stripe_secret_key", "STRIPE_SECRET_KEY"),
  secret("outside_services.payments.stripe_webhook_secret", "STRIPE_WEBHOOK_SECRET"),

  { key: "outside_services.github_issues.repo", env: "GITHUB_ISSUES_REPO", kind: "text", field: "githubIssuesRepo" },
  { key: "outside_services.github_issues.label", env: "GITHUB_ISSUES_LABEL", kind: "text", field: "githubIssuesLabel" },
  {
    key: "outside_services.github_issues.include_external_reports",
    env: "GITHUB_ISSUES_INCLUDE_EXTERNAL",
    kind: "boolean",
    field: "githubIssuesIncludeExternal",
  },
  {
    key: "outside_services.github_issues.api_base_url",
    env: "GITHUB_API_BASE_URL",
    kind: "text",
    field: "githubApiBaseUrl",
  },
  { key: "outside_services.github_issues.app_id", env: "GITHUB_APP_ID", kind: "text", field: "githubAppId" },
  {
    key: "outside_services.github_issues.app_installation_id",
    env: "GITHUB_APP_INSTALLATION_ID",
    kind: "text",
    field: "githubAppInstallationId",
  },
  secret("outside_services.github_issues.token", "GITHUB_TOKEN"),
  secret("outside_services.github_issues.app_private_key", "GITHUB_APP_PRIVATE_KEY"),

  // Which labels each model provider and outside service may be sent text at
  // (src/provider-labels.ts). A group of its own: it speaks of both.
  { key: "provider_labels", env: "PROVIDER_LABELS", kind: "lists", field: "providerLabels" },

  { key: "run_log.mode", env: "RUN_LOG_MODE", kind: "text", field: "runLogMode" },
  { key: "run_log.level", env: "TRACE_LEVEL", kind: "text", field: "traceLevel" },
  { key: "run_log.retention_days", env: "TRACE_RETENTION_DAYS", kind: "number", field: "traceRetentionDays" },

  { key: "hosting.environment", env: "ENVIRONMENT", kind: "text", field: "env" },
  { key: "hosting.web_base_url", env: "PUBLIC_WEB_BASE_URL", kind: "text", field: "publicWebBaseUrl" },
  { key: "hosting.api_base_url", env: "PUBLIC_API_BASE_URL", kind: "text", field: "publicApiBaseUrl" },
  { key: "hosting.citation_url_base", env: "CITATION_URL_BASE", kind: "text", field: "citationUrlBase" },
  { key: "hosting.cors_origins", env: "CORS_ORIGINS", kind: "list", field: "corsOrigins" },
  { key: "hosting.host", env: "HOST", kind: "text", field: "host" },
  { key: "hosting.port", env: "PORT", kind: "number", field: "port" },
  { key: "hosting.log_level", env: "LOG_LEVEL", kind: "text", field: "logLevel" },
  {
    key: "hosting.anonymous_rate_limit_per_minute",
    env: "ANONYMOUS_RATE_LIMIT_PER_MINUTE",
    kind: "number",
    field: "anonymousRateLimitPerMinute",
  },
  secret("hosting.api_keys", "API_KEYS"),
  secret("hosting.operator_key", "MINERVAL_OPERATOR_KEY"),

  { key: "database.host", env: "DB_HOST", kind: "text", field: "dbHost" },
  { key: "database.port", env: "DB_PORT", kind: "number", field: "dbPort" },
  { key: "database.name", env: "DB_NAME", kind: "text", field: "dbName" },
  { key: "database.user", env: "DB_USERNAME", kind: "text", field: "dbUser" },
  secret("database.password", "DB_PASSWORD"),
  // A connection string carries its password.
  secret("database.url", "DATABASE_URL"),
  secret("database.sql_agent_url", "SQL_AGENT_DATABASE_URL"),
  secret("database.sql_caller_url", "SQL_CALLER_DATABASE_URL"),
  secret("database.sql_agent_password", "SQL_AGENT_DB_PASSWORD"),
  secret("database.sql_caller_password", "SQL_CALLER_DB_PASSWORD"),

  { key: "pricing.owl_price_micro_usd", env: "OWL_PRICE_MICRO_USD", kind: "number", field: "owlPriceMicroUsd" },
  { key: "pricing.owl_cost_micro_usd", env: "OWL_COST_MICRO_USD", kind: "number", field: "owlCostMicroUsd" },
  { key: "pricing.owl_packs", env: "OWL_PACKS", kind: "list", field: "owlPacks" },
  { key: "pricing.signup_grant_owls", env: "SIGNUP_GRANT_OWLS", kind: "number", field: "signupGrantOwls" },
  { key: "pricing.monthly_grant_owls", env: "MONTHLY_GRANT_OWLS", kind: "number", field: "monthlyGrantOwls" },
  {
    key: "pricing.cap_claim_proposal_owls",
    env: "CAP_CLAIM_PROPOSAL_OWLS",
    kind: "number",
    field: "capClaimProposalOwls",
  },
  { key: "pricing.cap_assessment_owls", env: "CAP_ASSESSMENT_OWLS", kind: "number", field: "capAssessmentOwls" },
  {
    key: "pricing.cap_source_ingest_owls",
    env: "CAP_SOURCE_INGEST_OWLS",
    kind: "number",
    field: "capSourceIngestOwls",
  },
  {
    key: "pricing.cap_extension_analysis_owls",
    env: "CAP_EXTENSION_ANALYSIS_OWLS",
    kind: "number",
    field: "capExtensionAnalysisOwls",
  },
  {
    key: "pricing.cap_extension_chat_owls",
    env: "CAP_EXTENSION_CHAT_OWLS",
    kind: "number",
    field: "capExtensionChatOwls",
  },
  {
    key: "pricing.cap_text_analysis_owls",
    env: "CAP_TEXT_ANALYSIS_OWLS",
    kind: "number",
    field: "capTextAnalysisOwls",
  },
];

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
    "The labels each model provider and outside service may be sent text at. " +
    "One that is not named here is cleared for \"public\" alone.",
  run_log: "How much a run depends on its log, and how long logs of runs that wrote nothing are kept.",
  hosting: "Where this deployment is reached and how the API listens.",
  database: "Where the database is. Its password is DB_PASSWORD.",
  pricing: "What an owl costs, what is given away, and the most each paid operation can cost.",
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
  return CONFIG_FILE_KEYS.filter((k) => !k.secret);
}

/** The secrets: settings a file may not hold, each with its environment variable. */
export function secretConfigFileKeys(): ConfigFileKey[] {
  return CONFIG_FILE_KEYS.filter((k) => k.secret);
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

/** How many single-character edits turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
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
