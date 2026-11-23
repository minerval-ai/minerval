/**
 * Claude on Amazon Bedrock.
 *
 * Bedrock serves Claude through the Anthropic Messages API, so this is the
 * Anthropic adapter (providers/anthropic.ts, messagesApiAdapter) with
 * Anthropic's Bedrock client in place of its own. A model id is
 * "bedrock:" and then Bedrock's id for the model or its inference profile
 * ("bedrock:us.anthropic.claude-opus-5-5-v1:0"); routing.ts sends it here,
 * and what follows the prefix is what Bedrock is sent.
 *
 * The region is BEDROCK_REGION, else AWS_REGION. The credentials are AWS's:
 * a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK when one is set, and
 * otherwise the default credential chain (a task or instance role, the
 * AWS_ACCESS_KEY_ID pair, a profile), with every request signed. The
 * deployment holds the account, so the prompts stay in it.
 */
import { onConfigChange } from "../../config-changes.js";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";

import { loadConfig } from "../../config.js";
import {
  LONG_RUN_MAX_RETRIES,
  longRunTimeoutMs,
  messagesApiAdapter,
  requestMaxRetries,
  requestTimeoutMs,
} from "./anthropic.js";
import type { ProviderAdapter } from "./types.js";

let _client: Anthropic | null = null;
let _longRunClient: Anthropic | null = null;

function makeClient(timeout: number, maxRetries: number): Anthropic {
  const config = loadConfig();
  if (!config.bedrockRegion) {
    throw new Error(
      'A call was routed to Claude on Amazon Bedrock (a "bedrock:…" model), but no region ' +
        "is set for it. Set BEDROCK_REGION (or AWS_REGION) to the region the deployment's " +
        "Bedrock account serves Claude in, or point the agent's *_MODEL at another provider."
    );
  }
  // The Bedrock client is the Anthropic client over another transport: the
  // same resources, typed on its own base class.
  return new AnthropicBedrock({
    awsRegion: config.bedrockRegion,
    // null, not undefined: with no key set the client signs with AWS
    // credentials rather than reading the variable itself.
    apiKey: config.bedrockApiKey || null,
    timeout,
    maxRetries,
  }) as unknown as Anthropic;
}

function getClient(): Anthropic {
  _client ??= makeClient(requestTimeoutMs(), requestMaxRetries());
  return _client;
}

function getLongRunClient(): Anthropic {
  _longRunClient ??= makeClient(longRunTimeoutMs(), LONG_RUN_MAX_RETRIES);
  return _longRunClient;
}

/** Test seam: drop the memoized clients so a new config takes effect. */
export function resetBedrockClient(): void {
  _client = null;
  _longRunClient = null;
}

export const bedrockAdapter: ProviderAdapter = messagesApiAdapter({
  name: "bedrock",
  client: getClient,
  longRunClient: getLongRunClient,
});

// A region or a key changed in the app is in force at the next call: the client made with the old one is dropped.
onConfigChange(resetBedrockClient);
