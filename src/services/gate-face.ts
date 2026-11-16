/**
 * What an organization has said it will release, as its gate says it
 * (docs/the-gate.md, "Outside").
 *
 * A mandate offered to the gate to outside is the organization's face on
 * the public graph: a request there can be addressed to it. Its terms say
 * what it takes up. What becomes of the work is decided at the gate to
 * outside, by that gate's settings, so those settings are what the
 * organization has committed to: for example, that whatever the Redactor
 * lets through under the published policy is released with nobody deciding
 * after it. There is no other record of a commitment and nobody writes one.
 * This file reads the gates' own rows and states them in the gate's fixed
 * vocabulary, and the statement travels with the mandate as part of what
 * is always shown of it. When a setting changes, the mandate is offered
 * again, and the public graph keeps each version with its date.
 *
 * The stamp names no label, no mandate, no request and no node that the
 * public graph does not already hold.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { GATE_MODES, GATE_SCOPES, type GateKind, type GateMode } from "./gate-kinds.js";
import { liveSettings, modesFor } from "./gate-settings-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { ensureBoundaryPolicy } from "./redaction-policy.js";

const REASON = "A published mandate's stamp is read from the settings of the gates to outside, which are kept at the labels things come from.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(REASON, fn);

/** Strictest last: where the gates a mandate's work may leave by are set differently, the strictest is what is stated. */
const STRICTNESS: readonly GateMode[] = ["open", "redactor", "person"];

/** What is said, on every published mandate, about who pays. The same words for every organization. */
export const FACE_MONEY_WORDS =
  "Work on a request this mandate takes up is paid for inside its publisher's graph, from the mandate's own budget. Owls on the public graph " +
  "do not pay for work there and do not convert. Anyone may fund the public graph's own assessment of a node a request bears on, which " +
  "weighs what is published in answer when it arrives.";

/** What flows to the gate when a request addressed to the mandate is taken up (request-adoption-service.ts, flowWhereThePublicAsked). */
export const FACE_PAGES_FLOW_WORDS =
  "When this mandate takes a request up, its publisher's graph's page of each node the request bears on goes to the gate to outside as it is " +
  "assessed there, and each later version follows. Nobody sets that for each request. A version that does not come through shows as held, with since when.";

/** What is said about material that is not the publisher's own. */
export const FACE_OTHER_PARTIES_WORDS =
  "These are the settings for the publisher's own material. Where a page rests on another party's material, that party's own setting " +
  "applies to those parts, and each page's record says which setting it was released under.";

/**
 * The kinds a published mandate's stamp states: what answers a request
 * addressed to it. A public request is taken up, or declined, at the
 * mandate's own label, so only that label's gate says those; a page may
 * leave from any label the work went on to.
 */
const STAMPED_KINDS: ReadonlyArray<{ kind: GateKind; what: string; ownLabelOnly: boolean }> = [
  { kind: "taken_up", what: "That a request was taken up", ownLabelOnly: true },
  { kind: "answer", what: "That the work will not be done, with its reason", ownLabelOnly: true },
  { kind: "page", what: "The page of a node a request bears on, which is how what the work found is published", ownLabelOnly: false },
];

export interface FaceSetting {
  what: string;
  kind: GateKind;
  the_gate: GateMode;
  in_words: string;
  /** How wide the setting it comes from is, in the gate's words, or that it is where every gate starts. */
  from: string;
  set_on: string | null;
  /** A standing delay of the setting, where it has one. */
  kept_back_hours?: number;
  in_batches_of_hours?: number;
}

export interface FaceStamp {
  format: "minerval-face/1";
  settings: FaceSetting[];
  /** Settings for a node of the public graph and what sits under it: how the gate treats requests in that category. */
  for_requests_under: Array<{ public_node_id: string; kind: GateKind | "every kind"; the_gate: GateMode; in_words: string; set_on: string }>;
  /** Settings narrower than can be said outside (one request, or a node the public graph does not hold): how many. */
  narrower_settings_not_listed: number;
  pages_flow: string;
  other_parties: string;
  money: string;
}

/** The labels a mandate's work may leave from: its own, and those of the mandates made above for what it asked there. */
async function labelsOfWork(grantId: string): Promise<string[]> {
  const [own] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM grants WHERE id = $1`, [grantId]);
  if (!own) return [];
  const above = await rawQuery<{ label: string }>(
    `SELECT DISTINCT a.sensitivity_label AS label
       FROM adopted_requests a JOIN requests r ON r.id = a.from_request_id
      WHERE r.filer_grant_id = $1 AND a.sensitivity_label <> $2`,
    [grantId, own.label]
  );
  return [own.label, ...above.map((a) => a.label)];
}

/**
 * The stamp for one mandate: how the gates to outside are set for its
 * work, for the organization's own material. Computed from the gates' rows
 * each time it is asked for.
 */
export async function faceStamp(grantId: string): Promise<FaceStamp | null> {
  if (oneLabelOnly()) return null;
  return asOwner(async () => {
    const [own] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    const labels = await labelsOfWork(grantId);
    if (!own || labels.length === 0) return null;
    const gates: Array<{ boundaryId: string; from: string }> = [];
    for (const from of labels) gates.push({ boundaryId: (await ensureBoundaryPolicy({ from, to: null })).boundary_id, from });

    const settings: FaceSetting[] = [];
    for (const { kind, what, ownLabelOnly } of STAMPED_KINDS) {
      let strictest: FaceSetting | null = null;
      for (const gate of ownLabelOnly ? gates.slice(0, 1) : gates) {
        const found = (
          await modesFor({ boundaryId: gate.boundaryId, kind, fromLabel: gate.from, nodeId: null, subjectRef: null, replyRef: null, grantIds: [grantId] }, [own.id])
        ).get(own.id)!;
        const [row] = found.settingId
          ? await rawQuery<{ scope: keyof typeof GATE_SCOPES; set_at: Date; delay_hours: number; batch_hours: number }>(
              `SELECT scope, set_at, delay_hours, batch_hours FROM gate_settings WHERE id = $1`,
              [found.settingId]
            )
          : [];
        const one: FaceSetting = {
          what,
          kind,
          the_gate: found.mode,
          in_words: GATE_MODES[found.mode],
          from: row ? `a setting for ${GATE_SCOPES[row.scope]}` : "where every gate starts for this kind of thing",
          set_on: row ? row.set_at.toISOString().slice(0, 10) : null,
          ...(row && row.delay_hours > 0 ? { kept_back_hours: row.delay_hours } : {}),
          ...(row && row.batch_hours > 0 ? { in_batches_of_hours: row.batch_hours } : {}),
        };
        if (!strictest || STRICTNESS.indexOf(one.the_gate) > STRICTNESS.indexOf(strictest.the_gate)) strictest = one;
      }
      settings.push(strictest!);
    }

    const under: FaceStamp["for_requests_under"] = [];
    let narrower = 0;
    for (const gate of gates) {
      for (const s of await liveSettings(gate.boundaryId)) {
        if (s.party_id !== null && s.party_id !== own.id) continue;
        if (s.scope === "request") narrower++;
        if (s.scope !== "under") continue;
        // Only what answers a request is stated: a setting for another kind of thing under a node says nothing about requests.
        if (s.kind !== "*" && !STAMPED_KINDS.some((k) => k.kind === s.kind)) continue;
        const [node] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1 AND origin = 'mirror'`, [s.scope_ref]);
        if (!node) {
          narrower++;
          continue;
        }
        under.push({
          public_node_id: node.id,
          kind: s.kind === "*" ? "every kind" : s.kind,
          the_gate: s.mode,
          in_words: GATE_MODES[s.mode],
          set_on: s.set_at.toISOString().slice(0, 10),
        });
      }
    }
    under.sort((a, b) => (a.public_node_id + a.kind).localeCompare(b.public_node_id + b.kind));

    return {
      format: "minerval-face/1",
      settings,
      for_requests_under: under,
      narrower_settings_not_listed: narrower,
      pages_flow: FACE_PAGES_FLOW_WORDS,
      other_parties: FACE_OTHER_PARTIES_WORDS,
      money: FACE_MONEY_WORDS,
    };
  });
}

/**
 * Offer every published mandate again, so that a changed setting, term or
 * flow is stated outside. Offering one that says what it said before
 * changes nothing. Called when a gate to outside is set, and by the
 * scheduler.
 */
export async function restampPublishedMandates(): Promise<number> {
  if (oneLabelOnly()) return 0;
  const live = await asOwner(() =>
    rawQuery<{ grant_id: string; label: string; payer: string | null }>(
      `SELECT subject_ref AS grant_id, sensitivity_label AS label, payer_grant_id AS payer FROM showings WHERE kind = 'mandate' AND to_outside AND ended_at IS NULL`
    )
  );
  const { offerToGate } = await import("./gate-service.js");
  let offered = 0;
  for (const m of live) {
    const item = await offerToGate({ kind: "mandate", fromLabel: m.label, toLabel: null, subject: { grantId: m.grant_id }, payer: m.payer ? { grantId: m.payer } : undefined }).catch(
      (err: unknown) => {
        console.error(`[gate] could not offer published mandate ${m.grant_id} again: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    );
    if (item) offered++;
  }
  return offered;
}
