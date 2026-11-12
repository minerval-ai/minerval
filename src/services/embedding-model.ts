/**
 * The one embedding model, and the size of its vectors. Every vector in the
 * graph is compared with every other, so they must all come from the same
 * model: the mirror feed states these two with the vectors it carries, and
 * a deployment applies a batch only when they are its own
 * (mirror-apply-service.ts). Kept apart from embedding-service.ts so that
 * reading the name does not load the provider's client.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
