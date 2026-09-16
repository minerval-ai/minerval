import { z } from "zod";
import { chatMessages, chatPageContext } from "./ask.js";

/** Request bodies for the browser-extension endpoints (#72). */

// Page text is capped well below the extractor's comfort zone: the extension
// sends readable content, not raw HTML, and 200k chars ≈ a very long article.
export const extensionAnalyzeBody = z.object({
  url: z.string().url(),
  title: z.string().max(500).optional(),
  content: z.string().min(80).max(200_000),
});

export const extensionAnalysisParams = z.object({
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

// The conversation and page shapes are the graph chat's (#312); the
// extension's endpoint is its page mode under the original name.
export const extensionChatBody = z.object({
  messages: chatMessages,
  page: chatPageContext.default({ url: null, title: null, claims: [] }),
});

export type ExtensionAnalyzeBody = z.infer<typeof extensionAnalyzeBody>;
export type ExtensionChatBody = z.infer<typeof extensionChatBody>;
