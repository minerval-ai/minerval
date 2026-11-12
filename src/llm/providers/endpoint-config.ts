/**
 * Endpoints a deployment declares for itself: MODEL_ENDPOINTS.
 *
 * A deployment can serve open-weight models from a server it runs (vLLM,
 * llama.cpp's server, TGI, Ollama), beside or instead of the three hosted
 * APIs. Each such server is declared once, by name, and a model id of the
 * shape "endpoint:<name>/<model>" routes to it (routing.ts).
 *
 * MODEL_ENDPOINTS is a JSON list, one object per endpoint:
 *
 *   [{ "name": "local",
 *      "baseUrl": "http://vllm.internal:8000/v1",
 *      "keyEnv": "LOCAL_LLM_KEY",
 *      "inputUsdPerMtok": 0.5,
 *      "outputUsdPerMtok": 1.5 }]
 *
 *  - name: what the model ids and PROVIDER_LABELS call it.
 *  - baseUrl: where its OpenAI-compatible API is served, up to and including
 *    the version segment, as the server documents it (".../v1").
 *  - keyEnv: optional. The NAME of the environment variable that holds its
 *    key, never the key, so the list can be written into a config file. An
 *    endpoint that takes no key leaves it out.
 *  - inputUsdPerMtok, outputUsdPerMtok: what a call costs, in US dollars per
 *    million tokens. Both are required. A run's budget and the owls charged
 *    for it are counted in metered cost, and only the deployment knows what
 *    its own hardware costs, so there is no default; a deployment that
 *    counts its endpoint as free writes 0 and says so.
 *
 * There is no dialect field. Every server named above serves Chat
 * Completions, which is the dialect the endpoint adapter speaks
 * (providers/endpoint.ts); none needs another to be reached.
 *
 * Like routing.ts, this module imports nothing from the config or the
 * adapters, so src/config.ts can parse the setting at load time.
 */
import { ENDPOINT_NAME_PATTERN } from "./routing.js";

export interface ModelEndpoint {
  name: string;
  /** Without a trailing slash. */
  baseUrl: string;
  /** The environment variable that holds the endpoint's key, when it takes one. */
  keyEnv?: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

const EXAMPLE =
  '[{"name":"local","baseUrl":"http://localhost:8000/v1","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';

const FIELDS = ["name", "baseUrl", "keyEnv", "inputUsdPerMtok", "outputUsdPerMtok"];

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * A MODEL_ENDPOINTS value as the endpoints it declares, with everything
 * wrong with it in words an installer can act on. Empty in, nothing out:
 * a deployment that declares no endpoint has none.
 */
export function parseModelEndpoints(raw: string): {
  endpoints: ModelEndpoint[];
  problems: string[];
} {
  const text = raw.trim();
  if (!text) return { endpoints: [], problems: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      endpoints: [],
      problems: [
        `MODEL_ENDPOINTS is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
          `It is a JSON list with one object per endpoint, for example ${EXAMPLE}.`,
      ],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      endpoints: [],
      problems: [
        `MODEL_ENDPOINTS must be a JSON list with one object per endpoint, for example ${EXAMPLE}.`,
      ],
    };
  }

  const endpoints: ModelEndpoint[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  parsed.forEach((entry, i) => {
    const at = `MODEL_ENDPOINTS entry ${i + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} is not an object. Each entry looks like ${EXAMPLE.slice(1, -1)}.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const who = name ? `${at} ("${name}")` : at;
    const before = problems.length;

    const unknown = Object.keys(e).filter((k) => !FIELDS.includes(k));
    if (unknown.length > 0) {
      problems.push(
        `${who} has ${unknown.map((k) => `"${k}"`).join(", ")}, which ` +
          `${unknown.length === 1 ? "is not a field" : "are not fields"} of an endpoint. ` +
          `The fields are: ${FIELDS.join(", ")}.`
      );
    }
    if (!ENDPOINT_NAME_PATTERN.test(name)) {
      problems.push(
        `${at} needs a "name" of lower-case letters, digits, "-" and "_" (it is what follows ` +
          `"endpoint:" in a model ID).`
      );
    } else if (seen.has(name)) {
      problems.push(`MODEL_ENDPOINTS declares "${name}" more than once. Each endpoint needs its own name.`);
    }

    let baseUrl = "";
    try {
      const url = new URL(typeof e.baseUrl === "string" ? e.baseUrl : "");
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http");
      baseUrl = url.toString().replace(/\/+$/, "");
    } catch {
      problems.push(
        `${who} needs a "baseUrl": the http or https address its OpenAI-compatible API is ` +
          `served at, for example "http://localhost:8000/v1".`
      );
    }

    if (e.keyEnv !== undefined && (typeof e.keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.keyEnv))) {
      problems.push(
        `${who} has a "keyEnv" that is not the name of an environment variable. It names the ` +
          `variable that holds the endpoint's key (for example "LOCAL_LLM_KEY"), not the key itself.`
      );
    }

    if (!isPrice(e.inputUsdPerMtok) || !isPrice(e.outputUsdPerMtok)) {
      problems.push(
        `${who} needs "inputUsdPerMtok" and "outputUsdPerMtok": what a call to it costs, in US ` +
          `dollars per million tokens, as numbers of 0 or more. Budgets and owls are counted in ` +
          `this cost, so it has no default.`
      );
    }

    if (problems.length > before) return;
    seen.add(name);
    endpoints.push({
      name,
      baseUrl,
      ...(typeof e.keyEnv === "string" ? { keyEnv: e.keyEnv } : {}),
      inputUsdPerMtok: e.inputUsdPerMtok as number,
      outputUsdPerMtok: e.outputUsdPerMtok as number,
    });
  });

  return { endpoints, problems };
}
