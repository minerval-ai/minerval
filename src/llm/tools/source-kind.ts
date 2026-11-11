/**
 * The source_kind field the recording tools share: an agent that records a
 * source says what kind of document it is, from the graph's one list
 * (SOURCE_KIND_DESCRIPTIONS in src/schemas/common.ts). A kind stated while
 * citing fills in where the source has none more specific; the provenance
 * tools, used by an agent that opened the document, correct it.
 */
import {
  SOURCE_KIND_GUIDANCE,
  STATABLE_SOURCE_KINDS,
  statedSourceKind,
} from "../../schemas/common.js";
import { recordSourceKind, type SourceKindOutcome } from "../../services/source-service.js";

export const SOURCE_KIND_PROPERTY = {
  type: "string",
  enum: [...STATABLE_SOURCE_KINDS],
  description:
    SOURCE_KIND_GUIDANCE +
    " It is taken where the source has no more specific kind recorded, and the result says what the source's kind now is.",
} as const;

/** Why `value` cannot be taken as a source kind, or null when it can (or none was given). */
export function sourceKindRefusal(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return statedSourceKind(value)
    ? null
    : `source_kind must be one of ${STATABLE_SOURCE_KINDS.join(", ")} (got "${String(value)}"). Omit it if none fits.`;
}

/** Record the kind a tool call stated for its source; nothing when it stated none. Check sourceKindRefusal first. */
export async function applyStatedSourceKind(
  sourceId: string,
  value: unknown
): Promise<SourceKindOutcome | Record<string, never>> {
  const kind = statedSourceKind(value);
  return kind ? recordSourceKind(sourceId, kind) : {};
}
