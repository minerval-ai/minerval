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
  report: "an agent's report of a fault in Minerval's machinery, for its maintainers",
  proposal: "the words a node is proposed to the public graph in",
} as const;
export type GateKind = keyof typeof GATE_KINDS;
export const isGateKind = (k: unknown): k is GateKind => typeof k === "string" && k in GATE_KINDS;

/**
 * How a gate treats an item. `open`: it goes as written, and no Redactor
 * runs. `redactor`: the Redactor works under the boundary's policy, Audit
 * checks its work, and what the Redactor let through goes with nobody
 * waiting on a person. `person`: the Redactor does the same work as a
 * proposal, and each part waits for the people who consent for the
 * parties it rests on.
 */
export const GATE_MODES = {
  open: "Open: it goes as written. No Redactor runs and nothing is removed.",
  redactor:
    "The Redactor decides: it removes what the policy protects, may hold or delay a part, and Audit checks its work. What it let through goes, with nobody waiting on a person.",
  person:
    "A person decides as well: the Redactor does the same work as a proposal, and each part then waits for the people who consent for the parties it rests on. They approve it as proposed or change it with the same acts.",
} as const;
export type GateMode = keyof typeof GATE_MODES;
export const isGateMode = (m: unknown): m is GateMode => typeof m === "string" && m in GATE_MODES;

/**
 * Where every gate starts for a kind, until its authorities set otherwise
 * (docs/the-gate.md, "Where a gate starts"). A person decides after the
 * Redactor, for everything that carries text written at the label. The
 * Redactor deciding alone is where a gate is meant to end up: a gate that
 * waits on a person for each item moves at the speed of that person. But a
 * deployment has no reason yet to trust its Redactor under a policy nobody
 * has watched it apply, so each gate starts with the people who consent
 * approving what the Redactor proposes, and its authorities hand a kind to
 * the Redactor once its proposals are ones they approve as they stand (the
 * gate's page counts how often that was so). Nothing written at a label
 * leaves it unread by a person until someone has chosen that it should.
 *
 * Two kinds carry no text from the label and start open. The bare fact that
 * a request was taken up tells the asker not to pay for the same work twice.
 * A statement is figures in fixed words about the payer's own money, which
 * the payer's own account already shows as it moves.
 */
export const STARTING_MODE: Record<GateKind, GateMode> = {
  page: "person",
  answer: "person",
  taken_up: "open",
  funding: "person",
  mandate: "person",
  message: "person",
  // A petition carries the run's own words about work at its label.
  petition: "person",
  statement: "open",
  // An agent's report was not asked for by its readers, and its words were written about the agent's own work
  // with no thought of leaving the label.
  report: "person",
  // A proposal's words were written for the outside by a person who directs the graph.
  proposal: "person",
};

/**
 * Where the gate to outside starts: as every gate does, and with a person
 * also for the statement that a request was taken up, which outside is
 * the organization's own public statement on the public graph, in its name.
 */
export const STARTING_MODE_OUTSIDE: Record<GateKind, GateMode> = { ...STARTING_MODE, taken_up: "person" };

/** Where a gate starts for a kind, until its authorities set otherwise. */
export const startingMode = (kind: GateKind, toOutside: boolean): GateMode =>
  (toOutside ? STARTING_MODE_OUTSIDE : STARTING_MODE)[kind];

/** Every kind's starting position at a gate. */
export const startingPositions = (toOutside: boolean): Record<GateKind, GateMode> =>
  toOutside ? STARTING_MODE_OUTSIDE : STARTING_MODE;

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
  timing: "not to be released yet",
  disputed: "the party disputes what it says",
  policy: "what the policy protects could not be removed from it",
  no_reason_given: "no reason given",
} as const;
export type HoldReason = keyof typeof HOLD_REASONS;

/**
 * What the Redactor says it would do with something it refers to a person
 * (refer_to_person). A referral is the one act the Redactor has that a
 * person does not: it is how the Redactor says "I would decide this, but a
 * person should", whatever the gate is set to. The item or part then waits
 * for the people who consent for the parties it rests on, with the
 * recommendation beside it, and the gate's setting lets nothing of it
 * through until one of them has acted.
 */
export const REFER_RECOMMENDATIONS = {
  let_through: "let it through as the Redactor left it",
  hold: "hold it",
} as const;
export type ReferRecommendation = keyof typeof REFER_RECOMMENDATIONS;

/**
 * The acts at a gate. The Redactor and a person the gate's authorities put
 * there have the same ones, and neither has one that writes a word.
 */
export const GATE_ACTS = {
  consent: "Consent: let a part, or the item itself, through for your party.",
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
  referred: "referred to a person by the Redactor, with its recommendation",
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
  title: ["a report's title", "reports' titles"],
  words: ["a paragraph of an agent's report", "paragraphs of agents' reports"],
  proposed: ["the words a node is proposed in", "wordings nodes are proposed in"],
};
