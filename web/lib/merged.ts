import type { ResolvedFrom } from "./types";

// A merged claim's address (#884). A merge leaves the absorbed claim as an
// alias "so that existing references still resolve" (constitution §5): the
// API answers a read of the alias with the survivor's record and
// `resolved_from`, and the pages under /claims/<alias> redirect to the
// survivor, carrying the alias in `merged_from` so the survivor's page can
// say where the reader came from. The redirect is temporary, not permanent:
// a merge can be reversed, and the alias is then a claim of its own again.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a page under /claims/<requested> should send the reader, or null
 * when the record it loaded is the requested claim's own. `view` is the
 * page's suffix ("", "/history", "/map").
 */
export function mergedRedirectPath(
  detail: { claim: { id: string }; resolved_from?: ResolvedFrom | null } | null,
  requestedId: string,
  view: "" | "/history" | "/map" = "",
): string | null {
  if (!detail?.resolved_from) return null;
  const survivorId = detail.claim.id;
  if (!survivorId || survivorId.toLowerCase() === requestedId.toLowerCase()) return null;
  return `/claims/${encodeURIComponent(survivorId)}${view}?merged_from=${encodeURIComponent(requestedId)}`;
}

/** The `merged_from` query value when it could be a claim id, else null. */
export function mergedFromParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * What the "merged from" line says about how the absorbed claim stood to
 * this one. An opposed merge is the case a reader must not miss: the claim
 * they followed a link to stated the opposite, so this page's verdict reads
 * the other way round for it.
 */
export function mergedFromRelation(from: ResolvedFrom): string {
  if (from.stance_relation === "opposed") {
    return (
      "It stated the opposite of this claim, so what this page finds for this claim " +
      "it finds against that one."
    );
  }
  if (from.stance_relation === "same") return "It stated the same proposition.";
  return "The record does not say whether it stated this proposition or its opposite.";
}
