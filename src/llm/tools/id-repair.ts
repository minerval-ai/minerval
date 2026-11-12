/**
 * Reading a mistyped id against what the run has seen (llm/seen-ids.ts):
 * the repair the graph reads make, and the candidates a write's refusal
 * offers instead.
 *
 * A read may be repaired. It writes nothing, the corrected read says it was
 * corrected and names both ids, and the rule needs exactly one candidate, so
 * the worst a repair can do is show the model a node it then sees is not the
 * one it meant. A write is never repaired: an edge, a link or an instance
 * landed on a guessed node is a change to the graph that someone else has to
 * find and undo. A write given an id that names nothing refuses, and lists
 * the nearest ids the run has seen with their wording so the model can pick
 * one and call again.
 */
import { rawQuery } from "../../db/client.js";
import {
  describeIdShape,
  isUuid,
  seenIdsInRun,
  type IdRepairRule,
  type SeenIds,
} from "../seen-ids.js";

/** How many near ids a miss lists. */
export const NEAREST_SEEN_LIMIT = 5;
/** How many of the nearest the record is asked for before the ones that are not of the kind are dropped. */
const NEAREST_POOL = 20;
const NEAREST_TEXT_CHARS = 160;

export type IdTarget = "node" | "argument";

export interface NearSeenId {
  id: string;
  /** A node's canonical form, or an argument's name. */
  text: string | null;
  /** For an argument: the node it argues for. */
  claim_id?: string;
}

function clip(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NEAREST_TEXT_CHARS ? `${flat.slice(0, NEAREST_TEXT_CHARS - 1)}…` : flat;
}

/**
 * The ids nearest `requested` that this run has seen and that are of the
 * kind asked for (a node for a claim id, an argument for an argument id),
 * nearest first, each with its wording as the graph holds it. `first` puts
 * ids ahead of the ranking (an ambiguous repair's candidates). When the
 * graph cannot be asked, the record's own wording is listed instead.
 */
export async function nearestSeenIds(
  record: SeenIds | null,
  requested: unknown,
  target: IdTarget,
  first: readonly string[] = []
): Promise<NearSeenId[]> {
  if (!record || record.size === 0) return [];
  const ranked = record.nearest(requested, NEAREST_POOL).map((s) => s.id);
  const pool = [...new Set([...first, ...ranked])];
  try {
    const rows =
      target === "argument"
        ? await rawQuery<{ id: string; text: string | null; claim_id: string }>(
            `SELECT id, name AS text, claim_id FROM arguments WHERE id = ANY($1::uuid[])`,
            [pool]
          )
        : await rawQuery<{ id: string; text: string | null }>(
            `SELECT id, text FROM claims WHERE id = ANY($1::uuid[])`,
            [pool]
          );
    const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
    return pool
      .filter((id) => byId.has(id))
      .slice(0, NEAREST_SEEN_LIMIT)
      .map((id) => {
        const r = byId.get(id)! as { id: string; text: string | null; claim_id?: string };
        return { id, text: clip(r.text), ...(r.claim_id ? { claim_id: r.claim_id } : {}) };
      });
  } catch {
    return pool
      .map((id) => record.get(id)!)
      .filter((s) => s && s.text)
      .slice(0, NEAREST_SEEN_LIMIT)
      .map((s) => ({ id: s.id, text: s.text }));
  }
}

const WHAT: Record<IdTarget, { noun: string; field: string }> = {
  node: { noun: "node", field: "claim_id" },
  argument: { noun: "argument", field: "argument_id" },
};

/**
 * Why an id that named nothing was not corrected, in a sentence or two the
 * model can act on: what the run saw it as when the run saw it, and why no
 * id the run has seen was taken for it. (A malformed id's shape is already
 * in the miss.) Nothing is said outside a tool loop, where there is no
 * record to have corrected against.
 */
function unresolvedReason(
  record: SeenIds | null,
  requested: unknown,
  target: IdTarget,
  outcome: { ambiguous: readonly string[]; triedNotOfKind: string | null }
): string {
  if (!record) return "";
  const { noun } = WHAT[target];
  const article = noun === "argument" ? "an" : "a";
  const parts: string[] = [];
  const seen = record.get(requested);
  if (seen && seen.seenAs.length > 0) {
    parts.push(
      `This run has seen that id, as \`${seen.seenAs.join("`, `")}\` in an earlier result, but it is ` +
        `not ${article} ${noun}'s id.`
    );
  }
  if (record.size === 0) {
    parts.push(`No tool result in this run has shown an id yet: find the ${noun} first, then copy its id.`);
  } else if (outcome.ambiguous.length > 1) {
    parts.push(
      `It is one character away from, or begins like, ${outcome.ambiguous.length} ids this run has ` +
        `seen, so it was not corrected: nearest_seen_ids lists them first.`
    );
  } else if (outcome.triedNotOfKind) {
    parts.push(
      `The one id this run has seen that it resembles, ${outcome.triedNotOfKind}, is not ${article} ` +
        `${noun}'s id either, so it was not corrected.`
    );
  } else {
    parts.push(
      `No id this run has seen is one character away from it or begins like it, so it was not corrected.`
    );
  }
  return " " + parts.join(" ");
}

/**
 * The result of a read whose id named nothing, after the repair: either the
 * corrected read, marked `id_corrected`, or the miss with the reason and
 * the nearest ids. `reread` runs the same read with a corrected id and
 * returns its JSON, or null when that read missed too.
 */
export async function repairRead(opts: {
  target: IdTarget;
  requested: unknown;
  /** The miss the first read answered: its code and text are kept. */
  miss: { code: string; error: string };
  reread: (id: string) => Promise<string | null>;
}): Promise<string> {
  const record = seenIdsInRun();
  // Outside a tool loop there is nothing to correct against.
  if (!record) return JSON.stringify(opts.miss);
  const { noun } = WHAT[opts.target];
  const outcome: { ambiguous: string[]; triedNotOfKind: string | null } = { ambiguous: [], triedNotOfKind: null };
  // The read has already missed, so the id as given is not a candidate,
  // even where the run has seen it (an assessment's id read as a node's).
  const resolution = record.resolve(opts.requested, { excludeExact: true });
  if (resolution.kind === "repaired") {
    const second = await opts.reread(resolution.id);
    if (second !== null) {
      return JSON.stringify({
        id_corrected: {
          requested_id: opts.requested,
          resolved_id: resolution.id,
          rule: resolution.rule,
          note: correctionNote(noun, resolution.id, resolution.rule),
        },
        ...(JSON.parse(second) as Record<string, unknown>),
      });
    }
    // The one id it resembles is something else's (an edge's, an
    // assessment's): not what this read takes.
    outcome.triedNotOfKind = resolution.id;
  } else if (resolution.kind === "ambiguous") {
    outcome.ambiguous = resolution.candidates;
  }
  const nearest = await nearestSeenIds(record, opts.requested, opts.target, outcome.ambiguous);
  return JSON.stringify({
    code: opts.miss.code,
    error:
      `${opts.miss.error}${unresolvedReason(record, opts.requested, opts.target, outcome)}` +
      (nearest.length > 0
        ? ` nearest_seen_ids lists the ${noun}s this run has seen whose ids are closest to it, with ` +
          `their wording; if one is the ${noun} you meant, copy its id exactly and read again.`
        : ""),
    requested_id: opts.requested ?? null,
    nearest_seen_ids: nearest,
  });
}

function correctionNote(noun: string, resolved: string, rule: IdRepairRule): string {
  const how =
    rule === "one_character"
      ? `It is one character away from exactly one id this run has seen`
      : `It begins like exactly one id this run has seen`;
  return (
    `No ${noun} has the id you asked for. ${how}, ${resolved}, and that ${noun} is the one shown ` +
    `here. Check it is the ${noun} you meant, and use ${resolved} from now on. Writes are never ` +
    `corrected this way: a write given a mistyped id is refused.`
  );
}

/**
 * For a write that refuses an id naming nothing: the id asked for and the
 * nearest ids this run has seen, to spread into the refusal. Never
 * corrects, and never throws: a refusal is not made to fail by its
 * candidates. Empty outside a tool loop.
 */
export async function writeIdCandidates(
  requested: unknown,
  target: IdTarget = "node"
): Promise<{
  code?: "CLAIM_NOT_FOUND" | "ARGUMENT_NOT_FOUND";
  requested_id?: unknown;
  nearest_seen_ids?: NearSeenId[];
  correction?: string;
}> {
  const record = seenIdsInRun();
  if (!record) return {};
  try {
    const nearest = await nearestSeenIds(record, requested, target);
    const shape = describeIdShape(requested);
    return {
      // A refusal carries a miss code, so the run's record does not take
      // the id it echoes for one the run was shown.
      code: target === "argument" ? "ARGUMENT_NOT_FOUND" : "CLAIM_NOT_FOUND",
      requested_id: requested ?? null,
      nearest_seen_ids: nearest,
      correction:
        (shape ? `The id is not well-formed: ${shape}. ` : "") +
        `This tool writes, so a mistyped id is never corrected here: a guessed target could put ` +
        `the write on the wrong ${WHAT[target].noun}. ` +
        (nearest.length > 0
          ? `nearest_seen_ids lists the ids this run has seen that are closest to it; if one is ` +
            `what you meant, call again with it copied exactly.`
          : `Find the ${WHAT[target].noun} first (a search or a read), then call again with its id copied exactly.`),
    };
  } catch {
    return {};
  }
}

/**
 * For a write that names several nodes (a consistency flag's claim_ids):
 * each given id that names no node, with the nearest ids this run has seen.
 * Empty when every id names a node. Never corrects, never throws.
 */
export async function unresolvedNodeIds(
  ids: readonly unknown[]
): Promise<Array<{ requested_id: unknown; nearest_seen_ids?: NearSeenId[]; correction?: string }>> {
  try {
    const given = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.trim() !== ""))];
    const wellFormed = given.filter((v) => isUuid(v)).map((v) => v.trim());
    const found =
      wellFormed.length === 0
        ? new Set<string>()
        : new Set(
            (
              await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = ANY($1::uuid[])`, [wellFormed])
            ).map((r) => String(r.id).toLowerCase())
          );
    const missing = given.filter((v) => !isUuid(v) || !found.has(v.trim().toLowerCase()));
    return await Promise.all(
      missing.map(async (v) => {
        const { code: _code, ...candidates } = await writeIdCandidates(v);
        return { ...candidates, requested_id: v };
      })
    );
  } catch {
    return [];
  }
}

/**
 * The refusal for a write the database refused for a malformed uuid
 * (22P02), naming each id-like field of the input that is not a uuid and
 * the nearest ids for it, instead of the bare syntax error.
 */
export async function malformedIdRefusal(input: Record<string, unknown>): Promise<string> {
  const bad = Object.entries(input).filter(
    ([k, v]) => k.endsWith("_id") && typeof v === "string" && v.trim() !== "" && !isUuid(v)
  );
  const unresolved = await Promise.all(
    bad.map(async ([field, value]) => {
      const { code: _code, ...candidates } = await writeIdCandidates(value);
      return { field, ...candidates };
    })
  );
  return JSON.stringify({
    success: false,
    code: "INVALID_CLAIM_ID",
    message:
      `The database refused this call at an id that is not a uuid: ` +
      (bad.length > 0
        ? bad.map(([field, value]) => `${field} ${JSON.stringify(value)} (${describeIdShape(value)})`).join("; ")
        : "an id in the input is not a well-formed uuid") +
      `. This tool writes, so the id was not corrected. Call again with the id copied exactly from a ` +
      `tool result` +
      (unresolved.some((u) => (u.nearest_seen_ids?.length ?? 0) > 0)
        ? `; each entry of \`unresolved\` lists the nearest ids this run has seen.`
        : `.`),
    unresolved,
  });
}
