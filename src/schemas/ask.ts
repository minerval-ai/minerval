import { z } from "zod";

/**
 * Request body for POST /ask, "Ask the graph" (#312): a conversation plus
 * where it starts from. The extension's POST /extension/chat shares the
 * pieces (src/schemas/extension.ts).
 */

/** A conversation so far; the last turn is the reader's question. */
export const chatMessages = z
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
  });

/** The page the extension's reader has open, with its annotated claims. */
export const chatPageContext = z.object({
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
});

export const askContext = z.discriminatedUnion("kind", [
  // A question to the graph as a whole: the site's ask page.
  z.object({ kind: z.literal("graph") }),
  // A question about one claim: a claim page's ask box.
  z.object({ kind: z.literal("claim"), claim_id: z.string().uuid() }),
  // A question about a web page: the browser extension's popup.
  chatPageContext.extend({ kind: z.literal("page") }),
]);

export const askBody = z.object({
  messages: chatMessages,
  context: askContext.default({ kind: "graph" }),
});

export type AskBody = z.infer<typeof askBody>;
export type AskContext = z.infer<typeof askContext>;
