import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-model.js";

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
  const client = getClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0]!.embedding;
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = getClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
