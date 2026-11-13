/**
 * A private graph acting on the public graph, other than by showing a page
 * (docs/outward-acts.md).
 *
 * A deployment acts on the public graph as an ordinary account and only as
 * one. Everything here is a call to a route any account could call, with
 * the key of the organization's own account (PUBLIC_GRAPH_API_URL,
 * PUBLIC_GRAPH_API_KEY; outbound-service.ts has the client):
 *
 *   - taking a public request up, and later saying the work will not be done;
 *   - opening a public mandate with the public Grantmaker, funding it,
 *     backing an existing one, and funding a public node's assessment;
 *   - asking a public mandate the organization funds for a fresh public
 *     assessment of a node whose version here has changed (keeping the
 *     public version current).
 *
 * Every one of these shows something outside, at least where the
 * organization's attention is. So each is the act of a person who holds the
 * permission the deployment names (PUBLIC_ACTS_BY), present in a signed-in
 * session or pressing the card the Assistant shows for an outward act; or
 * it follows from a standing choice such a person made after being shown,
 * in the words kept with the choice, what it shows outside. Each is a row
 * in outward_acts with who, what was sent, and what the public graph
 * answered.
 *
 * Nothing private crosses here. A call carries ids the public graph already
 * holds, amounts, a reason from a fixed list, or words a person wrote for
 * the outside from a signed-in session. No text an agent wrote is sent by
 * anything in this file: that leaves through showing a page.
 *
 * Nothing here reads the live public graph to learn about a node or a
 * request: those reads are of the mirror. The only reads of the public
 * graph are of the organization's own account, its own mandates and its own
 * conversation with the public Grantmaker.
 */
import { loadConfig } from "../config.js";
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import type { PermissionName } from "../permissions.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { OutboundError, answerOf, call, publicGraph } from "./outbound-service.js";
import { logAdministrativeEvent } from "./permission-service.js";
import type { GateActor } from "./release-gate-service.js";
import { DECLINE_REASONS, type DeclineReason } from "./request-take-up-service.js";

export class OutwardError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

const REASON_LOG =
  "The log of acts on the public graph and the deployment's standing choices are kept at `public`, where every member reads them, and are written once the route has checked the person.";
const asOwner = <T>(fn: () => Promise<T>) => withSystemClearance(REASON_LOG, fn);

/** The permission whose holders may act on the public graph in the organization's name. */
export function publicActsPermission(): PermissionName {
  return loadConfig().publicActsBy;
}

// ---- the log ---------------------------------------------------------------------

export type OutwardActKind =
  | "take_up_request"
  | "decline_request"
  | "open_public_mandate"
  | "public_mandate_message"
  | "fund_public_mandate"
  | "back_public_mandate"
  | "fund_public_node"
  | "raise_public_node"
  | "keep_current"
  | "send_report"
  | "send_failure_facts";

/** What each kind of act is, as the log says it to a member. */
export const OUTWARD_ACT_WORDS: Record<OutwardActKind, string> = {
  take_up_request: "said on the public graph that this graph is taking a request up",
  decline_request: "said on the public graph that this graph will not do work it took up",
  open_public_mandate: "opened a conversation with the public Grantmaker about a new public mandate",
  public_mandate_message: "wrote to the public Grantmaker about a public mandate",
  fund_public_mandate: "funded a public mandate with public owls",
  back_public_mandate: "added public owls to a public mandate",
  fund_public_node: "paid for a public assessment of a node with public owls",
  raise_public_node: "asked a public mandate for a fresh public assessment of a node",
  keep_current: "asked a public mandate for a fresh public assessment of a node whose version here changed",
  send_report: "sent an agent's report, as redacted, to Minerval's maintainers",
  send_failure_facts: "sent the facts of a tool failure to Minerval's maintainers",
};

export type Actor = { actor: GateActor } | { standingChoice: StandingChoiceKey };

export async function logOutwardAct(row: {
  kind: OutwardActKind;
  by: Actor;
  publicRef?: string | null;
  sent: Record<string, unknown>;
  result: "done" | "refused" | "failed";
  said?: string | null;
}): Promise<string> {
  const person = "actor" in row.by ? row.by.actor : null;
  return asOwner(async () => {
    const [r] = await rawQuery<{ id: string }>(
      `INSERT INTO outward_acts (kind, acted_by, holding, under_standing_choice, public_ref, sent, result, public_graph_said, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING id`,
      [
        row.kind,
        person?.id ?? null,
        person?.holding ?? [],
        "standingChoice" in row.by ? row.by.standingChoice : null,
        row.publicRef ?? null,
        JSON.stringify(row.sent),
        row.result,
        row.said ? row.said.slice(0, 1000) : null,
        PUBLIC_LABEL,
      ]
    );
    return r!.id;
  });
}

/**
 * One call to the public graph, logged whatever comes back. Returns the
 * answer; throws OutwardError when the public graph refuses or cannot be
 * reached, after the refusal is on the log.
 */
async function act(input: {
  kind: OutwardActKind;
  by: Actor;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  publicRef?: string | null;
  ok?: number[];
}): Promise<Record<string, any>> {
  let graph;
  try {
    graph = publicGraph();
  } catch (err) {
    if (err instanceof OutboundError) throw new OutwardError("NO_ROUTE_OUT", NO_ACCOUNT_WORDS);
    throw err;
  }
  let res: { status: number; json: Record<string, any> };
  try {
    res = await call(graph, input.method, input.path, input.body);
  } catch (err) {
    const said = err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached.";
    await logOutwardAct({ kind: input.kind, by: input.by, publicRef: input.publicRef, sent: input.body, result: "failed", said });
    throw new OutwardError("PUBLIC_GRAPH_UNREACHABLE", `The public graph could not be reached, so nothing was sent: ${said}`, 502);
  }
  const fine = (input.ok ?? [200, 201, 202]).includes(res.status);
  const said = fine ? String(res.json.in_words ?? res.json.note ?? "") : `${res.status}: ${answerOf(res.json)}`;
  await logOutwardAct({ kind: input.kind, by: input.by, publicRef: input.publicRef, sent: input.body, result: fine ? "done" : "refused", said });
  if (!fine) {
    throw new OutwardError("PUBLIC_GRAPH_REFUSED", `The public graph did not take this, and said: ${answerOf(res.json) || `status ${res.status}`}`, res.status === 402 ? 402 : 409);
  }
  return res.json;
}

export const NO_ACCOUNT_WORDS =
  "This deployment has no address or key for the public graph (PUBLIC_GRAPH_API_URL, PUBLIC_GRAPH_API_KEY), so it cannot act there. " +
  "The organization opens an account on the public graph, makes an API key for it, and an operator sets both.";

/** The log of acts on the public graph, newest first, as a member reads it. */
export async function outwardLog(opts: { limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<{
    id: string; kind: OutwardActKind; by: string | null; holding: string[]; under_standing_choice: string | null;
    public_ref: string | null; sent: Record<string, unknown>; result: string; public_graph_said: string | null; at: Date;
  }>(
    `SELECT a.id, a.kind, c.display_name AS by, a.holding, a.under_standing_choice, a.public_ref, a.sent, a.result, a.public_graph_said, a.at
       FROM outward_acts a LEFT JOIN contributors c ON c.id = a.acted_by ORDER BY a.at DESC LIMIT $1`,
    [Math.min(200, Math.max(1, opts.limit ?? 50))]
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    what: OUTWARD_ACT_WORDS[r.kind] ?? r.kind,
    kind: r.kind,
    by: r.under_standing_choice ? `the standing choice "${STANDING_CHOICES[r.under_standing_choice as StandingChoiceKey]?.name ?? r.under_standing_choice}"` : r.by,
    holding: r.holding,
    on_the_public_graph: r.public_ref,
    sent: r.sent,
    result: r.result,
    ...(r.public_graph_said ? { the_public_graph_said: r.public_graph_said } : {}),
  }));
}

// ---- standing choices -------------------------------------------------------------

/**
 * The choices a deployment makes once about what goes out with nobody
 * acting. `told` is what the person choosing is shown before they choose,
 * and it is stored with the choice as they were shown it. `by` is the
 * permission the person must hold: the one that would let them do each act
 * themselves.
 */
export const STANDING_CHOICES = {
  keep_public_current: {
    name: "Keep the public versions of nodes current",
    starts: "on" as const,
    told:
      "When a version of a public node changes at any label in this deployment, your graph asks the public mandate named here for a fresh " +
      "public assessment of that node. Nothing your graph holds is sent: the request names the node and nothing else, and the public " +
      "assessment is made on public evidence by the public graph's own Steward. What this shows outside is which public nodes your graph " +
      "works on, and when, to anyone who reads that mandate's public page. A delay, or sending in batches, hides when and not which. A " +
      "mandate here, or one node, can be left out. Whether this is on, and whether a public mandate pays for it, is stated on every page " +
      "your graph shows outside. It is on unless someone turns it off, and until a person names a public mandate here nothing is sent.",
  },
  send_failure_facts: {
    name: "Send the facts of tool failures to Minerval's maintainers",
    starts: "off" as const,
    told:
      "When one of your graph's agents reports that a tool failed and Audit finds the report to be about Minerval's machinery, your graph " +
      "sends Minerval's maintainers these facts and nothing else: which tool (only if it is one of Minerval's own tools, by its name in " +
      "the code), the kind of report and its severity from fixed lists, the version of Minerval your deployment runs, and how many times " +
      "it was seen. None of the agent's words are sent. What this shows outside is that your organization runs this version and which of " +
      "Minerval's tools fail for it, to Minerval's maintainers and nobody else.",
  },
  send_redacted_reports: {
    name: "Send agents' reports about Minerval's machinery, as redacted, without asking each time",
    starts: "off" as const,
    told:
      "When Audit finds an agent's report to be about Minerval's machinery and the Redactor has finished its pass over the agent's words, " +
      "your graph sends the report to Minerval's maintainers as redacted, with nobody reading it first. The words are the agent's own, " +
      "less what the Redactor removed under the policy for what leaves the report's label, each removal marked. What this shows outside " +
      "is whatever those words say about what your agents were doing, to Minerval's maintainers and nobody else. A redaction can miss " +
      "something a person would have caught.",
  },
} as const;
export type StandingChoiceKey = keyof typeof STANDING_CHOICES;

export interface KeepCurrentValue {
  on: boolean;
  public_mandate_id: string | null;
  delay_hours: number;
  batch_hours: number;
}

interface SettingRow {
  key: string;
  value: Record<string, unknown>;
  told: string;
  set_by: string | null;
  by: string | null;
  set_at: Date;
}

async function settingRow(key: StandingChoiceKey): Promise<SettingRow | null> {
  const [row] = await asOwner(() =>
    rawQuery<SettingRow>(
      `SELECT s.key, s.value, s.told, s.set_by, c.display_name AS by, s.set_at FROM outward_settings s LEFT JOIN contributors c ON c.id = s.set_by WHERE s.key = $1`,
      [key]
    )
  );
  return row ?? null;
}

/** Whether a standing choice is on. A choice nobody has made is where it starts. */
export async function standingChoiceOn(key: StandingChoiceKey): Promise<boolean> {
  const row = await settingRow(key);
  if (!row) return STANDING_CHOICES[key].starts === "on";
  return row.value.on === true;
}

/** Keeping public versions current, as it stands: the setting, and whether anything is behind it. */
export async function keepCurrentState(): Promise<{
  setting: "on" | "off";
  public_mandate_id: string | null;
  delay_hours: number;
  batch_hours: number;
  sends: boolean;
  in_words: string;
  set_at: string | null;
}> {
  const row = await settingRow("keep_public_current");
  const value = (row?.value ?? {}) as Partial<KeepCurrentValue>;
  const on = row ? value.on === true : true;
  const mandate = typeof value.public_mandate_id === "string" ? value.public_mandate_id : null;
  const { publicGraphApiUrl, publicGraphApiKey } = loadConfig();
  const account = Boolean(publicGraphApiUrl && publicGraphApiKey);
  const sends = on && mandate !== null && account;
  const in_words = !on
    ? "Off. Nothing is asked of the public graph when a version here changes, and every page this graph shows outside says so."
    : !account
      ? "On, and nothing is sent: this deployment has no account on the public graph to act as (PUBLIC_GRAPH_API_URL, PUBLIC_GRAPH_API_KEY)."
      : mandate === null
        ? "On, and nothing is sent: nobody has named a public mandate to pay for it. A person who may act on the public graph for the organization opens one and names it here."
        : "On. When a version of a public node changes here, the public mandate named is asked for a fresh public assessment of the node.";
  return {
    setting: on ? "on" : "off",
    public_mandate_id: mandate,
    delay_hours: Number(value.delay_hours ?? 0),
    batch_hours: Number(value.batch_hours ?? 0),
    sends,
    in_words,
    set_at: row?.set_at.toISOString() ?? null,
  };
}

/** What a package says of this setting: fixed words, stamped by the system (published-page/verify.ts). */
export async function keepCurrentStamp(): Promise<{ setting: "on" | "off"; a_public_mandate_pays_for_it: boolean }> {
  const state = await keepCurrentState();
  return { setting: state.setting, a_public_mandate_pays_for_it: state.sends };
}

/** Every standing choice as it stands, with what each shows outside and who set it. */
export async function standingChoices(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const key of Object.keys(STANDING_CHOICES) as StandingChoiceKey[]) {
    const row = await settingRow(key);
    out.push({
      key,
      name: STANDING_CHOICES[key].name,
      on: row ? row.value.on === true : STANDING_CHOICES[key].starts === "on",
      what_it_shows_outside: STANDING_CHOICES[key].told,
      set_by: row?.by ?? null,
      set_at: row?.set_at.toISOString() ?? null,
      ...(key === "keep_public_current" ? { as_it_stands: await keepCurrentState() } : {}),
      who_may_set_it:
        key === "send_redacted_reports"
          ? "a person who holds release for the organization's own material"
          : key === "send_failure_facts"
            ? "a person who directs the graph"
            : `a person who holds ${publicActsPermission()}`,
    });
  }
  return out;
}

/**
 * Set a standing choice. The route has checked the person. The text the
 * person was shown is stored with the choice, and the change is on the
 * administrative log.
 */
export async function setStandingChoice(input: {
  key: StandingChoiceKey;
  on: boolean;
  publicMandateId?: string | null;
  delayHours?: number;
  batchHours?: number;
  actor: GateActor;
}): Promise<Record<string, unknown>> {
  const def = STANDING_CHOICES[input.key];
  if (!def) throw new OutwardError("NO_SUCH_CHOICE", `The standing choices are: ${Object.keys(STANDING_CHOICES).join(", ")}.`, 404);
  const before = await settingRow(input.key);
  const hours = (n: number | undefined, was: unknown) => Math.min(24 * 90, Math.max(0, Math.round(Number(n ?? was ?? 0))));
  const value: Record<string, unknown> =
    input.key === "keep_public_current"
      ? {
          on: input.on,
          public_mandate_id: input.publicMandateId === undefined ? (before?.value.public_mandate_id ?? null) : input.publicMandateId,
          delay_hours: hours(input.delayHours, before?.value.delay_hours),
          batch_hours: hours(input.batchHours, before?.value.batch_hours),
        }
      : { on: input.on };
  await asOwner(() =>
    withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO outward_settings (key, value, told, set_by, holding, set_at, sensitivity_label)
         VALUES ($1, $2::jsonb, $3, $4, $5, now(), $6)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, told = EXCLUDED.told, set_by = EXCLUDED.set_by, holding = EXCLUDED.holding, set_at = now()`,
        [input.key, JSON.stringify(value), def.told, input.actor.id, input.actor.holding, PUBLIC_LABEL]
      );
      await logAdministrativeEvent(tx, "standing_choice_set", input.actor.id, {
        choice: def.name,
        set_to: input.on ? "on" : "off",
        ...(input.key === "keep_public_current"
          ? { public_mandate_id: (value.public_mandate_id as string | null) ?? null, delay_hours: String(value.delay_hours), batch_hours: String(value.batch_hours) }
          : {}),
      });
    })
  );
  return { key: input.key, name: def.name, on: input.on, what_it_shows_outside: def.told, ...(input.key === "keep_public_current" ? { as_it_stands: await keepCurrentState() } : {}) };
}

// ---- public requests: adopted, and taken up in public ----------------------------------

/** The public graph's requests, from the mirror, with what this deployment has done about each that the reader may see. */
export async function publicRequests(opts: { nodeId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
  const rows = await rawQuery<{
    id: string; ask: string; why: string; satisfied_by: string; who_could: string | null; addressed_to: string | null;
    bears_on_text: string | null; state: string; filed_at: Date;
  }>(
    `SELECT r.id, r.ask, r.why, r.satisfied_by, r.who_could, r.addressed_to, r.bears_on_text, r.state, r.filed_at
       FROM feed_requests r
      WHERE r.origin = 'mirror'
        AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM feed_request_targets t WHERE t.request_id = r.id AND t.claim_id = $1))
      ORDER BY (r.state IN ('open', 'addressed', 'in_progress')) DESC, r.filed_at DESC LIMIT $2`,
    [opts.nodeId ?? null, Math.min(200, Math.max(1, opts.limit ?? 50))]
  );
  const ids = rows.map((r) => r.id);
  const targets = await rawQuery<{ request_id: string; id: string; text: string }>(
    `SELECT t.request_id, c.id, c.text FROM feed_request_targets t JOIN claims c ON c.id = t.claim_id WHERE t.request_id = ANY($1::uuid[])`,
    [ids]
  );
  // Read as the caller: a request adopted at a label the reader does not read is not listed as adopted.
  const adopted = await rawQuery<{ public_request_id: string; id: string; request_id: string; adopted_at: Date; taken_up_at: Date | null; declined_at: Date | null; decline_reason: string | null; state: string }>(
    `SELECT a.public_request_id, a.id, a.request_id, a.adopted_at, a.taken_up_at, a.declined_at, a.decline_reason, r.state
       FROM adopted_requests a JOIN requests r ON r.id = a.request_id WHERE a.public_request_id = ANY($1::uuid[])`,
    [ids]
  );
  return {
    requests: rows.map((r) => {
      const mine = adopted.filter((a) => a.public_request_id === r.id);
      return {
        public_request_id: r.id,
        ask: r.ask,
        why: r.why,
        satisfied_by: r.satisfied_by,
        who_could: r.who_could,
        addressed_to: r.addressed_to,
        bears_on: targets.filter((t) => t.request_id === r.id).map((t) => ({ id: t.id, text: t.text })),
        bears_on_text: r.bears_on_text,
        state_on_the_public_graph: r.state,
        filed_at: r.filed_at.toISOString(),
        here: mine.map((a) => ({
          adoption_id: a.id,
          request_id: a.request_id,
          adopted_at: a.adopted_at.toISOString(),
          state_here: a.state,
          taken_up_in_public_at: a.taken_up_at?.toISOString() ?? null,
          ...(a.declined_at ? { declined_in_public: { at: a.declined_at.toISOString(), because: DECLINE_REASONS[(a.decline_reason ?? "no_reason") as DeclineReason] } } : {}),
        })),
      };
    }),
    as_of: "These are the public graph's requests as the mirror last brought them. Reading them tells the public graph nothing.",
    adopting:
      "Adopting a request makes it an ordinary request in this deployment, at a label you choose, linked to the public one. It says nothing outside, " +
      "and the work runs when it is funded here, like any work.",
    taking_up_in_public: TAKE_UP_TOLD,
  };
}

/** What a person is shown before they say in public that the graph is taking a request up. */
export const TAKE_UP_TOLD =
  "Saying in public that your graph is taking a request up puts the organization's name and today's date on that request's public record. " +
  "It shows outside that your graph is working on what the request asks about. It commits your graph to doing the work well, not to a result, " +
  "and it funds nothing: the work runs here when a mandate or a person pays for it. The public record then shows what followed: a page your " +
  "graph publishes on a node the request bears on, a statement that the work will not be done with its reason, or nothing yet, with how long. " +
  "The statement is not taken back.";

/**
 * Adopt a public request: it becomes an ordinary request here, at `label`,
 * linked to the public one. Nothing is said outside. The words are the
 * public graph's own, which every label reads.
 */
export async function adoptRequest(input: { publicRequestId: string; label?: string | null; actor: GateActor }): Promise<{ adoption_id: string; request_id: string; already: boolean }> {
  const [pub] = await rawQuery<{ id: string; ask: string; why: string; satisfied_by: string; who_could: string | null; addressed_to: string | null; bears_on_text: string | null; state: string }>(
    `SELECT id, ask, why, satisfied_by, who_could, addressed_to, bears_on_text, state FROM feed_requests WHERE id = $1 AND origin = 'mirror'`,
    [input.publicRequestId]
  );
  if (!pub) throw new OutwardError("REQUEST_NOT_FOUND", "The mirror holds no public request with that id.", 404);
  const single = oneLabelOnly();
  const label = single ? PUBLIC_LABEL : (input.label ?? "");
  if (!single) {
    if (!label) throw new OutwardError("LABEL_NEEDED", "Say which label the work on this request is to be done at: one you read. GET /labels/mine lists them.", 422);
    if (label === PUBLIC_LABEL) {
      throw new OutwardError("LABEL_NEEDED", "A request adopted here is this deployment's own work, so it is at one of the deployment's own labels. Work at `public` on what the public graph holds is the public graph's.", 422);
    }
    if (!input.actor.clearance.includes(label)) throw new OutwardError("LABEL_NOT_READ", "You do not read that label.", 403);
  }
  return runAtLabel(label, `adopting public request ${pub.id}`, async () => {
    const [existing] = await rawQuery<{ id: string; request_id: string }>(
      `SELECT id, request_id FROM adopted_requests WHERE public_request_id = $1 AND sensitivity_label = $2`,
      [pub.id, label]
    );
    if (existing) return { adoption_id: existing.id, request_id: existing.request_id, already: true };
    const targets = await rawQuery<{ claim_id: string }>(
      `SELECT t.claim_id FROM feed_request_targets t JOIN claims c ON c.id = t.claim_id WHERE t.request_id = $1`,
      [pub.id]
    );
    const { fileRequest } = await import("./request-service.js");
    const filed = await fileRequest({
      ask: pub.ask,
      why: pub.why,
      satisfiedBy: pub.satisfied_by,
      whoCould: pub.who_could,
      addressedTo: pub.addressed_to,
      bearsOnText: pub.bears_on_text ?? (targets.length === 0 ? "What the public request describes." : null),
      claimIds: targets.map((t) => t.claim_id),
      filer: { kind: "contributor", contributorId: input.actor.id },
    });
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO adopted_requests (request_id, public_request_id, adopted_by, sensitivity_label) VALUES ($1, $2, $3, $4) RETURNING id`,
      [filed.id, pub.id, input.actor.id, label]
    );
    return { adoption_id: row!.id, request_id: filed.id, already: false };
  });
}

async function adoptionFor(adoptionId: string): Promise<{ id: string; public_request_id: string; taken_up_at: Date | null; declined_at: Date | null; label: string }> {
  // Read as the person: an adoption at a label they do not read does not exist for them.
  const [row] = await rawQuery<{ id: string; public_request_id: string; taken_up_at: Date | null; declined_at: Date | null; label: string }>(
    `SELECT id, public_request_id, taken_up_at, declined_at, sensitivity_label AS label FROM adopted_requests WHERE id = $1`,
    [adoptionId]
  );
  if (!row) throw new OutwardError("ADOPTION_NOT_FOUND", "No adopted request with that id is one you read.", 404);
  return row;
}

/** Say on the public graph, in the organization's name, that this graph is taking the request up. */
export async function takeUpInPublic(input: { adoptionId: string; actor: GateActor }): Promise<Record<string, unknown>> {
  const adoption = await adoptionFor(input.adoptionId);
  if (adoption.taken_up_at) throw new OutwardError("ALREADY_TAKEN_UP", "This graph has already said in public that it is taking this request up.");
  const answer = await act({
    kind: "take_up_request",
    by: { actor: input.actor },
    method: "POST",
    path: `/requests/${adoption.public_request_id}/take-up`,
    body: {},
    publicRef: adoption.public_request_id,
  });
  await runAtLabel(adoption.label, `recording that request ${adoption.id} was taken up in public`, () =>
    rawQuery(`UPDATE adopted_requests SET taken_up_at = now() WHERE id = $1`, [adoption.id])
  );
  return { taken_up: true, public_request_id: adoption.public_request_id, the_public_graph_said: String(answer.in_words ?? "") };
}

/** Say on the public graph that this graph will not do the work it took up, with a reason from the fixed list. */
export async function declineInPublic(input: { adoptionId: string; reason: string; actor: GateActor }): Promise<Record<string, unknown>> {
  if (!(input.reason in DECLINE_REASONS)) throw new OutwardError("UNKNOWN_REASON", `A reason is one of: ${Object.keys(DECLINE_REASONS).join(", ")}.`, 422);
  const adoption = await adoptionFor(input.adoptionId);
  if (!adoption.taken_up_at) throw new OutwardError("NOT_TAKEN_UP", "This graph has not said in public that it is taking this request up, so there is nothing to answer there. A request adopted here and dropped needs no public statement.");
  if (adoption.declined_at) throw new OutwardError("ALREADY_DECLINED", "This graph has already said in public that it will not do this work.");
  const answer = await act({
    kind: "decline_request",
    by: { actor: input.actor },
    method: "POST",
    path: `/requests/${adoption.public_request_id}/take-up/decline`,
    body: { reason: input.reason },
    publicRef: adoption.public_request_id,
  });
  await runAtLabel(adoption.label, `recording that request ${adoption.id} was declined in public`, () =>
    rawQuery(`UPDATE adopted_requests SET declined_at = now(), decline_reason = $2 WHERE id = $1`, [adoption.id, input.reason])
  );
  return { declined: true, because: DECLINE_REASONS[input.reason as DeclineReason], the_public_graph_said: String(answer.in_words ?? "") };
}

// ---- public owls and public mandates -----------------------------------------------------

/** What a person is shown before any act that spends public owls or opens a public mandate. */
export const PUBLIC_MANDATE_TOLD =
  "A public mandate is made on the public graph under the organization's own account, as any account makes one, and is public at once: " +
  "its scope in your words, its funder, its budget, what its Grantmaker decides and what it pays for. It is paid for in public owls, which " +
  "are bought on the public graph; owls created in this deployment do not convert. You write the scope yourself. Nothing from this " +
  "deployment is filled in for you, and what you write is sent as you wrote it to the public Grantmaker, which may decline a scope that " +
  "steers a conclusion. It shows outside what your organization wants examined.";

export const FUND_NODE_TOLD =
  "This pays, from the organization's public owls, for the public graph's own Steward to assess this node on public evidence. The payment " +
  "is public on the public graph under the organization's account. It shows outside that your organization wanted this node looked at, " +
  "and when. Nothing this deployment holds is sent.";

/** The organization's account on the public graph: its balance of public owls and its public mandates. Reads its own account only. */
export async function publicAccount(): Promise<Record<string, unknown>> {
  const who = `Holders of ${publicActsPermission()} may act on the public graph in the organization's name.`;
  let graph;
  try {
    graph = publicGraph();
  } catch {
    return { connected: false, in_words: NO_ACCOUNT_WORDS, who_may_act: who };
  }
  try {
    const me = await call(graph, "GET", "/users/me");
    if (me.status !== 200) {
      return { connected: false, in_words: `The public graph did not accept this deployment's key (${me.status}). An operator checks PUBLIC_GRAPH_API_KEY.`, who_may_act: who };
    }
    const grants = await call(graph, "GET", "/grants");
    const list = (Array.isArray(grants.json.grants) ? grants.json.grants : []) as Array<Record<string, any>>;
    return {
      connected: true,
      account: { id: me.json.user?.id ?? null, name: me.json.user?.display_name ?? null },
      public_owls: Number(me.json.entitlement?.owl_balance ?? 0),
      public_owls_statement:
        "Public owls are the organization's balance on the public graph, bought there. They pay for public work only, and owls created in this deployment never convert to them.",
      public_mandates: list.map((g) => ({
        id: g.id,
        title: g.title ?? g.mandate?.title ?? null,
        status: g.status ?? null,
        budget_owls: g.budget_owls ?? g.budget?.owls ?? null,
        spent_owls: g.spent_owls ?? g.spend?.owls ?? null,
        public: true,
      })),
      who_may_act: who,
      what_a_public_mandate_shows: PUBLIC_MANDATE_TOLD,
    };
  } catch (err) {
    return { connected: false, in_words: `The public graph could not be reached: ${err instanceof Error ? err.message.slice(0, 300) : "no answer"}`, who_may_act: who };
  }
}

/** Open a conversation with the public Grantmaker about a new public mandate, in the person's own words. */
export async function openPublicMandate(input: { message: string; actor: GateActor }): Promise<Record<string, unknown>> {
  const message = input.message.trim();
  if (!message) throw new OutwardError("NO_WORDS", "Write what the public mandate is for. These words are sent as you write them.", 422);
  const answer = await act({ kind: "open_public_mandate", by: { actor: input.actor }, method: "POST", path: "/grant-conversations", body: { message } });
  const id = answer.conversation?.id ?? answer.id ?? null;
  return { conversation_id: id, the_public_graph: answer };
}

export async function sayToPublicGrantmaker(input: { conversationId: string; message: string; actor: GateActor }): Promise<Record<string, unknown>> {
  const message = input.message.trim();
  if (!message) throw new OutwardError("NO_WORDS", "Write what you want to say to the public Grantmaker. These words are sent as you write them.", 422);
  const answer = await act({
    kind: "public_mandate_message",
    by: { actor: input.actor },
    method: "POST",
    path: `/grant-conversations/${input.conversationId}/messages`,
    body: { message },
    publicRef: input.conversationId,
  });
  return { the_public_graph: answer };
}

/** The organization's own conversation with the public Grantmaker, as the public graph serves it to the account. */
export async function readPublicConversation(conversationId: string): Promise<Record<string, unknown>> {
  let graph;
  try {
    graph = publicGraph();
  } catch {
    throw new OutwardError("NO_ROUTE_OUT", NO_ACCOUNT_WORDS);
  }
  const res = await call(graph, "GET", `/grant-conversations/${conversationId}?wait=20`);
  if (res.status !== 200) throw new OutwardError("PUBLIC_GRAPH_REFUSED", `The public graph said: ${answerOf(res.json) || res.status}`, res.status === 404 ? 404 : 409);
  return res.json;
}

export async function fundPublicMandate(input: { conversationId: string; budgetOwls: number; actor: GateActor }): Promise<Record<string, unknown>> {
  const answer = await act({
    kind: "fund_public_mandate",
    by: { actor: input.actor },
    method: "POST",
    path: `/grant-conversations/${input.conversationId}/fund`,
    body: { budget_owls: input.budgetOwls },
    publicRef: input.conversationId,
  });
  return { public_mandate_id: answer.grant_id ?? answer.grant?.id ?? null, the_public_graph: answer };
}

export async function backPublicMandate(input: { mandateId: string; owls: number; actor: GateActor }): Promise<Record<string, unknown>> {
  const answer = await act({
    kind: "back_public_mandate",
    by: { actor: input.actor },
    method: "POST",
    path: `/mandates/${input.mandateId}/contribute`,
    body: { owls: input.owls },
    publicRef: input.mandateId,
  });
  return { the_public_graph: answer };
}

/** The node as the public graph knows it: a mirrored node's own id. Anything else is not on the public graph. */
async function publicNode(nodeId: string): Promise<string> {
  const [node] = await rawQuery<{ id: string; origin: string }>(`SELECT id, origin FROM claims WHERE id = $1`, [nodeId]);
  if (!node) throw new OutwardError("NODE_NOT_FOUND", "No node with that id is one you read.", 404);
  if (node.origin !== "mirror") {
    throw new OutwardError(
      "NOT_A_PUBLIC_NODE",
      "This node exists only in this deployment, so the public graph has nothing to assess. A node reaches the public graph by being proposed there when its page is shown outside."
    );
  }
  return node.id;
}

/** Pay, from the organization's public owls, for the public graph's assessment of a mirrored node. */
export async function fundPublicNode(input: { nodeId: string; owls: number; actor: GateActor }): Promise<Record<string, unknown>> {
  const id = await publicNode(input.nodeId);
  const answer = await act({ kind: "fund_public_node", by: { actor: input.actor }, method: "POST", path: `/claims/${id}/contribute`, body: { owls: input.owls }, publicRef: id });
  return { funded: true, node_id: id, the_public_graph: answer };
}

/** Ask one of the organization's public mandates for a fresh public assessment of a mirrored node. */
export async function raisePublicNode(input: { nodeId: string; mandateId: string; by: Actor }): Promise<Record<string, unknown>> {
  const id = "actor" in input.by ? await publicNode(input.nodeId) : input.nodeId;
  const answer = await act({
    kind: "actor" in input.by ? "raise_public_node" : "keep_current",
    by: input.by,
    method: "POST",
    path: `/mandates/${input.mandateId}/raise`,
    body: { node_id: id },
    publicRef: id,
  });
  return { asked: true, node_id: id, the_public_graph_said: String(answer.in_words ?? "") };
}

// ---- keeping the public version current -------------------------------------------------------

const REASON_KEEP_CURRENT =
  "Keeping public versions current looks, at every label, for versions of mirrored nodes that have been replaced, and records each at its own version's label.";
const atEveryLabel = <T>(fn: () => Promise<T>) => withSystemClearance(REASON_KEEP_CURRENT, fn);

/** Why a changed version was not sent on, in the only words the queue says it in. */
export const NOT_SENT_WORDS = {
  left_out_for_the_mandate: "the mandate that paid for the version leaves its work out",
  node_left_out: "this node is left out",
  refused: "the public graph did not take the request",
  unreachable: "the public graph could not be reached",
  turned_off: "keeping public versions current was turned off before it was due",
} as const;

/**
 * Record each version of a mirrored node, at a label other than the node's
 * own, that has come into force since the setting was last set by a person,
 * and say when the public graph may be asked about it. Does nothing until
 * the setting sends (keepCurrentState): before a person has named a public
 * mandate, no version is queued, so nothing made earlier is sent later.
 */
export async function noticeChangedVersions(): Promise<number> {
  if (oneLabelOnly()) return 0;
  const state = await keepCurrentState();
  if (!state.sends || !state.set_at) return 0;
  const since = state.set_at;
  return atEveryLabel(async () => {
    // The version's time is carried as the database wrote it: a JavaScript date would drop its microseconds, and the same version would be noticed again.
    const versions = await rawQuery<{ node_id: string; label: string; at: Date; at_exact: string; job: string | null }>(
      `SELECT v.node_id, v.label, v.at, v.at::text AS at_exact, v.job FROM (
         SELECT a.claim_id AS node_id, a.sensitivity_label AS label, a.assessed_at AS at, a.funded_by_job_id AS job FROM assessments_in_force a
         UNION ALL
         SELECT q.claim_id, q.sensitivity_label, q.assessed_at, q.funded_by_job_id FROM quantity_estimates_in_force q
         UNION ALL
         SELECT s.claim_id, s.sensitivity_label, s.assessed_at, s.funded_by_job_id FROM question_assessments_in_force s
       ) v JOIN claims c ON c.id = v.node_id
       WHERE c.origin = 'mirror' AND v.label <> c.sensitivity_label AND v.at > $1::timestamptz
         AND NOT EXISTS (SELECT 1 FROM keep_current_queue k WHERE k.node_id = v.node_id AND k.version_at = v.at AND k.sensitivity_label = v.label)`,
      [since]
    );
    let noticed = 0;
    for (const v of versions) {
      const [grant] = v.job ? await rawQuery<{ id: string }>(`SELECT id FROM grants WHERE budget_job_id = $1`, [v.job]) : [];
      const exceptions = await rawQuery<{ grant_id: string | null; node_id: string | null }>(
        `SELECT grant_id, node_id FROM keep_current_exceptions
          WHERE lifted_at IS NULL
            AND ((grant_id IS NULL AND node_id = $1) OR (grant_id = $2 AND (node_id IS NULL OR node_id = $1)))`,
        [v.node_id, grant?.id ?? null]
      );
      const leftOut = exceptions.find((e) => e.grant_id && !e.node_id) ? "left_out_for_the_mandate" : exceptions.length > 0 ? "node_left_out" : null;
      // Due after the delay, and then at the next batch boundary where batches are set.
      let due = v.at.getTime() + state.delay_hours * 3_600_000;
      if (state.batch_hours > 0) {
        const span = state.batch_hours * 3_600_000;
        due = Math.ceil(due / span) * span;
      }
      await rawQuery(
        `INSERT INTO keep_current_queue (node_id, version_at, paid_by_grant_id, due_at, state, because, settled_at, sensitivity_label)
         VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [v.node_id, v.at_exact, grant?.id ?? null, new Date(due), leftOut ? "not_sent" : "waiting", leftOut ? NOT_SENT_WORDS[leftOut] : null, leftOut ? new Date() : null, v.label]
      );
      noticed++;
    }
    return noticed;
  });
}

/**
 * Ask the public mandate named in the setting for a fresh public assessment
 * of each node whose changed version is due. One request per node, however
 * many versions and labels are waiting on it. Each is logged as made under
 * the standing choice.
 */
export async function sendKeepCurrent(now: Date = new Date()): Promise<{ asked: number; not_sent: number }> {
  if (oneLabelOnly()) return { asked: 0, not_sent: 0 };
  const state = await keepCurrentState();
  const settle = (nodeId: string, how: "sent" | "not_sent", because: string | null) =>
    atEveryLabel(() =>
      rawQuery(`UPDATE keep_current_queue SET state = $2, because = $3, settled_at = now() WHERE node_id = $1 AND state = 'waiting' AND due_at <= $4`, [nodeId, how, because, now])
    );
  const due = await atEveryLabel(() =>
    rawQuery<{ node_id: string }>(`SELECT DISTINCT node_id FROM keep_current_queue WHERE state = 'waiting' AND due_at <= $1 ORDER BY node_id`, [now])
  );
  let asked = 0;
  let notSent = 0;
  for (const { node_id } of due) {
    if (!state.sends || !state.public_mandate_id) {
      await settle(node_id, "not_sent", NOT_SENT_WORDS.turned_off);
      notSent++;
      continue;
    }
    try {
      await raisePublicNode({ nodeId: node_id, mandateId: state.public_mandate_id, by: { standingChoice: "keep_public_current" } });
      await settle(node_id, "sent", null);
      asked++;
    } catch (err) {
      const code = err instanceof OutwardError ? err.code : "";
      await settle(node_id, "not_sent", code === "PUBLIC_GRAPH_UNREACHABLE" ? NOT_SENT_WORDS.unreachable : NOT_SENT_WORDS.refused);
      notSent++;
    }
  }
  return { asked, not_sent: notSent };
}

/** The scheduler's step: notice, then send what is due. */
export async function followKeepCurrent(): Promise<{ noticed: number; asked: number; not_sent: number }> {
  const noticed = await noticeChangedVersions();
  return { noticed, ...(await sendKeepCurrent()) };
}

/** What an administrator is shown about keeping public versions current: the setting, what has been asked and what was not, with why. */
export async function keepCurrentOverview(): Promise<Record<string, unknown>> {
  const state = await keepCurrentState();
  // Read as the caller: the queue's rows are at their versions' labels.
  const rows = await rawQuery<{ node_id: string; node: string | null; version_at: Date; due_at: Date; state: string; because: string | null; settled_at: Date | null }>(
    `SELECT k.node_id, c.text AS node, k.version_at, k.due_at, k.state, k.because, k.settled_at
       FROM keep_current_queue k LEFT JOIN claims c ON c.id = k.node_id ORDER BY k.noticed_at DESC LIMIT 100`
  );
  const exceptions = await rawQuery<{ id: string; grant_id: string | null; node_id: string | null; node: string | null; set_at: Date; by: string | null }>(
    `SELECT e.id, e.grant_id, e.node_id, c.text AS node, e.set_at, p.display_name AS by
       FROM keep_current_exceptions e LEFT JOIN claims c ON c.id = e.node_id LEFT JOIN contributors p ON p.id = e.set_by
      WHERE e.lifted_at IS NULL ORDER BY e.set_at DESC`
  );
  const [lastRefusal] = await rawQuery<{ at: Date; said: string | null }>(
    `SELECT at, public_graph_said AS said FROM outward_acts WHERE kind = 'keep_current' AND result <> 'done' ORDER BY at DESC LIMIT 1`
  );
  return {
    ...state,
    what_it_shows_outside: STANDING_CHOICES.keep_public_current.told,
    ...(lastRefusal ? { last_not_taken: { at: lastRefusal.at.toISOString(), the_public_graph_said: lastRefusal.said } } : {}),
    versions: rows.map((r) => ({
      node_id: r.node_id,
      node: r.node,
      version_of: r.version_at.toISOString(),
      due_at: r.due_at.toISOString(),
      state: r.state,
      ...(r.because ? { because: r.because } : {}),
    })),
    versions_note: "Listed are the changed versions at labels you read. Others may be waiting at labels you do not read.",
    left_out: exceptions.map((e) => ({ id: e.id, mandate_id: e.grant_id, node_id: e.node_id, node: e.node, set_at: e.set_at.toISOString(), by: e.by })),
  };
}

/**
 * Leave a mandate's work, or one node, out of keeping public versions
 * current. For a mandate, the row is at the mandate's label, which the
 * person must read; for a node alone, at the label the person names.
 */
export async function leaveOut(input: { grantId?: string | null; nodeId?: string | null; label?: string | null; actor: GateActor }): Promise<{ id: string }> {
  if (!input.grantId && !input.nodeId) throw new OutwardError("NOTHING_NAMED", "Name a mandate, a node, or both.", 422);
  let label = input.label ?? null;
  if (input.grantId) {
    // Read as the person: a mandate at a label they do not read does not exist for them.
    const [grant] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM grants WHERE id = $1`, [input.grantId]);
    if (!grant) throw new OutwardError("MANDATE_NOT_FOUND", "No mandate with that id is one you read.", 404);
    label = grant.label;
  }
  if (oneLabelOnly()) label = PUBLIC_LABEL;
  if (!label) throw new OutwardError("LABEL_NEEDED", "Say which label this is recorded at: one you read. Which nodes are left out says which are worked on, so the record is kept at a label.", 422);
  if (!input.actor.clearance.includes(label)) throw new OutwardError("LABEL_NOT_READ", "You do not read that label.", 403);
  return runAtLabel(label, "leaving work out of keeping public versions current", async () => {
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO keep_current_exceptions (grant_id, node_id, set_by, sensitivity_label) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.grantId ?? null, input.nodeId ?? null, input.actor.id, label]
    );
    return { id: row!.id };
  });
}

export async function takeBackLeaveOut(input: { id: string }): Promise<{ lifted: boolean }> {
  // As the person, at their clearance: a row at a label they do not read is not found.
  const [row] = await rawQuery<{ id: string; label: string }>(`SELECT id, sensitivity_label AS label FROM keep_current_exceptions WHERE id = $1 AND lifted_at IS NULL`, [input.id]);
  if (!row) throw new OutwardError("NOT_FOUND", "Nothing left out has that id at a label you read.", 404);
  await runAtLabel(row.label, "taking back a leaving-out", () => rawQuery(`UPDATE keep_current_exceptions SET lifted_at = now() WHERE id = $1`, [row.id]));
  return { lifted: true };
}
