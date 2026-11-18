/**
 * The release gate, and what a shown page is on the other side of it
 * (docs/releasing-a-page.md, "The gate" and "What the destination sees").
 *
 * An item reaches the gate once it is fingerprinted: after the Redactor's
 * run and Audit's check of it, or at once where the gate is open for it.
 * A part rests on the parties whose material it draws on; a part that
 * rests on no outside party's material is the organization's own. For each
 * party the gate's setting says how the part is treated
 * (gate-settings-service.ts): let through as the Redactor left it, or kept
 * for that party's holders of `consent` to decide.
 *
 * The acts are the same whoever performs them, the Redactor or a person:
 * let through, remove a passage and mark it, hold a part or the whole item
 * with a reason, delay, lift. None changes a word. Every act is a row that
 * is added and never changed or removed (release_acts), with who made it
 * or which run: a hold stays on the record after it is lifted, and a
 * release is not taken back.
 *
 * A released page arrives at a destination label as a source like any
 * other there, and its arrival opens a reassessment of the node at that
 * label, which runs when it is funded. It is evidence for that label's
 * Steward to weigh. It does not replace that label's judgment.
 *
 * This is the one way text reaches a label that does not read the label
 * it was written at.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { runAtLabel } from "../llm/usage-context.js";
import { verifyReleasedPage, type Mark, type Verification } from "./page-fingerprint.js";
import { releaseCovers } from "../published-page/shape.js";
import { RemovalError, applyRemovals, countByCategory, heldWords, kindWords, locate, overlaps } from "./page-parts.js";
import { GATE_ACTS, GATE_KINDS, GATE_MODES, GATE_SCOPES, HOLDERS, HOLD_REASONS, type GateKind, type HoldReason, type Holder } from "./gate-kinds.js";
import { dueUnder, faceOfGate, gateOf, modesFor, type ModeFound } from "./gate-settings-service.js";
import { FINGERPRINT_FORMAT, VERDICT_DESCRIPTOR, pageRoot, partCommitment, type LeafRecord } from "./page-fingerprint.js";

/** Whether a page is recorded under the construction whose parts carry the public ids they cite (#1157). */
const isRefsFormat = (format: string) => format === FINGERPRINT_FORMAT;
import {
  END_REASONS,
  FIDELITY_ANSWERS,
  LEFT_REASONS,
  RELEASE_COLUMNS,
  ReleaseError,
  PAGE_COLUMNS,
  bothSides,
  destinationOf,
  itemScopeOf,
  ownOrganizationParty,
  type Actor,
  type FidelityAnswer,
  type PageRow,
  type PageStage,
  type ReleaseRow,
} from "./release-service.js";

export { HOLD_REASONS, type HoldReason };

/** The person at the gate, as a route resolved them. */
export interface GateActor extends Actor {
  /** The labels they may read. */
  clearance: readonly string[];
  /** The parties they hold `consent` for. */
  consentParties: readonly string[];
  direct: boolean;
}

type ItemStanding = "consented" | "held" | "waiting";

interface ActRow {
  id: string;
  release_id: string;
  page_id: string | null;
  part_id: string | null;
  act: string;
  party_id: string | null;
  actor_id: string | null;
  holding: string[];
  rule_id: string | null;
  reason: string | null;
  at: Date;
  by: string;
  run_id: string | null;
  until: Date | null;
}

const actsOfPage = (pageId: string) =>
  rawQuery<ActRow>(
    `SELECT id, release_id, page_id, part_id, act, party_id, actor_id, holding, rule_id, reason, at, by, run_id, until
       FROM release_acts WHERE page_id = $1 ORDER BY at, id`,
    [pageId]
  );

/**
 * A hold placed on an item for the gate and not for one party: the
 * Redactor's, which a person at the gate may lift. The hold that stands, or null.
 */
function gateHold(acts: readonly ActRow[], partId: string | null): ActRow | null {
  let held: ActRow | null = null;
  for (const a of acts) {
    if (a.part_id !== partId || a.party_id !== null) continue;
    if (a.act === "held") held = a;
    if (a.act === "hold_lifted") held = null;
  }
  return held;
}

/** The delay that stands on an item and has not run out, or null. */
function delayOn(acts: readonly ActRow[], partId: string | null, now = new Date()): ActRow | null {
  let delay: ActRow | null = null;
  for (const a of acts) {
    if (a.part_id !== partId) continue;
    if (a.act === "delayed") delay = a;
    if (a.act === "delay_lifted") delay = null;
  }
  return delay && delay.until && delay.until > now ? delay : null;
}

/** Where one party stands on one item, from the acts in order. A consent is final. */
function standingOf(acts: readonly ActRow[], partId: string | null, partyId: string): ItemStanding {
  let standing: ItemStanding = "waiting";
  for (const a of acts) {
    if (a.part_id !== partId || a.party_id !== partyId) continue;
    if (a.act === "consented") return "consented";
    if (a.act === "held") standing = "held";
    if (a.act === "hold_lifted") standing = "waiting";
  }
  return standing;
}

/** Whether a holder of `direct` holds the page now. */
function pageHeldByDirect(acts: readonly ActRow[]): ActRow | null {
  let held: ActRow | null = null;
  for (const a of acts) {
    if (a.act === "page_held") held = a;
    if (a.act === "page_hold_lifted") held = null;
  }
  return held;
}

async function insertAct(
  tx: { query: <R>(text: string, params?: unknown[]) => Promise<R[]> },
  act: {
    releaseId: string;
    pageId?: string | null;
    partId?: string | null;
    act: string;
    partyId?: string | null;
    actor?: Actor | null;
    ruleId?: string | null;
    reason?: string | null;
    label: string;
    /** 'person' | 'redactor' | 'setting' | 'process'. A person where an actor is given. */
    by?: string;
    runId?: string | null;
    until?: Date | null;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO release_acts (release_id, page_id, part_id, act, party_id, actor_id, holding, rule_id, reason, at, sensitivity_label, by, run_id, until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), $10, $11, $12, $13)`,
    [
      act.releaseId,
      act.pageId ?? null,
      act.partId ?? null,
      act.act,
      act.partyId ?? null,
      act.actor?.id ?? null,
      act.actor?.holding ?? [],
      act.ruleId ?? null,
      act.reason ?? null,
      act.label,
      act.by ?? (act.actor ? "person" : "process"),
      act.runId ?? null,
      act.until ?? null,
    ]
  );
}

interface GatePage {
  id: string;
  release_id: string;
  node_id: string | null;
  stage: PageStage;
  header: string;
  header_salt: string;
  rests_on: string[];
  audit_answer: FidelityAnswer | null;
  least_sure: Array<{ removal_id?: string; part?: number; why: string }> | null;
  checked_at: Date | null;
  judged_at: Date;
  page_label: string;
}

const GATE_PAGE_COLUMNS = `id, release_id, node_id, stage, header, header_salt, rests_on, audit_answer, least_sure, checked_at, judged_at, sensitivity_label AS page_label`;

interface GatePart {
  id: string;
  position: number;
  kind: string;
  descriptor: string;
  original: string;
  redacted: string | null;
  marks: Mark[] | null;
  salt: string;
  rests_on: string[];
  /** The public ids the part cites (#1157). */
  public_refs: string[];
}

const gatePartsOf = (pageId: string) =>
  rawQuery<GatePart>(
    `SELECT id, position, kind, descriptor, original, redacted, marks, salt, rests_on, public_refs FROM release_parts WHERE page_id = $1 ORDER BY position`,
    [pageId]
  );

// ---- settling: what the acts so far release -----------------------------------

/**
 * Bring the destination side up to the acts recorded so far. The page is
 * shown once every party its verdict rests on has released it and no
 * holder of `direct` holds it; from then on each part shows as its text
 * once every party it rests on has released it, and as a held part until
 * then. Text is written to the destination side here and nowhere else.
 * Called inside bothSides.
 *
 * One settling of a page at a time. Two people deciding at once each record
 * their act and then settle, and each could find the other's act already
 * there: without the lock both would show the page and it would arrive
 * twice. The second waits for the first, then finds nothing left to do.
 */
async function settle(pageId: string): Promise<{ released: boolean; newlyReleased: number }> {
  const { outsidePage, ...result } = await withTransaction(async (lock) => {
    await lock.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settle-released-page:${pageId}`]);
    return settleLocked(pageId);
  });
  // A node's page released outside leaves in its signed package, built and sent now (outbound-service.ts),
  // and on the scheduler's next look if that fails.
  if (outsidePage) {
    const { followReleaseOutside } = await import("./outbound-service.js");
    await followReleaseOutside(outsidePage).catch((err: unknown) =>
      console.error(`[gate] the page ${pageId} is through the gate to outside and its package was not sent yet: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
  return result;
}

async function settleLocked(pageId: string): Promise<{ released: boolean; newlyReleased: number; outsidePage?: string }> {
  const [page] = await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM release_pages WHERE id = $1`, [pageId]);
  if (!page || page.stage !== "at_gate") return { released: false, newlyReleased: 0 };
  const [release] = await rawQuery<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE id = $1`, [page.release_id]);
  const destination = destinationOf(release!);
  const parts = await gatePartsOf(pageId);
  let acts = await actsOfPage(pageId);
  // What the gate's setting lets through with nobody waiting on a person: every item that neither the Redactor nor a
  // person holds and that is not delayed, for each party whose setting is not "a person decides as well". A release
  // that has ended lets nothing more through.
  let modes: Map<string, ModeFound> | null = null;
  if (!release!.ended_at) {
    modes = await modesOfPage(release!, page, parts);
    // A setting's standing delay keeps the whole item back until its time, once, as a delay made by the setting.
    // It shows on the other side and in the backlog as any delay does, and a person at the gate may lift it.
    if (!acts.some((a) => a.act === "delayed" && a.by === "setting" && a.part_id === null)) {
      const delayed = [...modes.values()].filter((m) => m.mode !== "person" && (m.delayHours > 0 || m.batchHours > 0));
      const until = delayed.reduce<Date | null>((latest, m) => {
        const due = dueUnder(m, page.judged_at);
        return !latest || due > latest ? due : latest;
      }, null);
      if (until && until > new Date()) {
        await withTransaction((tx) =>
          insertAct(tx, { releaseId: page.release_id, pageId, act: "delayed", ruleId: delayed[0]!.settingId, by: "setting", until, label: destination })
        );
        acts = await actsOfPage(pageId);
      }
    }
    const through: Array<{ partId: string | null; party: string; setting: string | null }> = [];
    for (const item of [{ id: null as string | null, rests_on: page.rests_on }, ...parts]) {
      if (gateHold(acts, item.id) || delayOn(acts, item.id)) continue;
      for (const party of item.rests_on) {
        const mode = modes.get(party)!;
        if (mode.mode !== "person" && standingOf(acts, item.id, party) === "waiting") through.push({ partId: item.id, party, setting: mode.settingId });
      }
    }
    if (through.length > 0) {
      await withTransaction(async (tx) => {
        for (const t of through) {
          await insertAct(tx, { releaseId: page.release_id, pageId, partId: t.partId, act: "consented", partyId: t.party, ruleId: t.setting, by: "setting", label: destination });
        }
      });
      acts = await actsOfPage(pageId);
    }
  }
  const [received] = await rawQuery<{ released_at: Date | null }>(`SELECT released_at FROM received_pages WHERE id = $1`, [pageId]);
  let changed = 0;
  let isReleased = !!received?.released_at;
  const free = (partId: string | null) => !gateHold(acts, partId) && !delayOn(acts, partId);
  if (!isReleased) {
    const verdictReleased = page.rests_on.every((party) => standingOf(acts, null, party) === "consented");
    if (!verdictReleased || !free(null) || pageHeldByDirect(acts)) return { released: false, newlyReleased: 0 };
    const first = await rawQuery(
      `UPDATE received_pages SET header = $2, header_salt = $3, released_at = now() WHERE id = $1 AND released_at IS NULL RETURNING id`,
      [pageId, page.header, page.header_salt]
    );
    isReleased = true;
    changed += first.length;
  }
  const released = new Set(
    (await rawQuery<{ id: string }>(`SELECT id FROM received_parts WHERE page_id = $1 AND released_at IS NOT NULL`, [pageId])).map((r) => r.id)
  );
  for (const part of parts) {
    if (released.has(part.id)) continue;
    if (!free(part.id) || !part.rests_on.every((party) => standingOf(acts, part.id, party) === "consented")) continue;
    const now = await rawQuery(
      `UPDATE received_parts SET text = $2, marks = $3::jsonb, salt = $4, public_refs = $5::uuid[], released_at = now()
        WHERE id = $1 AND released_at IS NULL RETURNING id`,
      [part.id, part.redacted ?? part.original, JSON.stringify(part.marks ?? []), part.salt, part.public_refs]
    );
    changed += now.length;
  }
  if (changed > 0) {
    await stampReleasedUnder(pageId, release!, page, parts, modes);
    if (!release!.to_outside) await arrive(pageId, release!);
    // A node's page leaves in its signed package (outbound-service.ts). Anything else that the gate to outside
    // has let through leaves by its own kind's way out (gate-outside.ts), now or on the scheduler's next look.
    else if (release!.kind !== "page") {
      await import("./gate-outside.js")
        .then((out) => out.sendThroughOutside({ itemId: pageId }))
        .catch((err: unknown) => console.error(`[gate] item ${pageId} is through the gate to outside and was not sent yet: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      return { released: isReleased, newlyReleased: changed, outsidePage: release!.id };
    }
  }
  return { released: isReleased, newlyReleased: changed };
}

/**
 * Record, on the side the item is read from, how the gate was set for it
 * when it went: for each party it rests on, the setting in the gate's fixed
 * words, how wide the setting is, and the day it was set. It names no
 * mandate, node or request. A page shown outside carries it in its package,
 * so that a reader can see whether a person decided or the Redactor's work
 * went as it stood.
 */
async function stampReleasedUnder(pageId: string, release: ReleaseRow, page: GatePage, parts: readonly GatePart[], known: Map<string, ModeFound> | null): Promise<void> {
  const modes = known ?? (await modesOfPage(release, page, parts));
  const names = await partyNames([...modes.keys()]);
  const stamp = [...modes.entries()]
    .map(([party, m]) => ({
      for_party: names.get(party) ?? "a party",
      the_gate: m.mode,
      in_words: GATE_MODES[m.mode],
      from: m.scope ? `a setting for ${GATE_SCOPES[m.scope]}` : "where every gate starts for this kind of thing",
      set_on: m.setAt ? m.setAt.toISOString().slice(0, 10) : null,
    }))
    .sort((a, b) => a.for_party.localeCompare(b.for_party));
  await rawQuery(`UPDATE received_pages SET released_under = $2::jsonb WHERE id = $1`, [pageId, JSON.stringify(stamp)]);
}

/** How the gate treats this item for each party it or a part of it rests on. */
async function modesOfPage(release: ReleaseRow, page: GatePage, parts: readonly { rests_on: string[] }[]): Promise<Map<string, ModeFound>> {
  const [full] = await rawQuery<PageRow>(`SELECT ${PAGE_COLUMNS} FROM release_pages WHERE id = $1`, [page.id]);
  const scope = await runAtLabel(release.page_label, `the gate setting for item ${page.id}`, () => itemScopeOf(release, full!));
  return modesFor(scope, [...page.rests_on, ...parts.flatMap((p) => p.rests_on)]);
}

/**
 * Settle every item at a gate whose delay has run out, or whose setting may
 * have changed. The scheduler's work, and called when a setting is changed.
 */
export async function settleWaiting(opts: { boundaryId?: string } = {}): Promise<number> {
  return bothSides(async () => {
    const pages = await rawQuery<{ id: string }>(
      `SELECT p.id FROM release_pages p JOIN releases s ON s.id = p.release_id
        WHERE p.stage = 'at_gate' AND ($1::uuid IS NULL OR s.boundary_id = $1)
          AND EXISTS (SELECT 1 FROM received_parts sp WHERE sp.page_id = p.id AND sp.released_at IS NULL
                      UNION ALL SELECT 1 FROM received_pages o WHERE o.id = p.id AND o.released_at IS NULL)
        ORDER BY p.checked_at`,
      [opts.boundaryId ?? null]
    );
    let moved = 0;
    for (const p of pages) moved += (await settle(p.id)).newlyReleased;
    return moved;
  });
}

// ---- arrival at a destination label -------------------------------------------

interface ReceivedPageRow {
  id: string;
  release_id: string;
  kind: GateKind;
  node_id: string | null;
  judged_at: Date;
  opened_at: Date;
  waiting_for_funds: boolean;
  stage: PageStage;
  round: number;
  root: string | null;
  roots: unknown[];
  fingerprint_format: string;
  header_commitment: string | null;
  header: string | null;
  header_salt: string | null;
  needs: string[];
  audit_answer: FidelityAnswer | null;
  released_at: Date | null;
  source_id: string | null;
  released_under: ReleasedUnder[] | null;
}

/** How the gate was set for an item when it went, for one party it rests on (stampReleasedUnder). */
export interface ReleasedUnder {
  for_party: string;
  the_gate: "open" | "redactor" | "person";
  in_words: string;
  from: string;
  set_on: string | null;
}

/**
 * Where a released page is found as a source at the label it arrived at:
 * `minerval:released-page/<received_pages.id>/<n>`, the nth arrival of that
 * page. Sources made before the name changed are at
 * `minerval:shown-page/...`, and are found there still: the address of a
 * source already made is not rewritten.
 */
export const RELEASED_PAGE_ADDRESS = "minerval:released-page/";
const RELEASED_PAGE_ADDRESS_1 = "minerval:shown-page/";
/** The LIKE patterns of every arrival of one page, under either address. */
export const arrivalsOf = (pageId: string): string[] => [RELEASED_PAGE_ADDRESS, RELEASED_PAGE_ADDRESS_1].map((a) => `${a}${pageId}/%`);

const RECEIVED_PAGE_COLUMNS = `id, release_id, kind, node_id, judged_at, opened_at, waiting_for_funds, stage, round, root, roots, fingerprint_format, header_commitment, header, header_salt, needs, audit_answer, released_at, source_id, released_under`;

interface ReceivedPartRow {
  id: string;
  position: number;
  kind: string;
  descriptor: string;
  commitment: string;
  needs: string[];
  text: string | null;
  marks: Mark[] | null;
  salt: string | null;
  /** The public ids the part cites, once released (#1157). */
  public_refs: string[] | null;
  released_at: Date | null;
}

const receivedPartsOf = (pageId: string) =>
  rawQuery<ReceivedPartRow>(
    `SELECT id, position, kind, descriptor, commitment, needs, text, marks, salt, public_refs, released_at FROM received_parts WHERE page_id = $1 ORDER BY position`,
    [pageId]
  );

async function partyNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await rawQuery<{ id: string; name: string }>(`SELECT id, name FROM parties WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function verdictLine(header: Record<string, unknown>): string {
  const v = (header.verdict ?? {}) as Record<string, unknown>;
  if ("status" in v) {
    return `Status: ${String(v.status)}. Confidence: ${String(v.confidence)}.${v.credence !== null && v.credence !== undefined ? ` Credence: ${String(v.credence)}.` : " No credence was given."}`;
  }
  if ("estimate" in v) return `Estimate: ${JSON.stringify(v.estimate)}.`;
  return `Standing: ${String(v.standing)}.${v.confidence !== null && v.confidence !== undefined ? ` Confidence: ${String(v.confidence)}.` : ""}`;
}

/** Who supplied a source, as far as is always shown: which side of the organization's own edge, and never the name. */
const SUPPLIED_BY: Record<string, string> = {
  the_organization_itself: "supplied by the organization itself",
  an_outside_party: "supplied by an outside party",
  not_recorded: "its supplier is not on record",
};

/** The held parts counted by kind, in words: "2 arguments against, a paragraph of reasoning". */
function heldByKind(parts: readonly { descriptor: string }[]): string {
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p.descriptor, (counts.get(p.descriptor) ?? 0) + 1);
  return [...counts.entries()].map(([d, n]) => kindWords(d, n)).join(", ");
}

/** The page as shown, as one text: what a reader or a Steward on the destination side reads. */
function renderReleasedPage(
  page: ReceivedPageRow,
  parts: readonly ReceivedPartRow[],
  holders: (part: ReceivedPartRow) => string[],
  policy: { version: number | null; hash: string | null },
  acts: readonly ActRow[]
): string {
  const header = JSON.parse(page.header!) as Record<string, unknown>;
  const held = parts.filter((p) => p.released_at === null);
  const removals = Object.entries((header.removals ?? {}) as Record<string, number>);
  const sources = (header.sources ?? []) as Array<{ source: number; kind: string; supplied_by: string; interest_recorded: boolean; fingerprint: string | null }>;
  const gaps = (header.gaps ?? {}) as { requests?: Array<{ state: string }>; names_what_remains_open?: boolean };
  const made = (header.made ?? {}) as Record<string, unknown>;
  const lines = [
    "A page of this graph, written at a label this one does not read and released here. The text below is as its " +
      "author wrote it. What a policy removed is marked where it was removed, and each part that is held is named in its place.",
    "",
    `Version of ${page.judged_at.toISOString().slice(0, 10)}.`,
    verdictLine(header),
    `Coverage: ${((header.coverage as { on?: string[] })?.on ?? []).join(", ") || "examined"}.`,
    sources.length === 0
      ? "Sources read at its label: none recorded."
      : `Sources read at its label: ${sources
          .map(
            (s) =>
              `source ${s.source}: ${s.kind.replace(/_/g, " ")}, ${SUPPLIED_BY[s.supplied_by] ?? SUPPLIED_BY.not_recorded}, ` +
              `${s.interest_recorded ? "an interest in this node is recorded for it" : "no interest in this node is recorded for it"}` +
              (s.fingerprint ? `, fingerprint ${s.fingerprint.slice(0, 16)}` : "")
          )
          .join(" | ")}.`,
    `Gaps it records: ${(gaps.requests ?? []).length} request${(gaps.requests ?? []).length === 1 ? "" : "s"}` +
      ((gaps.requests ?? []).length > 0 ? ` (${(gaps.requests ?? []).map((r) => r.state.replace(/_/g, " ")).join(", ")})` : "") +
      (gaps.names_what_remains_open ? "; it says what remains open." : "."),
    `How it was made: prompt set ${String(made.prompt_set ?? "not recorded").slice(0, 16)}, policy version ${policy.version ?? "not recorded"}` +
      `, assessed by ${String(made.assessed_by_model ?? "a model not recorded")}, redacted by ${String(made.redacted_by_model ?? "a model not recorded")}.`,
    `Removals under the policy: ${removals.length === 0 ? "none" : removals.map(([c, n]) => `${c}: ${n}`).join(", ")}.`,
    `Audit's check of the redaction: ${auditAnswerWords(page.audit_answer, acts) ?? "not recorded"}`,
    held.length === 0
      ? `Parts: ${parts.length}, all released.`
      : `Parts: ${parts.length}, of which ${held.length} ${held.length === 1 ? "is" : "are"} held (${heldByKind(held)}).`,
    `Fingerprint: ${page.root}`,
    "",
    ...parts.flatMap((p) => [p.released_at !== null ? p.text! : heldWords(p.descriptor, holders(p)), ""]),
  ];
  return lines.join("\n").trimEnd();
}

/** What the Steward at the destination label is told when a shown page arrives among its node's sources. */
export function pageReleasedMessage(input: { heldParts: number; parts: number; removals: number; again: boolean }): string {
  return (
    `A page of this node, written at a label this one does not read, ${input.again ? "has had more of it released and is released here again" : "has been released here"}. ` +
    `It is now one of this node's sources, of the kind released_page. It is that label's Steward's assessment as written, ` +
    `made on material this label cannot read: ${input.removals} passage${input.removals === 1 ? " was" : "s were"} removed under the boundary's ` +
    `policy and marked in place, and ${input.heldParts} of its ${input.parts} part${input.parts === 1 ? "" : "s"} ${input.heldParts === 1 ? "is" : "are"} held. ` +
    `It is evidence at this label, to weigh as you weigh any source: the source's text states the verdict, the policy version, ` +
    `what was removed and held and by whom, and Audit's check. What was removed and what is held are part of what it tells ` +
    `you, as any omission is: what kind of thing is missing, under what rule, and by whose decision. It does not replace ` +
    `this label's judgment, which is yours to reach.`
  );
}

/**
 * The shown page arrives at its destination label: a source there, with
 * the page as shown as its text; attached to the node where the
 * destination reads the node; and a reassessment of the node opened at
 * that label, which runs when it is funded. A page that has more released
 * later arrives again as a new source, since a source's text does not
 * change, and the earlier one is detached from the node and kept.
 * Called inside bothSides.
 */
async function arrive(pageId: string, release: ReleaseRow): Promise<void> {
  if (release.kind !== "page") return arriveItem(pageId, release);
  const destination = destinationOf(release);
  const [page] = await rawQuery<ReceivedPageRow>(`SELECT ${RECEIVED_PAGE_COLUMNS} FROM received_pages WHERE id = $1`, [pageId]);
  if (!page?.released_at || !page.header) return;
  const parts = await receivedPartsOf(pageId);
  const acts = await actsOfPage(pageId);
  const names = await partyNames(parts.flatMap((p) => p.needs));
  const holders = (part: ReceivedPartRow) => holdersOf(acts, part, names);
  const [policy] = await rawQuery<{ version: number; hash: string }>(
    `SELECT p.version, p.hash FROM release_pages sp JOIN redaction_policies p ON p.id = sp.policy_id WHERE sp.id = $1`,
    [pageId]
  );
  const text = renderReleasedPage(page, parts, holders, { version: policy?.version ?? null, hash: policy?.hash ?? null }, acts);
  const [{ n }] = (await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM sources WHERE url LIKE ANY($1::text[])`,
    [arrivalsOf(pageId)]
  )) as [{ n: number }];
  const [node] = await rawQuery<{ readable: boolean; latest: boolean }>(
    `SELECT c.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text])) AS readable,
            NOT EXISTS (SELECT 1 FROM received_pages o
                         WHERE o.release_id = $3 AND o.node_id = c.id AND o.released_at IS NOT NULL AND o.judged_at > $4) AS latest
       FROM claims c WHERE c.id = $1`,
    [page.node_id, destination, page.release_id, page.judged_at]
  );
  const nodeId = page.node_id!;
  const sourceId = await withTransaction(async (tx) => {
    const [source] = await tx.query<{ id: string }>(
      `INSERT INTO sources (url, title, content_hash, raw_content, source_type, page_url_hash, sensitivity_label)
       VALUES ($1, $2, $3, $4, 'released_page', '', $5) RETURNING id`,
      [
        `${RELEASED_PAGE_ADDRESS}${pageId}/${n + 1}`,
        `A page released from a label this one does not read (version of ${page.judged_at.toISOString().slice(0, 10)})`,
        createHash("sha256").update(text, "utf8").digest("hex"),
        text,
        destination,
      ]
    );
    await tx.query(`UPDATE received_pages SET source_id = $2 WHERE id = $1`, [pageId, source!.id]);
    if (node?.readable && node.latest) {
      // Earlier arrivals of this node's page under this release give way to this one. The sources stay.
      await tx.query(
        `UPDATE claim_instances i
            SET detached_at = now(), detached_by = 'release',
                detached_reason = 'A later release of this page replaced it.'
          WHERE i.claim_id = $1 AND i.detached_at IS NULL AND i.created_by = 'release' AND i.sensitivity_label = $3
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id AND s.url LIKE ANY (
                  SELECT a || o.id || '/%' FROM received_pages o, unnest(ARRAY['minerval:released-page/', 'minerval:shown-page/']) AS a WHERE o.release_id = $2 AND o.node_id = $1))`,
        [nodeId, page.release_id, destination]
      );
      await tx.query(
        `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, context, stance, created_by, sensitivity_label)
         VALUES ($1, $2, $3, $4, 'mentions', 'release', $5)`,
        [
          nodeId,
          source!.id,
          verdictLine(JSON.parse(page.header!) as Record<string, unknown>),
          "The verdict of a page of this node written at a label this one does not read. The source's text is the page as released, with removals marked and held parts named.",
          destination,
        ]
      );
    }
    return source!.id;
  });
  if (!node?.readable || !node.latest) return;
  const header = JSON.parse(page.header) as { removals?: Record<string, number> };
  const message = pageReleasedMessage({
    heldParts: parts.filter((p) => p.released_at === null).length,
    parts: parts.length,
    removals: Object.values(header.removals ?? {}).reduce((a, b) => a + b, 0),
    again: n > 0,
  });
  // The reassessment is opened at the destination label and nowhere else, from words composed of nothing but counts.
  await runAtLabel(destination, `the arrival of shown page ${pageId}`, async () => {
    const { enqueueSteward } = await import("./queue-service.js");
    await enqueueSteward({
      claimId: nodeId,
      trigger: "page_released",
      context: message,
      sender: { kind: "system", ref: `released:${sourceId}` },
    });
  }).catch((err: unknown) => {
    console.error(`[release] could not open the reassessment for shown page ${pageId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ---- arrival of an item that is not a node's page ---------------------------------

/** An item as shown, as one text: what a reader or an agent on the destination side reads. */
function renderReceivedItem(page: ReceivedPageRow, parts: readonly ReceivedPartRow[], holders: (part: ReceivedPartRow) => string[], policyVersion: number | null): string {
  const header = JSON.parse(page.header!) as Record<string, unknown>;
  const removals = Object.entries((header.removals ?? {}) as Record<string, number>);
  const held = parts.filter((p) => p.released_at === null);
  const made = (header.made ?? {}) as Record<string, unknown>;
  return [
    `${capitalize(GATE_KINDS[page.kind])}, from work at a label this one does not read. The text below is as it was written there. ` +
      `What a policy removed is marked where it was removed, and each part that is held is named in its place.`,
    "",
    `Dated ${page.judged_at.toISOString().slice(0, 10)}.`,
    made.redaction
      ? `Redaction: ${String(made.redaction)}.`
      : `Policy version ${policyVersion ?? "not recorded"}, redacted by ${String(made.redacted_by_model ?? "a model not recorded")}. ` +
        `Removals under the policy: ${removals.length === 0 ? "none" : removals.map(([c, n]) => `${c}: ${n}`).join(", ")}.`,
    held.length === 0
      ? `Parts: ${parts.length}, all released.`
      : `Parts: ${parts.length}, of which ${held.length} ${held.length === 1 ? "is" : "are"} held (${heldByKind(held)}).`,
    `Fingerprint: ${page.root}`,
    "",
    ...parts.flatMap((p) => [p.released_at !== null ? p.text! : heldWords(p.descriptor, holders(p)), ""]),
  ]
    .join("\n")
    .trimEnd();
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The parties still holding or not yet deciding a part, by name; "the Redactor" where its hold stands. */
function holdersOf(acts: readonly ActRow[], part: { id: string; needs: string[] }, names: Map<string, string>): string[] {
  // Under the Redactor's hold a party that has not yet been asked is not holding anything: only one that holds is named with it.
  const redactor = gateHold(acts, part.id);
  const out = part.needs
    .filter((party) => (redactor ? standingOf(acts, part.id, party) === "held" : standingOf(acts, part.id, party) !== "consented"))
    .map((party) => names.get(party) ?? "a party");
  return redactor ? ["the Redactor", ...out] : out;
}

/**
 * An item that is not a node's page arrives at its destination label: a
 * source there whose text is the item as shown, and what its kind does on
 * that side. An answer is recorded on the request that asked, where one
 * did. An answer to a message is sent to the node that sent the message.
 * A mandate's funding of work is placed on the node's pass there. That a
 * request was taken up, and that a mandate exists, are read from the
 * item's own row (receivedItems). Arriving again, with more released,
 * replaces what the earlier arrival recorded. Called inside bothSides.
 */
async function arriveItem(pageId: string, release: ReleaseRow): Promise<void> {
  const destination = destinationOf(release);
  const [page] = await rawQuery<ReceivedPageRow>(`SELECT ${RECEIVED_PAGE_COLUMNS} FROM received_pages WHERE id = $1`, [pageId]);
  if (!page?.released_at || !page.header) return;
  const parts = await receivedPartsOf(pageId);
  const acts = await actsOfPage(pageId);
  const names = await partyNames(parts.flatMap((p) => p.needs));
  const [policy] = await rawQuery<{ version: number }>(
    `SELECT p.version FROM release_pages sp JOIN redaction_policies p ON p.id = sp.policy_id WHERE sp.id = $1`,
    [pageId]
  );
  const text = renderReceivedItem(page, parts, (p) => holdersOf(acts, p, names), policy?.version ?? null);
  const [{ n }] = (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE url LIKE ANY($1::text[])`, [arrivalsOf(pageId)])) as [{ n: number }];
  const [source] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, content_hash, raw_content, source_type, page_url_hash, sensitivity_label)
     VALUES ($1, $2, $3, $4, 'released_page', '', $5) RETURNING id`,
    [
      `${RELEASED_PAGE_ADDRESS}${pageId}/${n + 1}`,
      `${capitalize(GATE_KINDS[page.kind])}, from a label this one does not read (${page.judged_at.toISOString().slice(0, 10)})`,
      createHash("sha256").update(text, "utf8").digest("hex"),
      text,
      destination,
    ]
  );
  await rawQuery(`UPDATE received_pages SET source_id = $2 WHERE id = $1`, [pageId, source!.id]);
  const released = parts.filter((p) => p.released_at !== null);
  const marker = `gate item ${pageId}`;
  const onRequest: Partial<Record<GateKind, string>> = {
    answer: "An answer from work",
    statement: "A statement of what was spent, from work",
    mandate: "Word of the mandate made for this request",
  };
  if (onRequest[release.kind] && release.reply_ref) {
    const summary =
      `${onRequest[release.kind]} at a label this one does not read, as it came through the gate (${marker}; source ${source!.id}). ` +
      `${released.length} of its ${parts.length} part${parts.length === 1 ? "" : "s"} ${released.length === 1 ? "is" : "are"} released.\n\n` +
      parts.map((p) => (p.released_at !== null ? p.text! : heldWords(p.descriptor, holdersOf(acts, p, names)))).join("\n\n");
    await rawQuery(`DELETE FROM request_work WHERE request_id = $1 AND sensitivity_label = $2 AND summary LIKE $3`, [release.reply_ref, destination, `%(${marker};%`]);
    await rawQuery(
      `INSERT INTO request_work (request_id, by_label, summary, sensitivity_label)
       SELECT r.id, 'Work at a label this one does not read', $2, $3 FROM requests r WHERE r.id = $1 AND r.sensitivity_label = $3`,
      [release.reply_ref, summary, destination]
    );
  }
  if (release.kind === "message" && release.reply_ref && n === 0) {
    const [message] = await rawQuery<{ node_id: string; sender_kind: string; sender_node_id: string | null; created_at: Date }>(
      `SELECT node_id, sender_kind, sender_node_id, created_at FROM node_messages WHERE id = $1 AND sensitivity_label = $2`,
      [release.reply_ref, destination]
    );
    if (message?.sender_kind === "steward" && message.sender_node_id) {
      await runAtLabel(destination, `the arrival of an answer to message ${release.reply_ref}`, async () => {
        const { postMessage } = await import("./inbox-service.js");
        await postMessage({
          nodeId: message.sender_node_id!,
          trigger: "message_reply",
          body:
            `Your message of ${message.created_at.toISOString().slice(0, 10)} was also read by work at a label this one does not read, ` +
            `and its answer came through the gate (source ${source!.id}):\n\n${released.map((p) => p.text!).join("\n\n")}`,
          sender: { kind: "system", ref: `released:${source!.id}` },
          replyTo: release.reply_ref!,
        });
      }).catch((err: unknown) => console.error(`[gate] could not deliver the answer to message ${release.reply_ref}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  if (release.kind === "answer" && release.reply_ref) await answerReachesItsNodes(pageId, release, destination, source!.id, n > 0);
  if (release.kind === "petition" && release.reply_ref && n === 0) {
    await runAtLabel(destination, `the arrival of a petition for mandate ${release.reply_ref}`, async () => {
      const { raiseToMandate } = await import("./mandate-inbox-service.js");
      await raiseToMandate({
        grantId: release.reply_ref!,
        targetNodeId: null,
        targetRef: `released:${source!.id}`,
        source: "the gate",
        summary:
          `Work this mandate pays for at a label it does not read has petitioned it, and the petition came through the gate (source ${source!.id}). ` +
          `Adding to what was asked gives that work more to spend; it is not waiting for an answer.\n\n${released.map((p) => p.text!).join("\n\n")}`,
        detail: { gate_item: pageId, source_id: source!.id },
      });
    }).catch((err: unknown) => console.error(`[gate] could not raise the petition of item ${pageId}: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (release.kind === "funding" && n === 0) await placeFundingBelow(pageId, release, destination);
}

/** What the Steward of a node is told when an answer to a request on the node arrives from a label it does not read. */
export function answerArrivedMessage(input: { released: number; parts: number; again: boolean }): string {
  return (
    `An answer to a request on this node, from work at a label this one does not read, ${input.again ? "has had more of it released and is here again" : "has come through the gate"}. ` +
    `It is now one of this node's sources, of the kind released_page: the work's own words, with what a policy removed marked in place and ` +
    `${input.parts - input.released} of its ${input.parts} part${input.parts === 1 ? "" : "s"} held. Weigh it as you weigh any source. ` +
    `What was removed and what is held are part of what it tells you, as any omission is.`
  );
}

/**
 * An item that is not a node's page, as the gate has let it through: what
 * leaves the deployment when its destination is outside (gate-outside.ts).
 * Released parts with their text, marks in place; held parts with who
 * holds them and the reasons given. Called inside bothSides.
 */
export async function itemAsReceived(itemId: string): Promise<{
  kind: GateKind;
  release_id: string;
  version_of: Date;
  released_at: Date;
  header: Record<string, unknown>;
  parts: Array<{ kind: string; text: string } | { kind: string; held: { by: string[]; because: string[] } }>;
  policy: { version: number; hash: string } | null;
  released_under: ReleasedUnder[];
} | null> {
  const [page] = await rawQuery<ReceivedPageRow>(`SELECT ${RECEIVED_PAGE_COLUMNS} FROM received_pages WHERE id = $1`, [itemId]);
  if (!page?.released_at || !page.header) return null;
  const parts = await receivedPartsOf(itemId);
  const acts = await actsOfPage(itemId);
  const names = await partyNames(parts.flatMap((p) => p.needs));
  const [policy] = await rawQuery<{ version: number; hash: string }>(
    `SELECT p.version, p.hash FROM release_pages sp JOIN redaction_policies p ON p.id = sp.policy_id WHERE sp.id = $1`,
    [itemId]
  );
  return {
    kind: page.kind,
    release_id: page.release_id,
    version_of: page.judged_at,
    released_at: page.released_at,
    header: JSON.parse(page.header) as Record<string, unknown>,
    parts: parts.map((p) => {
      if (p.released_at !== null) return { kind: p.kind, text: p.text! };
      const holds = acts.filter((a) => a.part_id === p.id && a.act === "held");
      return {
        kind: p.kind,
        held: {
          by: holdersOf(acts, p, names),
          because: [...new Set(holds.map((a) => HOLD_REASONS[(a.reason ?? "no_reason_given") as HoldReason] ?? "no reason given"))],
        },
      };
    }),
    policy: policy ?? null,
    released_under: page.released_under ?? [],
  };
}

/**
 * An answer is attached, as a source, to each node the asking request
 * bears on at the destination label, and a pass on that node is opened
 * there, so that the Steward that asked reads it on a later pass.
 */
async function answerReachesItsNodes(pageId: string, release: ReleaseRow, destination: string, sourceId: string, again: boolean): Promise<void> {
  const parts = await receivedPartsOf(pageId);
  const nodes = await rawQuery<{ claim_id: string }>(
    `SELECT t.claim_id FROM request_targets t JOIN claims c ON c.id = t.claim_id
      WHERE t.request_id = $1 AND t.claim_id IS NOT NULL AND c.state = 'active'
        AND c.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text]))`,
    [release.reply_ref, destination]
  );
  for (const { claim_id } of nodes) {
    await rawQuery(
      `UPDATE claim_instances i SET detached_at = now(), detached_by = 'release', detached_reason = 'A later arrival of this answer replaced it.'
        WHERE i.claim_id = $1 AND i.detached_at IS NULL AND i.created_by = 'release' AND i.sensitivity_label = $3
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id AND s.url LIKE ANY($2::text[]))`,
      [claim_id, arrivalsOf(pageId), destination]
    );
    await rawQuery(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, context, stance, created_by, sensitivity_label)
       VALUES ($1, $2, $3, $4, 'mentions', 'release', $5)`,
      [
        claim_id,
        sourceId,
        // The passage is the source's own first sentence (renderReceivedItem), so
        // that a Steward checking the instance against the source finds it.
        `${capitalize(GATE_KINDS.answer)}, from work at a label this one does not read.`,
        "The source's text is the answer as it came through the gate, with removals marked and held parts named.",
        destination,
      ]
    );
    await runAtLabel(destination, `the arrival of an answer as item ${pageId}`, async () => {
      const { enqueueSteward } = await import("./queue-service.js");
      await enqueueSteward({
        claimId: claim_id,
        trigger: "page_released",
        context: answerArrivedMessage({ released: parts.filter((p) => p.released_at !== null).length, parts: parts.length, again }),
        sender: { kind: "system", ref: `released:${sourceId}` },
      });
    }).catch((err: unknown) => console.error(`[gate] could not open the pass for the answer in item ${pageId}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** What the Steward on the other side is told when a mandate it cannot read pays for a pass on its node. */
export const FUNDED_FROM_ABOVE_BRIEF =
  "A mandate at a label this one does not read asked for a fresh assessment of this node here, and its asking came through the gate. " +
  "It adds nothing to the brief: assess the node as you would on any pass, from what this label reads.";

const REASON_FUNDING =
  "A mandate's funding of a pass at a label that does not read the mandate's own is placed, once the gate has let it through, by a step that reads the mandate's budget at its label and writes the commission at the label of the pass.";

/**
 * A mandate's funding of work on a node, once it is through the gate: a
 * pass on the node is commissioned at the destination label from that
 * mandate's budget.
 *
 * The commission is a row at the label of the pass, naming a payer at a
 * label that one does not read, as work asked for from below is a row
 * above naming a payer below (ask-above-service.ts). The amount is what
 * the gate let through. A payer's escrow is the sum of its allocations
 * wherever they are, so the money counts against the mandate at once,
 * spend settles against it, and what the pass does not spend stops
 * counting when the pass ends. The step that places it writes at the
 * destination label and reads as the tables' owner, since no label reads
 * both the mandate's budget and the pass.
 *
 * Where the mandate's budget cannot pay (its escrow or its pace), or the
 * offer carried no amount, the pass is opened for the destination label's
 * own funders, with the same words.
 */
async function placeFundingBelow(pageId: string, release: ReleaseRow, destination: string): Promise<void> {
  const [page] = await rawQuery<{ header: string }>(`SELECT header FROM release_pages WHERE id = $1`, [pageId]);
  const amount = Number((JSON.parse(page!.header) as { amount_micro_usd?: number }).amount_micro_usd ?? 0);
  const nodeId = release.subject_ref!;
  const { withSystemClearance } = await import("../db/clearance.js");
  await runAtLabel(destination, `funding that came through the gate as item ${pageId}`, async () => {
    const { commissionNodePass } = await import("./commission-service.js");
    const placed =
      release.payer_grant_id && amount > 0
        ? await withSystemClearance(REASON_FUNDING, () =>
            commissionNodePass({
              payer: { kind: "grant", grantId: release.payer_grant_id! },
              claimId: nodeId,
              budgetMicroUsd: amount,
              brief: FUNDED_FROM_ABOVE_BRIEF,
              reason: "Funding from a mandate at another label, through the gate.",
              commissionedBy: "gate",
              message: { trigger: "funded_from_above", sender: { kind: "system", ref: `gate:${pageId}` } },
            })
          ).catch((err: unknown) => {
            console.error(`[gate] the funding of item ${pageId} was not placed from its mandate: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        : null;
    await bothSidesNote(pageId, placed?.ok ? "placed" : "opened");
    if (placed?.ok) return;
    const { enqueueSteward } = await import("./queue-service.js");
    await enqueueSteward({ claimId: nodeId, trigger: "funded_from_above", context: FUNDED_FROM_ABOVE_BRIEF, sender: { kind: "system", ref: `gate:${pageId}` } });
  }).catch((err: unknown) => console.error(`[gate] could not place the funding of item ${pageId}: ${err instanceof Error ? err.message : String(err)}`));
}

/** Record on the item, where the label it came from reads it, whether its money was placed or the pass was only opened. */
async function bothSidesNote(pageId: string, how: "placed" | "opened"): Promise<void> {
  const { withSystemClearance } = await import("../db/clearance.js");
  await withSystemClearance(REASON_FUNDING, () => rawQuery(`UPDATE release_pages SET funding_placed = $2 WHERE id = $1`, [pageId, how === "placed"])).catch(() => undefined);
}

// ---- reaching the gate ----------------------------------------------------------

/**
 * An item is fingerprinted and at the gate: after the Redactor's run and
 * Audit's check, or at once where the gate is open for it. What the gate's
 * setting lets through goes now; the rest waits for whoever holds it.
 */
export async function itemReachedGate(pageId: string): Promise<void> {
  await bothSides(() => settle(pageId));
}

// ---- deciding -------------------------------------------------------------------

export interface GateItem {
  /** The item: a version of a node's page, or of another kind of thing. `page_id` is the same id under its older name. */
  item_id?: string;
  page_id?: string;
  /** The part's place in the item; null or absent for the item itself (a page with its verdict). */
  part?: number | null;
  /** For this item alone, where it differs from the request's. */
  decision?: GateDecision;
  party_id?: string;
  reason?: string;
  until?: string;
  passage?: string;
  occurrence?: number;
  category?: string;
}

export type GateDecision = keyof typeof GATE_ACTS;

/**
 * Act at the gate on each of the items: consent, approve, remove a
 * passage, hold, delay or lift. The same acts the Redactor has. An act for
 * a party is made for each party the item rests on that the person holds
 * `consent` for, or for the one named. Asking for what already stands
 * changes nothing and is counted as unchanged, so a call can be sent
 * again. An item that cannot be acted on as asked is reported with the
 * reason, and the others are decided.
 */
export async function decideAtGate(input: {
  actor: GateActor;
  partyId?: string;
  items: readonly GateItem[];
  decision?: GateDecision;
  reason?: string;
  until?: string;
}): Promise<{ decided: number; unchanged: number; refused: Array<{ item: GateItem; why: string }>; released: string[] }> {
  if (input.partyId && !input.actor.consentParties.includes(input.partyId)) {
    throw new ReleaseError("NOT_YOUR_PARTY", "This decision is for a party you do not hold the permission to consent for.");
  }
  if (input.decision === "hold" && !(input.reason && input.reason in HOLD_REASONS) && input.items.every((i) => !i.reason && !i.decision)) {
    throw new ReleaseError("BAD_REASON", `A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
  }
  return bothSides(async () => {
    const refused: Array<{ item: GateItem; why: string }> = [];
    const touched = new Set<string>();
    let decided = 0;
    let unchanged = 0;
    for (const item of input.items) {
      const decision = item.decision ?? input.decision;
      const reason = item.reason ?? input.reason;
      const until = item.until ?? input.until;
      const pageId = item.item_id ?? item.page_id ?? "";
      const refuse = (why: string) => refused.push({ item, why });
      if (!decision || !(decision in GATE_ACTS)) {
        refuse(`Say what to do with it: one of ${Object.keys(GATE_ACTS).join(", ")}.`);
        continue;
      }
      const [page] = /^[0-9a-f-]{36}$/i.test(pageId) ? await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM release_pages WHERE id = $1`, [pageId]) : [];
      if (!page || page.stage !== "at_gate") {
        refuse("No item with that id is at the gate.");
        continue;
      }
      const [release] = await rawQuery<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE id = $1`, [page.release_id]);
      const destination = destinationOf(release!);
      if (release!.ended_at && (decision === "consent" || decision === "approve")) {
        refuse(
          release!.kind === "page"
            ? "This page's release has ended, so nothing more is released from it. What was released stays released."
            : "This item's flow has ended, so nothing more is released from it. What was released stays released."
        );
        continue;
      }
      const parts = await gatePartsOf(page.id);
      let part: GatePart | null = null;
      if (item.part !== null && item.part !== undefined) {
        part = parts.find((p) => p.position === item.part) ?? null;
        if (!part) {
          refuse(`That item has no part ${item.part}.`);
          continue;
        }
      }
      const partId = part?.id ?? null;
      const needs = part ? part.rests_on : page.rests_on;
      // The parties this person acts for on this item: the one named, or every one of theirs it rests on.
      const wanted = item.party_id ?? input.partyId;
      const reach = decision === "approve" ? [...new Set([...page.rests_on, ...parts.flatMap((p) => p.rests_on)])] : needs;
      const mine = input.actor.consentParties.filter((party) => reach.includes(party) && (!wanted || party === wanted));
      if (mine.length === 0) {
        refuse(
          wanted && !input.actor.consentParties.includes(wanted)
            ? "That is a party you do not hold the permission to consent for."
            : wanted
              ? "This item does not rest on that party's material, so it is not that party's to consent to or hold."
              : "This item does not rest on the material of a party you consent for, so it is not yours to act on."
        );
        continue;
      }
      const acts = await actsOfPage(page.id);
      const act = (a: Omit<Parameters<typeof insertAct>[1], "releaseId" | "pageId" | "label" | "actor">) =>
        withTransaction((tx) => insertAct(tx, { releaseId: page.release_id, pageId: page.id, label: destination, actor: input.actor, ...a }));
      let did = 0;
      if (decision === "approve") {
        // Everything of the item that nobody holds, for this person's parties, as the Redactor left it.
        for (const target of [{ id: null as string | null, rests_on: page.rests_on }, ...parts]) {
          if (gateHold(acts, target.id) || delayOn(acts, target.id)) continue;
          for (const party of mine) {
            if (!target.rests_on.includes(party) || standingOf(acts, target.id, party) !== "waiting") continue;
            await act({ partId: target.id, act: "consented", partyId: party });
            did++;
          }
        }
      } else if (decision === "consent") {
        for (const party of mine) {
          if (standingOf(acts, partId, party) === "consented") continue;
          await act({ partId, act: "consented", partyId: party });
          did++;
        }
      } else if (decision === "hold") {
        if (!(reason && reason in HOLD_REASONS)) {
          refuse(`A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
          continue;
        }
        const releasedBy = mine.filter((party) => standingOf(acts, partId, party) === "consented");
        if (releasedBy.length === mine.length) {
          refuse("This party has consented to it, and consent is not taken back.");
          continue;
        }
        for (const party of mine) {
          if (standingOf(acts, partId, party) !== "waiting") continue;
          await act({ partId, act: "held", partyId: party, reason });
          did++;
        }
      } else if (decision === "lift") {
        // A person's own hold for a party, the Redactor's hold, and a delay: whichever stand.
        for (const party of mine) {
          if (standingOf(acts, partId, party) !== "held") continue;
          await act({ partId, act: "hold_lifted", partyId: party });
          did++;
        }
        if (gateHold(acts, partId)) {
          await act({ partId, act: "hold_lifted", partyId: null });
          did++;
        }
        if (delayOn(acts, partId)) {
          await act({ partId, act: "delay_lifted", partyId: null });
          did++;
        }
      } else if (decision === "delay") {
        const at = until ? new Date(until) : null;
        if (!at || Number.isNaN(at.getTime()) || at <= new Date()) {
          refuse("A delay gives the time it runs until, as a date and time that has not passed.");
          continue;
        }
        if (mine.every((party) => standingOf(acts, partId, party) === "consented") && !gateHold(acts, partId)) {
          refuse("It has been consented to, and consent is not taken back.");
          continue;
        }
        const standingDelay = delayOn(acts, partId);
        if (!standingDelay || standingDelay.until!.getTime() !== at.getTime()) {
          await act({ partId, act: "delayed", partyId: null, until: at });
          did++;
        }
      } else {
        // remove
        if (!part) {
          refuse("A passage is removed from a part. Say which part.");
          continue;
        }
        try {
          did += (await removeAtGate({ actor: input.actor, page, release: release!, part, passage: item.passage ?? "", occurrence: item.occurrence, category: item.category ?? "" })) ? 1 : 0;
        } catch (err) {
          if (!(err instanceof ReleaseError)) throw err;
          refuse(err.message);
          continue;
        }
      }
      if (did > 0) {
        decided++;
        touched.add(page.id);
      } else unchanged++;
    }
    const releasedPages: string[] = [];
    for (const pageId of touched) if ((await settle(pageId)).released) releasedPages.push(pageId);
    return { decided, unchanged, refused, released: releasedPages };
  });
}

/**
 * A person at the gate removes one passage from a part, under a category
 * of the boundary's policy: the Redactor's own act, with the same mark.
 * The part's hash and the item's fingerprint are recorded again, and the
 * fingerprint before it stays on the record. It can be done until the item
 * itself is shown: what is always shown counts the removals, and once that
 * has gone out it is not changed. After that the part can be held.
 * Returns false where the same removal already stands.
 */
async function removeAtGate(input: {
  actor: GateActor;
  page: GatePage;
  release: ReleaseRow;
  part: GatePart;
  passage: string;
  occurrence?: number;
  category: string;
}): Promise<boolean> {
  const { page, part } = input;
  const [received] = await rawQuery<{ released_at: Date | null }>(`SELECT released_at FROM received_pages WHERE id = $1`, [page.id]);
  if (received?.released_at) {
    throw new ReleaseError(
      "ALREADY_RELEASED",
      "This item has been released, with the count of removals that is always shown with it, so nothing more is removed from it. A part not yet released can be held."
    );
  }
  const [full] = await rawQuery<PageRow>(`SELECT ${PAGE_COLUMNS} FROM release_pages WHERE id = $1`, [page.id]);
  const [policy] = await rawQuery<{ id: string; version: number; categories: Array<{ name: string }> }>(
    `SELECT id, version, categories FROM redaction_policies WHERE id = $1`,
    [full!.policy_id]
  );
  const category = policy?.categories.find((c) => c.name === input.category.trim());
  if (!category) {
    // The item's own policy, the one it was redacted under, is the list (GET /gate/queue gives it on each item as `policy.categories`).
    const names = (policy?.categories ?? []).map((c) => `"${c.name}"`);
    const asked = input.category.trim() ? `"${input.category.trim()}" is not a category of the policy` : "No category was given, and a removal is made under a category of the policy";
    throw new ReleaseError(
      "NO_SUCH_CATEGORY",
      `${asked} this item was redacted under${policy ? ` (version ${policy.version})` : ""}. ` +
        (names.length > 0 ? `Its categories are ${names.join(", ")}. ` : "That policy has no categories, so nothing can be removed under it. ") +
        "A passage no category covers stays, or the part is held."
    );
  }
  const existing = await rawQuery<{ start_offset: number; end_offset: number; category: string }>(
    `SELECT start_offset, end_offset, category FROM release_removals WHERE part_id = $1 AND taken_back_at IS NULL ORDER BY start_offset`,
    [part.id]
  );
  const asRemovals = existing.map((r) => ({ start: r.start_offset, end: r.end_offset, category: r.category }));
  let span: { start: number; end: number };
  try {
    span = locate(part.original, input.passage, input.occurrence);
  } catch (err) {
    if (err instanceof RemovalError) throw new ReleaseError("PASSAGE_NOT_FOUND", err.message);
    throw err;
  }
  if (asRemovals.some((r) => r.start === span.start && r.end === span.end && r.category === category.name)) return false;
  if (overlaps(asRemovals, span)) throw new ReleaseError("OVERLAPS", "That passage overlaps a removal already made in this part.");
  const now = applyRemovals(part.original, [...asRemovals, { ...span, category: category.name }]);
  const format = full!.fingerprint_format;
  const commitment = partCommitment(part.salt, now.text, now.marks, part.public_refs, format);
  const all = await rawQuery<{ id: string; position: number; descriptor: string; commitment: string; category_list: string[] }>(
    `SELECT p.id, p.position, p.descriptor, p.commitment,
            ARRAY(SELECT r.category FROM release_removals r WHERE r.part_id = p.id AND r.taken_back_at IS NULL) AS category_list
       FROM release_parts p WHERE p.page_id = $1 ORDER BY p.position`,
    [page.id]
  );
  const header = JSON.stringify({ ...JSON.parse(page.header), removals: countByCategory([...all.flatMap((p) => p.category_list), category.name]) });
  const headerCommitment = partCommitment(page.header_salt, header, [], [], format);
  const leaves: LeafRecord[] = [
    { position: 0, descriptor: VERDICT_DESCRIPTOR, commitment: headerCommitment },
    ...all.map((p) => ({ position: p.position, descriptor: p.descriptor, commitment: p.id === part.id ? commitment : p.commitment })),
  ];
  const root = pageRoot(leaves, format);
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO release_removals (part_id, start_offset, end_offset, category, note, policy_id, made_in_round, made_by, sensitivity_label)
       VALUES ($1, $2, $3, $4, 'Removed by a person at the gate.', $5, $6, $7, $8)`,
      [part.id, span.start, span.end, category.name, policy!.id, full!.round, input.actor.id, page.page_label]
    );
    await tx.query(`UPDATE release_parts SET redacted = $2, marks = $3::jsonb, commitment = $4 WHERE id = $1`, [part.id, now.text, JSON.stringify(now.marks), commitment]);
    await tx.query(`UPDATE release_pages SET header = $2, root = $3 WHERE id = $1`, [page.id, header, root]);
    await tx.query(`UPDATE received_parts SET commitment = $2 WHERE id = $1`, [part.id, commitment]);
    await tx.query(
      `UPDATE received_pages SET root = $2, header_commitment = $3,
              roots = roots || jsonb_build_object('round', round, 'root', $2::text, 'recorded_at', now(), 'after', 'a removal by a person at the gate')
        WHERE id = $1`,
      [page.id, root, headerCommitment]
    );
    await insertAct(tx, { releaseId: page.release_id, pageId: page.id, partId: part.id, act: "removed", actor: input.actor, reason: category.name, label: destinationOf(input.release) });
  });
  return true;
}

/**
 * The Redactor's acts at the gate other than removal: hold a part or the
 * whole item with a reason from the fixed list, delay it, or lift a hold
 * or a delay of its own from an earlier round. Recorded with its run.
 * Its note stays at the item's label, with what it was least sure of.
 * Made during its run, before the item is fingerprinted. Run at the item's
 * label.
 */
export async function redactorActs(input: {
  pageId: string;
  act: "hold" | "delay" | "lift";
  part?: number | null;
  reason?: string;
  until?: string;
  note?: string;
  runId?: string | null;
}): Promise<{ recorded: boolean }> {
  const [page] = await rawQuery<PageRow>(`SELECT ${PAGE_COLUMNS} FROM release_pages WHERE id = $1`, [input.pageId]);
  if (!page || page.stage !== "to_redact") {
    throw new ReleaseError("NOT_BEING_REDACTED", "This item's redaction is finished, so its holds and delays are now for the people at the gate.");
  }
  let partId: string | null = null;
  if (input.part !== null && input.part !== undefined) {
    const [part] = await rawQuery<{ id: string }>(`SELECT id FROM release_parts WHERE page_id = $1 AND position = $2`, [page.id, input.part]);
    if (!part) throw new ReleaseError("NO_SUCH_PART", `This item has no part ${input.part}.`);
    partId = part.id;
  }
  if (input.act === "hold" && !(input.reason && input.reason in HOLD_REASONS)) {
    throw new ReleaseError("BAD_REASON", `A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
  }
  if (input.act === "hold" && !input.note?.trim()) {
    throw new ReleaseError("NOTE_NEEDED", "Say in the note why you are holding it. Audit and the people at the gate who read this label read it; it stays at this label.");
  }
  const until = input.until ? new Date(input.until) : null;
  if (input.act === "delay" && (!until || Number.isNaN(until.getTime()) || until <= new Date())) {
    throw new ReleaseError("BAD_TIME", "A delay gives the time it runs until, as a date and time that has not passed.");
  }
  const recorded = await bothSides(async () => {
    const [release] = await rawQuery<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE id = $1`, [page.release_id]);
    const acts = await actsOfPage(page.id);
    const rows: Array<{ act: string; reason?: string; until?: Date | null }> = [];
    if (input.act === "hold" && !gateHold(acts, partId)) rows.push({ act: "held", reason: input.reason });
    if (input.act === "delay") rows.push({ act: "delayed", until });
    if (input.act === "lift") {
      if (gateHold(acts, partId)) rows.push({ act: "hold_lifted" });
      if (delayOn(acts, partId)) rows.push({ act: "delay_lifted" });
    }
    await withTransaction(async (tx) => {
      for (const r of rows) {
        await insertAct(tx, { releaseId: page.release_id, pageId: page.id, partId, act: r.act, reason: r.reason ?? null, until: r.until ?? null, by: "redactor", runId: input.runId ?? null, label: destinationOf(release!) });
      }
    });
    return rows.length > 0;
  });
  if (recorded && input.act === "hold") {
    const kept = Array.isArray(page.least_sure) ? (page.least_sure as unknown[]) : [];
    await rawQuery(`UPDATE release_pages SET least_sure = $2::jsonb WHERE id = $1`, [
      page.id,
      JSON.stringify([...kept, { ...(input.part ? { part: input.part } : {}), held: true, why: `Held (${HOLD_REASONS[input.reason as HoldReason]}): ${input.note!.trim()}` }]),
    ]);
  }
  return { recorded };
}

/**
 * A holder of `direct` holds a page that has not been shown, or lifts that
 * hold. A page already shown cannot be held: a release is not taken back,
 * and ending the release is what stops later versions.
 */
export async function holdPage(input: { actor: GateActor; pageId: string; lift?: boolean; reason?: string }): Promise<void> {
  if (!input.actor.direct) throw new ReleaseError("NEEDS_DIRECT", "Holding a page takes the permission to direct the graph.");
  if (!input.lift && !(input.reason && input.reason in HOLD_REASONS)) {
    throw new ReleaseError("BAD_REASON", `A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
  }
  await bothSides(async () => {
    const [page] = await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM release_pages WHERE id = $1`, [input.pageId]);
    if (!page || !input.actor.clearance.includes(page.page_label)) throw new ReleaseError("PAGE_NOT_FOUND", "No page under a release has that id at a label you read.");
    const [release] = await rawQuery<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE id = $1`, [page.release_id]);
    const [received] = await rawQuery<{ released_at: Date | null }>(`SELECT released_at FROM received_pages WHERE id = $1`, [page.id]);
    const held = pageHeldByDirect(await actsOfPage(page.id));
    if (input.lift) {
      if (!held) throw new ReleaseError("NOT_HELD", "No hold by a person who directs the graph is on this page.");
    } else {
      if (received?.released_at) throw new ReleaseError("ALREADY_RELEASED", "This page has been released, and that is not taken back. Ending the release stops later versions from following.");
      if (held) throw new ReleaseError("ALREADY_HELD", "This page is already held.");
    }
    await withTransaction((tx) =>
      insertAct(tx, {
        releaseId: page.release_id,
        pageId: page.id,
        act: input.lift ? "page_hold_lifted" : "page_held",
        actor: input.actor,
        reason: input.lift ? null : input.reason,
        label: destinationOf(release!),
      })
    );
    if (input.lift) await settle(page.id);
  });
}

// ---- the queue --------------------------------------------------------------------

/**
 * What a person who holds `consent` for a party and does not read the
 * page's label is told, on each item. A gate held by someone who cannot see
 * what passes through it is not a gate, so they are shown what their
 * decision would release: the part as it would be shown, with what is
 * always shown of the page and the node's wording as they would be shown.
 * That text is bound for readers who read less than this person is trusted
 * to decide for. What the Redactor took out, and what it and Audit wrote
 * about the page, were written at the page's label and stay with those who
 * read it. One exception: what was taken out of a part that rests only on
 * the material of an outside party this person releases for is that
 * party's own, and is shown. The organization's own party is not such a
 * party here: a part that rests on no outside party's material is the
 * organization's by default, at a label this person does not read, and
 * what a policy removed from it is what that label holds.
 */
const SEEN_AS_RELEASED =
  "You hold the permission to consent for this party and do not read the label this page was written at. " +
  "You are shown what your consent would release, as it would be released: the part with each removal marked, what " +
  "is always shown of the page, and the node's wording. You are not shown the passages the Redactor removed, its " +
  "notes, or why it flagged a part. The one exception is a passage removed from a part that rests only on the " +
  "material of an outside party you consent for, which is that party's own. An administrator of this deployment " +
  "grants reading at a label.";

/**
 * What waits on a person at the gate: every item at the gate that rests on
 * a party they release for and that party has not released, oldest page
 * first, and within a page the parts the Redactor was least sure of first.
 * Each item carries the part as it would be shown if released, the
 * Redactor's removals by category, whether the Redactor flagged it, and
 * Audit's answer, with what is always shown of its page and the node's
 * wording as they would be shown. A person who also reads at the page's
 * label is given the part as written, each removed passage with the
 * Redactor's note, and why a part was flagged.
 */
export async function gateQueue(
  actor: GateActor & { administer?: boolean },
  opts: { limit?: number; kind?: string } = {}
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Where an item crosses, once for each gate: the label it was written at, named as the gate's settings
  // name it (gateSettings): its own name to a person who reads it or administers, else the face it shows
  // where things arrive, else nothing. A label's name is not shown to people who may not read it.
  const crossings = new Map<string, Record<string, unknown>>();
  const crossingOf = async (release: ReleaseRow): Promise<Record<string, unknown>> => {
    const known = crossings.get(release.boundary_id);
    if (known) return known;
    const named = actor.administer || actor.clearance.includes(release.page_label);
    const face = named ? null : await faceOfGate(release.boundary_id);
    const crossing = {
      gate_id: release.boundary_id,
      ...(named ? { from: release.page_label, from_named_by: "its label" } : face ? { from: face, from_named_by: "the face it shows where things arrive" } : {}),
      to: release.to_outside ? "outside this deployment" : release.to_label,
      to_outside: release.to_outside,
    };
    crossings.set(release.boundary_id, crossing);
    return crossing;
  };
  // The policy an item was redacted under, with the categories a passage can be removed under (removeAtGate).
  const policies = new Map<string, Record<string, unknown> | null>();
  const policyOf = async (pageId: string): Promise<Record<string, unknown> | null> => {
    const [row] = await rawQuery<{ id: string; version: number; hash: string; categories: Array<{ name: string }> }>(
      `SELECT r.id, r.version, r.hash, r.categories FROM redaction_policies r JOIN release_pages p ON p.policy_id = r.id WHERE p.id = $1`,
      [pageId]
    );
    if (!row) return null;
    if (!policies.has(row.id)) {
      policies.set(row.id, { policy_id: row.id, version: row.version, hash: row.hash, categories: (row.categories ?? []).map((c) => c.name) });
    }
    return policies.get(row.id)!;
  };
  return bothSides(async () => {
    const pages = await rawQuery<GatePage>(
      `SELECT ${GATE_PAGE_COLUMNS} FROM release_pages
        WHERE stage = 'at_gate'
          AND (rests_on && $1::uuid[] OR EXISTS (SELECT 1 FROM release_parts p WHERE p.page_id = release_pages.id AND p.rests_on && $1::uuid[]))
          AND ($2::text IS NULL OR (SELECT s.kind FROM releases s WHERE s.id = release_pages.release_id) = $2)
        ORDER BY checked_at, id`,
      [[...actor.consentParties], opts.kind ?? null]
    );
    const names = await partyNames(actor.consentParties as string[]);
    const ownOrganization = (await ownOrganizationParty())?.id ?? null;
    const items: Array<Record<string, unknown>> = [];
    let more = false;
    for (const page of pages) {
      const acts = await actsOfPage(page.id);
      const parts = await gatePartsOf(page.id);
      const removals = await rawQuery<{ id: string; part_id: string; start_offset: number; end_offset: number; category: string; note: string }>(
        `SELECT r.id, r.part_id, r.start_offset, r.end_offset, r.category, r.note
           FROM release_removals r JOIN release_parts p ON p.id = r.part_id
          WHERE p.page_id = $1 AND r.taken_back_at IS NULL ORDER BY r.start_offset`,
        [page.id]
      );
      const reads = actor.clearance.includes(page.page_label);
      const leastSure = page.least_sure ?? [];
      const unsure = (part: GatePart) =>
        leastSure.filter((l) => l.part === part.position || removals.some((r) => r.part_id === part.id && r.id === l.removal_id));
      const allNames = await partyNames([...page.rests_on, ...parts.flatMap((p) => p.rests_on)]);
      const wait = (partId: string | null, needs: string[]) =>
        needs.map((party) => ({ party: { id: party, name: allNames.get(party) ?? "" }, standing: standingOf(acts, partId, party) }));
      const mine = (partId: string | null, needs: string[]) =>
        actor.consentParties.filter((party) => needs.includes(party) && standingOf(acts, partId, party) !== "consented");
      // The node the page is of: its id always, and its wording where this person reads the node.
      const [node] = page.node_id
        ? await rawQuery<{ text: string; label: string }>(`SELECT text, sensitivity_label AS label FROM claims WHERE id = $1`, [page.node_id])
        : [];
      const [release] = await rawQuery<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE id = $1`, [page.release_id]);
      const modes = await modesOfPage(release!, page, parts);
      const crossing = await crossingOf(release!);
      const policy = await policyOf(page.id);
      // What stands on an item beside each party's own decision: the Redactor's hold, and a delay.
      const standing = (partId: string | null) => {
        const hold = gateHold(acts, partId);
        const delay = delayOn(acts, partId);
        return {
          ...(hold ? { held_by_the_redactor: { reason: HOLD_REASONS[(hold.reason ?? "no_reason_given") as HoldReason] ?? hold.reason, since: hold.at.toISOString() } } : {}),
          ...(delay ? { delayed_until: delay.until!.toISOString() } : {}),
          the_redactor_proposes: hold ? "hold" : delay ? "delay" : "let through",
        };
      };
      // A hold this person's parties have already placed on an item: its reason and since when.
      const heldBy = (partId: string | null) =>
        actor.consentParties
          .filter((party) => standingOf(acts, partId, party) === "held")
          .map((party) => {
            const hold = [...acts].reverse().find((a) => a.act === "held" && a.part_id === partId && a.party_id === party);
            return {
              party: { id: party, name: names.get(party) ?? "" },
              reason: HOLD_REASONS[(hold?.reason ?? "no_reason_given") as HoldReason] ?? hold?.reason ?? null,
              since: hold?.at.toISOString() ?? null,
            };
          });
      // The node's wording as the page would show it: where the node is at
      // the page's label its wording is a part of the page, and what would
      // be shown is that part after the Redactor's removals. Where the node
      // is at another label the page does not carry its wording, and it is
      // given only to a person who reads the node (`node`, below).
      const wording = parts.find((p) => p.kind === "wording");
      const base = {
        item_id: page.id,
        page_id: page.id,
        kind_of_thing: release!.kind,
        kind_of_thing_in_words: GATE_KINDS[release!.kind],
        release_id: page.release_id,
        ...crossing,
        // The policy it was redacted under: a passage is removed under one of these categories and no other.
        policy,
        ...(page.node_id ? { node_id: page.node_id } : {}),
        ...(node && actor.clearance.includes(node.label) ? { node: node.text } : {}),
        // What is shown whenever anything of the page is shown, and so with any part this person releases.
        always_released: JSON.parse(page.header),
        ...(wording ? { wording_as_it_would_be_released: wording.redacted ?? wording.original } : {}),
        audit: auditAnswerWords(page.audit_answer, acts),
        waiting_since: page.checked_at?.toISOString() ?? null,
        ...(reads ? {} : { seen_as_released: SEEN_AS_RELEASED }),
      };
      // A part that rests on the material of outside parties this person releases for, and on nobody else's:
      // what was removed from it is those parties' own.
      const theirsAlone = (needs: string[]) =>
        needs.length > 0 && needs.every((party) => party !== ownOrganization && actor.consentParties.includes(party));
      const pageItems: Array<Record<string, unknown> & { order: number }> = [];
      if (mine(null, page.rests_on).length > 0) {
        pageItems.push({
          ...base,
          part: null,
          kind: release!.kind === "page" ? "the page itself, with its verdict and everything that is always shown with it" : "the item itself, with what is always shown of it",
          decide_for: mine(null, page.rests_on).map((id) => ({ id, name: names.get(id) ?? "", setting: modes.get(id)?.mode })),
          rests_on: wait(null, page.rests_on),
          ...standing(null),
          ...(heldBy(null).length > 0 ? { held: heldBy(null) } : {}),
          order: -1,
        });
      }
      for (const part of parts) {
        if (mine(part.id, part.rests_on).length === 0) continue;
        const own = removals.filter((r) => r.part_id === part.id);
        const counts: Record<string, number> = {};
        for (const r of own) counts[r.category] = (counts[r.category] ?? 0) + 1;
        pageItems.push({
          ...base,
          part: part.position,
          kind: kindWords(part.descriptor),
          decide_for: mine(part.id, part.rests_on).map((id) => ({ id, name: names.get(id) ?? "", setting: modes.get(id)?.mode })),
          rests_on: wait(part.id, part.rests_on),
          ...standing(part.id),
          ...(heldBy(part.id).length > 0 ? { held: heldBy(part.id) } : {}),
          removals_by_category: counts,
          redactor_least_sure: unsure(part).length > 0,
          as_it_would_be_released: part.redacted ?? part.original,
          ...(reads
            ? {
                as_written: part.original,
                removals: own.map((r) => ({ passage: part.original.slice(r.start_offset, r.end_offset), category: r.category, redactor_note: r.note })),
                ...(unsure(part).length > 0 ? { why_least_sure: unsure(part).map((l) => l.why) } : {}),
              }
            : theirsAlone(part.rests_on) && own.length > 0
              ? { removals: own.map((r) => ({ passage: part.original.slice(r.start_offset, r.end_offset), category: r.category })) }
              : {}),
          order: unsure(part).length > 0 ? 0 : part.position,
        });
      }
      pageItems.sort((a, b) => a.order - b.order);
      for (const { order: _order, ...item } of pageItems) {
        if (items.length >= limit) {
          more = true;
          break;
        }
        items.push(item);
      }
      if (more) break;
    }
    const unread = items.filter((i) => "seen_as_released" in i).length;
    return {
      items,
      more_waiting: more,
      ...(unread > 0
        ? {
            not_reading_the_label:
              `${unread} of these ${items.length} item${items.length === 1 ? "" : "s"} ${unread === 1 ? "is" : "are"} of a page written at a label you do not read. ` +
              `For each you are shown the text your consent would release, as it would be released, and not what was removed from it or what ` +
              `the Redactor wrote about it.`,
          }
        : {}),
      // The fixed list a hold gives its reason from, each key with the words the other side is told.
      hold_reasons: HOLD_REASONS,
      acts: GATE_ACTS,
      note:
        "These are the items that wait on you: those whose gate is set to a person's decision for a party you consent for, and " +
        "those the Redactor or a person holds or has delayed. Everything else went through as the Redactor left it. " +
        "POST /gate/decisions takes many items at once, and sending the same decision again changes nothing. " +
        "The other side sees how many items wait, of what kinds, for how long and on whom.",
    };
  });
}

// ---- what the destination side reads -------------------------------------------------

export type NodeState = "not_yet_assessed" | "released_whole" | "released_in_part" | "held";

const STAGE_WORDS: Record<PageStage, string> = {
  to_redact: "waiting for the Redactor's run, which is paid for from the budget of the work that produced it",
  to_check: "redacted, and waiting for Audit's check of the redaction",
  at_gate: "at the gate",
  cannot_cross: "it cannot be released under this boundary's policy: something that is always shown with a page could not be released here",
  overtaken: "a later version was recorded before this one was redacted, so this one was not",
};

/** The same stages where the budget that pays for the work could not pay. */
const STAGE_WORDS_UNPAID: Partial<Record<PageStage, string>> = {
  to_redact: "waiting for funds: none of the budgets that pay for its redaction could pay for it",
  to_check: "waiting for funds: none of the budgets that pay for the check of its redaction could pay for it",
};

const ACT_WORDS: Record<string, string> = {
  removed: "removed a passage",
  delayed: "delayed",
  delay_lifted: "lifted a delay",
  asked: "asked for the release",
  ended: "ended the release",
  consented: "consented",
  held: "held",
  hold_lifted: "lifted a hold",
  page_held: "held the page",
  page_hold_lifted: "lifted a hold on the page",
  returned_by_check: "the check returned the redaction to be done again",
  cannot_cross: "the Redactor found that the page cannot be released under the policy",
};

/** What an act was, in words. A flow set because a request on the other side asked for the page says so. */
const actWhat = (a: { act: string; reason: string | null }): string =>
  a.act === "asked" && a.reason === "asked_for_by_a_request" ? "the page was asked for by a request made on the other side, which set the flow" : (ACT_WORDS[a.act] ?? a.act);

function age(since: Date): string {
  const hours = Math.floor((Date.now() - since.getTime()) / 3_600_000);
  return hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.floor(hours / 24)} days`;
}

/**
 * Audit's answer as it is shown, with what a person changed after it. Audit
 * checks the page as the Redactor left it. A person at the gate may then
 * remove more, or lift a hold the Redactor placed, and nothing checks that
 * again: those acts are said beside the answer in fixed words, so that the
 * answer is not read as covering text Audit never saw. A hold or a release
 * changes no text and is not listed. Null where no answer is recorded.
 */
export function auditAnswerWords(answer: FidelityAnswer | null, acts: readonly Pick<ActRow, "act" | "by" | "party_id" | "part_id">[]): string | null {
  if (!answer) return null;
  const byPerson = acts.filter((a) => a.by === "person");
  const removed = byPerson.filter((a) => a.act === "removed").length;
  const lifted = byPerson.filter((a) => a.act === "hold_lifted" && a.party_id === null);
  const after: string[] = [];
  if (removed > 0) after.push(`removed ${removed === 1 ? "a passage" : `${removed} passages`}`);
  if (lifted.some((a) => a.part_id === null)) after.push("lifted the Redactor's hold on the whole item");
  const liftedParts = new Set(lifted.filter((a) => a.part_id !== null).map((a) => a.part_id)).size;
  if (liftedParts > 0) after.push(`lifted the Redactor's hold on ${liftedParts === 1 ? "a part" : `${liftedParts} parts`}`);
  if (after.length === 0) return FIDELITY_ANSWERS[answer];
  return `${FIDELITY_ANSWERS[answer]} The check was made before a person at the gate ${after.join(" and ")}, which it did not check.`;
}

/** Why an item that has not been shown is held, in fixed words: a person's hold, the Redactor's, a delay, who it waits on, or the stage it is at. */
function heldBecause(page: ReceivedPageRow, acts: readonly ActRow[], waitingOn: readonly string[]): string {
  const directHold = pageHeldByDirect(acts);
  if (directHold) return `held by a person who directs the graph (${HOLD_REASONS[(directHold.reason ?? "no_reason_given") as HoldReason]})`;
  if (page.stage !== "at_gate") return (page.waiting_for_funds ? STAGE_WORDS_UNPAID[page.stage] : undefined) ?? STAGE_WORDS[page.stage];
  const redactor = gateHold(acts, null);
  if (redactor) return `held by the Redactor (${HOLD_REASONS[(redactor.reason ?? "no_reason_given") as HoldReason]})`;
  const delay = delayOn(acts, null);
  if (delay) return `delayed until ${delay.until!.toISOString()}`;
  return `waiting on ${waitingOn.join(" and ") || "the people who consent for its parties"}`;
}

/** One version of a node's page as the destination side may describe it without any of its text. */
async function describeReceivedPage(page: ReceivedPageRow): Promise<Record<string, unknown>> {
  const parts = await receivedPartsOf(page.id);
  const acts = await actsOfPage(page.id);
  const names = await partyNames([...page.needs, ...parts.flatMap((p) => p.needs)]);
  const held = parts.filter((p) => p.released_at === null);
  const waitingOn = page.needs.filter((party) => standingOf(acts, null, party) !== "consented").map((party) => names.get(party) ?? "a party");
  const state: NodeState = !page.released_at ? "held" : held.length === 0 ? "released_whole" : "released_in_part";
  return {
    page_id: page.id,
    version_of: page.judged_at.toISOString(),
    state,
    ...(state === "held"
      ? {
          held_because: heldBecause(page, acts, waitingOn),
          held_for: age(page.opened_at),
        }
      : {
          released_at: page.released_at!.toISOString(),
          source_id: page.source_id,
          // Beside the state, always: a page released whole can still have passages removed inside its parts.
          removals_under_the_policy: (JSON.parse(page.header!) as { removals?: Record<string, number> }).removals ?? {},
        }),
    ...(state === "released_in_part" ? { parts_held: held.length, of_parts: parts.length, held_kinds: heldByKind(held) } : {}),
    ...(state === "released_whole" ? { of_parts: parts.length } : {}),
    redaction_round: page.round,
    fingerprint: page.root,
    fingerprint_format: page.fingerprint_format,
    audit: auditAnswerWords(page.audit_answer, acts),
  };
}

/**
 * A release as its destination side reads it: every node it covers with
 * one of four states, every version made while it stood, and every act on
 * it with who acted and which permissions they held. Read with the
 * caller's own clearance: a caller who does not read the destination label
 * finds nothing.
 */
export async function receivedRelease(releaseId: string): Promise<Record<string, unknown> | null> {
  const [release] = await rawQuery<{
    id: string; kind: GateKind; node_id: string; to_outside: boolean; boundary_id: string; form: string; scope: string;
    asked_at: Date; ended_at: Date | null; end_reason: string | null; label: string; asker: string | null; asked_holding: string[];
  }>(
    `SELECT s.id, s.kind, s.node_id, s.to_outside, s.boundary_id, s.form, s.scope, s.asked_at, s.ended_at, s.end_reason,
            s.sensitivity_label AS label, c.display_name AS asker, s.asked_holding
       FROM received_releases s LEFT JOIN contributors c ON c.id = s.asked_by WHERE s.id = $1`,
    [releaseId]
  );
  if (!release) return null;
  const nodes = await rawQuery<{ id: string; node_id: string; place_parent_id: string | null; entered_at: Date; left_at: Date | null; left_reason: string | null; first_assessed_at: Date | null; text: string | null }>(
    `SELECT n.id, n.node_id, n.place_parent_id, n.entered_at, n.left_at, n.left_reason, n.first_assessed_at, c.text
       FROM received_nodes n LEFT JOIN claims c ON c.id = n.node_id
      WHERE n.release_id = $1 ORDER BY n.entered_at, n.id`,
    [releaseId]
  );
  const pages = await rawQuery<ReceivedPageRow>(`SELECT ${RECEIVED_PAGE_COLUMNS} FROM received_pages WHERE release_id = $1 ORDER BY judged_at DESC, opened_at DESC`, [releaseId]);
  const acts = await rawQuery<ActRow & { actor: string | null; party: string | null; position: number | null }>(
    `SELECT a.id, a.release_id, a.page_id, a.part_id, a.act, a.party_id, a.actor_id, a.holding, a.rule_id, a.reason, a.at, a.by, a.run_id, a.until,
            c.display_name AS actor, p.name AS party, sp.position
       FROM release_acts a LEFT JOIN contributors c ON c.id = a.actor_id LEFT JOIN parties p ON p.id = a.party_id
       LEFT JOIN received_parts sp ON sp.id = a.part_id
      WHERE a.release_id = $1 ORDER BY a.at, a.id`,
    [releaseId]
  );
  const [policy] = await rawQuery<{ id: string; version: number; hash: string }>(
    `SELECT id, version, hash FROM redaction_policies WHERE boundary_id = $1 AND side = 'destination' ORDER BY version DESC LIMIT 1`,
    [release.boundary_id]
  );
  const described = new Map<string, Record<string, unknown>>();
  for (const page of pages) described.set(page.id, await describeReceivedPage(page));
  const covers = await coversOfRelease(release);
  return {
    release_id: release.id,
    released_to: release.to_outside ? "outside this deployment" : `readers at "${release.label}"`,
    form: release.form,
    // What the release covers, in words (releaseCovers); `scope_code` is the scope as GET /releases lists it.
    scope: covers,
    scope_code: release.scope,
    asked_at: release.asked_at.toISOString(),
    asked_by: release.asker,
    asked_holding: release.asked_holding,
    ended_at: release.ended_at?.toISOString() ?? null,
    ended_because: release.end_reason ? END_REASONS[release.end_reason as keyof typeof END_REASONS] : null,
    policy: policy ? { policy_id: policy.id, version: policy.version, hash: policy.hash } : null,
    nodes: nodes.map((n) => {
      const own = pages.filter((p) => p.node_id === n.node_id && p.stage !== "overtaken");
      const latest = own[0];
      return {
        node_id: n.node_id,
        // The node's wording, where this reader reads the node. A node at the page's label is known here by its page.
        text: n.text,
        under: n.place_parent_id,
        covered_from: n.entered_at.toISOString(),
        ...(n.left_at ? { left_at: n.left_at.toISOString(), left_because: LEFT_REASONS[n.left_reason as keyof typeof LEFT_REASONS] ?? n.left_reason } : {}),
        first_assessed_at: n.first_assessed_at?.toISOString() ?? null,
        release_began: n.first_assessed_at === null ? "before the node was first assessed" : n.first_assessed_at > n.entered_at ? "before the node was first assessed" : "after the node was first assessed",
        state: latest ? described.get(latest.id)!.state : ("not_yet_assessed" as NodeState),
        versions: pages.filter((p) => p.node_id === n.node_id).map((p) => described.get(p.id)),
      };
    }),
    acts: acts.map((a) => ({
      at: a.at.toISOString(),
      what: actWhat(a),
      ...(a.page_id ? { page_id: a.page_id, on: a.part_id ? `part ${a.position ?? "?"}` : "the page" } : {}),
      ...(a.party ? { for_party: a.party } : {}),
      by: a.actor ?? (a.by === "redactor" ? "the Redactor" : a.by === "setting" ? "the gate's setting" : "the process"),
      ...(a.run_id ? { run_id: a.run_id } : {}),
      ...(a.until ? { until: a.until.toISOString() } : {}),
      ...(a.act === "removed" && a.reason ? { category: a.reason } : {}),
      ...(a.rule_id ? { rule_id: a.rule_id } : {}),
      holding: a.holding,
      ...(a.reason && (a.act === "held" || a.act === "page_held") ? { reason: HOLD_REASONS[a.reason as HoldReason] ?? a.reason } : {}),
      ...(a.reason && a.act === "ended" ? { reason: END_REASONS[a.reason as keyof typeof END_REASONS] ?? a.reason } : {}),
    })),
  };
}

/**
 * What a release covers, in words, naming what this reader may be told: the
 * mandate, and the label its pages are written at, where they read that
 * label (the page side's row of the release is read with their own
 * clearance, so it is found only then); else the face that label shows
 * where things arrive (faceOfGate), else nothing.
 */
async function coversOfRelease(release: { id: string; kind: GateKind; scope: string; boundary_id: string }): Promise<string> {
  if (release.scope !== "mandate" && release.scope !== "boundary" && release.scope !== "item") return releaseCovers(release.scope);
  const [side] = await rawQuery<{ from: string; mandate: string | null }>(
    `SELECT s.sensitivity_label AS from, g.name AS mandate FROM releases s LEFT JOIN grants g ON g.id = s.subject_ref AND s.scope = 'mandate' WHERE s.id = $1`,
    [release.id]
  );
  const from = side?.from ?? (release.scope === "boundary" ? await faceOfGate(release.boundary_id) : null);
  return releaseCovers(release.scope, { mandate: side?.mandate ?? null, from, item: GATE_KINDS[release.kind] ?? null });
}

/** The releases whose destination side the caller reads, newest first. */
export async function receivedReleases(opts: { nodeId?: string } = {}): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<{ id: string; node_id: string; to_outside: boolean; form: string; scope: string; asked_at: Date; ended_at: Date | null; label: string }>(
    `SELECT s.id, s.node_id, s.to_outside, s.form, s.scope, s.asked_at, s.ended_at, s.sensitivity_label AS label
       FROM received_releases s
      WHERE ($1::uuid IS NULL OR s.node_id = $1 OR EXISTS (SELECT 1 FROM received_nodes n WHERE n.release_id = s.id AND n.node_id = $1))
      ORDER BY s.asked_at DESC`,
    [opts.nodeId ?? null]
  );
  return rows.map((r) => ({
    release_id: r.id,
    node_id: r.node_id,
    released_to: r.to_outside ? "outside this deployment" : `readers at "${r.label}"`,
    form: r.form,
    scope: r.scope,
    asked_at: r.asked_at.toISOString(),
    ended_at: r.ended_at?.toISOString() ?? null,
  }));
}

/**
 * One shown page as the destination side reads it: what is always shown,
 * each released part as written with its marks, each held part named by
 * its kind and who holds it, and everything needed to check it against the
 * fingerprint recorded before the gate, with the result of that check.
 * Read with the caller's own clearance.
 */
export async function receivedPage(pageId: string): Promise<(Record<string, unknown> & { verification: Verification | null }) | null> {
  const [page] = await rawQuery<ReceivedPageRow>(`SELECT ${RECEIVED_PAGE_COLUMNS} FROM received_pages WHERE id = $1`, [pageId]);
  if (!page) return null;
  const described = await describeReceivedPage(page);
  if (!page.released_at || !page.header) return { ...described, verification: null };
  const parts = await receivedPartsOf(pageId);
  const acts = await actsOfPage(pageId);
  const names = await partyNames(parts.flatMap((p) => p.needs));
  const verification = verifyReleasedPage({
    root: page.root!,
    format: page.fingerprint_format,
    verdict: { position: 0, descriptor: "verdict", commitment: page.header_commitment!, text: page.header, salt: page.header_salt, marks: [] },
    parts: parts.map((p) => ({ position: p.position, descriptor: p.descriptor, commitment: p.commitment, text: p.text, marks: p.marks, salt: p.salt, refs: p.public_refs })),
  });
  return {
    ...described,
    always_released: JSON.parse(page.header),
    always_released_as_hashed: { text: page.header, salt: page.header_salt, hash: page.header_commitment },
    earlier_fingerprints: page.roots,
    parts: parts.map((p) =>
      p.released_at !== null
        ? {
            part: p.position, kind: p.kind, descriptor: p.descriptor, text: p.text, removals_marked: p.marks ?? [], salt: p.salt,
            ...(p.public_refs && p.public_refs.length > 0 ? { refs: p.public_refs } : {}),
            hash: p.commitment,
          }
        : {
            part: p.position,
            kind: p.kind,
            descriptor: p.descriptor,
            held: heldWords(p.descriptor, holdersOf(acts, p, names)),
            hash: p.commitment,
          }
    ),
    verification,
  };
}

/**
 * The releases asked for at labels the caller reads, with where each page
 * stands on the page's side: for the people who direct the graph there.
 * Read with the caller's own clearance.
 */
export async function askedReleases(): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<ReleaseRow & { text: string | null }>(
    `SELECT s.id, s.node_id, s.to_label, s.to_outside, s.boundary_id, s.form, s.scope, s.asked_at, s.ended_at,
            s.sensitivity_label AS page_label, c.text
       FROM releases s LEFT JOIN claims c ON c.id = s.node_id ORDER BY s.asked_at DESC`
  );
  const out: Array<Record<string, unknown>> = [];
  for (const s of rows) {
    const pages = await rawQuery<{ id: string; node_id: string; stage: PageStage; round: number; judged_at: Date; redact_action_id: string | null; audit_run_id: string | null; cannot_cross_category: string | null; cannot_cross_note: string | null; audit_reasons: string | null; funds_wanted_at: Date | null }>(
      `SELECT id, node_id, stage, round, judged_at, redact_action_id, audit_run_id, cannot_cross_category, cannot_cross_note, audit_reasons, funds_wanted_at
         FROM release_pages WHERE release_id = $1 ORDER BY judged_at DESC`,
      [s.id]
    );
    // For a page at the release gate: which kinds of part wait on which party, and where each party stands.
    // Kind and party and nothing of the text, which this reader has in front of them on the node's own page.
    const waiting = new Map<string, Array<{ part: number | null; kind: string; party: string; standing: ItemStanding }>>();
    for (const p of pages.filter((page) => page.stage === "at_gate")) {
      const [page] = await rawQuery<{ rests_on: string[] }>(`SELECT rests_on FROM release_pages WHERE id = $1`, [p.id]);
      const parts = await rawQuery<{ id: string; position: number; descriptor: string; rests_on: string[] }>(
        `SELECT id, position, descriptor, rests_on FROM release_parts WHERE page_id = $1 ORDER BY position`,
        [p.id]
      );
      // The acts are rows on the side the page is shown to, which this reader may not read; only where each party stands is taken from them.
      const { acts, names } = await bothSides(async () => ({
        acts: await actsOfPage(p.id),
        names: await partyNames([...(page?.rests_on ?? []), ...parts.flatMap((part) => part.rests_on)]),
      }));
      const lines: Array<{ part: number | null; kind: string; party: string; standing: ItemStanding }> = [];
      for (const party of page?.rests_on ?? []) {
        const standing = standingOf(acts, null, party);
        if (standing !== "consented") lines.push({ part: null, kind: "the page itself, with its verdict", party: names.get(party) ?? "a party", standing });
      }
      for (const part of parts) {
        for (const party of part.rests_on) {
          const standing = standingOf(acts, part.id, party);
          if (standing !== "consented") lines.push({ part: part.position, kind: kindWords(part.descriptor), party: names.get(party) ?? "a party", standing });
        }
      }
      waiting.set(p.id, lines);
    }
    out.push({
      release_id: s.id,
      node_id: s.node_id,
      node: s.text,
      page_label: s.page_label,
      released_to: s.to_outside ? "outside this deployment" : s.to_label,
      form: s.form,
      scope: s.scope,
      asked_at: s.asked_at.toISOString(),
      ended_at: s.ended_at?.toISOString() ?? null,
      pages: pages.map((p) => ({
        ...(waiting.has(p.id) ? { waiting_on: waiting.get(p.id) } : {}),
        page_id: p.id,
        node_id: p.node_id,
        version_of: p.judged_at.toISOString(),
        stage: p.stage,
        // A page whose redaction or check the budget could not pay says so,
        // as it does on the side it goes to (stageWords above).
        stage_in_words: (p.funds_wanted_at ? STAGE_WORDS_UNPAID[p.stage] : undefined) ?? STAGE_WORDS[p.stage],
        round: p.round,
        redact_action_id: p.redact_action_id,
        ...(p.cannot_cross_category ? { cannot_cross: { category: p.cannot_cross_category, note: p.cannot_cross_note } } : {}),
        ...(p.audit_reasons ? { audit_reasons: p.audit_reasons } : {}),
      })),
    });
  }
  return out;
}

// ---- what a release outside says to the outside ------------------------------------

/**
 * One node under a release outside, as the outside is to read it: its state,
 * the current version's page with each released part's text and salt and
 * each held part's hash, kind and who holds it, every version made while
 * the release stood, and every act with the permissions held. This is what
 * a signed package carries (services/outbound-service.ts), and everything
 * in it comes from the destination-side rows of the release, which are at
 * `public`.
 *
 * It holds no age and no clock reading, so that the same state always
 * gives the same answer: a new package is built when this changes.
 *
 * People are numbered in the order they first acted on the release. No
 * name of a person is included.
 *
 * Read with the caller's own clearance; the package builder calls it as
 * work at `public`, where nothing at another label can be read.
 */
export async function outsideRecord(releaseId: string, nodeId: string): Promise<{
  release: { id: string; form: string; scope: string; asked_at: string; send: "by_a_person_each_time" | "as_released"; ended: null | { at: string; because: string } };
  node: { covered_from: string; first_assessed_at: string | null; release_began: string; left: null | { at: string; because: string } };
  state: NodeState;
  page: null | Record<string, unknown>;
  policy: null | { version: number; hash: string; text: string };
  made: null | Record<string, unknown>;
  acts: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
} | null> {
  const [release] = await rawQuery<{
    id: string; boundary_id: string; form: string; scope: string; asked_at: Date; ended_at: Date | null; end_reason: string | null; send_as_released: boolean;
  }>(
    `SELECT id, boundary_id, form, scope, asked_at, ended_at, end_reason, send_as_released FROM received_releases WHERE id = $1 AND to_outside`,
    [releaseId]
  );
  if (!release) return null;
  const [node] = await rawQuery<{ entered_at: Date; left_at: Date | null; left_reason: string | null; first_assessed_at: Date | null }>(
    `SELECT entered_at, left_at, left_reason, first_assessed_at FROM received_nodes WHERE release_id = $1 AND node_id = $2 ORDER BY entered_at LIMIT 1`,
    [releaseId, nodeId]
  );
  if (!node) return null;
  const pages = await rawQuery<ReceivedPageRow>(
    `SELECT ${RECEIVED_PAGE_COLUMNS} FROM received_pages WHERE release_id = $1 AND node_id = $2 ORDER BY judged_at DESC, opened_at DESC`,
    [releaseId, nodeId]
  );
  const allActs = await rawQuery<ActRow & { party: string | null; position: number | null }>(
    `SELECT a.id, a.release_id, a.page_id, a.part_id, a.act, a.party_id, a.actor_id, a.holding, a.rule_id, a.reason, a.at, a.by, a.run_id, a.until,
            p.name AS party, sp.position
       FROM release_acts a LEFT JOIN parties p ON p.id = a.party_id LEFT JOIN received_parts sp ON sp.id = a.part_id
      WHERE a.release_id = $1 ORDER BY a.at, a.id`,
    [releaseId]
  );
  const people = new Map<string, string>();
  for (const a of allActs) if (a.actor_id && !people.has(a.actor_id)) people.set(a.actor_id, `person ${people.size + 1}`);
  const pageIds = new Set(pages.map((p) => p.id));

  const versions: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  let currentState: NodeState = "not_yet_assessed";
  let policy: { version: number; hash: string; text: string } | null = null;
  let made: Record<string, unknown> | null = null;
  const live = pages.filter((p) => p.stage !== "overtaken");
  for (const page of pages) {
    const parts = await receivedPartsOf(page.id);
    const acts = allActs.filter((a) => a.page_id === page.id);
    const names = await partyNames([...page.needs, ...parts.flatMap((p) => p.needs)]);
    const heldParts = parts.filter((p) => p.released_at === null);
    const directHold = pageHeldByDirect(acts);
    const waitingOn = page.needs.filter((party) => standingOf(acts, null, party) !== "consented").map((party) => names.get(party) ?? "a party");
    const header = page.released_at && page.header ? (JSON.parse(page.header) as Record<string, unknown>) : null;
    const state: NodeState | "not_redacted" =
      page.stage === "overtaken" ? "not_redacted" : !page.released_at ? "held" : heldParts.length === 0 ? "released_whole" : "released_in_part";
    const because = heldBecause(page, acts, waitingOn);
    const since = (directHold?.at ?? page.opened_at).toISOString();
    versions.push({
      page_id: page.id,
      version_of: page.judged_at.toISOString(),
      state,
      ...(state === "held" || state === "not_redacted" ? { held_because: because, held_since: since } : { released_at: page.released_at!.toISOString() }),
      ...(state === "released_in_part" ? { parts_held: heldParts.length, held_kinds: heldByKind(heldParts) } : {}),
      ...(header ? { of_parts: parts.length, removals: (header.removals as Record<string, number>) ?? {} } : {}),
      // How the publisher's gate was set for this version when it went, stamped by the gate (stampReleasedUnder).
      ...(page.released_at && page.released_under ? { released_under: page.released_under } : {}),
      fingerprint: page.root,
    });
    if (page.id === live[0]?.id) currentState = state as NodeState;
    // The page carried is the latest version that is shown, or the latest version where none is.
    if (page.id !== (live.find((p) => p.released_at !== null) ?? live[0])?.id) continue;
    const heldOf = (part: ReceivedPartRow) => {
      const holders = part.needs.filter((party) => standingOf(acts, part.id, party) !== "consented");
      const holds = holders
        .map((party) => [...acts].reverse().find((a) => a.part_id === part.id && a.party_id === party && a.act === "held" && standingOf(acts, part.id, party) === "held"))
        .filter((a): a is (typeof acts)[number] => !!a);
      return {
        by: holders.map((party) => names.get(party) ?? "a party"),
        reasons: [...new Set(holds.map((a) => HOLD_REASONS[(a.reason ?? "no_reason_given") as HoldReason] ?? "no reason given"))],
        since: holds.length > 0 ? holds.map((a) => a.at.toISOString()).sort()[0]! : null,
      };
    };
    current = {
      id: page.id,
      version_of: page.judged_at.toISOString(),
      state,
      held: page.released_at ? null : { because, since },
      released_at: page.released_at?.toISOString() ?? null,
      redaction_round: page.round,
      fingerprint: page.root,
      fingerprint_format: page.fingerprint_format,
      earlier_fingerprints: page.roots,
      always_released: page.released_at && page.header ? { text: page.header, salt: page.header_salt } : null,
      always_released_hash: page.header_commitment,
      // Until the page itself is shown no part's text is on this side, whoever has released it.
      parts: parts.map((p) =>
        page.released_at && p.released_at !== null
          ? {
              part: p.position, kind: p.kind, descriptor: p.descriptor, hash: p.commitment, text: p.text, marks: p.marks ?? [], salt: p.salt,
              // The nodes it cites that the public graph holds, by their public ids, under the construction that covers them (#1157).
              ...(isRefsFormat(page.fingerprint_format) ? { refs: p.public_refs ?? [] } : {}),
            }
          : { part: p.position, kind: p.kind, descriptor: p.descriptor, hash: p.commitment, held: heldOf(p) }
      ),
      audit: page.released_at ? auditAnswerWords(page.audit_answer, acts) : null,
    };
    if (header) {
      const how = (header.made ?? {}) as Record<string, unknown>;
      made = {
        prompt_set: how.prompt_set ?? null,
        assessed_by_model: how.assessed_by_model ?? null,
        redacted_by_model: how.redacted_by_model ?? null,
        role_additions: how.role_additions ?? [],
        run_log: how.run_log ?? null,
        paid_for: how.paid_for ?? null,
      };
      const under = (how.policy ?? {}) as { version?: number | null };
      const [row] = await rawQuery<{ version: number; hash: string; body: string }>(
        `SELECT version, hash, body FROM redaction_policies WHERE boundary_id = $1 AND side = 'destination' AND version = $2`,
        [release.boundary_id, under.version ?? null]
      );
      if (row) policy = { version: row.version, hash: row.hash, text: row.body };
    }
  }

  return {
    release: {
      id: release.id,
      form: release.form,
      scope: release.scope,
      asked_at: release.asked_at.toISOString(),
      send: release.send_as_released ? "as_released" : "by_a_person_each_time",
      ended: release.ended_at
        ? { at: release.ended_at.toISOString(), because: END_REASONS[(release.end_reason ?? "no_reason_given") as keyof typeof END_REASONS] ?? "no reason given" }
        : null,
    },
    node: {
      covered_from: node.entered_at.toISOString(),
      first_assessed_at: node.first_assessed_at?.toISOString() ?? null,
      release_began:
        node.first_assessed_at === null || node.first_assessed_at > node.entered_at
          ? "before the node was first assessed"
          : "after the node was first assessed",
      left: node.left_at
        ? { at: node.left_at.toISOString(), because: LEFT_REASONS[node.left_reason as keyof typeof LEFT_REASONS] ?? "not recorded" }
        : null,
    },
    state: currentState,
    page: current,
    policy,
    made,
    acts: allActs
      .filter((a) => a.page_id === null || pageIds.has(a.page_id))
      .map((a) => ({
        at: a.at.toISOString(),
        what: actWhat(a),
        ...(a.page_id ? { page_id: a.page_id, on: a.part_id ? `part ${a.position ?? "?"}` : "the page" } : {}),
        ...(a.party ? { for_party: a.party } : {}),
        by: a.actor_id ? people.get(a.actor_id)! : a.by === "redactor" ? "the Redactor" : a.by === "setting" ? "the gate's setting" : "the process",
        holding: a.holding,
        ...(a.reason && (a.act === "held" || a.act === "page_held") ? { reason: HOLD_REASONS[a.reason as HoldReason] ?? a.reason } : {}),
        ...(a.reason && a.act === "ended" ? { reason: END_REASONS[a.reason as keyof typeof END_REASONS] ?? a.reason } : {}),
      })),
    versions,
  };
}

// ---- the backlog ---------------------------------------------------------------------

/**
 * A gate's backlog: how many items have not gone through, of what kinds,
 * for how long, and what each waits on (the budget, the Redactor's run,
 * Audit's check, the Redactor's hold, a person's hold or decision by
 * party, a delay). It is counts and fixed words. No item is named, nothing
 * of any item's text is in it, and the label things come from is named
 * only to a person who reads it or has a say over the gate.
 *
 * It is shown to the readers of the destination label unless the gate's
 * authorities turned that off: a long backlog says the policy is set wrong
 * or that whoever holds is not acting, and the people waiting are the ones
 * placed to notice. Read from the destination-side rows with the caller's
 * own clearance; an authority who does not read that label is given the
 * same counts as the tables' owner.
 */
export async function gateBacklog(
  reader: { clearance: readonly string[]; administer: boolean; consentParties: readonly string[] },
  opts: { boundaryId?: string } = {}
): Promise<Record<string, unknown>> {
  const authority = reader.administer || reader.consentParties.length > 0;
  const read = async () => {
    const pages = await rawQuery<ReceivedPageRow & { boundary_id: string; to_outside: boolean; to: string; backlog_visible: boolean }>(
      `SELECT ${RECEIVED_PAGE_COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")}, s.boundary_id, s.to_outside, s.sensitivity_label AS to,
              COALESCE(g.backlog_visible, true) AS backlog_visible
         FROM received_pages p JOIN received_releases s ON s.id = p.release_id
         LEFT JOIN gates g ON g.boundary_id = s.boundary_id
        WHERE p.stage IN ('to_redact', 'to_check', 'at_gate', 'cannot_cross')
          AND ($1::uuid IS NULL OR s.boundary_id = $1)
          AND (p.released_at IS NULL OR EXISTS (SELECT 1 FROM received_parts sp WHERE sp.page_id = p.id AND sp.released_at IS NULL))
        ORDER BY p.opened_at`,
      [opts.boundaryId ?? null]
    );
    const lines = new Map<string, { gate: string; kind: GateKind; holder: Holder; party: string | null; items: Set<string>; parts: number; oldest: Date }>();
    const count = (page: (typeof pages)[number], holder: Holder, party: string | null, parts: number) => {
      const key = `${page.boundary_id}|${page.kind}|${holder}|${party ?? ""}`;
      const line = lines.get(key) ?? { gate: page.boundary_id, kind: page.kind, holder, party, items: new Set<string>(), parts: 0, oldest: page.opened_at };
      line.items.add(page.id);
      line.parts += parts;
      if (page.opened_at < line.oldest) line.oldest = page.opened_at;
      lines.set(key, line);
    };
    const gatesSeen = new Map<string, { to: string; to_outside: boolean; visible: boolean }>();
    for (const page of pages) {
      gatesSeen.set(page.boundary_id, { to: page.to, to_outside: page.to_outside, visible: page.backlog_visible });
      if (!page.backlog_visible && !authority) continue;
      if (page.stage === "to_redact") count(page, page.waiting_for_funds ? "funds" : "redactor_run", null, 0);
      else if (page.stage === "to_check") count(page, page.waiting_for_funds ? "funds" : "check", null, 0);
      else if (page.stage === "cannot_cross") count(page, "redactor", null, 0);
      else {
        const acts = await actsOfPage(page.id);
        const parts = await receivedPartsOf(page.id);
        const names = await partyNames([...page.needs, ...parts.flatMap((p) => p.needs)]);
        const targets = [...(page.released_at ? [] : [{ id: null as string | null, needs: page.needs }]), ...parts.filter((p) => p.released_at === null)];
        if (pageHeldByDirect(acts) && !page.released_at) count(page, "person", null, 0);
        for (const t of targets) {
          const n = t.id === null ? 0 : 1;
          if (gateHold(acts, t.id)) count(page, "redactor", null, n);
          if (delayOn(acts, t.id)) count(page, "delayed", null, n);
          for (const party of t.needs) {
            const standing = standingOf(acts, t.id, party);
            if (standing === "held") count(page, "person", names.get(party) ?? "a party", n);
            if (standing === "waiting" && !gateHold(acts, t.id) && !delayOn(acts, t.id)) count(page, "waiting_on_person", names.get(party) ?? "a party", n);
          }
        }
      }
    }
    return { lines: [...lines.values()], gatesSeen };
  };
  const { lines, gatesSeen } = authority ? await bothSides(read) : await read();
  // Where things come from: the label's name for those who read it and for administrators, who define
  // the labels; for anyone else the face that label shows on this side, where it shows one.
  const from = new Map<string, string>();
  for (const id of gatesSeen.keys()) {
    const gate = await gateOf(id);
    if (!gate) continue;
    if (reader.administer || reader.clearance.includes(gate.from_label)) from.set(id, gate.from_label);
    else {
      const face = await faceOfGate(id);
      if (face) from.set(id, face);
    }
  }
  const hours = (since: Date) => Math.max(0, Math.floor((Date.now() - since.getTime()) / 3_600_000));
  return {
    gates: [...gatesSeen.entries()]
      .filter(([, g]) => g.visible || authority)
      .map(([id, g]) => {
        const own = lines.filter((l) => l.gate === id);
        return {
          gate_id: id,
          ...(from.has(id) ? { from: from.get(id) } : {}),
          to: g.to_outside ? "outside this deployment" : g.to,
          items_waiting: new Set(own.flatMap((l) => [...l.items])).size,
          waiting: own
            .sort((a, b) => a.oldest.getTime() - b.oldest.getTime())
            .map((l) => ({
              kind: l.kind,
              kind_in_words: GATE_KINDS[l.kind],
              waiting_on: l.holder,
              in_words: HOLDERS[l.holder],
              ...(l.party ? { party: l.party } : {}),
              items: l.items.size,
              ...(l.parts > 0 ? { parts: l.parts } : {}),
              oldest_waiting_hours: hours(l.oldest),
            })),
        };
      }),
    asked_from_here: await askedFromHere(),
    note:
      "Counts of what has not gone through each gate, by kind and by what it waits on. An item can wait on more than one thing, so the lines of a gate can add up to more than its items. " +
      "Nothing here says what any item contains. A long wait on the Redactor's hold or on a person suggests the policy or the setting needs changing, which the gate's authorities do.",
  };
}

/**
 * Items that are not a node's page, as the destination side holds them:
 * what came through, by kind, with the source its text is in. Read with
 * the caller's own clearance. `replyRef` narrows it to what answers one
 * row on this side (a request, a message).
 */
export async function receivedItems(opts: { kind?: string; replyRef?: string } = {}): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<{ id: string; kind: GateKind; reply_ref: string | null; opened_at: Date; released_at: Date | null; source_id: string | null; stage: PageStage; waiting_for_funds: boolean }>(
    `SELECT p.id, p.kind, s.reply_ref, p.opened_at, p.released_at, p.source_id, p.stage, p.waiting_for_funds
       FROM received_pages p JOIN received_releases s ON s.id = p.release_id
      WHERE p.kind <> 'page' AND p.stage <> 'overtaken'
        AND ($1::text IS NULL OR p.kind = $1) AND ($2::uuid IS NULL OR s.reply_ref = $2)
      ORDER BY p.opened_at DESC`,
    [opts.kind ?? null, opts.replyRef ?? null]
  );
  return rows.map((r) => ({
    item_id: r.id,
    kind: r.kind,
    kind_in_words: GATE_KINDS[r.kind],
    ...(r.reply_ref ? { answers: r.reply_ref } : {}),
    offered_at: r.opened_at.toISOString(),
    state: r.released_at ? "through the gate" : r.waiting_for_funds ? STAGE_WORDS_UNPAID[r.stage] ?? STAGE_WORDS[r.stage] : STAGE_WORDS[r.stage],
    ...(r.released_at ? { came_through_at: r.released_at.toISOString(), source_id: r.source_id } : {}),
  }));
}

/**
 * How much of what the caller's labels asked of a label above, and paid
 * for, has come back: for each face asked, how many requests, with how
 * many owls behind them, and for how many the gate has let through that
 * they were taken up, an answer, or nothing yet. Read with the caller's own
 * clearance, from rows at the labels they read; it names the face and
 * never the label behind it.
 */
async function askedFromHere(): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<{ face: string; at: string; asks: number; owls: string; told: number; answered: number; waiting: number; nothing: number }>(
    `SELECT f.name AS face, r.sensitivity_label AS at, count(*)::int AS asks,
            COALESCE(sum(r.asked_budget_micro_usd), 0) AS owls,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM received_releases s JOIN received_pages p ON p.release_id = s.id
                                            WHERE s.reply_ref = r.id AND p.kind = 'taken_up' AND p.released_at IS NOT NULL))::int AS told,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM received_releases s JOIN received_pages p ON p.release_id = s.id
                                            WHERE s.reply_ref = r.id AND p.kind = 'answer' AND p.released_at IS NOT NULL))::int AS answered,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM received_releases s JOIN received_pages p ON p.release_id = s.id
                                            WHERE s.reply_ref = r.id AND p.kind = 'answer' AND p.released_at IS NULL AND p.stage <> 'overtaken')
                               AND NOT EXISTS (SELECT 1 FROM received_releases s JOIN received_pages p ON p.release_id = s.id
                                            WHERE s.reply_ref = r.id AND p.kind = 'answer' AND p.released_at IS NOT NULL))::int AS waiting,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM received_releases s JOIN received_pages p ON p.release_id = s.id
                                            WHERE s.reply_ref = r.id AND p.stage <> 'overtaken' AND (p.released_at IS NOT NULL OR p.kind = 'answer')))::int AS nothing
       FROM requests r JOIN label_faces f ON f.id = r.asked_of_face_id
      GROUP BY f.name, r.sensitivity_label ORDER BY f.name, r.sensitivity_label`
  ).catch(() => []);
  return rows.map((r) => ({
    asked_of: r.face,
    asked_at: r.at,
    requests: r.asks,
    owls_put_behind_them: Number(r.owls) / 1_000_000,
    told_they_were_taken_up: r.told,
    answer_through_the_gate: r.answered,
    answer_waiting_at_the_gate: r.waiting,
    nothing_back_yet: r.nothing,
  }));
}
