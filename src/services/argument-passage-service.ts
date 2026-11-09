/**
 * Argument passages at ingestion, and their placement by the Steward (#541).
 *
 * The Extractor records, on each claim it proposes, the passages where the
 * document reasons about it. Once the claim is linked or minted, each
 * passage is matched within the claim's arguments, retired ones included
 * (agents/argument-matcher.ts). A match is recorded as an instance of that
 * argument. A passage that matches none is kept on the claim, unplaced,
 * since only the claim's Steward creates arguments (Part VIII); its Steward
 * sees it in get_claim and places it on an argument or dismisses it.
 */
import { rawQuery } from "../db/client.js";
import { matchArgumentPassage, type ArgumentCandidate } from "../llm/agents/argument-matcher.js";
import type { ArgumentPassage } from "../llm/agents/extractor.js";
import {
  INGEST_RECORDER,
  findArgumentInstance,
  insertArgumentInstance,
  insertUnplacedPassage,
} from "./argument-instance-service.js";

/** The claim's arguments as candidates for a passage: live first, then retired. */
export async function argumentCandidates(claimId: string): Promise<ArgumentCandidate[]> {
  const rows = await rawQuery<{
    id: string;
    name: string | null;
    stance: string;
    shows: unknown;
    content: string;
    retired_at: Date | null;
  }>(
    `SELECT id, name, stance, shows, content, retired_at
       FROM arguments
      WHERE claim_id = $1 AND merged_into IS NULL
      ORDER BY (retired_at IS NOT NULL), created_at`,
    [claimId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    stance: r.stance,
    shows: r.shows,
    written_form: r.content,
    retired: r.retired_at !== null,
  }));
}

/**
 * Record one source's argument passages on a claim. Returns how many were
 * placed on an argument, left unplaced, or skipped as already recorded.
 */
export async function recordArgumentPassages(input: {
  claimId: string;
  claimText: string;
  claimKind: string;
  sourceId: string;
  /** The source's instance stance on the claim. */
  sourceStance: string | null;
  passages: readonly ArgumentPassage[];
}): Promise<{ placed: number; unplaced: number; skipped: number }> {
  const counts = { placed: 0, unplaced: 0, skipped: 0 };
  // A question has no arguments of its own (§7a).
  if (input.claimKind === "question" || input.passages.length === 0) return counts;
  const candidates = await argumentCandidates(input.claimId);

  for (const passage of input.passages) {
    // A source read again proposes the same passages: one record each.
    const [seen] = await rawQuery<{ id: string }>(
      `SELECT ai.id FROM argument_instances ai
         LEFT JOIN arguments a ON a.id = ai.argument_id
        WHERE ai.source_id = $1 AND ai.verbatim_text = $2
          AND (ai.claim_id = $3 OR a.claim_id = $3)
        LIMIT 1`,
      [input.sourceId, passage.verbatim_text, input.claimId]
    );
    if (seen) {
      counts.skipped++;
      continue;
    }
    const placement = await matchArgumentPassage({
      claim: { text: input.claimText, kind: input.claimKind },
      sourceStance: input.sourceStance,
      passage,
      candidates,
    });
    if (placement.argument_id) {
      // One instance per (argument, source): a second passage from the same
      // source making the same argument adds nothing.
      const existing = await findArgumentInstance({
        argumentId: placement.argument_id,
        sourceId: input.sourceId,
        speaker: null,
      });
      if (existing) {
        counts.skipped++;
        continue;
      }
      await insertArgumentInstance({
        argumentId: placement.argument_id,
        sourceId: input.sourceId,
        verbatimText: passage.verbatim_text,
        context: passage.context,
        stance: placement.stance,
        reading: placement.reading,
        statedShows: null,
        createdBy: INGEST_RECORDER,
      });
      counts.placed++;
    } else {
      await insertUnplacedPassage({
        claimId: input.claimId,
        sourceId: input.sourceId,
        verbatimText: passage.verbatim_text,
        context: passage.context,
        stance: placement.stance,
        direction: placement.direction,
      });
      counts.unplaced++;
    }
  }
  return counts;
}
