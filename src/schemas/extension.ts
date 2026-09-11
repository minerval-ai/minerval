import { z } from "zod";

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

export const extensionChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20_000),
      })
    )
    .min(1)
    .max(40)
    .refine((msgs) => msgs[msgs.length - 1]!.role === "user", {
      message: "last message must be from the user",
    }),
  page: z
    .object({
      url: z.string().url().nullable().default(null),
      title: z.string().max(500).nullable().default(null),
      claims: z
        .array(
          z.object({
            verbatim_text: z.string().max(2_000),
            verdict: z.string().max(40),
            claim_id: z.string().uuid().nullable().default(null),
            canonical_form: z.string().max(2_000).nullable().default(null),
            status: z.string().max(40).nullable().default(null),
          })
        )
        .max(50)
        .default([]),
    })
    .default({ url: null, title: null, claims: [] }),
});

export type ExtensionAnalyzeBody = z.infer<typeof extensionAnalyzeBody>;
export type ExtensionChatBody = z.infer<typeof extensionChatBody>;
