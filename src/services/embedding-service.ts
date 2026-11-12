/**
 * Embeddings: the vector for a text, from OpenAI's embeddings API.
 *
 * The text leaves the process here, so both functions first ask whether the
 * `embeddings` service is cleared for the label of the run or request
 * calling them (llm/provider-clearance.ts). Where it is not they throw,
 * and nothing is sent. Most callers already treat a failed embedding as
 * "no vector": a row is written without one and a search falls back to
 * keywords, each as it did when the API was down.
 */
import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { assertProviderCleared } from "../llm/provider-clearance.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const config = loadConfig();
  _client = new OpenAI({
    apiKey: config.openaiApiKey,
    // The SDK's bundled HTTP client (node-fetch) fails with "Premature close"
    // against api.openai.com in some environments (observed on ECS Fargate /
    // Node 22) — every embeddings call errors. Native fetch works reliably
    // there (verified raw fetch + this override both succeed), so force the
    // SDK to use it.
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >["fetch"],
  });
  return _client;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  await assertProviderCleared("embeddings");
  const client = getClient();
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
  });
  return response.data[0]!.embedding;
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  await assertProviderCleared("embeddings");
  const client = getClient();
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
    dimensions: 1536,
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
