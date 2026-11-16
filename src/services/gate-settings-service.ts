/**
 * A gate's settings (docs/the-gate.md, "Settings").
 *
 * A gate treats an item in one of three ways (GATE_MODES): open, the
 * Redactor decides, or a person decides as well. Its authorities set that
 * for a kind of thing or for every kind, for the whole boundary or for a
 * narrower scope, and for one party's material or for every party that has
 * not said. Two sets of people are a gate's authorities: the deployment's
 * administrators, for the gate as a whole, and the holders of `release` for
 * a party, for that party's material.
 *
 * Which setting an item falls under is read here, each time the gate looks
 * at the item, so a setting changed while an item waits applies to it.
 * What has been released stays released.
 *
 * Setting rows are kept at the label things come from: a scope can name a
 * mandate, a node or a request there, and that such a row exists is not
 * for the other side. The row for the gate as a whole (`gates`) is on the
 * destination side and names nothing.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import {
  GATE_MODES,
  GATE_SCOPES,
  SCOPE_ORDER,
  STARTING_MODE,
  isGateKind,
  isGateMode,
  type GateKind,
  type GateMode,
  type GateScope,
} from "./gate-kinds.js";

const REASON = "A gate's settings are read and written for both sides of a boundary, which may share no label.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(REASON, fn);

export class GateError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export interface GateRow {
  boundary_id: string;
  from_label: string;
  to_label: string | null;
  to_outside: boolean;
  flow: "asked" | "everything";
  backlog_shown: boolean;
  send_as_released: boolean;
  /** The mandate asked to pay for a fresh assessment on the other side when a version here changes; null where nothing is asked. */
  keep_current_mandate: string | null;
  keep_current_micro_usd: number;
  keep_current_since: Date | null;
}

/** The label the destination side's rows are kept at. */
export const destinationOfGate = (g: Pick<GateRow, "to_label">): string => g.to_label ?? PUBLIC_LABEL;

/**
 * The gate of a boundary, with the row for the gate as a whole made the
 * first time it is asked for. A boundary exists once it has a policy
 * (redaction-policy.ts, ensureBoundaryPolicy). Called as the tables' owner.
 */
export async function gateOf(boundaryId: string): Promise<GateRow | null> {
  return asOwner(async () => {
    const [pair] = await rawQuery<{ from_label: string; to_label: string | null; to_outside: boolean }>(
      `SELECT from_label, to_label, to_outside FROM redaction_policies WHERE boundary_id = $1 AND side = 'page' ORDER BY version LIMIT 1`,
      [boundaryId]
    );
    if (!pair) return null;
    const destination = pair.to_label ?? PUBLIC_LABEL;
    await rawQuery(
      `INSERT INTO gates (boundary_id, sensitivity_label) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [boundaryId, destination]
    );
    const [row] = await rawQuery<{
      flow: "asked" | "everything"; backlog_shown: boolean; send_as_released: boolean;
      keep_current_mandate: string | null; keep_current_micro_usd: string; keep_current_since: Date | null;
    }>(
      `SELECT flow, backlog_shown, send_as_released, keep_current_mandate, keep_current_micro_usd, keep_current_since
         FROM gates WHERE boundary_id = $1 AND sensitivity_label = $2`,
      [boundaryId, destination]
    );
    return { boundary_id: boundaryId, ...pair, ...row!, keep_current_micro_usd: Number(row!.keep_current_micro_usd) };
  });
}

/**
 * How the label a gate's things come from is named to a reader of the
 * destination who does not read it: the face that label shows there
 * (label_faces), or null where it shows none. A label's own name is not
 * shown to people who may not read it.
 */
export async function faceOfGate(boundaryId: string): Promise<string | null> {
  return asOwner(async () => {
    const [row] = await rawQuery<{ name: string }>(
      `SELECT f.name FROM redaction_policies p JOIN label_faces f ON f.for_label = p.from_label AND f.sensitivity_label = COALESCE(p.to_label, 'public')
        WHERE p.boundary_id = $1 AND p.side = 'page' AND f.withdrawn_at IS NULL LIMIT 1`,
      [boundaryId]
    ).catch(() => []);
    return row?.name ?? null;
  });
}

export interface SettingRow {
  id: string;
  boundary_id: string;
  kind: GateKind | "*";
  scope: GateScope;
  scope_ref: string | null;
  party_id: string | null;
  mode: GateMode;
  delay_hours: number;
  batch_hours: number;
  set_by: string | null;
  set_holding: string[];
  set_at: Date;
  from_rule: string | null;
}

const SETTING_COLUMNS = `id, boundary_id, kind, scope, scope_ref, party_id, mode, delay_hours, batch_hours, set_by, set_holding, set_at, from_rule`;

export const liveSettings = (boundaryId: string): Promise<SettingRow[]> =>
  asOwner(() =>
    rawQuery<SettingRow>(`SELECT ${SETTING_COLUMNS} FROM gate_settings WHERE boundary_id = $1 AND ended_at IS NULL ORDER BY set_at, id`, [boundaryId])
  );

/** What an item is, as far as a setting's scope asks. */
export interface ItemScope {
  boundaryId: string;
  kind: GateKind;
  /** The label the item was produced at. */
  fromLabel: string;
  nodeId: string | null;
  /** The request, mandate, message or ledger row the item is about, and the row that asked. */
  subjectRef: string | null;
  replyRef: string | null;
  /** The mandates the item is the work of: the one that paid for it, the one it is about. */
  grantIds: readonly string[];
}

/** A halting guard on the walk up from a node to what it sits under. It decides nothing about any item. */
const UNDER_WALK_DEPTH = 40;

async function scopeCovers(setting: SettingRow, item: ItemScope): Promise<boolean> {
  if (setting.scope === "boundary") return true;
  const ref = setting.scope_ref!;
  if (setting.scope === "mandate") return item.grantIds.includes(ref);
  if (setting.scope === "request") {
    if (item.subjectRef === ref || item.replyRef === ref) return true;
    if (!item.nodeId) return false;
    const [bears] = await rawQuery(`SELECT 1 FROM request_targets WHERE request_id = $1 AND claim_id = $2 LIMIT 1`, [ref, item.nodeId]);
    return !!bears;
  }
  // 'under': the item's node, or a node its request bears on, is the scope's node or sits under it.
  const nodes = item.nodeId
    ? [item.nodeId]
    : item.kind === "answer" || item.kind === "taken_up"
      ? (await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM request_targets WHERE request_id = $1 AND claim_id IS NOT NULL`, [item.subjectRef])).map((r) => r.claim_id)
      : [];
  if (nodes.length === 0) return false;
  if (nodes.includes(ref)) return true;
  const [found] = await rawQuery(
    `WITH RECURSIVE up(id, depth) AS (
       SELECT unnest($1::uuid[]), 0
       UNION
       SELECT r.parent_claim_id, up.depth + 1 FROM claim_relationships r JOIN up ON r.child_claim_id = up.id
        WHERE up.depth < $3 AND r.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$4::text]))
     ) SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
    [nodes, ref, UNDER_WALK_DEPTH, item.fromLabel]
  );
  return !!found;
}

export interface ModeFound {
  mode: GateMode;
  /** The setting it came from; null where it is the gate's starting position. */
  settingId: string | null;
  /** How wide that setting is, and when it was set. */
  scope: GateScope | null;
  setAt: Date | null;
  /** The setting's standing delay: hours kept back from when the item was produced, and the batch it then goes with. */
  delayHours: number;
  batchHours: number;
}

/**
 * When an item produced at `at` may go under a setting's standing delay:
 * after the delay, and then at the next multiple of the batch, so that
 * items go together.
 */
export function dueUnder(found: Pick<ModeFound, "delayHours" | "batchHours">, at: Date): Date {
  let due = at.getTime() + found.delayHours * 3_600_000;
  if (found.batchHours > 0) {
    const span = found.batchHours * 3_600_000;
    due = Math.ceil(due / span) * span;
  }
  return new Date(due);
}

/**
 * How the gate treats this item for each party it rests on. A party's own
 * setting is taken before one for the gate as a whole, since release is a
 * party's to give; within either, the narrowest scope that covers the item,
 * and a setting for the item's kind before one for every kind. With no
 * setting it is the starting position for the kind.
 */
export async function modesFor(item: ItemScope, partyIds: readonly string[]): Promise<Map<string, ModeFound>> {
  return asOwner(async () => {
    const rows = await liveSettings(item.boundaryId);
    const covering: SettingRow[] = [];
    for (const r of rows) {
      if (r.kind !== "*" && r.kind !== item.kind) continue;
      if (await scopeCovers(r, item)) covering.push(r);
    }
    const best = (candidates: SettingRow[]): SettingRow | null => {
      for (const scope of SCOPE_ORDER) {
        const at = candidates.filter((c) => c.scope === scope);
        const pick = [...at].reverse().find((c) => c.kind === item.kind) ?? [...at].reverse().find((c) => c.kind === "*");
        if (pick) return pick;
      }
      return null;
    };
    const whole = best(covering.filter((c) => c.party_id === null));
    const out = new Map<string, ModeFound>();
    for (const party of new Set(partyIds)) {
      const own = best(covering.filter((c) => c.party_id === party));
      const pick = own ?? whole;
      out.set(
        party,
        pick
          ? { mode: pick.mode, settingId: pick.id, scope: pick.scope, setAt: pick.set_at, delayHours: pick.delay_hours, batchHours: pick.batch_hours }
          : { mode: STARTING_MODE[item.kind], settingId: null, scope: null, setAt: null, delayHours: 0, batchHours: 0 }
      );
    }
    return out;
  });
}

/** The person setting a gate, as a route resolved them. */
export interface GateAuthority {
  id: string;
  holding: string[];
  administer: boolean;
  releaseParties: readonly string[];
}

const settingView = (r: SettingRow, names: Map<string, string>, setters: Map<string, string>) => ({
  setting_id: r.id,
  kind: r.kind,
  scope: r.scope,
  scope_in_words: GATE_SCOPES[r.scope],
  scope_ref: r.scope_ref,
  party: r.party_id ? { id: r.party_id, name: names.get(r.party_id) ?? "" } : null,
  mode: r.mode,
  in_words: GATE_MODES[r.mode],
  ...(r.delay_hours > 0 ? { delay_hours: r.delay_hours } : {}),
  ...(r.batch_hours > 0 ? { batch_hours: r.batch_hours } : {}),
  set_by: r.set_by ? (setters.get(r.set_by) ?? null) : null,
  set_holding: r.set_holding,
  set_at: r.set_at.toISOString(),
  ...(r.from_rule ? { made_from_release_rule: r.from_rule } : {}),
});

/**
 * Set how a gate treats a kind of thing in a scope. A setting for the gate
 * as a whole is an administrator's; one for a party's material is set by
 * someone who holds `release` for that party. Setting what already stands
 * changes nothing and says so. A setting it replaces is ended, and stays on
 * the record.
 */
export async function setGateMode(input: {
  boundaryId: string;
  kind?: string;
  scope?: string;
  scopeRef?: string | null;
  partyId?: string | null;
  mode: string;
  /** A standing delay, in hours, and the batch what is delayed then goes with. Left out: none. */
  delayHours?: number;
  batchHours?: number;
  actor: GateAuthority;
}): Promise<{ setting_id: string; changed: boolean; applies: string }> {
  const kind = input.kind ?? "*";
  const scope = (input.scope ?? "boundary") as GateScope;
  const partyId = input.partyId ?? null;
  if (!isGateMode(input.mode)) throw new GateError("BAD_MODE", `A gate's setting is one of: ${Object.keys(GATE_MODES).join(", ")}.`);
  if (kind !== "*" && !isGateKind(kind)) throw new GateError("BAD_KIND", `A setting is for one kind of thing or for every kind ("*").`);
  if (!(scope in GATE_SCOPES)) throw new GateError("BAD_SCOPE", `A setting's scope is one of: ${Object.keys(GATE_SCOPES).join(", ")}.`);
  if ((scope === "boundary") !== !input.scopeRef) {
    throw new GateError("BAD_SCOPE", scope === "boundary" ? "A setting for the whole boundary names nothing narrower." : `Say which ${scope === "under" ? "node" : scope} with scope_ref.`);
  }
  if (partyId === null ? !input.actor.administer : !input.actor.releaseParties.includes(partyId)) {
    throw new GateError(
      "NOT_YOURS_TO_SET",
      partyId === null
        ? "A setting for the gate as a whole is an administrator's. A person who holds release for a party sets the gate for that party's material by naming the party."
        : "A setting for a party's material is set by someone who holds the permission to release that party's material."
    );
  }
  const gate = await gateOf(input.boundaryId);
  if (!gate) throw new GateError("GATE_NOT_FOUND", "No gate has that id.");
  return asOwner(async () => {
    const live = await rawQuery<SettingRow>(
      `SELECT ${SETTING_COLUMNS} FROM gate_settings
        WHERE boundary_id = $1 AND ended_at IS NULL AND kind = $2 AND scope = $3
          AND scope_ref IS NOT DISTINCT FROM $4 AND party_id IS NOT DISTINCT FROM $5`,
      [input.boundaryId, kind, scope, input.scopeRef ?? null, partyId]
    );
    const applies =
      "It applies to everything at the gate that has not been released, from now. What has been released stays released.";
    // A delay is whole hours, and at most ninety days: a halting bound on a number a person types, which decides nothing.
    const hours = (n: number | undefined) => Math.min(24 * 90, Math.max(0, Math.round(Number(n ?? 0)) || 0));
    const delay = hours(input.delayHours);
    const batch = hours(input.batchHours);
    if (live.length === 1 && live[0]!.mode === input.mode && live[0]!.delay_hours === delay && live[0]!.batch_hours === batch) {
      return { setting_id: live[0]!.id, changed: false, applies };
    }
    await rawQuery(`UPDATE gate_settings SET ended_at = now(), ended_by = $2 WHERE id = ANY($1::uuid[])`, [live.map((l) => l.id), input.actor.id]);
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO gate_settings (boundary_id, kind, scope, scope_ref, party_id, mode, delay_hours, batch_hours, set_by, set_holding, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $10, $11, $7, $8, $9) RETURNING id`,
      [input.boundaryId, kind, scope, input.scopeRef ?? null, partyId, input.mode, input.actor.id, input.actor.holding, gate.from_label, delay, batch]
    );
    await restampWhereOutside(gate);
    return { setting_id: row!.id, changed: true, applies };
  });
}

/**
 * A setting of the gate to outside is part of what a published mandate
 * says of itself (gate-face.ts), so changing one offers those mandates
 * again, and the public graph then shows the change with its date.
 */
async function restampWhereOutside(gate: Pick<GateRow, "to_outside">): Promise<void> {
  if (!gate.to_outside) return;
  await import("./gate-face.js")
    .then((face) => face.restampPublishedMandates())
    .catch((err: unknown) => console.error(`[gate] could not state a changed setting on the published mandates: ${err instanceof Error ? err.message : String(err)}`));
}

/** End a setting: the item falls back to the next widest one, or to the starting position. */
export async function endGateSetting(input: { settingId: string; actor: GateAuthority }): Promise<{ changed: boolean }> {
  return asOwner(async () => {
    const [row] = await rawQuery<{ party_id: string | null; ended_at: Date | null; boundary_id: string }>(`SELECT party_id, ended_at, boundary_id FROM gate_settings WHERE id = $1`, [input.settingId]);
    const mine = row && (row.party_id === null ? input.actor.administer : input.actor.releaseParties.includes(row.party_id));
    if (!row || !mine) throw new GateError("SETTING_NOT_FOUND", "No setting you may change has that id.");
    if (row.ended_at) return { changed: false };
    await rawQuery(`UPDATE gate_settings SET ended_at = now(), ended_by = $2 WHERE id = $1`, [input.settingId, input.actor.id]);
    const gate = await gateOf(row.boundary_id);
    if (gate) await restampWhereOutside(gate);
    return { changed: true };
  });
}

/** Set what holds for the gate as a whole: what flows, whether the backlog is shown, and, outside, whether what is released is sent. */
export async function setGate(input: {
  boundaryId: string;
  flow?: string;
  backlogShown?: boolean;
  sendAsReleased?: boolean;
  /**
   * The mandate asked to pay for a fresh assessment on the other side when
   * a version here changes on a node the other side holds; null to ask
   * nothing. Between two labels, a mandate at the label things come from,
   * with what it pays each time. For the gate to outside, a public mandate
   * the organization funds on the public graph.
   */
  keepCurrentMandate?: string | null;
  keepCurrentOwls?: number;
  actor: GateAuthority;
}): Promise<GateRow> {
  if (!input.actor.administer) throw new GateError("NOT_YOURS_TO_SET", "What holds for the gate as a whole is an administrator's to set.");
  if (input.flow !== undefined && input.flow !== "asked" && input.flow !== "everything") {
    throw new GateError("BAD_FLOW", `What flows is "asked" or "everything".`);
  }
  const gate = await gateOf(input.boundaryId);
  if (!gate) throw new GateError("GATE_NOT_FOUND", "No gate has that id.");
  if (input.keepCurrentMandate && !gate.to_outside) {
    const [grant] = await asOwner(() => rawQuery(`SELECT 1 FROM grants WHERE id = $1 AND sensitivity_label = $2`, [input.keepCurrentMandate, gate.from_label]));
    if (!grant) throw new GateError("MANDATE_NOT_FOUND", `No mandate with that id works at the label this gate's things come from.`);
  }
  await asOwner(async () => {
    await rawQuery(
      `UPDATE gates SET flow = COALESCE($2, flow), backlog_shown = COALESCE($3, backlog_shown),
              send_as_released = COALESCE($4, send_as_released), set_by = $5, set_at = now()
        WHERE boundary_id = $1`,
      [input.boundaryId, input.flow ?? null, input.backlogShown ?? null, input.sendAsReleased ?? null, input.actor.id]
    );
    if (input.keepCurrentMandate !== undefined || input.keepCurrentOwls !== undefined) {
      const mandate = input.keepCurrentMandate === undefined ? gate.keep_current_mandate : input.keepCurrentMandate;
      const pays = input.keepCurrentOwls === undefined ? gate.keep_current_micro_usd : Math.max(0, Math.round(input.keepCurrentOwls * 1_000_000));
      // Versions made before a mandate was named are not asked about afterwards: `keep_current_since` is when it was.
      await rawQuery(
        `UPDATE gates SET keep_current_mandate = $2, keep_current_micro_usd = $3,
                keep_current_since = CASE WHEN $2::uuid IS NULL THEN NULL WHEN keep_current_mandate IS DISTINCT FROM $2::uuid THEN now() ELSE keep_current_since END
          WHERE boundary_id = $1`,
        [input.boundaryId, mandate, pays]
      );
    }
    // A showing outside carries the gate's choice, which is what the sender reads (outbound-service.ts).
    if (input.sendAsReleased !== undefined && gate.to_outside) {
      await rawQuery(`UPDATE shown_showings SET send_as_released = $2 WHERE boundary_id = $1`, [input.boundaryId, input.sendAsReleased]);
    }
  });
  return (await gateOf(input.boundaryId))!;
}

/**
 * The gates this person has a say over or reads from the side things come
 * from, each with its settings. A person who holds `release` for a party
 * and does not read the label is shown the settings for that party and for
 * the gate as a whole. The label things come from is named to those who
 * read it and to administrators, who define the labels; anyone else is
 * given the face it shows on the other side, or told only that it is a
 * label they do not read.
 */
export async function gatesFor(actor: GateAuthority & { clearance: readonly string[] }): Promise<Array<Record<string, unknown>>> {
  return asOwner(async () => {
    const pairs = await rawQuery<{ boundary_id: string; from_label: string }>(
      `SELECT DISTINCT boundary_id, from_label FROM redaction_policies WHERE side = 'page' ORDER BY from_label, boundary_id`
    );
    const names = new Map((await rawQuery<{ id: string; name: string }>(`SELECT id, name FROM parties`)).map((p) => [p.id, p.name]));
    const setters = new Map((await rawQuery<{ id: string; display_name: string }>(`SELECT id, display_name FROM contributors WHERE id IN (SELECT set_by FROM gate_settings)`)).map((c) => [c.id, c.display_name]));
    const out: Array<Record<string, unknown>> = [];
    for (const p of pairs) {
      const reads = actor.clearance.includes(p.from_label);
      if (!reads && !actor.administer && actor.releaseParties.length === 0) continue;
      const gate = (await gateOf(p.boundary_id))!;
      const settings = (await liveSettings(p.boundary_id)).filter(
        (s) => reads || actor.administer || s.party_id === null || actor.releaseParties.includes(s.party_id)
      );
      out.push({
        gate_id: gate.boundary_id,
        from: reads || actor.administer ? gate.from_label : ((await faceOfGate(gate.boundary_id)) ?? "a label you do not read"),
        from_named_by: reads || actor.administer ? "its label" : "the face it shows where things arrive",
        to: gate.to_outside ? "outside this deployment" : gate.to_label,
        to_outside: gate.to_outside,
        flow: gate.flow,
        flow_in_words: FLOW_WORDS[gate.flow],
        backlog_shown_to_the_other_side: gate.backlog_shown,
        ...(gate.to_outside ? { send_as_released: gate.send_as_released } : {}),
        keeps_the_other_side_current: keepCurrentWords(gate),
        keep_current_mandate: gate.keep_current_mandate,
        ...(gate.to_outside ? {} : { keep_current_owls: gate.keep_current_micro_usd / 1_000_000 }),
        starting_positions: STARTING_MODE,
        settings: settings.map((s) => settingView(s, names, setters)),
        you_may_set: {
          the_gate_as_a_whole: actor.administer,
          for_parties: actor.releaseParties.map((id) => ({ id, name: names.get(id) ?? "" })),
        },
      });
    }
    return out;
  });
}

export const FLOW_WORDS = {
  asked:
    "What was asked for from the other side goes to the gate when it is ready: an answer to a request taken up here, that it was taken up, an answer to a message. A node's page goes where a flow was set for it.",
  everything:
    "Every page at this label goes to the gate as each version is finished, and each mandate here is offered with its terms. Each page's redaction and check are paid from the budget of the work that produced it.",
} as const;

/** Whether a gate asks for fresh assessments on the other side, in words. */
export function keepCurrentWords(gate: Pick<GateRow, "to_outside" | "keep_current_mandate" | "keep_current_micro_usd">): string {
  if (!gate.keep_current_mandate) {
    return gate.to_outside
      ? "Nothing is asked of the public graph when a version here changes: no public mandate is named to pay for a fresh public assessment."
      : "Nothing is asked of the other side when a version here changes: no mandate is named to pay for a fresh assessment there.";
  }
  return gate.to_outside
    ? "When a version here changes on a node the public graph holds, the public mandate named is asked for a fresh public assessment of the node. The asking is an item at this gate, of the kind funding, and shows outside which public nodes are worked on here and when."
    : `When a version here changes on a node the other side has assessed, the mandate named pays ${(gate.keep_current_micro_usd / 1_000_000).toFixed(2)} owls for a fresh assessment of the node there. The asking is an item at this gate, of the kind funding.`;
}
