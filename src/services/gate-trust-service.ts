/**
 * How far a gate's people have come toward leaving it to the Redactor
 * (docs/the-gate.md, "Toward the Redactor's decision").
 *
 * A gate starts with a person deciding after the Redactor (gate-kinds.ts,
 * STARTING_MODE), and the aim is a gate where the Redactor decides and
 * nobody needs to look. What moves a gate from one to the other is its
 * people's trust that the Redactor decides as they would, and the record
 * already says whether it does: each item a person decided was either let
 * through as the Redactor proposed, or changed. This counts the two, by
 * kind, over a recent window, and says where a kind has been approved as
 * proposed often enough that handing it to the Redactor is worth weighing.
 *
 * It is counts. No item is named and nothing of any text is read, so it is
 * read as the tables' owner: the acts are on the destination side and the
 * removals at the page's label, which may share no label.
 */
import { rawQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { GATE_KINDS, type GateKind, type GateMode, startingMode } from "./gate-kinds.js";
import { gateOf, liveSettings } from "./gate-settings-service.js";

const REASON =
  "How often a gate's people approved the Redactor's proposals as they stood is counted from acts on the destination side and removals at the page's label, which may share no label. Counts only.";

/** The window the counts are over: recent enough to describe the policy in force, long enough to hold a fair number of items. */
export const AGREEMENT_WINDOW_DAYS = 90;

/**
 * When a kind's record is worth bringing to its authorities as a reason to
 * hand it to the Redactor: at least this many items decided by a person in
 * the window, and at least this share of them approved as proposed. These
 * decide nothing. They choose when a suggestion is shown; the authorities
 * decide, and the Redactor's referrals still reach a person afterwards.
 */
export const SUGGEST_AFTER_DECIDED = 20;
export const SUGGEST_AT_SHARE = 0.9;

export interface KindAgreement {
  kind: GateKind;
  kind_in_words: string;
  /** Items a person decided in the window. */
  decided: number;
  /** Of those, the ones let through as the Redactor proposed: nothing removed, held, delayed or lifted by a person, and no referral to hold overruled. */
  as_proposed: number;
  /** Where the record makes handing this kind to the Redactor worth weighing. */
  suggests_the_redactor: boolean;
}

export interface GateAgreement {
  window_days: number;
  decided: number;
  as_proposed: number;
  by_kind: KindAgreement[];
  in_words: string;
}

const suggests = (decided: number, asProposed: number) => decided >= SUGGEST_AFTER_DECIDED && asProposed / decided >= SUGGEST_AT_SHARE;

/** How often the people at a gate approved the Redactor's proposals as they stood, by kind. */
export async function gateAgreement(boundaryId: string): Promise<GateAgreement> {
  const rows = await withSystemClearance(REASON, () =>
    rawQuery<{ kind: GateKind; decided: number; as_proposed: number }>(
      `WITH decided AS (
         SELECT p.id, r.kind FROM release_pages p JOIN releases r ON r.id = p.release_id
          WHERE r.boundary_id = $1 AND p.opened_at > now() - make_interval(days => $2)
            AND EXISTS (SELECT 1 FROM release_acts a WHERE a.page_id = p.id AND a.by = 'person')
       )
       SELECT d.kind, count(*)::int AS decided,
              count(*) FILTER (WHERE
                NOT EXISTS (SELECT 1 FROM release_acts a WHERE a.page_id = d.id AND a.by = 'person' AND a.act <> 'consented')
                AND NOT EXISTS (SELECT 1 FROM release_removals m JOIN release_parts t ON t.id = m.part_id
                                 WHERE t.page_id = d.id AND m.made_by IS NOT NULL AND m.taken_back_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM release_acts a WHERE a.page_id = d.id AND a.act = 'referred' AND a.reason = 'hold')
              )::int AS as_proposed
         FROM decided d GROUP BY d.kind ORDER BY d.kind`,
      [boundaryId, AGREEMENT_WINDOW_DAYS]
    )
  );
  const decided = rows.reduce((n, r) => n + r.decided, 0);
  const asProposed = rows.reduce((n, r) => n + r.as_proposed, 0);
  return {
    window_days: AGREEMENT_WINDOW_DAYS,
    decided,
    as_proposed: asProposed,
    by_kind: rows.map((r) => ({
      kind: r.kind,
      kind_in_words: GATE_KINDS[r.kind] ?? r.kind,
      decided: r.decided,
      as_proposed: r.as_proposed,
      suggests_the_redactor: suggests(r.decided, r.as_proposed),
    })),
    in_words:
      decided === 0
        ? `Nobody has decided an item at this gate in the last ${AGREEMENT_WINDOW_DAYS} days.`
        : `In the last ${AGREEMENT_WINDOW_DAYS} days a person decided ${decided} item${decided === 1 ? "" : "s"} here and let ${asProposed} through as the Redactor proposed. ` +
          `Where a kind is let through as proposed nearly every time, its people can hand it to the Redactor and write what they still want to see into the policy's guidelines for asking a person.`,
  };
}

/**
 * How the gate as a whole treats each kind, for every party that has not
 * said otherwise: the setting for the whole boundary, or the starting
 * position. Narrower settings and a party's own are counted beside it.
 */
export async function modesAtGate(boundaryId: string): Promise<{ modes: Record<GateKind, GateMode>; narrower_settings: number }> {
  const gate = await gateOf(boundaryId);
  const settings = await liveSettings(boundaryId);
  const whole = settings.filter((s) => s.scope === "boundary" && s.party_id === null);
  const modes = {} as Record<GateKind, GateMode>;
  for (const kind of Object.keys(GATE_KINDS) as GateKind[]) {
    const own = [...whole].reverse().find((s) => s.kind === kind) ?? [...whole].reverse().find((s) => s.kind === "*");
    modes[kind] = own ? own.mode : startingMode(kind, gate?.to_outside ?? false);
  }
  return { modes, narrower_settings: settings.length - whole.length };
}
