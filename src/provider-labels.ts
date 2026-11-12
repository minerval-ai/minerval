/**
 * Providers cleared by label: PROVIDER_LABELS.
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
 * PROVIDER_LABELS is a JSON object from a provider's name to the list of
 * labels it may receive text at:
 *
 *   {"anthropic": ["public", "internal"],
 *    "endpoint:local": ["public", "internal", "restricted"],
 *    "embeddings": ["public", "internal"]}
 *
 * A provider the setting does not name is cleared for `public` and for
 * nothing else. So the public graph, whose only label is `public`, needs no
 * setting, and a private deployment serves no other label until whoever
 * runs it clears a provider for it. That is a step of setting one up, on
 * purpose: which outside party may read private text is never guessed.
 *
 * A provider the setting names is cleared for exactly the labels listed, so
 * an empty list switches it off for everything, `public` included.
 *
 * Labels are named by name and are never created from here. Whether each
 * name is a row in `labels` can only be asked of the database, which config
 * loading does not have, so it is asked the first time the setting is used
 * (llm/provider-clearance.ts). What can be checked without the database is
 * checked at config load (providerSettingProblems).
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
} from "./llm/providers/routing.js";

/** The hosted model APIs, by the names routing gives them. */
export const HOSTED_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;

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

/** The part of the config the clearance reads. A config without it (a test's partial config) has the defaults. */
export interface ProviderLabelsConfig {
  providerLabels?: Readonly<Record<string, readonly string[]>>;
  modelEndpoints?: readonly ModelEndpoint[];
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
  return problems;
}

/**
 * The labels a provider is cleared for: the list PROVIDER_LABELS gives it,
 * or `public` alone when the setting does not name it.
 */
export function clearedLabels(provider: string, config: ProviderLabelsConfig = loadConfig()): readonly string[] {
  const listed = config?.providerLabels;
  return listed && Object.hasOwn(listed, provider) ? listed[provider]! : [PUBLIC_LABEL];
}

/** Whether a provider may be sent text at `label`. */
export function providerClearedFor(
  provider: string,
  label: string,
  config: ProviderLabelsConfig = loadConfig()
): boolean {
  return clearedLabels(provider, config).includes(label);
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
    cleared: readonly string[]
  ) {
    super(
      `${provider} is not cleared for the label "${label}", so nothing was sent to it. ` +
        `PROVIDER_LABELS lists the labels each model provider and outside service may receive ` +
        `text at, and one it does not list is cleared for "${PUBLIC_LABEL}" alone. To clear this ` +
        `one, set its entry to ${JSON.stringify(provider)}:${JSON.stringify([...cleared, label])}.`
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
