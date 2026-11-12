import { z } from "zod";

/** Request bodies for the browser-extension endpoints (#72). */

// Page text is capped well below the extractor's comfort zone: the extension
// sends readable content, not raw HTML, and 200k chars ≈ a very long article.
export const extensionAnalyzeBody = z.object({
  url: z.string().url(),
  title: z.string().max(500).optional(),
  content: z.string().min(80).max(200_000),
  // The reader agrees to share the result with other readers of this page,
  // if the server can confirm the page is public. Absent means no: older
  // clients never asked their readers.
  share: z.boolean().optional(),
});

export const sharedPrefixQuery = z.object({
  prefix: z.string().regex(/^[0-9a-f]{4}$/),
});

export const sharedHashParams = z.object({
  url_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const extensionAnalysisParams = z.object({
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ExtensionAnalyzeBody = z.infer<typeof extensionAnalyzeBody>;
