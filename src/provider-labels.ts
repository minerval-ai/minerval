/**
 * Providers cleared by label.
 *
 * In a private deployment, text that is not public reaches only the parties
 * its owner chose: the deployment's members, and a model provider or an
 * outside service by contract. So each provider is cleared for a set of
 * labels (src/labels.ts), and a run is served only by one cleared for the
 * label it works at.
 *
 * A provider here is anything outside the deployment that is sent text a
 * run composed or read:
 *
 *  - each of the three hosted model APIs: `anthropic`, `openai`,
 *    `openrouter`;
 *  - each endpoint the deployment declares in MODEL_ENDPOINTS
 *    (llm/providers/endpoint-config.ts), as `endpoint:<name>`;
 *  - each outside service in OUTSIDE_SERVICES below.
 *
 * Every provider is cleared for `public`, and for no other label until
 * someone clears it. So the public graph, whose only label is `public`,
 * needs nothing, and a private deployment serves no other label until a
 * provider is cleared for it. That is a step of setting one up, on
 * purpose: which outside party may read private text is never guessed, and
 * clearing a provider for a label is never a default.
 *
 * Who clears it is one of two, never both:
 *
 *  - The administrators, on the labels page, where a label is defined
 *    (services/provider-clearance-service.ts). The choice is a row for each
 *    provider and label it clears (provider_clearances), made by a holder
 *    of `clear_providers` and logged. This is the starting arrangement.
 *
 *  - Whoever runs the machine, in PROVIDER_LABELS (or [provider_labels] in
 *    the config file). Set, it fixes the clearance: the stored choice is
 *    not read, the page says the clearance is fixed by the deployment's
 *    settings, and nothing can be changed there. It is a JSON object from a
 *    provider's name to the list of labels it may receive text at:
 *
 *      {"anthropic": ["public", "internal"],
 *       "endpoint:local": ["public", "internal", "restricted"],
 *       "embeddings": ["public", "internal"]}
 *
 *    A provider it does not name is cleared for `public` alone, and one it
 *    names is cleared for exactly the labels listed, so an empty list
 *    switches it off for everything, `public` included.
 *
 * The stored choice is in the database, which the synchronous readers here
 * cannot reach, so this process keeps the last copy it read
 * (noteStoredClearance), and llm/provider-clearance.ts reads it again
 * before relying on it at a label other than `public`. At `public` it is
 * never needed: under the stored choice every provider is cleared for it.
 *
 * Labels are named by name and are never created from here. Whether each
 * name PROVIDER_LABELS uses is a row in `labels` can only be asked of the
 * database, which config loading does not have, so it is asked the first
 * time the setting is used (llm/provider-clearance.ts). What can be checked
 * without the database is checked at config load (providerSettingProblems).
 * A stored row names its label by a foreign key, so it cannot name one
 * that is not defined.
 *
 * This module only reads the setting. The check each call makes before
 * anything is sent, and the reasoning about which label it checks, are in
 * llm/provider-clearance.ts.
 */
import { loadConfig } from "./config.js";
import { PUBLIC_LABEL } from "./labels.js";
import type { ModelEndpoint } from "./llm/providers/endpoint-config.js";
import {
  ENDPOINT_ID_PREFIX,
  endpointProviderName,
  parseEndpointModelId,
  resolveProvider,
} from "./llm/providers/routing.js";

/** The hosted model APIs, by the names routing gives them. */
export const HOSTED_PROVIDERS = ["anthropic", "openai", "openrouter", "bedrock", "vertex"] as const;

interface OutsideServiceDefinition {
  name: string;
  /** For whoever runs the deployment: what the service is and what it is sent. */
  description: string;
  /**
   * The service as an agent would recognize it in its own instructions and
   * tools: a short phrase, lower case where it is not a name, no full stop.
   * A run at a label the service is not cleared for is told so by this
   * phrase (llm/uncleared-services-note.ts). Null for a service no tool
   * belongs to.
   */
  agentPhrase: string | null;
}

/**
 * The outside services that are not model providers. A web search or a code
 * execution that a model's provider runs inside the turn (Anthropic's server
 * tools) is not listed: it goes where the model's text goes, and that
 * provider's clearance covers it.
 */
export const OUTSIDE_SERVICES = [
  {
    name: "embeddings",
    description:
      "OpenAI's embeddings API, which is sent the text of each claim, tag, finding, " +
      "request and report, and each search query, and returns the vector that search " +
      "by meaning compares.",
    agentPhrase: null,
  },
  {
    name: "web_search",
    description:
      "The web_search tool where the agent's own loop runs it: one request to " +
      "OpenRouter's web plugin, which passes the query to the Exa search engine.",
    agentPhrase: "web search",
  },
  {
    name: "web_pages",
    description:
      "Fetching an address on the open web: read_page and the other reading tools, " +
      "the reading of a submitted source, feeds, Crossref, arXiv and the Internet " +
      "Archive. What is sent is the address, which a run may have composed.",
    agentPhrase: "reading pages and files from the web",
  },
  {
    name: "elicit",
    description: "Elicit's search of papers and trials (the elicit_* tools), which is sent the query.",
    agentPhrase: "Elicit's search of papers and trials",
  },
  {
    name: "pangram",
    description:
      "Pangram's checks for AI-generated writing and for matching text on the web " +
      "(the pangram_* tools), which are sent the text checked.",
    agentPhrase: "Pangram's checks for AI-generated writing and for matching text on the web",
  },
] as const satisfies readonly OutsideServiceDefinition[];

export type OutsideServiceName = (typeof OUTSIDE_SERVICES)[number]["name"];

export const OUTSIDE_SERVICE_NAMES: readonly OutsideServiceName[] = OUTSIDE_SERVICES.map((s) => s.name);

/**
 * What each hosted model API is sent, for whoever clears it. An endpoint's
 * is written by endpointDescription.
 */
export const HOSTED_PROVIDER_DESCRIPTIONS: Record<(typeof HOSTED_PROVIDERS)[number], string> = {
  anthropic:
    "Anthropic's API, which is sent every prompt of a model it serves, and what its server " +
    "tools (web search, code execution) do inside a turn.",
  openai: "OpenAI's API, which is sent every prompt of a model it serves.",
  openrouter: "OpenRouter's API, which is sent every prompt of a model routed through it.",
  bedrock:
    "Claude on Amazon Bedrock, in the AWS account and region this deployment configures, which " +
    "is sent every prompt of a model it serves.",
  vertex:
    "Claude on Google Vertex AI, in the Google Cloud project and region this deployment " +
    "configures, which is sent every prompt of a model it serves.",
};

function endpointDescription(endpoint: ModelEndpoint): string {
  let host = endpoint.baseUrl;
  try {
    host = new URL(endpoint.baseUrl).host;
  } catch {
    // Shown as written.
  }
  return `The endpoint "${endpoint.name}" this deployment declares (${host}), which is sent every prompt of a model routed to it.`;
}

/**
 * The part of the config the clearance reads. A config without it (a
 * test's partial config) has the defaults. providerLabels undefined (or
 * null) is "PROVIDER_LABELS is not set": the administrators' stored choice
 * applies.
 */
export interface ProviderLabelsConfig {
  providerLabels?: Readonly<Record<string, readonly string[]>> | null;
  modelEndpoints?: readonly ModelEndpoint[];
  /** MODEL_PROVIDERS_ALLOWED: the model providers that may be called at all. Empty allows every one. */
  modelProvidersAllowed?: readonly string[];
}

/** Whether PROVIDER_LABELS (or [provider_labels]) is set, and so fixes the clearance. */
export function clearanceFixedBySettings(config: ProviderLabelsConfig = loadConfig()): boolean {
  return config?.providerLabels != null;
}

/**
 * The administrators' stored choice: each provider's labels besides
 * `public`. A provider with no entry is cleared for `public` alone.
 */
export type StoredClearance = Readonly<Record<string, readonly string[]>>;

/**
 * The last copy of the stored choice this process read, and when. Null
 * until one is read, which reads as nothing cleared beyond `public`: a
 * process that has not asked never sends private text on a guess.
 */
let lastStored: { clearance: StoredClearance; readAt: number } | null = null;

/** The stored choice as this process last read it; empty when it has read none. */
export function storedClearance(): StoredClearance {
  return lastStored?.clearance ?? {};
}

/** When this process last read the stored choice (Date.now()), or null when it has not. */
export function storedClearanceReadAt(): number | null {
  return lastStored?.readAt ?? null;
}

/** Keep a copy of the stored choice just read (services/provider-clearance-service.ts). */
export function noteStoredClearance(clearance: StoredClearance, readAt: number = Date.now()): void {
  lastStored = { clearance, readAt };
}

/** Forget the copy, so the next reader at a private label reads the table again. */
export function forgetStoredClearance(): void {
  lastStored = null;
}

/** The part of the config that says which providers and services this deployment has set up. */
export interface ProviderKeysConfig extends ProviderLabelsConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  bedrockRegion?: string;
  vertexRegion?: string;
  elicitApiKey?: string;
  elicitEnabled?: "true" | "false";
  pangramApiKey?: string;
  pangramEnabled?: "true" | "false";
}

export interface ProviderDescription {
  name: string;
  kind: "model_provider" | "outside_service";
  /** What it is and what it would be sent. */
  description: string;
  /** Whether this deployment has it set up: a key set, an endpoint declared, a service on. */
  configured: boolean;
}

/**
 * Every provider and outside service this deployment knows, each with what
 * it would be sent and whether it is set up here: what the labels page
 * offers to clear (architecture.md, "Providers cleared by label").
 */
export function describeProviders(config: ProviderKeysConfig = loadConfig()): ProviderDescription[] {
  const keyed = (key: string | undefined, enabled?: "true" | "false") => enabled !== "false" && !!key;
  // Bedrock and Vertex take the cloud's own credentials, which cannot be
  // seen without a call: set up is where a region is set for them.
  const hostedKey: Record<(typeof HOSTED_PROVIDERS)[number], string | undefined> = {
    anthropic: config.anthropicApiKey,
    openai: config.openaiApiKey,
    openrouter: config.openrouterApiKey,
    bedrock: config.bedrockRegion,
    vertex: config.vertexRegion,
  };
  const serviceOn: Record<OutsideServiceName, boolean> = {
    embeddings: keyed(config.openaiApiKey),
    // The search the agent's own loop runs goes through OpenRouter.
    web_search: keyed(config.openrouterApiKey),
    web_pages: true,
    elicit: keyed(config.elicitApiKey, config.elicitEnabled),
    pangram: keyed(config.pangramApiKey, config.pangramEnabled),
  };
  return [
    ...HOSTED_PROVIDERS.map((name) => ({
      name,
      kind: "model_provider" as const,
      description: HOSTED_PROVIDER_DESCRIPTIONS[name],
      configured: keyed(hostedKey[name]),
    })),
    ...(config.modelEndpoints ?? []).map((endpoint) => ({
      name: endpointProviderName(endpoint.name),
      kind: "model_provider" as const,
      description: endpointDescription(endpoint),
      configured: true,
    })),
    ...OUTSIDE_SERVICES.map((service) => ({
      name: service.name,
      kind: "outside_service" as const,
      description: service.description,
      configured: serviceOn[service.name],
    })),
  ];
}

const EXAMPLE = '{"anthropic":["public","internal"],"embeddings":["public","internal"]}';

/**
 * A PROVIDER_LABELS value as the lists it gives, with everything wrong with
 * its form. Empty in, nothing out: every provider keeps the default.
 */
export function parseProviderLabels(raw: string): {
  labels: Record<string, string[]>;
  problems: string[];
} {
  const text = raw.trim();
  if (!text) return { labels: {}, problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      labels: {},
      problems: [
        `PROVIDER_LABELS is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
          `It is a JSON object from a provider's name to the labels it may receive, for example ${EXAMPLE}.`,
      ],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      labels: {},
      problems: [
        `PROVIDER_LABELS must be a JSON object from a provider's name to the labels it may ` +
          `receive, for example ${EXAMPLE}.`,
      ],
    };
  }
  const labels: Record<string, string[]> = {};
  const problems: string[] = [];
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
      problems.push(
        `PROVIDER_LABELS gives "${provider}" something that is not a list of label names. ` +
          `Write the labels it may receive as a list, for example "${provider}":["public"], ` +
          `or [] to clear it for none.`
      );
      continue;
    }
    labels[provider] = [...new Set((value as string[]).map((v) => v.trim()))];
  }
  return { labels, problems };
}

/** Every name PROVIDER_LABELS may use in this deployment. */
export function knownProviderNames(config: ProviderLabelsConfig = loadConfig()): string[] {
  return [
    ...HOSTED_PROVIDERS,
    ...(config?.modelEndpoints ?? []).map((e) => endpointProviderName(e.name)),
    ...OUTSIDE_SERVICE_NAMES,
  ];
}

function declaredEndpoints(endpoints: readonly ModelEndpoint[]): string {
  return endpoints.length > 0
    ? `MODEL_ENDPOINTS declares: ${endpoints.map((e) => e.name).join(", ")}.`
    : `MODEL_ENDPOINTS declares none.`;
}

/**
 * What is wrong with a model id that names an endpoint this deployment does
 * not declare, or null. `setting` is the environment variable the id came
 * from, when it came from one.
 */
export function undeclaredEndpointMessage(
  modelId: string,
  endpoints: readonly ModelEndpoint[],
  setting?: string
): string | null {
  const parsed = parseEndpointModelId(modelId);
  if (!parsed || endpoints.some((e) => e.name === parsed.endpoint)) return null;
  return (
    (setting ? `${setting} is "${modelId}", which names` : `The model ID "${modelId}" names`) +
    ` the endpoint "${parsed.endpoint}", but this deployment declares no endpoint of that name. ` +
    declaredEndpoints(endpoints)
  );
}

/** The environment variable a config field is read from: stewardModel is STEWARD_MODEL. */
function envName(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * What config loading can find wrong with the two settings once both are
 * parsed, without the database: a name in PROVIDER_LABELS that is not a
 * provider here, and a model field that routes to an endpoint nobody
 * declared. A typo in either would otherwise wait for the first call to
 * show itself. `config` is the whole parsed config: every field whose name
 * ends in "Model" is read as a model id.
 */
export function providerSettingProblems(
  config: ProviderLabelsConfig & Readonly<Record<string, unknown>>
): string[] {
  const endpoints = config.modelEndpoints ?? [];
  const problems: string[] = [];
  const known = new Set(knownProviderNames(config));
  for (const provider of Object.keys(config.providerLabels ?? {})) {
    if (known.has(provider)) continue;
    problems.push(
      provider.startsWith(ENDPOINT_ID_PREFIX)
        ? `PROVIDER_LABELS names "${provider}", which is not an endpoint this deployment declares. ` +
            declaredEndpoints(endpoints)
        : `PROVIDER_LABELS names "${provider}", which is not a provider or an outside service. ` +
            `They are: ${[...known].join(", ")}.`
    );
  }
  for (const [field, value] of Object.entries(config)) {
    if (!/Model$/.test(field) || typeof value !== "string") continue;
    const problem = undeclaredEndpointMessage(value, endpoints, envName(field));
    if (problem) problems.push(problem);
  }
  problems.push(...allowedProviderProblems(config));
  return problems;
}

// ---------------------------------------------------------------------------
// Which model providers may be called at all (MODEL_PROVIDERS_ALLOWED)
// ---------------------------------------------------------------------------

/** Every model provider this deployment knows: the hosted ones and its declared endpoints. */
function modelProviderNames(config: ProviderLabelsConfig): string[] {
  return [
    ...HOSTED_PROVIDERS,
    ...(config?.modelEndpoints ?? []).map((e) => endpointProviderName(e.name)),
  ];
}

/**
 * Whether the deployment allows calls to a model provider at all. Where
 * MODEL_PROVIDERS_ALLOWED is empty (the default) every provider is
 * allowed, and which labels each may be sent is the clearance's
 * (clearedLabels). Where it names providers, no other is called, at any
 * label: a deployment that runs every agent on a cloud account it controls
 * says so once, and a role or a lookout pointed elsewhere is refused before
 * anything is sent rather than relying on a clearance line for each
 * provider it does not use.
 */
export function providerAllowed(provider: string, config: ProviderLabelsConfig = loadConfig()): boolean {
  const allowed = config?.modelProvidersAllowed ?? [];
  return allowed.length === 0 || allowed.includes(provider);
}

/** What a refused call, and a role on a provider that is not allowed, are told. */
function notAllowedMessage(provider: string, allowed: readonly string[]): string {
  return (
    `This deployment calls only the model providers MODEL_PROVIDERS_ALLOWED names ` +
    `(${allowed.join(", ")}), and ${provider} is not one of them`
  );
}

/** A call to a model provider the deployment does not allow. Thrown before anything is sent. */
export class ProviderNotAllowedError extends Error {
  readonly code = "PROVIDER_NOT_ALLOWED";
  constructor(readonly provider: string, allowed: readonly string[]) {
    super(
      `${notAllowedMessage(provider, allowed)}, so nothing was sent. Use a model on an allowed ` +
        `provider, or add ${provider} to MODEL_PROVIDERS_ALLOWED.`
    );
    this.name = "ProviderNotAllowedError";
  }
}

/** Refuse a call to a provider the deployment does not allow. */
export function assertProviderAllowed(provider: string, config: ProviderLabelsConfig = loadConfig()): void {
  if (!providerAllowed(provider, config)) {
    throw new ProviderNotAllowedError(provider, config?.modelProvidersAllowed ?? []);
  }
}

/**
 * What config loading finds wrong with MODEL_PROVIDERS_ALLOWED: a name that
 * is not a model provider here, and a model field whose model is on a
 * provider it does not name. Either would otherwise wait for a run to be
 * refused.
 */
export function allowedProviderProblems(
  config: ProviderLabelsConfig & Readonly<Record<string, unknown>>
): string[] {
  const allowed = config.modelProvidersAllowed ?? [];
  if (allowed.length === 0) return [];
  const known = modelProviderNames(config);
  const problems: string[] = [];
  for (const name of allowed) {
    if (known.includes(name)) continue;
    problems.push(
      `MODEL_PROVIDERS_ALLOWED names "${name}", which is not a model provider here. ` +
        `They are: ${known.join(", ")}.`
    );
  }
  for (const [field, value] of Object.entries(config)) {
    if (!/Model$/.test(field) || typeof value !== "string" || value.length === 0) continue;
    const provider = resolveProvider(value);
    if (!provider || providerAllowed(provider, config)) continue;
    problems.push(
      `${envName(field)} is "${value}", on ${provider}. ${notAllowedMessage(provider, allowed)}: ` +
        `point ${envName(field)} at a model on an allowed provider, or add ${provider} to the list.`
    );
  }
  return problems;
}

/**
 * The labels a provider is cleared for. Where PROVIDER_LABELS is set: the
 * list it gives the provider, or `public` alone when it does not name it.
 * Where it is not: `public` and the labels the administrators cleared it
 * for, as `stored` gives them (by default, this process's last copy).
 */
export function clearedLabels(
  provider: string,
  config: ProviderLabelsConfig = loadConfig(),
  stored: StoredClearance = storedClearance()
): readonly string[] {
  const listed = config?.providerLabels;
  if (listed != null) return Object.hasOwn(listed, provider) ? listed[provider]! : [PUBLIC_LABEL];
  const chosen = Object.hasOwn(stored, provider) ? stored[provider]! : [];
  return [PUBLIC_LABEL, ...chosen.filter((label) => label !== PUBLIC_LABEL)];
}

/** Whether a provider may be sent text at `label`. */
export function providerClearedFor(
  provider: string,
  label: string,
  config: ProviderLabelsConfig = loadConfig(),
  stored: StoredClearance = storedClearance()
): boolean {
  return clearedLabels(provider, config, stored).includes(label);
}

/**
 * A call was about to send text to a provider that is not cleared for the
 * label of the run making it. Thrown before anything is sent. There is no
 * second choice of provider and no reading of the label as `public`: either
 * would send private text somewhere its owner did not choose.
 */
export class ProviderNotClearedError extends Error {
  constructor(
    readonly provider: string,
    readonly label: string,
    cleared: readonly string[],
    /** Whether PROVIDER_LABELS fixes the clearance; otherwise the administrators choose it. */
    fixedBySettings: boolean = true
  ) {
    super(
      fixedBySettings
        ? `${provider} is not cleared for the label "${label}", so nothing was sent to it. ` +
            `PROVIDER_LABELS lists the labels each model provider and outside service may receive ` +
            `text at, and one it does not list is cleared for "${PUBLIC_LABEL}" alone. To clear this ` +
            `one, set its entry to ${JSON.stringify(provider)}:${JSON.stringify([...cleared, label])}.`
        : `${provider} is not cleared for the label "${label}", so nothing was sent to it. ` +
            `Every model provider and outside service is cleared for "${PUBLIC_LABEL}" and for no ` +
            `other label until it is cleared on purpose: a holder of the permission to clear ` +
            `providers does that for each label on the labels page (/admin/labels).`
    );
    this.name = "ProviderNotClearedError";
  }
}

/**
 * PROVIDER_LABELS names a label that is not a row in `labels`. Thrown the
 * first time the setting is used, and on every use until it is put right:
 * a misspelt label would otherwise leave the label that was meant
 * uncleared, or clear a provider for a label defined later by someone who
 * never chose that.
 */
export class UndefinedProviderLabelError extends Error {
  constructor(readonly undefinedLabels: ReadonlyArray<{ label: string; providers: string[] }>) {
    const named = undefinedLabels
      .map(({ label, providers }) => `"${label}" (for ${providers.join(", ")})`)
      .join(" and ");
    super(
      `PROVIDER_LABELS names ${named}, which this deployment does not define as a label, so ` +
        `nothing was sent. A label is a row in labels and is never created from configuration: ` +
        `define it first, or correct the name in PROVIDER_LABELS.`
    );
    this.name = "UndefinedProviderLabelError";
  }
}
