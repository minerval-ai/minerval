/**
 * Claude on Google Vertex AI.
 *
 * Vertex serves Claude through the Anthropic Messages API, so this is the
 * Anthropic adapter (providers/anthropic.ts, messagesApiAdapter) with
 * Anthropic's Vertex client in place of its own. A model id is "vertex:"
 * and then Vertex's id for the model ("vertex:claude-sonnet-5-5", or a
 * pinned version, "vertex:claude-sonnet-4-5@20250929"); routing.ts sends it
 * here, and what follows the prefix is what Vertex is sent.
 *
 * The region is VERTEX_REGION, else CLOUD_ML_REGION ("global" is the global
 * endpoint). The project is VERTEX_PROJECT_ID, else
 * ANTHROPIC_VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT, else the project of
 * the credentials. The credentials are Google's application default
 * credentials: GOOGLE_APPLICATION_CREDENTIALS, or the service account of the
 * machine. The deployment holds the project, so the prompts stay in it.
 */
import { onConfigChange } from "../../config-changes.js";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";

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
  if (!config.vertexRegion) {
    throw new Error(
      'A call was routed to Claude on Google Vertex AI (a "vertex:…" model), but no region ' +
        'is set for it. Set VERTEX_REGION (or CLOUD_ML_REGION) to the region the deployment\'s ' +
        'project serves Claude in, "global" for the global endpoint, or point the agent\'s ' +
        "*_MODEL at another provider."
    );
  }
  return new AnthropicVertex({
    region: config.vertexRegion,
    // null lets the client take the project from the credentials.
    projectId: config.vertexProjectId || null,
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
export function resetVertexClient(): void {
  _client = null;
  _longRunClient = null;
}

export const vertexAdapter: ProviderAdapter = messagesApiAdapter({
  name: "vertex",
  client: getClient,
  longRunClient: getLongRunClient,
});

// A region or a key changed in the app is in force at the next call: the client made with the old one is dropped.
onConfigChange(resetVertexClient);
