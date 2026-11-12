/**
 * Preflight: whether this deployment is ready to run (docs/deployment.md).
 *
 * One function, runPreflight, runs a list of named checks. Each answers
 * pass, fail or not applicable, with one sentence for whoever is installing.
 * It is read three ways: `npm run preflight` (scripts/preflight.ts), the
 * operator's route GET /setup/preflight (routes/preflight.ts), and the gate
 * on agent work (agentWorkGate below, held by workers/agent-work-gate.ts).
 *
 * A few checks are marked blocking. A blocking check that fails stops agent
 * work from starting, but only in a deployment that holds private material:
 * a mistake there (a run with no log, a report filed outside) cannot be
 * taken back. On a deployment that holds only public material every check is
 * information, nothing is refused, and the gate asks one question and opens.
 *
 * "Holds private material" has one definition for now: the deployment has
 * defined a label other than `public` (publicIsTheOnlyLabel,
 * services/label-service.ts). Reads are not yet held to labels, so there is
 * nothing finer to ask. A deployment that defines its second label has said
 * it means to hold something that is not for everyone.
 *
 * The checks are plain functions of the facts gathered first
 * (PreflightFacts), so each can be tested with its facts made up, and the
 * gathering (the database, the run log's test) is tested against a real
 * database. No check calls a model provider or any outside service: a key
 * being present is what is checked, not whether it works.
 *
 * Four checks are about which providers may be sent private text
 * (src/provider-labels.ts). One blocks: a label that provider_labels names
 * and nobody has defined refuses every call at every label, so holding the
 * work back loses nothing. A role whose model's provider is not cleared for
 * a label fails without blocking: its runs there are refused before anything
 * is sent, and the gate is one gate for the whole deployment, so closing it
 * would stop the work at the labels that are served as well. Embeddings and
 * the outside services pass either way and say what a label goes without:
 * leaving one uncleared sends nothing out, and which outside party may read
 * private text is the deployment's to choose, not a state to be corrected.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { appliedConfigFile, CONFIG_FILE_KEYS, type AppliedConfigFile } from "./config-file.js";
import { rawQuery } from "./db/client.js";
import { featureOn, offFeatures, type FeatureName } from "./features.js";
import { PUBLIC_LABEL } from "./labels.js";
import { ENDPOINT_ID_PREFIX, parseEndpointModelId, resolveProvider } from "./llm/providers/routing.js";
import { anthropicServerWebSearch } from "./llm/tools/web-search-tool.js";
import { providerClearedFor, type OutsideServiceName } from "./provider-labels.js";
import { labelsBesidesPublic, publicIsTheOnlyLabel } from "./services/label-service.js";
import { verifyRunLog } from "./services/run-view-service.js";
import { openAgentRun, recordAgentStep, sealAgentRun } from "./services/trace-service.js";

export type PreflightStatus = "pass" | "fail" | "not_applicable";

export interface PreflightCheckResult {
  name: string;
  status: PreflightStatus;
  /**
   * Whether a fail here stops agent work: the check is marked blocking and
   * the deployment holds private material (or that could not be told).
   * Always false on a deployment that holds only public material.
   */
  blocking: boolean;
  /** One sentence for whoever is installing. */
  message: string;
}

export interface PreflightReport {
  /** Whether a label other than `public` is defined; null when the labels could not be read. */
  holds_private_material: boolean | null;
  /** No check failed. */
  ready: boolean;
  /** Whether agent work may start: "refused" when a blocking check failed. */
  agent_work: "allowed" | "refused";
  checks: PreflightCheckResult[];
}

/** A migration in the folder beside the code: its name and the journal's date for it. */
export interface FolderMigration {
  tag: string;
  when: number;
}

export type DatabaseFacts =
  | { reachable: false; error: string }
  | {
      reachable: true;
      pgvector: boolean;
      /** The folder's journal in order; null when no migrations folder was found. */
      folder: FolderMigration[] | null;
      /** The dates of the migrations the database has applied, as the migrator recorded them. */
      applied: number[];
    };

export type RunLogSelfTest = { ok: true; steps: number } | { ok: false; reason: string };

/** Everything the checks look at, gathered once. */
export interface PreflightFacts {
  config: Config;
  /** What loadConfig read from the deployment's config file; null when it named none. */
  configFile: AppliedConfigFile | null;
  /** Whether a label other than `public` is defined; null when that could not be read. */
  holdsPrivate: boolean | null;
  /** The labels defined besides `public`, by name; null when the labels could not be read. */
  privateLabels: string[] | null;
  /**
   * The environment variables that declared model endpoints read their keys
   * from (keyEnv) and that are not set.
   */
  endpointKeysMissing: string[];
  database: DatabaseFacts;
  runLog: RunLogSelfTest;
}

type Outcome = { status: PreflightStatus; message: string };

export interface PreflightCheck {
  name: string;
  /** A fail stops agent work where the deployment holds private material. */
  blocking: boolean;
  run: (facts: PreflightFacts) => Outcome;
}

const pass = (message: string): Outcome => ({ status: "pass", message });
const fail = (message: string): Outcome => ({ status: "fail", message });
const notApplicable = (message: string): Outcome => ({ status: "not_applicable", message });

/** What a check that turns on it says when the labels could not be read. */
const PRIVATE_UNKNOWN =
  "This could not be checked: the labels could not be read, so it is not known whether " +
  "this deployment holds private material.";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** `the label "internal"`, `the labels "internal" and "restricted"`. */
function theLabels(labels: readonly string[]): string {
  return `the ${labels.length === 1 ? "label" : "labels"} ${listed(labels.map((l) => `"${l}"`))}`;
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// ---------------------------------------------------------------------------
// The config file
// ---------------------------------------------------------------------------

function checkConfigFile({ configFile }: PreflightFacts): Outcome {
  if (!configFile) {
    return notApplicable("No config file is named, so every setting comes from the environment or its default.");
  }
  const read = `${plural(configFile.settings.length, "setting")} ${
    configFile.settings.length === 1 ? "was" : "were"
  } read from ${configFile.path}`;
  if (configFile.overridden.length === 0) return pass(`${read}.`);
  return pass(
    `${read}; the environment overrides ${configFile.overridden.length} of them: ` +
      `${configFile.overridden.map((o) => `${o.key} (${o.env})`).join(", ")}.`
  );
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

function checkDatabase({ database }: PreflightFacts): Outcome {
  if (!database.reachable) return fail(`The database cannot be reached: ${database.error}.`);
  if (!database.pgvector) {
    return fail(
      "The database is reachable but does not have the pgvector extension; run CREATE EXTENSION vector in it."
    );
  }
  const { folder, applied } = database;
  if (!folder) {
    return fail(
      "The migrations folder was not found beside the code, so it cannot be told whether the database is current."
    );
  }
  const have = new Set(applied);
  const waiting = folder.filter((m) => !have.has(m.when));
  if (waiting.length === 0) {
    const known = new Set(folder.map((m) => m.when));
    const unknown = applied.filter((when) => !known.has(when)).length;
    if (unknown > 0) {
      return fail(
        `The database has ${plural(unknown, "migration")} applied that this code does not have, ` +
          "so it was migrated by newer code than is running."
      );
    }
    return pass(`The database is reachable, has pgvector, and has all ${folder.length} migrations applied.`);
  }
  if (applied.length === 0) {
    return fail(`No migration has been applied to the database; ${waiting.length} are waiting.`);
  }
  // The migrator runs only what is dated after the newest it has run
  // (scripts/migrations-lib.ts), so an older one that is still waiting
  // would be passed over without an error.
  const newest = Math.max(...applied);
  const passedOver = waiting.filter((m) => m.when <= newest);
  if (passedOver.length > 0) {
    return fail(
      `${plural(passedOver.length, "migration has", "migrations have")} not been applied and will not be, ` +
        "because a later one already has and the migrator passes over any dated before the newest it has run " +
        `(the first is ${passedOver[0]!.tag}).`
    );
  }
  return fail(
    `The database is behind the code: ${waiting.length} of ${folder.length} migrations have not been applied ` +
      `(the first is ${waiting[0]!.tag}).`
  );
}

// ---------------------------------------------------------------------------
// The run log
// ---------------------------------------------------------------------------

function checkRunLog({ config, holdsPrivate, runLog }: PreflightFacts): Outcome {
  const record = config.runLogMode === "record";
  if (!runLog.ok) return fail(`A test run could not be logged: ${runLog.reason}.`);
  if (!record && holdsPrivate === null) return fail(PRIVATE_UNKNOWN);
  if (!record && holdsPrivate) {
    return fail(
      "The run log is in best-effort mode, where a run carries on when a step cannot be written; " +
        'a deployment that holds private material keeps its log in record mode (run_log.mode = "record").'
    );
  }
  return pass(
    `A test run of ${runLog.steps} steps was written to the run log, sealed, checked against its seal and removed; ` +
      `the log is in ${record ? "record" : "best-effort"} mode.`
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * What each provider needs before a model on it can be called. A provider
 * that is not here is reported, not passed: this check cannot vouch for
 * what it does not know how to ask about.
 */
const PROVIDER_NEEDS: Record<string, { name: string; env: string; present: (config: Config) => boolean }> = {
  anthropic: { name: "Anthropic", env: "ANTHROPIC_API_KEY", present: (c) => c.anthropicApiKey.length > 0 },
  openai: { name: "OpenAI", env: "OPENAI_API_KEY", present: (c) => c.openaiApiKey.length > 0 },
  openrouter: { name: "OpenRouter", env: "OPENROUTER_API_KEY", present: (c) => c.openrouterApiKey.length > 0 },
};

/** Roles whose model is never called while a feature is off. */
const ROLE_FEATURE: Readonly<Record<string, FeatureName>> = {
  extension: "extension",
  solver: "mathematics",
};

interface RoleModel {
  /** The role's name in the config file's [models] group. */
  role: string;
  field: string;
  model: string;
}

/** Every role the configuration names a model for, less the roles of features that are off. */
function roleModels(config: Config): RoleModel[] {
  const roles: RoleModel[] = [];
  for (const key of CONFIG_FILE_KEYS) {
    if (!key.key.startsWith("models.") || !key.field) continue;
    const role = key.key.slice("models.".length);
    const feature = ROLE_FEATURE[role];
    if (feature && !featureOn(feature, config)) continue;
    const model = String((config as unknown as Record<string, unknown>)[key.field] ?? "").trim();
    // An empty model is a role that is not in use (the Steward's strong tier with tiering off).
    if (model) roles.push({ role, field: key.field, model });
  }
  return roles;
}

/** A provider as a sentence names it: a hosted API by its name, an endpoint by the name it was declared under. */
function providerName(provider: string): string {
  if (provider.startsWith(ENDPOINT_ID_PREFIX)) return `the endpoint "${provider.slice(ENDPOINT_ID_PREFIX.length)}"`;
  return PROVIDER_NEEDS[provider]?.name ?? provider;
}

function checkModels({ config, endpointKeysMissing }: PreflightFacts): Outcome {
  const roles = roleModels(config);
  const endpoints = config.modelEndpoints ?? [];
  const unserved: string[] = [];
  const missing = new Map<string, string[]>();
  const used = new Set<string>();
  // A model on an endpoint the deployment runs itself: the endpoint must be
  // declared, and its key present if it was declared with one.
  const undeclared = new Map<string, string[]>();
  const keyMissing = new Map<string, { env: string; roles: string[] }>();
  const endpointsReady = new Map<string, string>();
  for (const { role, model } of roles) {
    const onEndpoint = parseEndpointModelId(model);
    if (onEndpoint) {
      const name = onEndpoint.endpoint;
      const endpoint = endpoints.find((e) => e.name === name);
      if (!endpoint) {
        undeclared.set(name, [...(undeclared.get(name) ?? []), role]);
      } else if (endpoint.keyEnv && endpointKeysMissing.includes(endpoint.keyEnv)) {
        keyMissing.set(name, { env: endpoint.keyEnv, roles: [...(keyMissing.get(name)?.roles ?? []), role] });
      } else {
        endpointsReady.set(
          name,
          endpoint.keyEnv
            ? `the endpoint "${name}" is declared and its key (${endpoint.keyEnv}) is set`
            : `the endpoint "${name}" is declared and takes no key`
        );
      }
      continue;
    }
    const provider = resolveProvider(model);
    const needs = provider ? PROVIDER_NEEDS[provider] : undefined;
    if (!provider || !needs) {
      unserved.push(`${role} ("${model}")`);
      continue;
    }
    used.add(needs.name);
    if (!needs.present(config)) missing.set(provider, [...(missing.get(provider) ?? []), role]);
  }
  const problems: string[] = [];
  if (unserved.length > 0) {
    problems.push(`no provider this check knows serves the model named for ${unserved.join(", ")}`);
  }
  for (const [provider, itsRoles] of missing) {
    const needs = PROVIDER_NEEDS[provider]!;
    problems.push(
      `${needs.env} is not set, and ${plural(itsRoles.length, "role runs", "roles run")} on ` +
        `${needs.name} models (${itsRoles.join(", ")})`
    );
  }
  for (const [name, itsRoles] of undeclared) {
    problems.push(
      `the endpoint "${name}" is not declared in model_providers.endpoints, and ` +
        `${plural(itsRoles.length, "role runs", "roles run")} on its models (${itsRoles.join(", ")})`
    );
  }
  for (const [name, { env, roles: itsRoles }] of keyMissing) {
    problems.push(
      `${env} is not set, and ${plural(itsRoles.length, "role runs", "roles run")} on the endpoint "${name}", ` +
        `which reads its key from that variable (${itsRoles.join(", ")})`
    );
  }
  if (problems.length > 0) {
    const said = problems.join("; ");
    return fail(`${said.charAt(0).toUpperCase()}${said.slice(1)}.`);
  }
  const hosted = [...used].sort();
  if (endpointsReady.size === 0) {
    return pass(`Each of the ${roles.length} roles names a model whose provider has its key set (${hosted.join(", ")}).`);
  }
  const has = [
    ...(hosted.length > 0 ? [`${listed(hosted)} ${hosted.length === 1 ? "has its key" : "have their keys"} set`] : []),
    ...[...endpointsReady.keys()].sort().map((name) => endpointsReady.get(name)!),
  ];
  return pass(`Each of the ${roles.length} roles names a model whose provider has what it needs: ${has.join("; ")}.`);
}

// ---------------------------------------------------------------------------
// Which providers may be sent private text (src/provider-labels.ts)
// ---------------------------------------------------------------------------

/** What each of the three checks below says where `public` is the only label. */
function noOtherLabel(what: string): Outcome {
  return notApplicable(
    `This deployment defines no label besides public, so there is no other label for ${what} to be cleared for.`
  );
}

function checkProviderLabels({ config, privateLabels }: PreflightFacts): Outcome {
  const setting = config.providerLabels ?? {};
  if (Object.keys(setting).length === 0) {
    return notApplicable(
      "provider_labels is not set, so every model provider and outside service is cleared for public and for no other label."
    );
  }
  const providersByLabel = new Map<string, string[]>();
  for (const [provider, labels] of Object.entries(setting)) {
    for (const label of labels) {
      if (label === PUBLIC_LABEL) continue;
      providersByLabel.set(label, [...(providersByLabel.get(label) ?? []), provider]);
    }
  }
  const named = [...providersByLabel.keys()].sort();
  if (named.length === 0) return pass("provider_labels names no label besides public, which every deployment has.");
  if (privateLabels === null) {
    return fail(
      "This could not be checked: the labels could not be read, so it is not known whether the labels " +
        "provider_labels names are defined."
    );
  }
  const undefinedHere = named.filter((label) => !privateLabels.includes(label));
  if (undefinedHere.length === 0) {
    return pass(`Every label provider_labels names is defined (${named.map((l) => `"${l}"`).join(", ")}).`);
  }
  const one = undefinedHere.length === 1;
  return fail(
    `provider_labels names ${listed(
      undefinedHere.map((label) => `"${label}" (for ${providersByLabel.get(label)!.join(", ")})`)
    )}, which this deployment does not define as a label, so every model call and every call to an outside ` +
      `service is refused, at every label, until ${one ? "it is defined or the name is" : "they are defined or the names are"} corrected.`
  );
}

function checkModelClearance({ config, privateLabels }: PreflightFacts): Outcome {
  if (privateLabels === null) return fail(PRIVATE_UNKNOWN);
  if (privateLabels.length === 0) return noOtherLabel("a model provider");
  const rolesByProvider = new Map<string, string[]>();
  for (const { role, model } of roleModels(config)) {
    // A model no provider serves is the models check's to report.
    const provider = resolveProvider(model);
    if (provider) rolesByProvider.set(provider, [...(rolesByProvider.get(provider) ?? []), role]);
  }
  const providers = [...rolesByProvider.keys()];
  const problems: string[] = [];
  for (const label of privateLabels) {
    const uncleared = providers.filter((provider) => !providerClearedFor(provider, label, config));
    if (uncleared.length === 0) continue;
    if (uncleared.length === providers.length) {
      problems.push(
        `none of the providers the roles' models are on (${providers.map(providerName).join(", ")}) is cleared for ` +
          `the label "${label}", so every agent run there would be refused before anything is sent`
      );
      continue;
    }
    problems.push(
      `at the label "${label}", ${listed(
        uncleared.map((provider) => `${providerName(provider)} is not cleared (${rolesByProvider.get(provider)!.join(", ")})`)
      )}, so those roles' runs there would be refused before anything is sent`
    );
  }
  if (problems.length === 0) {
    return pass(`The provider of every role's model is cleared for ${theLabels(privateLabels)}.`);
  }
  return fail(
    `${sentence(problems.join("; "))} Clear the provider for the label in provider_labels, or name the role a model ` +
      "on a provider that is cleared. This check does not stop agent work, because that would also stop the work " +
      "at labels that are served, and a refused run sends nothing."
  );
}

function checkEmbeddingsClearance({ config, privateLabels }: PreflightFacts): Outcome {
  if (privateLabels === null) return fail(PRIVATE_UNKNOWN);
  if (privateLabels.length === 0) return noOtherLabel("embeddings");
  const uncleared = privateLabels.filter((label) => !providerClearedFor("embeddings", label, config));
  if (uncleared.length === 0) return pass(`Embeddings are cleared for ${theLabels(privateLabels)}.`);
  return pass(
    `Embeddings are not cleared for ${theLabels(uncleared)}, so what is written there is stored without a vector, ` +
      "and a search there matches on keywords where it can and returns an error where it cannot. This passes " +
      "because nothing is sent out and it may be what the deployment chose; clearing them (embeddings, in " +
      "provider_labels) sends the text of each claim, tag, finding, request and report there, and each search " +
      "query, to OpenAI."
  );
}

// ---------------------------------------------------------------------------
// Outside services: each is configured or off, never half of either
// ---------------------------------------------------------------------------

function checkEmbeddings({ config }: PreflightFacts): Outcome {
  if (config.openaiApiKey.length > 0) {
    return pass("Embeddings are made by OpenAI and OPENAI_API_KEY is set; embeddings have no off switch.");
  }
  return fail(
    "Embeddings are made by OpenAI and OPENAI_API_KEY is not set, so nothing that matches or searches claims " +
      "can run; embeddings have no off switch."
  );
}

/**
 * The roles whose agents are given web_search, by the config field of the
 * model each runs (the callers of createWebSearch in src/llm/agents).
 * tests/unit/preflight.test.ts fails when an agent file gains or loses the
 * tool, so this list is revisited when that changes.
 */
export const WEB_SEARCH_AGENT_MODELS: Readonly<Record<string, readonly string[]>> = {
  "claim-steward.ts": ["stewardModel", "stewardStrongModel"],
  "contribution-reviewer.ts": ["governanceModel"],
  "dispute-arbitrator.ts": ["arbitrationModel"],
  "grantmaker.ts": ["grantmakerModel"],
  "grantor.ts": ["grantmakerModel"],
  "mandate-review.ts": ["grantmakerModel"],
  "lookout.ts": ["lookoutModel"],
  "researcher.ts": ["researcherStrongModel", "researcherStandardModel", "researcherCheapModel"],
};

function checkWebSearch({ config }: PreflightFacts): Outcome {
  const fields = new Set(Object.values(WEB_SEARCH_AGENT_MODELS).flat());
  const searching = roleModels(config).filter((r) => fields.has(r.field));
  // A model Anthropic searches for is searched inside its API; every other
  // model's search goes through OpenRouter (llm/tools/web-search-tool.ts).
  const viaOpenRouter = searching.filter((r) => !anthropicServerWebSearch(r.model)).map((r) => r.role);
  const inside = searching.length - viaOpenRouter.length;
  if (viaOpenRouter.length === 0) {
    return pass(
      `Open-web search runs inside Anthropic's API for all ${searching.length} roles that search; it has no off switch.`
    );
  }
  if (config.openrouterApiKey.length === 0) {
    return fail(
      `Open-web search for ${viaOpenRouter.join(", ")} goes through OpenRouter, and OPENROUTER_API_KEY is not set, ` +
        "so those searches fail; open-web search has no off switch."
    );
  }
  return pass(
    `Open-web search runs inside Anthropic's API for ${plural(inside, "role")} and through OpenRouter for ` +
      `${viaOpenRouter.join(", ")}, and OPENROUTER_API_KEY is set; it has no off switch.`
  );
}

function checkPageReading(): Outcome {
  return notApplicable(
    "Agents read public web pages by fetching them directly, which needs no key; page reading has no off switch."
  );
}

/** A service that is on when its one key is set, with a switch in the config file. */
function keyedService(
  name: string,
  group: string,
  env: string,
  enabled: "true" | "false" | undefined,
  keyPresent: boolean
): Outcome {
  if (enabled === "false") return pass(`${name} is switched off.`);
  if (keyPresent) return pass(`${name} is on and ${env} is set.`);
  if (enabled === "true") {
    return fail(
      `${name} is switched on (${group}.use) but ${env} is not set, so its tools are not offered to any agent.`
    );
  }
  return pass(`${name} is off: ${env} is not set.`);
}

function checkElicit({ config }: PreflightFacts): Outcome {
  return keyedService(
    "Elicit",
    "outside_services.elicit",
    "ELICIT_API_KEY",
    config.elicitEnabled,
    config.elicitApiKey.length > 0
  );
}

function checkPangram({ config }: PreflightFacts): Outcome {
  return keyedService(
    "Pangram",
    "outside_services.pangram",
    "PANGRAM_API_KEY",
    config.pangramEnabled,
    config.pangramApiKey.length > 0
  );
}

/** Whether a service with one key and a switch is on, as keyedService above reads it. */
function keyedServiceOn(enabled: "true" | "false" | undefined, keyPresent: boolean): boolean {
  return enabled !== "false" && keyPresent;
}

/** The roles that search the web, split by where their search runs. */
function searchingRoles(config: Config): { insideAnthropic: RoleModel[]; viaOpenRouter: RoleModel[] } {
  const fields = new Set(Object.values(WEB_SEARCH_AGENT_MODELS).flat());
  const searching = roleModels(config).filter((r) => fields.has(r.field));
  return {
    insideAnthropic: searching.filter((r) => anthropicServerWebSearch(r.model)),
    viaOpenRouter: searching.filter((r) => !anthropicServerWebSearch(r.model)),
  };
}

function checkOutsideServiceClearance({ config, privateLabels }: PreflightFacts): Outcome {
  if (privateLabels === null) return fail(PRIVATE_UNKNOWN);
  if (privateLabels.length === 0) return noOtherLabel("an outside service");
  const { insideAnthropic, viaOpenRouter } = searchingRoles(config);
  // Each service an agent's tools reach, as a sentence names it, and whether
  // this deployment uses it at all. Embeddings have a check of their own.
  const services: Array<{ service: OutsideServiceName; name: string; on: boolean }> = [
    { service: "web_search", name: "open-web search through OpenRouter", on: viaOpenRouter.length > 0 },
    { service: "web_pages", name: "page reading", on: true },
    { service: "elicit", name: "Elicit", on: keyedServiceOn(config.elicitEnabled, config.elicitApiKey.length > 0) },
    { service: "pangram", name: "Pangram", on: keyedServiceOn(config.pangramEnabled, config.pangramApiKey.length > 0) },
  ];
  const inUse = services.filter((s) => s.on);
  const said: string[] = [];
  for (const label of privateLabels) {
    const cleared = inUse.filter((s) => providerClearedFor(s.service, label, config));
    const withheld = inUse.filter((s) => !providerClearedFor(s.service, label, config));
    let text: string;
    if (withheld.length === 0) {
      text = `at the label "${label}", every outside service that is on is cleared (${listed(cleared.map((s) => s.name))})`;
    } else {
      const one = withheld.length === 1;
      text =
        `at the label "${label}", ${listed(withheld.map((s) => s.name))} ${one ? "is" : "are"} not cleared, ` +
        `so runs there are not offered ${one ? "its" : "their"} tools and are told so`;
      if (withheld.some((s) => s.service === "web_pages")) {
        text += ", and a source submitted there by its address is not fetched";
      }
      if (cleared.length > 0) {
        text += `; ${listed(cleared.map((s) => s.name))} ${cleared.length === 1 ? "is" : "are"} cleared`;
      }
    }
    // A search Anthropic runs inside a turn goes where the model's text
    // goes, so leaving web_search uncleared does not stop it.
    if (
      insideAnthropic.length > 0 &&
      !providerClearedFor("web_search", label, config) &&
      providerClearedFor("anthropic", label, config)
    ) {
      text +=
        `; the ${plural(insideAnthropic.length, "role")} whose ${insideAnthropic.length === 1 ? "model" : "models"} ` +
        "Anthropic searches for still search the web there, inside Anthropic's API, which Anthropic's clearance covers";
    }
    said.push(sentence(text));
  }
  const off = services.filter((s) => !s.on).map((s) => s.name);
  if (off.length > 0) {
    said.push(sentence(`${listed(off)} ${off.length === 1 ? "is" : "are"} not in use at any label`));
  }
  said.push(
    "Nothing here fails: a service that is not cleared for a label is sent nothing from it, and which services " +
      "may be sent private text is the deployment's choice (provider_labels)."
  );
  return pass(said.join(" "));
}

function checkPayments({ config }: PreflightFacts): Outcome {
  if (config.paymentsEnabled === "false") return pass("Payments are switched off.");
  const secret = config.stripeSecretKey;
  const webhook = config.stripeWebhookSecret.length > 0;
  // The same test billing uses (stripeConfigured, services/billing-service.ts).
  const isStripeKey = secret.startsWith("sk_") || secret.startsWith("rk_");
  if (isStripeKey && webhook) return pass("Payments are on: both Stripe keys are set.");
  if (isStripeKey) {
    return fail(
      "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not, so a purchase would be paid for and never credited."
    );
  }
  if (secret.length > 0) {
    return fail(
      "STRIPE_SECRET_KEY is set but is not a Stripe key (it starts with neither sk_ nor rk_), so payments are off."
    );
  }
  if (webhook) return fail("STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is not, so payments are off.");
  if (config.paymentsEnabled === "true") {
    return fail("Payments are switched on (outside_services.payments.use) but STRIPE_SECRET_KEY is not set.");
  }
  return pass("Payments are off: no Stripe key is set.");
}

/** "owner/name", as the issue filer requires (services/github-issue-service.ts). */
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

function checkGithubIssues({ config }: PreflightFacts): Outcome {
  const repo = config.githubIssuesRepo.trim();
  if (!repo) return pass("No GitHub issue repository is named, so agents' reports are not filed on GitHub.");
  if (!REPOSITORY.test(repo)) {
    return fail(
      `outside_services.github_issues.repo is "${repo}", which is not an owner/name repository, so nothing is filed.`
    );
  }
  const app = {
    GITHUB_APP_ID: config.githubAppId,
    GITHUB_APP_INSTALLATION_ID: config.githubAppInstallationId,
    GITHUB_APP_PRIVATE_KEY: config.githubAppPrivateKey,
  };
  const absent = Object.entries(app)
    .filter(([, value]) => !value)
    .map(([env]) => env);
  if (absent.length === 0 || config.githubToken) {
    return pass(`Agents' reports are filed as issues in ${repo}.`);
  }
  if (absent.length < 3) {
    return fail(
      `Reports are to be filed in ${repo}, but the GitHub App is partly configured (${absent.join(", ")} ` +
        `${absent.length === 1 ? "is" : "are"} not set) and there is no GITHUB_TOKEN, so nothing is filed.`
    );
  }
  return fail(
    `Reports are to be filed in ${repo}, but no GitHub credential is set (the app's ids with ` +
      "GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN), so nothing is filed."
  );
}

// ---------------------------------------------------------------------------
// What must hold before private material is worked on
// ---------------------------------------------------------------------------

function checkReportsStayInside({ config, holdsPrivate }: PreflightFacts): Outcome {
  const repo = config.githubIssuesRepo.trim();
  if (!repo) {
    return pass("No GitHub issue repository is configured, so agents' reports stay inside this deployment.");
  }
  if (holdsPrivate === null) return fail(PRIVATE_UNKNOWN);
  if (!holdsPrivate) {
    return notApplicable(`This deployment holds only public material, so its agents' reports may be filed in ${repo}.`);
  }
  return fail(
    `This deployment holds private material and its agents' reports are to be filed as GitHub issues in ${repo}; ` +
      'set outside_services.github_issues.repo to "" so the reports stay inside.'
  );
}

/**
 * Work that is never written to the run log, in any mode, because what it
 * handles on the public graph is a reader's own text (#356; docs/run-log.md,
 * "Record mode"). `feature` is the feature that switches the work off, or
 * null where nothing does. tests/unit/preflight.test.ts fails when a file
 * starts or stops calling untraced(), so this list is revisited then.
 */
export const UNLOGGED_WORK: ReadonlyArray<{ file: string; what: string; feature: FeatureName | null }> = [
  { file: "services/extension-service.ts", what: "its page analysis and chat", feature: "extension" },
  { file: "mcp/server.ts", what: "the MCP tools match_claim, extract_claims and assess_text", feature: null },
  { file: "services/assistant-service.ts", what: "the naming of an Assistant conversation", feature: null },
];

function checkFeatures({ config, holdsPrivate }: PreflightFacts): Outcome {
  const off = offFeatures(config);
  const offNow = off.length > 0 ? `Switched off: ${off.join(", ")}.` : "No feature is switched off.";
  const unlogged = UNLOGGED_WORK.filter((w) => w.feature && featureOn(w.feature, config));
  if (unlogged.length === 0) {
    return pass(`${offNow.slice(0, -1)}; no feature that is on does work the run log leaves out.`);
  }
  if (holdsPrivate === null) return fail(PRIVATE_UNKNOWN);
  if (!holdsPrivate) return pass(offNow);
  return fail(
    unlogged
      .map((w) => `The ${w.feature} feature is on, and ${w.what} are never written to the run log`)
      .join("; ") +
      "; switch it off (features.off) while this deployment holds private material."
  );
}

function checkWorkOutsideTheRunLog({ holdsPrivate }: PreflightFacts): Outcome {
  const unswitchable = UNLOGGED_WORK.filter((w) => !w.feature).map((w) => w.what);
  const listed = unswitchable.join(", and ");
  if (holdsPrivate === null) return fail(PRIVATE_UNKNOWN);
  if (!holdsPrivate) {
    return notApplicable(
      `This deployment holds only public material, where ${listed} run without a log on purpose: ` +
        "what they are given is a reader's own text."
    );
  }
  return fail(
    `${listed.charAt(0).toUpperCase()}${listed.slice(1)} run without a log and have no switch, ` +
      "so on this deployment they handle private material unlogged, whatever the run log's mode."
  );
}

/** The checks, in the order they are reported. */
export const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  { name: "config_file", blocking: false, run: checkConfigFile },
  { name: "database", blocking: true, run: checkDatabase },
  { name: "run_log", blocking: true, run: checkRunLog },
  { name: "models", blocking: false, run: checkModels },
  { name: "provider_labels", blocking: true, run: checkProviderLabels },
  { name: "model_clearance", blocking: false, run: checkModelClearance },
  { name: "embeddings", blocking: false, run: checkEmbeddings },
  { name: "embeddings_clearance", blocking: false, run: checkEmbeddingsClearance },
  { name: "web_search", blocking: false, run: checkWebSearch },
  { name: "page_reading", blocking: false, run: checkPageReading },
  { name: "elicit", blocking: false, run: checkElicit },
  { name: "pangram", blocking: false, run: checkPangram },
  { name: "outside_service_clearance", blocking: false, run: checkOutsideServiceClearance },
  { name: "payments", blocking: false, run: checkPayments },
  { name: "github_issues", blocking: false, run: checkGithubIssues },
  { name: "reports_stay_inside", blocking: true, run: checkReportsStayInside },
  { name: "features", blocking: false, run: checkFeatures },
  { name: "work_outside_the_run_log", blocking: false, run: checkWorkOutsideTheRunLog },
];

/** Run every check over facts already gathered. */
export function evaluatePreflight(facts: PreflightFacts): PreflightReport {
  // Where the labels could not be read the deployment is treated as holding
  // private material: a blocking check is not made information by a failed read.
  const mayBlock = facts.holdsPrivate !== false;
  const checks = PREFLIGHT_CHECKS.map((check): PreflightCheckResult => {
    let outcome: Outcome;
    try {
      outcome = check.run(facts);
    } catch (err) {
      outcome = fail(`The check itself failed: ${err instanceof Error ? err.message : String(err)}.`);
    }
    return { name: check.name, status: outcome.status, blocking: check.blocking && mayBlock, message: outcome.message };
  });
  const refused = checks.some((c) => c.blocking && c.status === "fail");
  return {
    holds_private_material: facts.holdsPrivate,
    ready: checks.every((c) => c.status !== "fail"),
    agent_work: refused ? "refused" : "allowed",
    checks,
  };
}

// ---------------------------------------------------------------------------
// Gathering the facts
// ---------------------------------------------------------------------------

/**
 * Whether this deployment holds private material: it has defined a label
 * other than `public`. Throws when the labels cannot be read.
 */
export async function holdsPrivateMaterial(): Promise<boolean> {
  return !(await publicIsTheOnlyLabel());
}

/**
 * The migrations folder beside the running code: where the container keeps
 * it (src/index.ts migrates from there), else where the repository does.
 */
export function migrationsFolder(cwd: string = process.cwd()): string | null {
  for (const candidate of [join(cwd, "drizzle-migrations"), join(cwd, "src", "db", "migrations")]) {
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
  }
  return null;
}

/** The folder's journal: each migration's name and the date the migrator knows it by. */
export function readFolderMigrations(folder: string | null): FolderMigration[] | null {
  if (!folder) return null;
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries.map((e) => ({ tag: e.tag, when: e.when }));
}

/**
 * The database as the checks need it: reachable, with pgvector, and which
 * migrations it has applied. The migrator records each applied migration's
 * journal date in drizzle.__drizzle_migrations.created_at and decides what
 * to run by that date alone, so the same date is what is compared here.
 */
export async function readDatabaseFacts(folder: string | null = migrationsFolder()): Promise<DatabaseFacts> {
  try {
    await rawQuery("SELECT 1");
    const [extension] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'`
    );
    const [table] = await rawQuery<{ name: string | null }>(
      `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name`
    );
    const applied = table?.name
      ? (await rawQuery<{ created_at: string | number }>(`SELECT created_at FROM drizzle.__drizzle_migrations`)).map(
          (row) => Number(row.created_at)
        )
      : [];
    return { reachable: true, pgvector: (extension?.n ?? 0) > 0, folder: readFolderMigrations(folder), applied };
  } catch (err) {
    return { reachable: false, error: errorText(err) };
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // A refused connection to several addresses is an AggregateError with no message of its own.
  const inner = err instanceof AggregateError ? err.errors.map((e) => (e instanceof Error ? e.message : String(e))) : [];
  return (text || inner.join("; ") || "no reason was given").replace(/\.$/, "");
}

/** The agent name on the run the log's test writes. No agent has it. */
export const RUN_LOG_TEST_AGENT = "preflight";

/**
 * Test the run log by using it: open a run, write two steps through the
 * same writer every agent run uses (services/trace-service.ts), seal it,
 * recompute its chain with the verifier behind GET /runs/:run_id/verify,
 * and remove it. The run is opened whatever TRACE_LEVEL says, calls no
 * model, and is not public while it exists (an agent name nobody has
 * classified starts private, llm/run-visibility.ts). If the process dies
 * between the write and the removal, a sealed two-step run by the agent
 * "preflight" is left behind and says what it is.
 */
export async function runLogSelfTest(): Promise<RunLogSelfTest> {
  const trace = openAgentRun(RUN_LOG_TEST_AGENT, {});
  try {
    recordAgentStep(trace, "prompt", { preflight: "A test of the run log. No model was called." });
    recordAgentStep(trace, "completion", { preflight: "The second and last step of the test." });
    const steps = trace.seq.n;
    if (!(await sealAgentRun(trace, "ok"))) {
      return { ok: false, reason: "the run or one of its steps could not be written, so it closed unsealed" };
    }
    const check = await verifyRunLog(trace.runId, { isService: true });
    if (!check || "withheld" in check) return { ok: false, reason: "the run was written but could not be read back" };
    if (!check.sealed || !check.intact || check.steps_recorded !== steps) {
      return {
        ok: false,
        reason:
          `the run was written but its chain does not check out` +
          (check.problem ? ` (${check.problem.reason.replace(/_/g, " ")})` : ""),
      };
    }
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  } finally {
    await rawQuery(`DELETE FROM agent_runs WHERE id = $1`, [trace.runId]).catch(() => undefined);
  }
}

/** Gather what the checks look at from the running deployment. */
export async function gatherPreflightFacts(): Promise<PreflightFacts> {
  const config = loadConfig();
  const database = await readDatabaseFacts();
  let privateLabels: string[] | null = null;
  try {
    privateLabels = await labelsBesidesPublic();
  } catch {
    // Left null: the checks that turn on it say that it could not be read.
  }
  const holdsPrivate = privateLabels === null ? null : privateLabels.length > 0;
  const endpointKeysMissing = (config.modelEndpoints ?? [])
    .map((endpoint) => endpoint.keyEnv)
    .filter((env): env is string => !!env && !process.env[env]);
  const runLog: RunLogSelfTest = database.reachable
    ? await runLogSelfTest()
    : { ok: false, reason: "the database cannot be reached" };
  return {
    config,
    configFile: appliedConfigFile(),
    holdsPrivate,
    privateLabels,
    endpointKeysMissing,
    database,
    runLog,
  };
}

/** Run the preflight against the running deployment. */
export async function runPreflight(
  gather: () => Promise<PreflightFacts> = gatherPreflightFacts
): Promise<PreflightReport> {
  return evaluatePreflight(await gather());
}

// ---------------------------------------------------------------------------
// The gate on agent work
// ---------------------------------------------------------------------------

export interface AgentWorkGate {
  /** Whether agent work may start. */
  open: boolean;
  holdsPrivate: boolean;
  /** The blocking checks that failed; empty when the gate is open. */
  failed: PreflightCheckResult[];
}

/**
 * Whether agent work may start. A deployment that holds only public
 * material is asked that one question and nothing else: the answer opens the
 * gate, and no check runs. One that holds private material must pass every
 * blocking check. Throws when the labels cannot be read; the caller decides
 * what an unknown answer means (workers/agent-work-gate.ts keeps work
 * stopped until it can be read).
 */
export async function agentWorkGate(
  probes: { holdsPrivate: () => Promise<boolean>; preflight: () => Promise<PreflightReport> } = {
    holdsPrivate: holdsPrivateMaterial,
    preflight: runPreflight,
  }
): Promise<AgentWorkGate> {
  if (!(await probes.holdsPrivate())) return { open: true, holdsPrivate: false, failed: [] };
  const report = await probes.preflight();
  const failed = report.checks.filter((c) => c.blocking && c.status === "fail");
  return { open: failed.length === 0, holdsPrivate: true, failed };
}

/** The log line for a closed gate: which checks failed and what each said. */
export function agentWorkRefusal(failed: readonly PreflightCheckResult[]): string {
  return (
    `Agent work is not started: this deployment holds private material and ` +
    `${plural(failed.length, "preflight check")} that must pass first ${failed.length === 1 ? "has" : "have"} failed. ` +
    failed.map((c) => `${c.name}: ${c.message}`).join(" ") +
    " The API is serving, so GET /setup/preflight and `npm run preflight` show every check."
  );
}
