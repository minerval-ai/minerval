/**
 * A private graph acting on the public graph, other than by showing a page
 * (docs/outward-acts.md).
 *
 * A deployment acts on the public graph as an ordinary account and only as
 * one. Everything here is a call to a route any account could call, with
 * the key of the organization's own account (PUBLIC_GRAPH_API_URL,
 * PUBLIC_GRAPH_API_KEY; outbound-service.ts has the client):
 *
 *   - opening a public mandate with the public Grantmaker, funding it,
 *     backing an existing one, funding a public node's assessment, and
 *     asking a public mandate about a node.
 *
 * These are a person spending the organization's public owls and writing
 * in its name, so each is the act of a person who holds the permission the
 * deployment names (PUBLIC_ACTS_BY), present in a signed-in session or
 * pressing the card the Assistant shows for an outward act.
 *
 * What goes out because of work done at a label is not here. That a
 * request was taken up or will not be worked, a request for a fresh public
 * assessment when a version here changes, a mandate's terms, an agent's
 * report: each is an item at the gate to outside, let through under that
 * gate's settings like anything else going to readers who do not read the
 * label, and sent by gate-outside.ts. A person who wants one of them said
 * offers it to the gate (takeUpInPublic, declineInPublic).
 *
 * Every call to the public graph, from here or from the gate, is a row in
 * outward_acts with who or what made it, what was sent, and what the
 * public graph answered.
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
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import type { PermissionName } from "../permissions.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { OutboundError, answerOf, call, publicGraph } from "./outbound-service.js";
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
  "The log of acts on the public graph is kept at `public`, where every member reads it, and is written once the route has checked the person or the gate has let a thing through.";
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
  | "publish_mandate"
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
  publish_mandate: "sent a mandate's name and terms, as the gate let them through, to stand on the organization's record on the public graph",
  send_report: "sent an agent's report, as the gate let it through, to Minerval's maintainers",
  send_failure_facts: "sent the facts of a tool failure to Minerval's maintainers",
};

/** Who made a call: a person, or the gate to outside sending what its setting let through with nobody sending it. */
export type Actor = { actor: GateActor } | { gate: true };

/** What the log says under "by" where no person acted. Rows written before the gate sent these name a standing choice. */
const BY_THE_GATE = "the gate";

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
        "gate" in row.by ? BY_THE_GATE : null,
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
    by: r.under_standing_choice === BY_THE_GATE ? "the gate to outside, under its setting" : r.under_standing_choice ? `the standing choice "${r.under_standing_choice}"` : r.by,
    holding: r.holding,
    on_the_public_graph: r.public_ref,
    sent: r.sent,
    result: r.result,
    ...(r.public_graph_said ? { the_public_graph_said: r.public_graph_said } : {}),
  }));
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
  const [node] = opts.nodeId ? await rawQuery<{ origin: string }>(`SELECT origin FROM claims WHERE id = $1`, [opts.nodeId]) : [];
  return {
    // With node_id: whether the node is the public graph's own, which is what can be funded there.
    ...(opts.nodeId ? { node_is_on_the_public_graph: node?.origin === "mirror", what_funding_it_there_shows: FUND_NODE_TOLD } : {}),
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
  "It goes through the gate to outside like anything else from a label, and where that gate is open for it, which is where a gate starts, " +
  "it is said at once. The statement is not taken back.";

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
  // One mechanism for every layer below (request-adoption-service.ts): the public graph is the bottom one.
  const { takeUpFromBelow } = await import("./request-adoption-service.js");
  const taken = await runAtLabel(label, `adopting public request ${pub.id}`, () =>
    takeUpFromBelow({ publicRequestId: pub.id }, { filer: { kind: "contributor", contributorId: input.actor.id }, contributorId: input.actor.id })
  );
  return taken!;
}

/**
 * Take up, at `label`, a request filed at a label that `label` reads: the
 * same act as adopting a public request, one layer up. It becomes an
 * ordinary request at `label`, linked to the one below, and nothing is
 * shown to the readers of the label below.
 */
export async function adoptRequestFromBelow(input: { requestId: string; label?: string | null; actor: GateActor }): Promise<{ adoption_id: string; request_id: string; already: boolean }> {
  const label = input.label ?? "";
  if (!label) throw new OutwardError("LABEL_NEEDED", "Say which label the work on this request is to be done at: one you read that reads the request's own. GET /labels/mine lists them.", 422);
  if (!input.actor.clearance.includes(label)) throw new OutwardError("LABEL_NOT_READ", "You do not read that label.", 403);
  const { takeUpFromBelow } = await import("./request-adoption-service.js");
  const { RequestError } = await import("./request-service.js");
  try {
    // At `label` the read is held to what `label` reads: a request it does not read is not found.
    const taken = await runAtLabel(label, `taking up request ${input.requestId} from the label below`, () =>
      takeUpFromBelow({ requestId: input.requestId }, { filer: { kind: "contributor", contributorId: input.actor.id }, contributorId: input.actor.id })
    );
    if (!taken) {
      throw new OutwardError("SAME_LABEL", "That request is already at this label, so there is nothing to take up: it is funded and worked there as it stands.", 409);
    }
    return taken;
  } catch (err) {
    if (err instanceof RequestError) throw new OutwardError("REQUEST_NOT_FOUND", "No request with that id is one that label reads.", 404);
    throw err;
  }
}

async function adoptionFor(adoptionId: string): Promise<{ id: string; request_id: string; public_request_id: string; taken_up_at: Date | null; declined_at: Date | null; label: string }> {
  // Read as the person: an adoption at a label they do not read does not exist for them.
  const [row] = await rawQuery<{ id: string; request_id: string; public_request_id: string; taken_up_at: Date | null; declined_at: Date | null; label: string }>(
    `SELECT id, request_id, public_request_id, taken_up_at, declined_at, sensitivity_label AS label FROM adopted_requests WHERE id = $1 AND public_request_id IS NOT NULL`,
    [adoptionId]
  );
  if (!row) throw new OutwardError("ADOPTION_NOT_FOUND", "No adopted request with that id is one you read.", 404);
  return row;
}

/**
 * Have it said on the public graph, in the organization's name, that this
 * graph is taking the request up. It is offered to the gate to outside as
 * what any take-up is, and goes under that gate's setting: at once where
 * the gate is open for it, which is where a gate starts. A request that was
 * addressed to a mandate this deployment published needs no one to do
 * this: its taking up is offered when it is taken up.
 */
export async function takeUpInPublic(input: { adoptionId: string; actor: GateActor }): Promise<Record<string, unknown>> {
  const adoption = await adoptionFor(input.adoptionId);
  if (adoption.taken_up_at) throw new OutwardError("ALREADY_TAKEN_UP", "This graph has already said in public that it is taking this request up.");
  const { offerTakenUpBelow } = await import("./gate-service.js");
  const offered = await runAtLabel(adoption.label, `offering that request ${adoption.request_id} was taken up to the gate to outside`, () =>
    offerTakenUpBelow(adoption.request_id, { saidByAPerson: true })
  );
  if (!offered) throw new OutwardError("NOTHING_TO_OFFER", "There is nothing to say outside about this request: this deployment has not said which party is the organization itself, or holds one label only.");
  return { offered_to_the_gate: true, public_request_id: adoption.public_request_id, ...offered, in_words: OFFERED_WORDS[offered.state] };
}

const OFFERED_WORDS: Record<string, string> = {
  released: "It is through the gate to outside. It is on the public graph once the public graph has taken it, which the log of acts on the public graph shows.",
  waiting: "It is at the gate to outside, which is set so that something stands between: the Redactor's run, Audit's check, a delay or a person. It is said on the public graph when it is through.",
  held: "It is held at the gate to outside.",
};

/**
 * Say that this graph will not do the work on a request it took up from
 * the public graph, with a reason from the fixed list. The request here is
 * closed as declined, which is this deployment's own record of it, and
 * that it will not be done goes to the gate to outside with the reason.
 */
export async function declineInPublic(input: { adoptionId: string; reason: string; note?: string | null; actor: GateActor }): Promise<Record<string, unknown>> {
  if (!(input.reason in DECLINE_REASONS)) throw new OutwardError("UNKNOWN_REASON", `A reason is one of: ${Object.keys(DECLINE_REASONS).join(", ")}.`, 422);
  const adoption = await adoptionFor(input.adoptionId);
  if (adoption.declined_at) throw new OutwardError("ALREADY_DECLINED", "This graph has already said in public that it will not do this work.");
  // On the public graph an account declines what it said it was taking up, or what was addressed to a mandate it
  // published. Anything else was asked of nobody here, and there is nothing to answer there.
  const answerable = await runAtLabel(adoption.label, `checking whether request ${adoption.request_id} can be declined in public`, async () => {
    const [offered] = await rawQuery(`SELECT 1 FROM showings WHERE kind = 'taken_up' AND subject_ref = $1 AND to_outside`, [adoption.request_id]);
    if (offered) return true;
    const { publishedMandateAskedBy } = await import("./gate-service.js");
    return (await publishedMandateAskedBy(adoption.public_request_id)) !== null;
  });
  if (!answerable) {
    throw new OutwardError("NOT_TAKEN_UP", "This graph has not said in public that it is taking this request up, and it was not addressed to a mandate this graph published, so there is nothing to decline there.");
  }
  const because = DECLINE_REASONS[input.reason as DeclineReason];
  const offered = await runAtLabel(adoption.label, `declining request ${adoption.request_id}, taken up from the public graph`, async () => {
    await rawQuery(`UPDATE adopted_requests SET decline_reason = $2 WHERE id = $1`, [adoption.id, input.reason]);
    const { setRequestState } = await import("./request-service.js");
    const [request] = await rawQuery<{ state: string }>(`SELECT state FROM requests WHERE id = $1`, [adoption.request_id]);
    if (request && !["met", "declined", "withdrawn", "moot"].includes(request.state)) {
      await setRequestState({ requestId: adoption.request_id, state: input.reason === "moot" ? "moot" : "declined", note: input.note?.trim() || `Declined: ${because}.` });
    }
    const { offerAnswerBelow } = await import("./gate-service.js");
    return offerAnswerBelow(adoption.request_id, { saidByAPerson: true });
  });
  if (!offered) throw new OutwardError("NOTHING_TO_OFFER", "There is nothing to say outside about this request: it was met here, or this deployment has not said which party is the organization itself.");
  return { offered_to_the_gate: true, because, ...offered, in_words: OFFERED_WORDS[offered.state] };
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
        title: g.name ?? g.title ?? g.mandate?.title ?? null,
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

/** Ask one of the organization's public mandates for a fresh public assessment of a mirrored node: a person's own act, naming the node. */
export async function raisePublicNode(input: { nodeId: string; mandateId: string; actor: GateActor }): Promise<Record<string, unknown>> {
  const id = await publicNode(input.nodeId);
  const answer = await act({
    kind: "raise_public_node",
    by: { actor: input.actor },
    method: "POST",
    path: `/mandates/${input.mandateId}/raise`,
    body: { node_id: id },
    publicRef: id,
  });
  return { asked: true, node_id: id, the_public_graph_said: String(answer.in_words ?? "") };
}
