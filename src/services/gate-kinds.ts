/**
 * The gate's fixed words (docs/the-gate.md).
 *
 * Anything that goes from a label to readers who do not read it passes a
 * gate, and there is one gate for each boundary: the pair of the label a
 * thing was produced at and where it goes, a label inside the deployment or
 * outside it. This file holds what every gate shares: the kinds of thing,
 * the settings, the acts and the reasons. It imports nothing, so that the
 * services on both sides of it can.
 */

/**
 * What goes down. Each is an item at the gate with the same stages and the
 * same acts; a kind differs in what its parts are made from and in what its
 * arrival does on the other side.
 */
export const GATE_KINDS = {
  page: "a node's page",
  answer: "an answer to a request",
  taken_up: "that a request was taken up",
  funding: "a mandate's funding of work on the other side",
  mandate: "that a mandate exists, with its terms",
  message: "an answer to a message",
  petition: "a run's petition to the mandate that pays for it",
  statement: "a statement of what was spent and what was returned",
} as const;
export type GateKind = keyof typeof GATE_KINDS;
export const isGateKind = (k: unknown): k is GateKind => typeof k === "string" && k in GATE_KINDS;

/**
 * How a gate treats an item. `open`: it goes as written, and no Redactor
 * runs. `redactor`: the Redactor works under the boundary's policy, Audit
 * checks its work, and what the Redactor let through goes with nobody
 * waiting on a person. `person`: the Redactor does the same work as a
 * proposal, and each part waits for the people who hold release for the
 * parties it rests on.
 */
export const GATE_MODES = {
  open: "Open: it goes as written. No Redactor runs and nothing is removed.",
  redactor:
    "The Redactor decides: it removes what the policy protects, may hold or delay a part, and Audit checks its work. What it let through goes, with nobody waiting on a person.",
  person:
    "A person decides as well: the Redactor does the same work as a proposal, and each part then waits for the people who hold release for the parties it rests on. They approve it as proposed or change it with the same acts.",
} as const;
export type GateMode = keyof typeof GATE_MODES;
export const isGateMode = (m: unknown): m is GateMode => typeof m === "string" && m in GATE_MODES;

/**
 * Where every gate starts for a kind, until its authorities set otherwise.
 * The Redactor decides, for everything that carries text written at the
 * label: a gate that waited on a person for each item would not move, and
 * one that let text through unread would not be a gate. The bare fact that
 * a request was taken up carries no text from the label it was taken up at,
 * and the asker who is not told may pay for the same work twice, so it
 * starts open.
 */
export const STARTING_MODE: Record<GateKind, GateMode> = {
  page: "redactor",
  answer: "redactor",
  taken_up: "open",
  funding: "redactor",
  mandate: "redactor",
  message: "redactor",
  // A petition carries the run's own words about work at its label.
  petition: "redactor",
  // A statement is figures in fixed words about the payer's own money, which the payer's own account
  // already shows as it moves. It starts open: holding it would hide nothing the payer cannot see.
  statement: "open",
};

/** What a setting can be narrowed to. A narrower scope is taken before a wider one. */
export const GATE_SCOPES = {
  request: "one request",
  under: "a node and everything under it",
  mandate: "everything one mandate's work produced",
  boundary: "the whole boundary",
} as const;
export type GateScope = keyof typeof GATE_SCOPES;
/** Narrowest first. */
export const SCOPE_ORDER: readonly GateScope[] = ["request", "under", "mandate", "boundary"];

/**
 * Why a part or an item is held. Whoever holds picks one, a person or the
 * Redactor; nobody checks it, and it is all the other side is told.
 */
export const HOLD_REASONS = {
  under_review: "still being reviewed",
  confidentiality: "confidential to the party",
  legal: "a legal or contractual reason",
  security: "a safety or security reason",
  timing: "not to be shown yet",
  disputed: "the party disputes what it says",
  policy: "what the policy protects could not be removed from it",
  no_reason_given: "no reason given",
} as const;
export type HoldReason = keyof typeof HOLD_REASONS;

/**
 * The acts at a gate. The Redactor and a person the gate's authorities put
 * there have the same ones, and neither has one that writes a word.
 */
export const GATE_ACTS = {
  release: "Let a part, or the item itself, through.",
  approve: "Let through everything of the item that nobody holds, as the Redactor left it.",
  remove: "Remove one passage from a part under a category of the policy, and leave the category's mark where it was.",
  hold: "Hold a part, or the whole item, with a reason from the fixed list.",
  delay: "Keep a part, or the whole item, back until a time. Items delayed to the same time go together.",
  lift: "Lift a hold or a delay.",
} as const;
export type GateAct = keyof typeof GATE_ACTS;

/** Who holds something, as the backlog names them. */
export const HOLDERS = {
  funds: "waiting for the budget that pays for its redaction",
  redactor_run: "waiting for the Redactor's run",
  check: "waiting for Audit's check of the redaction",
  redactor: "held by the Redactor",
  person: "held by a person",
  waiting_on_person: "waiting for a person's decision",
  delayed: "delayed until a set time",
} as const;
export type Holder = keyof typeof HOLDERS;

/** The parts an item that is not a node's page is made of, as a held one is named. */
export const ITEM_PART_WORDS: Record<string, [one: string, several: string]> = {
  item: ["the item", "items"],
  standing: ["where the request stands, with its keeper's note", "statements of where a request stands"],
  finding: ["a paragraph of what the work found", "paragraphs of what the work found"],
  fact: ["a statement in fixed words", "statements in fixed words"],
  name: ["a mandate's name", "mandates' names"],
  terms: ["a paragraph of a mandate's terms", "paragraphs of mandates' terms"],
  amount: ["an amount of funding", "amounts of funding"],
  reply: ["a paragraph of an answer to a message", "paragraphs of answers to messages"],
  ask: ["a paragraph of what a run asks its payer for", "paragraphs of what a run asks its payer for"],
};
