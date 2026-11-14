/**
 * What a running agent turn has done so far, for whoever is waiting on it:
 * the tool each step called and what it was pointed at. The Assistant's
 * turn and the Grantmaker's granting-conversation turn both keep it, so a
 * caller polling a turn that spends minutes in tools before it writes a word
 * sees which step it is on.
 */

/** One step of a running turn: the tool, and what it was pointed at. */
export interface TurnStep {
  tool: string;
  about: string | null;
}

/** How many of the latest steps a turn keeps for its readers. */
export const ACTIVITY_KEPT = 12;

/** The argument that says what a call was about, cut short. */
export function aboutOf(input: Record<string, unknown>): string | null {
  for (const key of ["query", "q", "title", "text", "claim", "task", "message", "url", "name", "slug", "sql", "claim_id", "node_id"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.replace(/\s+/g, " ").trim();
      return line.length > 90 ? `${line.slice(0, 90)}…` : line;
    }
  }
  return null;
}
