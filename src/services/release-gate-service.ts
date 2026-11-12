/**
 * The release gate, and what a shown page is on the other side of it
 * (docs/showing-a-page.md, "The gate" and "What the destination sees").
 *
 * After a Redactor has removed what the boundary's policy names and Audit
 * has checked the result, people decide, part by part, what is released.
 * A part rests on the parties whose material it draws on, and each of
 * those parties' holders of `release` must release it; a part that rests on
 * no outside party's material is the organization's own. Who holds
 * `release` for a party is the administrators' choice, and nothing here
 * decides it.
 *
 * Release and hold act on a whole part. No route changes the text of one:
 * a changed part would not match the hash recorded before the gate. Every
 * act is a row that is added and never changed or removed
 * (showing_acts): a hold stays on the record after it is lifted, a release
 * is not taken back, and nothing is released by time passing.
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
import { PUBLIC_LABEL } from "../labels.js";
import { runAtLabel } from "../llm/usage-context.js";
import { verifyShownPage, type Mark, type Verification } from "./page-fingerprint.js";
import { heldWords, kindWords } from "./page-parts.js";
import { ensureBoundaryPolicy } from "./redaction-policy.js";
import {
  END_REASONS,
  FIDELITY_ANSWERS,
  LEFT_REASONS,
  SHOWING_COLUMNS,
  ShowingError,
  bothSides,
  destinationOf,
  type Actor,
  type FidelityAnswer,
  type PageStage,
  type ShowingRow,
} from "./showing-service.js";

/** Why a part or a page is held. The person holding picks one; nobody checks it, and it is all the other side is told. */
export const HOLD_REASONS = {
  under_review: "still being reviewed",
  confidentiality: "confidential to the party",
  legal: "a legal or contractual reason",
  security: "a safety or security reason",
  timing: "not to be shown yet",
  disputed: "the party disputes what it says",
  no_reason_given: "no reason given",
} as const;
export type HoldReason = keyof typeof HOLD_REASONS;

/**
 * The standing rules a party's holders of `release` may set. Each is a
 * condition the system can test from the record with no judgment in it.
 * Anything that needs judgment is a person's decision at the gate.
 */
export const RULE_CONDITIONS = {
  nothing_removed_and_only_ours:
    "Release a part when the Redactor removed nothing from it and it rests on this party's material and no other party's.",
  only_ours: "Release a part when it rests on this party's material and no other party's, whatever the Redactor removed from it.",
} as const;
export type RuleCondition = keyof typeof RULE_CONDITIONS;

/** The person at the gate, as a route resolved them. */
export interface GateActor extends Actor {
  /** The labels they may read. */
  clearance: readonly string[];
  /** The parties they hold `release` for. */
  releaseParties: readonly string[];
  direct: boolean;
}

type ItemStanding = "released" | "held" | "waiting";

interface ActRow {
  id: string;
  showing_id: string;
  page_id: string | null;
  part_id: string | null;
  act: string;
  party_id: string | null;
  actor_id: string | null;
  holding: string[];
  rule_id: string | null;
  reason: string | null;
  at: Date;
}

const actsOfPage = (pageId: string) =>
  rawQuery<ActRow>(
    `SELECT id, showing_id, page_id, part_id, act, party_id, actor_id, holding, rule_id, reason, at
       FROM showing_acts WHERE page_id = $1 ORDER BY at, id`,
    [pageId]
  );

/** Where one party stands on one item, from the acts in order. A release is final. */
function standingOf(acts: readonly ActRow[], partId: string | null, partyId: string): ItemStanding {
  let standing: ItemStanding = "waiting";
  for (const a of acts) {
    if (a.part_id !== partId || a.party_id !== partyId) continue;
    if (a.act === "released") return "released";
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
    showingId: string;
    pageId?: string | null;
    partId?: string | null;
    act: string;
    partyId?: string | null;
    actor?: Actor | null;
    ruleId?: string | null;
    reason?: string | null;
    label: string;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO showing_acts (showing_id, page_id, part_id, act, party_id, actor_id, holding, rule_id, reason, at, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), $10)`,
    [
      act.showingId,
      act.pageId ?? null,
      act.partId ?? null,
      act.act,
      act.partyId ?? null,
      act.actor?.id ?? null,
      act.actor?.holding ?? [],
      act.ruleId ?? null,
      act.reason ?? null,
      act.label,
    ]
  );
}

interface GatePage {
  id: string;
  showing_id: string;
  node_id: string;
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

const GATE_PAGE_COLUMNS = `id, showing_id, node_id, stage, header, header_salt, rests_on, audit_answer, least_sure, checked_at, judged_at, sensitivity_label AS page_label`;

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
}

const gatePartsOf = (pageId: string) =>
  rawQuery<GatePart>(
    `SELECT id, position, kind, descriptor, original, redacted, marks, salt, rests_on FROM showing_parts WHERE page_id = $1 ORDER BY position`,
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
 */
async function settle(pageId: string): Promise<{ shown: boolean; newlyReleased: number }> {
  const [page] = await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM showing_pages WHERE id = $1`, [pageId]);
  if (!page || page.stage !== "at_gate") return { shown: false, newlyReleased: 0 };
  const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [page.showing_id]);
  const acts = await actsOfPage(pageId);
  const [shown] = await rawQuery<{ shown_at: Date | null }>(`SELECT shown_at FROM shown_pages WHERE id = $1`, [pageId]);
  let changed = 0;
  let isShown = !!shown?.shown_at;
  if (!isShown) {
    const verdictReleased = page.rests_on.every((party) => standingOf(acts, null, party) === "released");
    if (!verdictReleased || pageHeldByDirect(acts)) return { shown: false, newlyReleased: 0 };
    await rawQuery(`UPDATE shown_pages SET header = $2, header_salt = $3, shown_at = now() WHERE id = $1 AND shown_at IS NULL`, [
      pageId,
      page.header,
      page.header_salt,
    ]);
    isShown = true;
    changed++;
  }
  const released = new Set(
    (await rawQuery<{ id: string }>(`SELECT id FROM shown_parts WHERE page_id = $1 AND released_at IS NOT NULL`, [pageId])).map((r) => r.id)
  );
  for (const part of await gatePartsOf(pageId)) {
    if (released.has(part.id)) continue;
    if (!part.rests_on.every((party) => standingOf(acts, part.id, party) === "released")) continue;
    await rawQuery(
      `UPDATE shown_parts SET text = $2, marks = $3::jsonb, salt = $4, released_at = now() WHERE id = $1 AND released_at IS NULL`,
      [part.id, part.redacted ?? part.original, JSON.stringify(part.marks ?? []), part.salt]
    );
    changed++;
  }
  if (changed > 0 && !showing!.to_outside) await arrive(pageId, showing!);
  return { shown: isShown, newlyReleased: changed };
}

// ---- arrival at a destination label -------------------------------------------

interface ShownPageRow {
  id: string;
  showing_id: string;
  node_id: string;
  judged_at: Date;
  opened_at: Date;
  stage: PageStage;
  round: number;
  root: string | null;
  roots: unknown[];
  header_commitment: string | null;
  header: string | null;
  header_salt: string | null;
  needs: string[];
  audit_answer: FidelityAnswer | null;
  shown_at: Date | null;
  source_id: string | null;
}

const SHOWN_PAGE_COLUMNS = `id, showing_id, node_id, judged_at, opened_at, stage, round, root, roots, header_commitment, header, header_salt, needs, audit_answer, shown_at, source_id`;

interface ShownPartRow {
  id: string;
  position: number;
  kind: string;
  descriptor: string;
  commitment: string;
  needs: string[];
  text: string | null;
  marks: Mark[] | null;
  salt: string | null;
  released_at: Date | null;
}

const shownPartsOf = (pageId: string) =>
  rawQuery<ShownPartRow>(
    `SELECT id, position, kind, descriptor, commitment, needs, text, marks, salt, released_at FROM shown_parts WHERE page_id = $1 ORDER BY position`,
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

/** The held parts counted by kind, in words: "2 arguments against, a paragraph of reasoning". */
function heldByKind(parts: readonly { descriptor: string }[]): string {
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p.descriptor, (counts.get(p.descriptor) ?? 0) + 1);
  return [...counts.entries()].map(([d, n]) => kindWords(d, n)).join(", ");
}

/** The page as shown, as one text: what a reader or a Steward on the destination side reads. */
function renderShownPage(
  page: ShownPageRow,
  parts: readonly ShownPartRow[],
  holders: (part: ShownPartRow) => string[],
  policy: { version: number | null; hash: string | null }
): string {
  const header = JSON.parse(page.header!) as Record<string, unknown>;
  const held = parts.filter((p) => p.released_at === null);
  const removals = Object.entries((header.removals ?? {}) as Record<string, number>);
  const sources = (header.sources ?? []) as Array<{ kind: string; supplied_by: string | null; interest: Array<{ party: string; stake: string }>; fingerprint: string | null }>;
  const gaps = (header.gaps ?? {}) as { requests?: Array<{ state: string }>; names_what_remains_open?: boolean };
  const made = (header.made ?? {}) as Record<string, unknown>;
  const lines = [
    "A page of this graph, written at a label this one does not read and shown here. The text below is as its " +
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
              `${s.kind.replace(/_/g, " ")}, supplied by ${s.supplied_by ?? "a party not on record"}` +
              (s.interest.length > 0 ? `, recorded interest: ${s.interest.map((i) => `${i.party} (${i.stake})`).join("; ")}` : "") +
              (s.fingerprint ? `, fingerprint ${s.fingerprint.slice(0, 16)}` : "")
          )
          .join(" | ")}.`,
    `Gaps it records: ${(gaps.requests ?? []).length} request${(gaps.requests ?? []).length === 1 ? "" : "s"}` +
      ((gaps.requests ?? []).length > 0 ? ` (${(gaps.requests ?? []).map((r) => r.state.replace(/_/g, " ")).join(", ")})` : "") +
      (gaps.names_what_remains_open ? "; it says what remains open." : "."),
    `How it was made: prompt set ${String(made.prompt_set ?? "not recorded").slice(0, 16)}, policy version ${policy.version ?? "not recorded"}` +
      `, assessed by ${String(made.assessed_by_model ?? "a model not recorded")}, redacted by ${String(made.redacted_by_model ?? "a model not recorded")}.`,
    `Removals under the policy: ${removals.length === 0 ? "none" : removals.map(([c, n]) => `${c}: ${n}`).join(", ")}.`,
    `Audit's check of the redaction: ${page.audit_answer ? FIDELITY_ANSWERS[page.audit_answer] : "not recorded"}`,
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
export function pageShownMessage(input: { heldParts: number; parts: number; removals: number; again: boolean }): string {
  return (
    `A page of this node, written at a label this one does not read, ${input.again ? "has had more of it released and is shown here again" : "has been shown here"}. ` +
    `It is now one of this node's sources, of the kind shown_page. It is that label's Steward's assessment as written, ` +
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
async function arrive(pageId: string, showing: ShowingRow): Promise<void> {
  const destination = destinationOf(showing);
  const [page] = await rawQuery<ShownPageRow>(`SELECT ${SHOWN_PAGE_COLUMNS} FROM shown_pages WHERE id = $1`, [pageId]);
  if (!page?.shown_at || !page.header) return;
  const parts = await shownPartsOf(pageId);
  const acts = await actsOfPage(pageId);
  const names = await partyNames(parts.flatMap((p) => p.needs));
  const holders = (part: ShownPartRow) =>
    part.needs.filter((party) => standingOf(acts, part.id, party) !== "released").map((party) => names.get(party) ?? "a party");
  const [policy] = await rawQuery<{ version: number; hash: string }>(
    `SELECT p.version, p.hash FROM showing_pages sp JOIN redaction_policies p ON p.id = sp.policy_id WHERE sp.id = $1`,
    [pageId]
  );
  const text = renderShownPage(page, parts, holders, { version: policy?.version ?? null, hash: policy?.hash ?? null });
  const [{ n }] = (await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM sources WHERE url LIKE $1`,
    [`minerval:shown-page/${pageId}/%`]
  )) as [{ n: number }];
  const [node] = await rawQuery<{ readable: boolean; latest: boolean }>(
    `SELECT c.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$2::text])) AS readable,
            NOT EXISTS (SELECT 1 FROM shown_pages o
                         WHERE o.showing_id = $3 AND o.node_id = c.id AND o.shown_at IS NOT NULL AND o.judged_at > $4) AS latest
       FROM claims c WHERE c.id = $1`,
    [page.node_id, destination, page.showing_id, page.judged_at]
  );
  const sourceId = await withTransaction(async (tx) => {
    const [source] = await tx.query<{ id: string }>(
      `INSERT INTO sources (url, title, content_hash, raw_content, source_type, page_url_hash, sensitivity_label)
       VALUES ($1, $2, $3, $4, 'shown_page', '', $5) RETURNING id`,
      [
        `minerval:shown-page/${pageId}/${n + 1}`,
        `A page shown from a label this one does not read (version of ${page.judged_at.toISOString().slice(0, 10)})`,
        createHash("sha256").update(text, "utf8").digest("hex"),
        text,
        destination,
      ]
    );
    await tx.query(`UPDATE shown_pages SET source_id = $2 WHERE id = $1`, [pageId, source!.id]);
    if (node?.readable && node.latest) {
      // Earlier arrivals of this node's page under this showing give way to this one. The sources stay.
      await tx.query(
        `UPDATE claim_instances i
            SET detached_at = now(), detached_by = 'showing',
                detached_reason = 'A later showing of this page replaced it.'
          WHERE i.claim_id = $1 AND i.detached_at IS NULL AND i.created_by = 'showing' AND i.sensitivity_label = $3
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id AND s.url LIKE ANY (
                  SELECT 'minerval:shown-page/' || o.id || '/%' FROM shown_pages o WHERE o.showing_id = $2 AND o.node_id = $1))`,
        [page.node_id, page.showing_id, destination]
      );
      await tx.query(
        `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, context, stance, created_by, sensitivity_label)
         VALUES ($1, $2, $3, $4, 'mentions', 'showing', $5)`,
        [
          page.node_id,
          source!.id,
          verdictLine(JSON.parse(page.header!) as Record<string, unknown>),
          "The verdict of a page of this node written at a label this one does not read. The source's text is the page as shown, with removals marked and held parts named.",
          destination,
        ]
      );
    }
    return source!.id;
  });
  if (!node?.readable || !node.latest) return;
  const header = JSON.parse(page.header) as { removals?: Record<string, number> };
  const message = pageShownMessage({
    heldParts: parts.filter((p) => p.released_at === null).length,
    parts: parts.length,
    removals: Object.values(header.removals ?? {}).reduce((a, b) => a + b, 0),
    again: n > 0,
  });
  // The reassessment is opened at the destination label and nowhere else, from words composed of nothing but counts.
  await runAtLabel(destination, `the arrival of shown page ${pageId}`, async () => {
    const { enqueueSteward } = await import("./queue-service.js");
    await enqueueSteward({
      claimId: page.node_id,
      trigger: "page_shown",
      context: message,
      sender: { kind: "system", ref: `shown:${sourceId}` },
    });
  }).catch((err: unknown) => {
    console.error(`[showing] could not open the reassessment for shown page ${pageId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ---- standing rules -------------------------------------------------------------

interface RuleRow {
  id: string;
  party_id: string;
  boundary_id: string;
  condition: RuleCondition;
  covers_verdict: boolean;
  set_by: string | null;
  set_at: Date;
  ended_at: Date | null;
}

/**
 * A page has passed the check and is at the gate: the standing rules of
 * the parties it rests on are applied to it, and what they release is
 * released. A rule applies to pages that reach the gate after it was set.
 */
export async function pageReachedGate(pageId: string): Promise<void> {
  await bothSides(async () => {
    const [page] = await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM showing_pages WHERE id = $1`, [pageId]);
    if (!page || page.stage !== "at_gate") return;
    const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [page.showing_id]);
    // A showing that has ended releases nothing more, by a rule or by a person.
    if (showing!.ended_at) return;
    const destination = destinationOf(showing!);
    const rules = await rawQuery<RuleRow>(
      `SELECT id, party_id, boundary_id, condition, covers_verdict, set_by, set_at, ended_at
         FROM release_rules WHERE boundary_id = $1 AND ended_at IS NULL ORDER BY set_at`,
      [showing!.boundary_id]
    );
    if (rules.length > 0) {
      const parts = await gatePartsOf(pageId);
      const removed = new Set(
        (
          await rawQuery<{ part_id: string }>(
            `SELECT DISTINCT r.part_id FROM showing_removals r JOIN showing_parts p ON p.id = r.part_id
              WHERE p.page_id = $1 AND r.taken_back_at IS NULL`,
            [pageId]
          )
        ).map((r) => r.part_id)
      );
      await withTransaction(async (tx) => {
        for (const rule of rules) {
          const onlyOurs = (needs: string[]) => needs.length === 1 && needs[0] === rule.party_id;
          for (const part of parts) {
            if (!onlyOurs(part.rests_on)) continue;
            if (rule.condition === "nothing_removed_and_only_ours" && removed.has(part.id)) continue;
            await insertAct(tx, { showingId: page.showing_id, pageId, partId: part.id, act: "released", partyId: rule.party_id, ruleId: rule.id, label: destination });
          }
          if (rule.covers_verdict && onlyOurs(page.rests_on)) {
            await insertAct(tx, { showingId: page.showing_id, pageId, partId: null, act: "released", partyId: rule.party_id, ruleId: rule.id, label: destination });
          }
        }
      });
    }
    await settle(pageId);
  });
}

/** Set a standing rule for one party at one boundary. The caller has checked that the actor holds `release` for the party. */
export async function setReleaseRule(input: {
  actor: GateActor;
  partyId: string;
  pageLabel: string;
  toLabel: string | null;
  condition: RuleCondition;
  coversVerdict: boolean;
}): Promise<{ rule_id: string; applies: string }> {
  if (!input.actor.releaseParties.includes(input.partyId)) {
    throw new ShowingError("NOT_YOUR_PARTY", "A standing rule is set by someone who holds the permission to release that party's material.");
  }
  if (!(input.condition in RULE_CONDITIONS)) {
    throw new ShowingError("BAD_CONDITION", `A rule's condition is one of: ${Object.keys(RULE_CONDITIONS).join(", ")}.`);
  }
  return bothSides(async () => {
    const policy = await ensureBoundaryPolicy({ from: input.pageLabel, to: input.toLabel }).catch(() => null);
    if (!policy) throw new ShowingError("UNKNOWN_LABEL", "One of those labels is not defined in this deployment.");
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO release_rules (party_id, boundary_id, condition, covers_verdict, set_by, set_holding, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.partyId, policy.boundary_id, input.condition, input.coversVerdict, input.actor.id, input.actor.holding, input.toLabel ?? PUBLIC_LABEL]
    );
    return {
      rule_id: row!.id,
      applies:
        "The rule applies to pages that reach the gate from now on. What is already waiting is not released by it: release that at the gate.",
    };
  });
}

export async function endReleaseRule(input: { actor: GateActor; ruleId: string }): Promise<void> {
  await bothSides(async () => {
    const [rule] = await rawQuery<{ party_id: string; ended_at: Date | null }>(`SELECT party_id, ended_at FROM release_rules WHERE id = $1`, [input.ruleId]);
    if (!rule || !input.actor.releaseParties.includes(rule.party_id)) throw new ShowingError("RULE_NOT_FOUND", "No standing rule of a party you release for has that id.");
    if (rule.ended_at) throw new ShowingError("ALREADY_ENDED", "That rule has already ended.");
    await rawQuery(`UPDATE release_rules SET ended_at = now(), ended_by = $2 WHERE id = $1`, [input.ruleId, input.actor.id]);
  });
}

export async function releaseRulesFor(actor: GateActor): Promise<Array<Record<string, unknown>>> {
  return bothSides(async () => {
    const rows = await rawQuery<RuleRow & { party: string; setter: string | null; set_holding: string[] }>(
      `SELECT r.id, r.party_id, r.boundary_id, r.condition, r.covers_verdict, r.set_by, r.set_at, r.ended_at, r.set_holding,
              p.name AS party, c.display_name AS setter
         FROM release_rules r JOIN parties p ON p.id = r.party_id LEFT JOIN contributors c ON c.id = r.set_by
        WHERE r.party_id = ANY($1::uuid[]) ORDER BY r.set_at DESC`,
      [[...actor.releaseParties]]
    );
    return rows.map((r) => ({
      rule_id: r.id,
      party: { id: r.party_id, name: r.party },
      boundary_id: r.boundary_id,
      condition: r.condition,
      in_words: RULE_CONDITIONS[r.condition],
      covers_verdict: r.covers_verdict,
      set_by: r.setter,
      set_holding: r.set_holding,
      set_at: r.set_at.toISOString(),
      ended_at: r.ended_at?.toISOString() ?? null,
    }));
  });
}

// ---- deciding -------------------------------------------------------------------

export interface GateItem {
  page_id: string;
  /** The part's place on the page; null or absent for the page itself, with its verdict. */
  part?: number | null;
}

export type GateDecision = "release" | "hold" | "lift";

/**
 * Release, hold, or lift a hold on, each of the items for one party. Each
 * item is decided whole. An item that cannot be decided as asked is
 * reported with the reason, and the others are decided.
 */
export async function decideAtGate(input: {
  actor: GateActor;
  partyId: string;
  items: readonly GateItem[];
  decision: GateDecision;
  reason?: string;
}): Promise<{ decided: number; refused: Array<{ item: GateItem; why: string }>; shown: string[] }> {
  if (!input.actor.releaseParties.includes(input.partyId)) {
    throw new ShowingError("NOT_YOUR_PARTY", "This decision is for a party whose material you do not hold the permission to release.");
  }
  if (input.decision === "hold" && !(input.reason && input.reason in HOLD_REASONS)) {
    throw new ShowingError("BAD_REASON", `A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
  }
  return bothSides(async () => {
    const refused: Array<{ item: GateItem; why: string }> = [];
    const touched = new Set<string>();
    let decided = 0;
    for (const item of input.items) {
      const [page] = await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM showing_pages WHERE id = $1`, [item.page_id]);
      if (!page || page.stage !== "at_gate") {
        refused.push({ item, why: "No page with that id is at the gate." });
        continue;
      }
      const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [page.showing_id]);
      if (showing!.ended_at && input.decision === "release") {
        refused.push({ item, why: "This page's showing has ended, so nothing more is released from it. What was shown stays shown." });
        continue;
      }
      let partId: string | null = null;
      let needs = page.rests_on;
      if (item.part !== null && item.part !== undefined) {
        const [part] = await rawQuery<{ id: string; rests_on: string[] }>(
          `SELECT id, rests_on FROM showing_parts WHERE page_id = $1 AND position = $2`,
          [page.id, item.part]
        );
        if (!part) {
          refused.push({ item, why: `That page has no part ${item.part}.` });
          continue;
        }
        partId = part.id;
        needs = part.rests_on;
      }
      if (!needs.includes(input.partyId)) {
        refused.push({ item, why: "This item does not rest on that party's material, so it is not that party's to release or hold." });
        continue;
      }
      const standing = standingOf(await actsOfPage(page.id), partId, input.partyId);
      if (standing === "released") {
        refused.push({
          item,
          why: input.decision === "release" ? "This party has already released it." : "This party has released it, and a release is not taken back.",
        });
        continue;
      }
      if (input.decision === "lift" && standing !== "held") {
        refused.push({ item, why: "This party is not holding it." });
        continue;
      }
      if (input.decision === "hold" && standing === "held") {
        refused.push({ item, why: "This party is already holding it." });
        continue;
      }
      await withTransaction((tx) =>
        insertAct(tx, {
          showingId: page.showing_id,
          pageId: page.id,
          partId,
          act: input.decision === "release" ? "released" : input.decision === "hold" ? "held" : "hold_lifted",
          partyId: input.partyId,
          actor: input.actor,
          reason: input.decision === "hold" ? input.reason : null,
          label: destinationOf(showing!),
        })
      );
      decided++;
      touched.add(page.id);
    }
    const shown: string[] = [];
    for (const pageId of touched) if ((await settle(pageId)).shown) shown.push(pageId);
    return { decided, refused, shown };
  });
}

/**
 * A holder of `direct` holds a page that has not been shown, or lifts that
 * hold. A page already shown cannot be held: a release is not taken back,
 * and ending the showing is what stops later versions.
 */
export async function holdPage(input: { actor: GateActor; pageId: string; lift?: boolean; reason?: string }): Promise<void> {
  if (!input.actor.direct) throw new ShowingError("NEEDS_DIRECT", "Holding a page takes the permission to direct the graph.");
  if (!input.lift && !(input.reason && input.reason in HOLD_REASONS)) {
    throw new ShowingError("BAD_REASON", `A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
  }
  await bothSides(async () => {
    const [page] = await rawQuery<GatePage>(`SELECT ${GATE_PAGE_COLUMNS} FROM showing_pages WHERE id = $1`, [input.pageId]);
    if (!page || !input.actor.clearance.includes(page.page_label)) throw new ShowingError("PAGE_NOT_FOUND", "No page under a showing has that id at a label you read.");
    const [showing] = await rawQuery<ShowingRow>(`SELECT ${SHOWING_COLUMNS} FROM showings WHERE id = $1`, [page.showing_id]);
    const [shown] = await rawQuery<{ shown_at: Date | null }>(`SELECT shown_at FROM shown_pages WHERE id = $1`, [page.id]);
    const held = pageHeldByDirect(await actsOfPage(page.id));
    if (input.lift) {
      if (!held) throw new ShowingError("NOT_HELD", "No hold by a person who directs the graph is on this page.");
    } else {
      if (shown?.shown_at) throw new ShowingError("ALREADY_SHOWN", "This page has been shown, and a release is not taken back. Ending the showing stops later versions from following.");
      if (held) throw new ShowingError("ALREADY_HELD", "This page is already held.");
    }
    await withTransaction((tx) =>
      insertAct(tx, {
        showingId: page.showing_id,
        pageId: page.id,
        act: input.lift ? "page_hold_lifted" : "page_held",
        actor: input.actor,
        reason: input.lift ? null : input.reason,
        label: destinationOf(showing!),
      })
    );
    if (input.lift) await settle(page.id);
  });
}

// ---- the queue --------------------------------------------------------------------

const TEXT_WITHHELD =
  "You hold the permission to release this party's material and not the permission to read at the label this page was " +
  "written at, so its text is not shown to you. An administrator grants reading at a label.";

/**
 * What waits on a person at the gate: every item at the gate that rests on
 * a party they release for and that party has not released, oldest page
 * first, and within a page the parts the Redactor was least sure of first.
 * Each item carries the Redactor's removals as differences with their
 * categories and Audit's answer. The text is included where the person
 * also reads at the page's label.
 */
export async function releaseQueue(actor: GateActor, opts: { limit?: number } = {}): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return bothSides(async () => {
    const pages = await rawQuery<GatePage>(
      `SELECT ${GATE_PAGE_COLUMNS} FROM showing_pages
        WHERE stage = 'at_gate'
          AND (rests_on && $1::uuid[] OR EXISTS (SELECT 1 FROM showing_parts p WHERE p.page_id = showing_pages.id AND p.rests_on && $1::uuid[]))
        ORDER BY checked_at, id`,
      [[...actor.releaseParties]]
    );
    const names = await partyNames(actor.releaseParties as string[]);
    const items: Array<Record<string, unknown>> = [];
    let more = false;
    for (const page of pages) {
      const acts = await actsOfPage(page.id);
      const parts = await gatePartsOf(page.id);
      const removals = await rawQuery<{ id: string; part_id: string; start_offset: number; end_offset: number; category: string; note: string }>(
        `SELECT r.id, r.part_id, r.start_offset, r.end_offset, r.category, r.note
           FROM showing_removals r JOIN showing_parts p ON p.id = r.part_id
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
        actor.releaseParties.filter((party) => needs.includes(party) && standingOf(acts, partId, party) !== "released");
      const base = {
        page_id: page.id,
        showing_id: page.showing_id,
        audit: page.audit_answer ? FIDELITY_ANSWERS[page.audit_answer] : null,
        waiting_since: page.checked_at?.toISOString() ?? null,
      };
      const pageItems: Array<Record<string, unknown> & { order: number }> = [];
      if (mine(null, page.rests_on).length > 0) {
        pageItems.push({
          ...base,
          part: null,
          kind: "the page itself, with its verdict and everything that is always shown with it",
          decide_for: mine(null, page.rests_on).map((id) => ({ id, name: names.get(id) ?? "" })),
          rests_on: wait(null, page.rests_on),
          ...(reads ? { always_shown: JSON.parse(page.header) } : { text_withheld: TEXT_WITHHELD }),
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
          decide_for: mine(part.id, part.rests_on).map((id) => ({ id, name: names.get(id) ?? "" })),
          rests_on: wait(part.id, part.rests_on),
          removals_by_category: counts,
          redactor_least_sure: unsure(part).length > 0,
          ...(reads
            ? {
                as_written: part.original,
                as_it_would_be_shown: part.redacted ?? part.original,
                removals: own.map((r) => ({ passage: part.original.slice(r.start_offset, r.end_offset), category: r.category, redactor_note: r.note })),
                ...(unsure(part).length > 0 ? { why_least_sure: unsure(part).map((l) => l.why) } : {}),
              }
            : { text_withheld: TEXT_WITHHELD }),
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
    return {
      items,
      more_waiting: more,
      note:
        "Each item is released or held whole, for one party at a time. Nothing is released by time passing: an item " +
        "nobody acts on stays held, and readers on the other side see how long it has waited.",
    };
  });
}

// ---- what the destination side reads -------------------------------------------------

export type NodeState = "not_yet_assessed" | "released_unaltered" | "released_in_part" | "held";

const STAGE_WORDS: Record<PageStage, string> = {
  to_redact: "waiting for its redaction, which runs when it is paid for",
  to_check: "redacted, and waiting for the check of the redaction, which runs when it is paid for",
  at_gate: "redacted and checked, and waiting on the people who decide what is released",
  cannot_cross: "it cannot be shown under this boundary's policy: something that is always shown with a page could not be shown here",
  overtaken: "a later version was recorded before this one was redacted, so this one was not",
};

const ACT_WORDS: Record<string, string> = {
  asked: "asked for the showing",
  ended: "ended the showing",
  released: "released",
  held: "held",
  hold_lifted: "lifted a hold",
  page_held: "held the page",
  page_hold_lifted: "lifted a hold on the page",
  returned_by_check: "the check returned the redaction to be done again",
  cannot_cross: "the Redactor found that the page cannot be shown under the policy",
};

function age(since: Date): string {
  const hours = Math.floor((Date.now() - since.getTime()) / 3_600_000);
  return hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.floor(hours / 24)} days`;
}

/** One version of a node's page as the destination side may describe it without any of its text. */
async function describeShownPage(page: ShownPageRow): Promise<Record<string, unknown>> {
  const parts = await shownPartsOf(page.id);
  const acts = await actsOfPage(page.id);
  const names = await partyNames([...page.needs, ...parts.flatMap((p) => p.needs)]);
  const held = parts.filter((p) => p.released_at === null);
  const directHold = pageHeldByDirect(acts);
  const waitingOn = page.needs.filter((party) => standingOf(acts, null, party) !== "released").map((party) => names.get(party) ?? "a party");
  const state: NodeState = !page.shown_at ? "held" : held.length === 0 ? "released_unaltered" : "released_in_part";
  return {
    page_id: page.id,
    version_of: page.judged_at.toISOString(),
    state,
    ...(state === "held"
      ? {
          held_because: directHold
            ? `held by a person who directs the graph (${HOLD_REASONS[(directHold.reason ?? "no_reason_given") as HoldReason]})`
            : page.stage === "at_gate"
              ? `waiting on ${waitingOn.join(" and ") || "the people who decide what is released"}`
              : STAGE_WORDS[page.stage],
          held_for: age(page.opened_at),
        }
      : { shown_at: page.shown_at!.toISOString(), source_id: page.source_id }),
    ...(state === "released_in_part" ? { parts_held: held.length, of_parts: parts.length, held_kinds: heldByKind(held) } : {}),
    ...(state === "released_unaltered" ? { of_parts: parts.length } : {}),
    redaction_round: page.round,
    fingerprint: page.root,
    audit: page.audit_answer ? FIDELITY_ANSWERS[page.audit_answer] : null,
  };
}

/**
 * A showing as its destination side reads it: every node it covers with
 * one of four states, every version made while it stood, and every act on
 * it with who acted and which permissions they held. Read with the
 * caller's own clearance: a caller who does not read the destination label
 * finds nothing.
 */
export async function shownShowing(showingId: string): Promise<Record<string, unknown> | null> {
  const [showing] = await rawQuery<{
    id: string; node_id: string; to_outside: boolean; boundary_id: string; form: string; scope: string;
    asked_at: Date; ended_at: Date | null; end_reason: string | null; label: string; asker: string | null; asked_holding: string[];
  }>(
    `SELECT s.id, s.node_id, s.to_outside, s.boundary_id, s.form, s.scope, s.asked_at, s.ended_at, s.end_reason,
            s.sensitivity_label AS label, c.display_name AS asker, s.asked_holding
       FROM shown_showings s LEFT JOIN contributors c ON c.id = s.asked_by WHERE s.id = $1`,
    [showingId]
  );
  if (!showing) return null;
  const nodes = await rawQuery<{ id: string; node_id: string; place_parent_id: string | null; entered_at: Date; left_at: Date | null; left_reason: string | null; first_assessed_at: Date | null; text: string | null }>(
    `SELECT n.id, n.node_id, n.place_parent_id, n.entered_at, n.left_at, n.left_reason, n.first_assessed_at, c.text
       FROM shown_nodes n LEFT JOIN claims c ON c.id = n.node_id
      WHERE n.showing_id = $1 ORDER BY n.entered_at, n.id`,
    [showingId]
  );
  const pages = await rawQuery<ShownPageRow>(`SELECT ${SHOWN_PAGE_COLUMNS} FROM shown_pages WHERE showing_id = $1 ORDER BY judged_at DESC, opened_at DESC`, [showingId]);
  const acts = await rawQuery<ActRow & { actor: string | null; party: string | null; position: number | null }>(
    `SELECT a.id, a.showing_id, a.page_id, a.part_id, a.act, a.party_id, a.actor_id, a.holding, a.rule_id, a.reason, a.at,
            c.display_name AS actor, p.name AS party, sp.position
       FROM showing_acts a LEFT JOIN contributors c ON c.id = a.actor_id LEFT JOIN parties p ON p.id = a.party_id
       LEFT JOIN shown_parts sp ON sp.id = a.part_id
      WHERE a.showing_id = $1 ORDER BY a.at, a.id`,
    [showingId]
  );
  const [policy] = await rawQuery<{ id: string; version: number; hash: string }>(
    `SELECT id, version, hash FROM redaction_policies WHERE boundary_id = $1 AND side = 'destination' ORDER BY version DESC LIMIT 1`,
    [showing.boundary_id]
  );
  const described = new Map<string, Record<string, unknown>>();
  for (const page of pages) described.set(page.id, await describeShownPage(page));
  return {
    showing_id: showing.id,
    shown_to: showing.to_outside ? "outside this deployment" : `readers at "${showing.label}"`,
    form: showing.form,
    scope: showing.scope === "under" ? "the node with what sits under it" : "the node alone",
    asked_at: showing.asked_at.toISOString(),
    asked_by: showing.asker,
    asked_holding: showing.asked_holding,
    ended_at: showing.ended_at?.toISOString() ?? null,
    ended_because: showing.end_reason ? END_REASONS[showing.end_reason as keyof typeof END_REASONS] : null,
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
        showing_began: n.first_assessed_at === null ? "before the node was first assessed" : n.first_assessed_at > n.entered_at ? "before the node was first assessed" : "after the node was first assessed",
        state: latest ? described.get(latest.id)!.state : ("not_yet_assessed" as NodeState),
        versions: pages.filter((p) => p.node_id === n.node_id).map((p) => described.get(p.id)),
      };
    }),
    acts: acts.map((a) => ({
      at: a.at.toISOString(),
      what: ACT_WORDS[a.act] ?? a.act,
      ...(a.page_id ? { page_id: a.page_id, on: a.part_id ? `part ${a.position ?? "?"}` : "the page" } : {}),
      ...(a.party ? { for_party: a.party } : {}),
      by: a.actor ?? (a.rule_id ? "a standing rule" : "the process"),
      ...(a.rule_id ? { rule_id: a.rule_id } : {}),
      holding: a.holding,
      ...(a.reason && (a.act === "held" || a.act === "page_held") ? { reason: HOLD_REASONS[a.reason as HoldReason] ?? a.reason } : {}),
      ...(a.reason && a.act === "ended" ? { reason: END_REASONS[a.reason as keyof typeof END_REASONS] ?? a.reason } : {}),
    })),
  };
}

/** The showings whose destination side the caller reads, newest first. */
export async function shownShowings(opts: { nodeId?: string } = {}): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<{ id: string; node_id: string; to_outside: boolean; form: string; scope: string; asked_at: Date; ended_at: Date | null; label: string }>(
    `SELECT s.id, s.node_id, s.to_outside, s.form, s.scope, s.asked_at, s.ended_at, s.sensitivity_label AS label
       FROM shown_showings s
      WHERE ($1::uuid IS NULL OR s.node_id = $1 OR EXISTS (SELECT 1 FROM shown_nodes n WHERE n.showing_id = s.id AND n.node_id = $1))
      ORDER BY s.asked_at DESC`,
    [opts.nodeId ?? null]
  );
  return rows.map((r) => ({
    showing_id: r.id,
    node_id: r.node_id,
    shown_to: r.to_outside ? "outside this deployment" : `readers at "${r.label}"`,
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
export async function shownPage(pageId: string): Promise<(Record<string, unknown> & { verification: Verification | null }) | null> {
  const [page] = await rawQuery<ShownPageRow>(`SELECT ${SHOWN_PAGE_COLUMNS} FROM shown_pages WHERE id = $1`, [pageId]);
  if (!page) return null;
  const described = await describeShownPage(page);
  if (!page.shown_at || !page.header) return { ...described, verification: null };
  const parts = await shownPartsOf(pageId);
  const acts = await actsOfPage(pageId);
  const names = await partyNames(parts.flatMap((p) => p.needs));
  const verification = verifyShownPage({
    root: page.root!,
    verdict: { position: 0, descriptor: "verdict", commitment: page.header_commitment!, text: page.header, salt: page.header_salt, marks: [] },
    parts: parts.map((p) => ({ position: p.position, descriptor: p.descriptor, commitment: p.commitment, text: p.text, marks: p.marks, salt: p.salt })),
  });
  return {
    ...described,
    always_shown: JSON.parse(page.header),
    always_shown_as_hashed: { text: page.header, salt: page.header_salt, hash: page.header_commitment },
    earlier_fingerprints: page.roots,
    parts: parts.map((p) =>
      p.released_at !== null
        ? { part: p.position, kind: p.kind, descriptor: p.descriptor, text: p.text, removals_marked: p.marks ?? [], salt: p.salt, hash: p.commitment }
        : {
            part: p.position,
            kind: p.kind,
            descriptor: p.descriptor,
            held: heldWords(
              p.descriptor,
              p.needs.filter((party) => standingOf(acts, p.id, party) !== "released").map((party) => names.get(party) ?? "a party")
            ),
            hash: p.commitment,
          }
    ),
    verification,
  };
}

/**
 * The showings asked for at labels the caller reads, with where each page
 * stands on the page's side: for the people who direct the graph there.
 * Read with the caller's own clearance.
 */
export async function askedShowings(): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<ShowingRow & { text: string | null }>(
    `SELECT s.id, s.node_id, s.to_label, s.to_outside, s.boundary_id, s.form, s.scope, s.asked_at, s.ended_at,
            s.sensitivity_label AS page_label, c.text
       FROM showings s LEFT JOIN claims c ON c.id = s.node_id ORDER BY s.asked_at DESC`
  );
  const out: Array<Record<string, unknown>> = [];
  for (const s of rows) {
    const pages = await rawQuery<{ id: string; node_id: string; stage: PageStage; round: number; judged_at: Date; redact_action_id: string | null; audit_run_id: string | null; cannot_cross_category: string | null; cannot_cross_note: string | null; audit_reasons: string | null }>(
      `SELECT id, node_id, stage, round, judged_at, redact_action_id, audit_run_id, cannot_cross_category, cannot_cross_note, audit_reasons
         FROM showing_pages WHERE showing_id = $1 ORDER BY judged_at DESC`,
      [s.id]
    );
    out.push({
      showing_id: s.id,
      node_id: s.node_id,
      node: s.text,
      page_label: s.page_label,
      shown_to: s.to_outside ? "outside this deployment" : s.to_label,
      form: s.form,
      scope: s.scope,
      asked_at: s.asked_at.toISOString(),
      ended_at: s.ended_at?.toISOString() ?? null,
      pages: pages.map((p) => ({
        page_id: p.id,
        node_id: p.node_id,
        version_of: p.judged_at.toISOString(),
        stage: p.stage,
        stage_in_words: STAGE_WORDS[p.stage],
        round: p.round,
        redact_action_id: p.redact_action_id,
        ...(p.cannot_cross_category ? { cannot_cross: { category: p.cannot_cross_category, note: p.cannot_cross_note } } : {}),
        ...(p.audit_reasons ? { audit_reasons: p.audit_reasons } : {}),
      })),
    });
  }
  return out;
}
