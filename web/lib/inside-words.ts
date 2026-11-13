// Words the pages for showings, the release queue and sending outside share.
//
// The two lists of reasons are the API's own (HOLD_REASONS in
// src/services/release-gate-service.ts, END_REASONS in
// src/services/showing-service.ts). The API takes a reason by its key and
// says it on the other side in these words; it serves neither list, so they
// are written out here, word for word, and a key it does not know is
// refused there.

import type { ShownVersion } from "./inside-api";

export const HOLD_REASONS: Record<string, string> = {
  under_review: "still being reviewed",
  confidentiality: "confidential to the party",
  legal: "a legal or contractual reason",
  security: "a safety or security reason",
  timing: "not to be shown yet",
  disputed: "the party disputes what it says",
  no_reason_given: "no reason given",
};

export const END_REASONS: Record<string, string> = {
  no_longer_needed: "it is no longer needed",
  replaced: "another showing replaces it",
  asked_in_error: "it was asked for in error",
  no_reason_given: "no reason given",
};

/** One of the four states a node under a showing is in, as the people it is shown to are told. */
export function stateOfVersion(v: Pick<ShownVersion, "state" | "held_because" | "held_for" | "parts_held" | "of_parts" | "held_kinds">): string {
  switch (v.state) {
    case "not_yet_assessed":
      return "Not yet assessed";
    case "released_whole":
      return `Released whole${v.of_parts ? `: all ${v.of_parts} parts` : ""}`;
    case "released_in_part":
      return `Released in part: ${v.parts_held} of ${v.of_parts} parts held (${v.held_kinds})`;
    case "held":
      return `Held${v.held_because ? `: ${v.held_because}` : ""}${v.held_for ? `, for ${v.held_for === "0 hours" ? "less than an hour" : v.held_for}` : ""}`;
    default:
      return "Not recorded";
  }
}

/** Removals counted by category, in words: "2 passages removed (commercial figures: 2)". */
export function removalsInWords(removals: Record<string, number> | undefined): string {
  const entries = Object.entries(removals ?? {});
  const n = entries.reduce((sum, [, c]) => sum + c, 0);
  if (n === 0) return "no passage removed under the policy";
  return `${n} passage${n === 1 ? "" : "s"} removed under the policy (${entries.map(([c, k]) => `${c}: ${k}`).join(", ")})`;
}

export function formWords(form: string): string {
  return form === "standing" ? "standing" : "once";
}

/** A part's kind as the API's fixed words say it, with a capital, for the head of a part. */
export function capital(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const KIND_WORDS: Record<string, string> = {
  wording: "the node's wording",
  summary: "a paragraph of the summary",
  reasoning: "a paragraph of reasoning",
  gap: "a gap the page records",
  argument: "an argument",
  "argument:for": "an argument for",
  "argument:against": "an argument against",
  "argument:neutral": "an argument that takes neither side",
  reading: "a source's reading",
  supplier: "a source's supplier and recorded interest, by name",
  stated_view: "a stated view",
  subclaim: "a subclaim with how it bears",
};

/** A part's kind in words, from the descriptor the fingerprint binds. */
export function kindWords(descriptor: string): string {
  return KIND_WORDS[descriptor] ?? KIND_WORDS[descriptor.split(":")[0]!] ?? "a part";
}

// --- file sets -------------------------------------------------------------------

export function bytesInWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const FILE_SET_STATE_WORDS: Record<string, string> = {
  open: "open: files are being uploaded",
  hashing: "being walked and hashed",
  closed: "closed",
  failed: "failed to fill",
};

