/**
 * Merged ids resolve to their survivor (#884).
 *
 * A merge leaves the absorbed node "as an alias so that existing references
 * still resolve" (constitution §5). The row was kept and `merged_into`
 * pointed at the survivor, but nothing followed the pointer: a read of an
 * absorbed id returned the dead row (`state: "merged"`, a stale verdict, no
 * instances) with nothing to say where the claim had gone, and a write
 * addressed to one was refused as "not found".
 *
 * `resolveClaimId` is the one place the pointer is followed. Every read
 * that takes a node id goes through it (get_claim and the graph walks for
 * agents and MCP, and the REST routes on /claims/:claim_id through
 * routes/claim-alias-hooks.ts), so the three surfaces cannot disagree, and
 * the three kinds are covered at once because claims, quantities and
 * questions share the table. `mergedAliasRefusal` is its counterpart for
 * writes: a write is never redirected, because the caller wrote for the
 * node it named and an opposed merge inverts what that node said; it is
 * refused, and the refusal names the survivor.
 */
import { rawQuery } from "../db/client.js";

/**
 * How many `merged_into` hops a resolution follows. A chain forms when a
 * survivor is itself later merged; real chains are a hop or two. The bound
 * exists so a corrupt pointer (a cycle, which no code path writes but no
 * constraint forbids) costs a bounded read instead of an endless one; it is
 * not a limit any agent works to.
 */
export const MAX_ALIAS_HOPS = 16;

/** z.guid()'s rule: any hex uuid. An id that is not one names no node. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StanceRelation = "same" | "opposed";

/** The alias a read was addressed to, served beside the survivor's view. */
export interface ResolvedFrom {
  /** The id the caller asked for: the absorbed node. */
  id: string;
  /** The absorbed node's own wording, as it stood when it was merged. */
  canonical_form: string;
  /**
   * How the absorbed node stood to the survivor: `same`, or `opposed` when
   * it was merged with its negation, so everything the survivor's view says
   * is about the opposite of what the caller's id stated. Composed over the
   * chain when the id was absorbed in more than one step. null when a
   * merge's record does not say.
   */
  stance_relation: StanceRelation | null;
  /** When the absorbed node was merged (its own merge, the first hop). */
  merged_at: string | null;
}

export interface ClaimIdResolution {
  /** The node to read: the survivor, or the id as given when it is no alias. */
  id: string;
  resolvedFrom: ResolvedFrom | null;
}

/** What every surface says about `resolved_from`, so the three agree. */
export const RESOLVED_FROM_DESCRIPTION =
  "An id that was merged into another node resolves to the survivor: the " +
  "read returns the survivor's record under the survivor's id, with " +
  "`resolved_from` (`id`, the id you asked for; `canonical_form`, its own " +
  "wording; `stance_relation`; `merged_at`) saying so. Absent when the id " +
  "is the node's own. Read `stance_relation` before you use the result: " +
  "`same` means your id stated the survivor's proposition; `opposed` means " +
  "it was merged with its negation, so the survivor's status, credence and " +
  "argument stances are about the OPPOSITE of what your id stated (a " +
  "survivor that is well supported means the claim you asked about is " +
  "not). null means the merge's record does not say. Use the survivor's id " +
  "from then on; a write addressed to a merged id is refused and names the " +
  "survivor.";

/** The JSON schema of `resolved_from`, for route responses. */
export const RESOLVED_FROM_SCHEMA = {
  type: "object",
  nullable: true,
  description: RESOLVED_FROM_DESCRIPTION,
  properties: {
    id: { type: "string", format: "uuid" },
    canonical_form: { type: "string" },
    stance_relation: { type: "string", enum: ["same", "opposed"], nullable: true },
    merged_at: { type: "string", format: "date-time", nullable: true },
  },
} as const;

interface ChainRow {
  id: string;
  merged_into: string | null;
  text: string;
  updated_at: Date | string;
  hop: number;
}

/**
 * Follow `merged_into` from `claimId` to the node it now names. Returns null
 * when no node has the id. An id that is its own node comes back unchanged
 * with `resolvedFrom` null. A chain that never reaches a live end (a cycle,
 * or one longer than MAX_ALIAS_HOPS) is not resolved: the id comes back as
 * given, so the read shows the row it names rather than an arbitrary link of
 * a broken chain. A malformed id throws the database's own error (22P02),
 * as a direct read of the row does.
 */
export async function resolveClaimId(claimId: string): Promise<ClaimIdResolution | null> {
  const chain = await rawQuery<ChainRow>(
    `WITH RECURSIVE chain AS (
       SELECT c.id, c.merged_into, c.text, c.updated_at, 0 AS hop, ARRAY[c.id] AS seen
         FROM claims c
        WHERE c.id = $1
       UNION ALL
       SELECT n.id, n.merged_into, n.text, n.updated_at, chain.hop + 1, chain.seen || n.id
         FROM chain
         JOIN claims n ON n.id = chain.merged_into
        WHERE chain.hop < $2 AND NOT (n.id = ANY(chain.seen))
     )
     SELECT id, merged_into, text, updated_at, hop FROM chain ORDER BY hop`,
    [claimId, MAX_ALIAS_HOPS]
  );
  const requested = chain[0];
  if (!requested) return null;
  if (!requested.merged_into) return { id: requested.id, resolvedFrom: null };

  const survivor = chain[chain.length - 1]!;
  if (survivor.merged_into) {
    console.warn(
      `[claim-alias] ${requested.id}: merged_into chain does not end within ` +
        `${MAX_ALIAS_HOPS} hops (a cycle or a corrupt pointer); serving the row as given`
    );
    return { id: requested.id, resolvedFrom: null };
  }

  // Each hop's own merge, from the Curator's log: the newest unreversed
  // merge that absorbed that node. A node un-merged and merged again has
  // one reversed event and one live one.
  const hops = chain.slice(0, -1);
  const events = await rawQuery<{
    loser_id: string;
    survivor_id: string;
    stance_relation: string | null;
    created_at: Date | string;
  }>(
    `SELECT DISTINCT ON (payload->>'loser_id')
            payload->>'loser_id' AS loser_id,
            payload->>'survivor_id' AS survivor_id,
            payload->>'stance_relation' AS stance_relation,
            created_at
       FROM reconciliation_events
      WHERE operation = 'merge' AND reversed = false
        AND payload->>'loser_id' = ANY($1::text[])
      ORDER BY payload->>'loser_id', created_at DESC`,
    [hops.map((h) => h.id)]
  ).catch((err) => {
    // The pointer is the fact; the log only describes it. Losing the
    // description must not lose the read.
    console.error(`[claim-alias] merge events failed for ${requested.id}: ${err instanceof Error ? err.message : err}`);
    return [];
  });
  const eventByLoser = new Map(events.map((e) => [e.loser_id, e]));

  // Two opposed merges in a row put the id back on its own side.
  let relation: StanceRelation | null = "same";
  for (const hop of hops) {
    const event = eventByLoser.get(hop.id);
    const step = event && event.survivor_id === hop.merged_into ? event.stance_relation : null;
    if (step !== "same" && step !== "opposed") {
      relation = null;
      break;
    }
    if (step === "opposed") relation = relation === "same" ? "opposed" : "same";
  }

  const firstEvent = eventByLoser.get(requested.id);
  // The merge stamps the absorbed row's updated_at, and nothing writes to
  // an alias afterwards, so it stands in where the event is missing.
  const mergedAt = firstEvent?.created_at ?? requested.updated_at ?? null;

  return {
    id: survivor.id,
    resolvedFrom: {
      id: requested.id,
      canonical_form: requested.text,
      stance_relation: relation,
      merged_at: mergedAt == null ? null : mergedAt instanceof Date ? mergedAt.toISOString() : new Date(mergedAt).toISOString(),
    },
  };
}

export interface MergedAliasRefusal {
  survivorId: string;
  stanceRelation: StanceRelation | null;
  /** What to tell the writer: that the node was merged, and into which. */
  message: string;
}

/**
 * For a write: null when `claimId` may be written to as far as merging goes
 * (it is its own node, or names nothing, which the caller's own check
 * reports), else the refusal that names the survivor. The pattern arguments
 * already use ("Argument X was merged into Y; name that argument"). A write
 * is refused rather than redirected because the writer composed it for the
 * node it named: after an opposed merge an argument "for" the alias is an
 * argument against the survivor, and no redirect can know that was meant.
 */
export async function mergedAliasRefusal(claimId: unknown): Promise<MergedAliasRefusal | null> {
  if (typeof claimId !== "string" || !UUID_RE.test(claimId)) return null;
  const resolution = await resolveClaimId(claimId);
  const from = resolution?.resolvedFrom;
  if (!resolution || !from) return null;
  return {
    survivorId: resolution.id,
    stanceRelation: from.stance_relation,
    message:
      `Node ${from.id} was merged into ${resolution.id}; address that node. ` +
      (from.stance_relation === "opposed"
        ? `It was merged with its negation: ${resolution.id} states the opposite of what ` +
          `${from.id} stated, so read its wording (get_claim) and restate what you are ` +
          `writing against it before you send it. `
        : "") +
      `Nothing was written.`,
  };
}

/**
 * For an agent's write tool: the refusal text when any of the node ids its
 * input names (under `keys`) was merged, else null. One guard at the head
 * of a tool executor covers every write in it that takes another node's id
 * (an edge, a link, an instance), where an id that merely exists used to be
 * enough and the write landed on the dead row.
 */
export async function mergedInputRefusal(
  input: Record<string, unknown>,
  keys: readonly string[]
): Promise<string | null> {
  const refusals = await mergedAliasRefusals(keys.map((k) => input[k]));
  return refusals.size === 0 ? null : [...refusals.values()].map((r) => r.message).join(" ");
}

/**
 * The refusals for several ids at once, keyed by the id asked: for a write
 * that names more than one node (a link, an edge, a request's targets).
 */
export async function mergedAliasRefusals(claimIds: readonly unknown[]): Promise<Map<string, MergedAliasRefusal>> {
  const out = new Map<string, MergedAliasRefusal>();
  for (const id of new Set(claimIds)) {
    const refusal = await mergedAliasRefusal(id);
    if (refusal) out.set(id as string, refusal);
  }
  return out;
}
