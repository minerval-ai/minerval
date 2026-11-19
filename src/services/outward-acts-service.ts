/**
 * A private graph acting on the public graph, other than by releasing a page
 * (docs/outward-acts.md).
 *
 * A deployment acts on the public graph as an ordinary account and only as
 * one. Everything here is a call to a route any account could call, made
 * as the organization over this deployment's connection, signed with its
 * own key (outbound-service.ts has the client):
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
 * anything in this file: that leaves through the release of a page.
 *
 * Nothing here reads the live public graph to learn about a node or a
 * request: those reads are of the mirror. The only reads of the public
 * graph are of the organization's own account, its own mandates, its own
 * conversations with the public Grantmaker and its own record as a publisher.
 */
import { loadConfig } from "../config.js";
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import type { PermissionName } from "../permissions.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { OutboundError, answerOf, call, publicGraph, signedRegistration, signingKeyId, type PublicGraph } from "./outbound-service.js";
import { keyIdOf } from "./mirror-batch.js";
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
  | "send_failure_facts"
  | "register_publisher"
  | "connect_deployment"
  | "disconnect_deployment"
  | "replace_connection_key";

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
  register_publisher: "registered this deployment's signing key to the organization's account on the public graph",
  connect_deployment: "asked minerval.ai to connect this deployment to an organization, with a new connection key",
  disconnect_deployment: "disconnected this deployment from minerval.ai, retiring its connection key there",
  replace_connection_key: "replaced this deployment's connection key on minerval.ai; the old key stopped working there",
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
  /** Where the public graph's id for what was acted on is known only from its answer (a conversation it opened): read from the answer when it took the act. */
  refFrom?: (answer: Record<string, any>) => string | null;
  ok?: number[];
}): Promise<Record<string, any>> {
  let graph;
  try {
    graph = await publicGraph();
  } catch (err) {
    if (err instanceof OutboundError) throw new OutwardError("NO_ROUTE_OUT", NO_ACCOUNT_WORDS);
    throw err;
  }
  // The person's name, where this deployment's administrators chose to send it (services/named-person.ts).
  const headers: Record<string, string> = {};
  if ("actor" in input.by) {
    const { sendsPersonName } = await import("./named-person.js");
    if (await sendsPersonName()) {
      const [person] = await rawQuery<{ display_name: string }>(`SELECT display_name FROM contributors WHERE id = $1`, [input.by.actor.id]);
      // Percent-encoded: a header carries Latin-1 only, and a name may be in any script.
      if (person?.display_name) headers["x-acting-person-name"] = encodeURIComponent(person.display_name.slice(0, 120));
    }
  }
  let res: { status: number; json: Record<string, any> };
  try {
    res = await call(graph, input.method, input.path, input.body, Object.keys(headers).length ? headers : undefined);
  } catch (err) {
    const said = err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached.";
    await logOutwardAct({ kind: input.kind, by: input.by, publicRef: input.publicRef, sent: input.body, result: "failed", said });
    throw new OutwardError("PUBLIC_GRAPH_UNREACHABLE", `The public graph could not be reached, so nothing was sent: ${said}`, 502);
  }
  const fine = (input.ok ?? [200, 201, 202]).includes(res.status);
  const said = fine ? String(res.json.in_words ?? res.json.note ?? "") : `${res.status}: ${answerOf(res.json)}`;
  const publicRef = fine && input.refFrom ? (input.refFrom(res.json) ?? input.publicRef) : input.publicRef;
  await logOutwardAct({ kind: input.kind, by: input.by, publicRef, sent: input.body, result: fine ? "done" : "refused", said });
  if (!fine) {
    throw new OutwardError("PUBLIC_GRAPH_REFUSED", `The public graph did not take this, and said: ${answerOf(res.json) || `status ${res.status}`}`, res.status === 402 ? 402 : 409);
  }
  return res.json;
}

export const NO_ACCOUNT_WORDS =
  "This deployment is not connected to minerval.ai, so it cannot act there. An administrator connects it on the public graph's " +
  "Overview: it shows a code that an admin of the organization approves on minerval.ai.";

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
    const [offered] = await rawQuery(`SELECT 1 FROM releases WHERE kind = 'taken_up' AND subject_ref = $1 AND to_outside`, [adoption.request_id]);
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

/** The organization's account on the public graph: its balance of public owls, its public mandates, and its registration as a publisher. Reads its own account only. */
export async function publicAccount(): Promise<Record<string, unknown>> {
  const who = `Holders of ${publicActsPermission()} may act on the public graph in the organization's name.`;
  const key = signingKeyId();
  let graph;
  try {
    graph = await publicGraph();
  } catch {
    return { connected: false, in_words: NO_ACCOUNT_WORDS, who_may_act: who, signing_key_fingerprint: key, ...(await registrationOf(null, null, key)) };
  }
  try {
    const me = await call(graph, "GET", "/users/me");
    if (me.status !== 200) {
      return {
        connected: false,
        in_words: `The public graph did not accept this deployment (${me.status}). An admin of the organization on minerval.ai can see on its Deployments tab whether this deployment's grants were withdrawn or it was retired.`,
        who_may_act: who,
        signing_key_fingerprint: key,
        ...(await registrationOf(null, null, key)),
      };
    }
    const accountId = typeof me.json.user?.id === "string" ? (me.json.user.id as string) : null;
    const [grants, conversations, registration] = await Promise.all([
      call(graph, "GET", "/grants"),
      call(graph, "GET", "/grant-conversations?limit=100").catch(() => null),
      registrationOf(graph, accountId ? { id: accountId, name: me.json.user?.display_name ?? null } : null, key),
    ]);
    const list = (Array.isArray(grants.json.grants) ? grants.json.grants : []) as Array<Record<string, any>>;
    // Which conversation with the public Grantmaker each mandate was funded from, where the account's own list says.
    const conversationOf = new Map<string, string>();
    for (const c of conversations?.status === 200 && Array.isArray(conversations.json.conversations) ? (conversations.json.conversations as Array<Record<string, any>>) : []) {
      if (typeof c.grant_id === "string" && typeof c.id === "string") conversationOf.set(c.grant_id, c.id);
    }
    return {
      connected: true,
      account: { id: accountId, name: me.json.user?.display_name ?? null },
      public_owls: Number(me.json.entitlement?.owl_balance ?? 0),
      public_owls_statement:
        "Public owls are the organization's balance on the public graph, bought there. They pay for public work only, and owls created in this deployment never convert to them.",
      public_mandates: list.map((g) => ({
        id: g.id,
        title: g.name ?? g.title ?? g.mandate?.title ?? null,
        status: g.status ?? null,
        budget_owls: g.budget_owls ?? g.budget?.owls ?? null,
        spent_owls: g.spent_owls ?? g.spend?.owls ?? null,
        conversation_id: conversationOf.get(g.id) ?? null,
        public: true,
      })),
      who_may_act: who,
      what_a_public_mandate_shows: PUBLIC_MANDATE_TOLD,
      signing_key_fingerprint: key,
      ...registration,
    };
  } catch (err) {
    return {
      connected: false,
      in_words: `The public graph could not be reached: ${err instanceof Error ? err.message.slice(0, 300) : "no answer"}`,
      who_may_act: who,
      signing_key_fingerprint: key,
      ...(await registrationOf(null, null, key)),
    };
  }
}

/** Where the deployment's signing key stands on the public graph, as GET /outside/account carries it. */
export interface PublisherRegistration {
  registered_at: string;
  /** The registered key's short name: the sha256 of its public half, as the public graph names it. */
  key_fingerprint: string;
  /** The account the key is registered to: its id on the public graph and its name there, where known. */
  account: { id: string | null; name: string | null };
  declared_interest: string | null;
  /** Whether the key registered is the one this deployment signs with now; null where it has no signing key. */
  is_the_current_key: boolean | null;
  /** Read from the public graph's record of the account, or, where that cannot be read, from this deployment's log of acts. */
  read_from: "the public graph" | "this deployment's log";
  /** The registration of this key made from here, by whom and when, where the log has one. */
  registered_from_here: { at: string; by: string | null } | null;
}

const REGISTRATION_WORDS = {
  current:
    "The deployment's signing key is registered to the organization's account on the public graph, so the public graph takes pages signed with it from that account.",
  other:
    "A key is registered to the organization's account on the public graph, but not the one this deployment signs with now, so the public graph will not take a page it signs. An administrator registers the current key.",
  none:
    "No key of this deployment's is registered on the public graph, so the public graph will not take a page it signs. An administrator registers it (POST /outbound/registration/send).",
  unknown: "This deployment has no signing key (PUBLISH_SIGNING_KEY), so it signs nothing.",
} as const;

/**
 * The deployment's registration as a publisher on the public graph. Where
 * the account can be read there, from the public graph's own record of it
 * (`GET /publishers/:account_id`, a read of the organization's own account):
 * the live registration of the current key, or else the newest live one.
 * Where it cannot, from this deployment's log: the newest registration made
 * from here that the public graph took. A key registered by a file sent
 * from elsewhere is then not known.
 */
async function registrationOf(graph: PublicGraph | null, account: { id: string; name: string | null } | null, currentKey: string | null): Promise<{ registration: PublisherRegistration | null; registration_in_words: string }> {
  const logged = await rawQuery<{ at: Date; by: string | null; public_key: string | null; declared_interest: string | null; account_id: string | null }>(
    `SELECT a.at, c.display_name AS by, a.sent->>'public_key' AS public_key, a.sent->>'declared_interest' AS declared_interest, a.public_ref AS account_id
       FROM outward_acts a LEFT JOIN contributors c ON c.id = a.acted_by
      WHERE a.kind = 'register_publisher' AND a.result = 'done' ORDER BY a.at DESC`
  );
  const fromHere = logged.map((r) => ({ ...r, key_id: r.public_key ? keyIdOf(r.public_key) : null }));
  const hereFor = (keyId: string) => {
    const r = fromHere.find((x) => x.key_id === keyId);
    return r ? { at: r.at.toISOString(), by: r.by } : null;
  };
  const said = (r: PublisherRegistration | null) =>
    !currentKey ? REGISTRATION_WORDS.unknown : !r ? REGISTRATION_WORDS.none : r.is_the_current_key ? REGISTRATION_WORDS.current : REGISTRATION_WORDS.other;

  if (graph && account) {
    const res = await call(graph, "GET", `/publishers/${account.id}`).catch(() => null);
    if (res?.status === 404) return { registration: null, registration_in_words: said(null) };
    if (res?.status === 200) {
      const live = ((Array.isArray(res.json.registrations) ? res.json.registrations : []) as Array<Record<string, any>>).filter((r) => !r.retired_at);
      const chosen = live.find((r) => r.key_id === currentKey) ?? live[0];
      if (!chosen) return { registration: null, registration_in_words: said(null) };
      const registration: PublisherRegistration = {
        registered_at: String(chosen.registered_at),
        key_fingerprint: String(chosen.key_id),
        account: { id: account.id, name: res.json.name ?? account.name },
        declared_interest: chosen.declared_interest ?? null,
        is_the_current_key: currentKey ? chosen.key_id === currentKey : null,
        read_from: "the public graph",
        registered_from_here: hereFor(String(chosen.key_id)),
      };
      return { registration, registration_in_words: said(registration) };
    }
  }
  const newest = fromHere.find((r) => r.key_id === currentKey) ?? fromHere[0];
  if (!newest?.key_id) return { registration: null, registration_in_words: said(null) };
  const registration: PublisherRegistration = {
    registered_at: newest.at.toISOString(),
    key_fingerprint: newest.key_id,
    account: { id: newest.account_id, name: null },
    declared_interest: newest.declared_interest,
    is_the_current_key: currentKey ? newest.key_id === currentKey : null,
    read_from: "this deployment's log",
    registered_from_here: { at: newest.at.toISOString(), by: newest.by },
  };
  return {
    registration,
    registration_in_words: `${said(registration)} This is read from this deployment's log of acts, because the public graph's record of the account could not be read.`,
  };
}

// ---- the organization's conversations with the public Grantmaker ----------------------------------

/**
 * The organization's conversations with the public Grantmaker, newest first:
 * those opened from here, as this deployment's log of acts records them
 * (who opened each and when, how many messages were written to it from
 * here, whether it was funded from here), with what the public graph says
 * of each now (its draft's title, its state, and the public mandate it was
 * funded as), read from the account's own list there. A conversation the
 * account holds there that was not opened from here is listed too, and
 * says so. Where the public graph cannot be read, the log alone answers.
 */
export async function publicConversations(): Promise<Record<string, unknown>> {
  const rows = await rawQuery<{ kind: OutwardActKind; ref: string; at: Date; by: string | null }>(
    `SELECT a.kind, a.public_ref AS ref, a.at, c.display_name AS by
       FROM outward_acts a LEFT JOIN contributors c ON c.id = a.acted_by
      WHERE a.kind IN ('open_public_mandate', 'public_mandate_message', 'fund_public_mandate') AND a.result = 'done' AND a.public_ref IS NOT NULL
      ORDER BY a.at`
  );
  interface Here { opened: { at: Date; by: string | null } | null; messages: number; funded: { at: Date; by: string | null } | null; first: Date }
  const here = new Map<string, Here>();
  for (const r of rows) {
    const h = here.get(r.ref) ?? { opened: null, messages: 0, funded: null, first: r.at };
    if (r.kind === "open_public_mandate") h.opened ??= { at: r.at, by: r.by };
    if (r.kind === "public_mandate_message") h.messages += 1;
    if (r.kind === "fund_public_mandate") h.funded ??= { at: r.at, by: r.by };
    here.set(r.ref, h);
  }

  let live: Map<string, Record<string, any>> | null = null;
  let unread: string | null = null;
  try {
    const res = await call(await publicGraph(), "GET", "/grant-conversations?limit=100");
    if (res.status === 200 && Array.isArray(res.json.conversations)) {
      live = new Map((res.json.conversations as Array<Record<string, any>>).filter((c) => typeof c.id === "string").map((c) => [c.id as string, c]));
    } else {
      unread = `The public graph said: ${answerOf(res.json) || res.status}`;
    }
  } catch (err) {
    unread = err instanceof OutboundError ? NO_ACCOUNT_WORDS : `The public graph could not be reached: ${err instanceof Error ? err.message.slice(0, 300) : "no answer"}`;
  }

  const ids = new Set<string>([...here.keys(), ...(live?.keys() ?? [])]);
  const conversations = [...ids].map((id) => {
    const h = here.get(id) ?? null;
    const l = live?.get(id) ?? null;
    const openedAt = h?.opened?.at.toISOString() ?? (typeof l?.created_at === "string" ? l.created_at : (h?.first.toISOString() ?? null));
    const grantId = typeof l?.grant_id === "string" ? l.grant_id : null;
    return {
      id,
      opened_at: openedAt,
      opened_by: h?.opened?.by ?? null,
      opened_from_here: !!h?.opened,
      title: typeof l?.title === "string" ? l.title : null,
      status_on_the_public_graph: typeof l?.status === "string" ? l.status : null,
      funded: l ? l.status === "funded" || grantId !== null : !!h?.funded,
      public_mandate_id: grantId,
      ...(h?.funded ? { funded_from_here: { at: h.funded.at.toISOString(), by: h.funded.by } } : {}),
      messages_from_here: h?.messages ?? 0,
    };
  });
  conversations.sort((a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""));
  return {
    conversations,
    read_from_the_public_graph: live !== null,
    in_words:
      live !== null
        ? "The organization's conversations with the public Grantmaker. Who opened each, and what was written and funded from here, is this deployment's log of acts; each one's title, state and the public mandate it was funded as are what the public graph says of it now."
        : `Only this deployment's log of acts answers: who opened each conversation and what was written and funded from here. ${unread ?? ""}`.trim(),
  };
}

const conversationIdOf = (answer: Record<string, any>): string | null => {
  const id = answer.conversation?.id ?? answer.id ?? null;
  return typeof id === "string" && id ? id : null;
};

/** Open a conversation with the public Grantmaker about a new public mandate, in the person's own words. */
export async function openPublicMandate(input: { message: string; actor: GateActor }): Promise<Record<string, unknown>> {
  const message = input.message.trim();
  if (!message) throw new OutwardError("NO_WORDS", "Write what the public mandate is for. These words are sent as you write them.", 422);
  const answer = await act({
    kind: "open_public_mandate",
    by: { actor: input.actor },
    method: "POST",
    path: "/grant-conversations",
    body: { message },
    // The conversation's id is the public graph's to give: the log keeps it, so that the conversations opened from here can be listed.
    refFrom: conversationIdOf,
  });
  const id = conversationIdOf(answer);
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
    graph = await publicGraph();
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
      "This node exists only in this deployment, so the public graph has nothing to assess. A node reaches the public graph by being proposed there when its page is released outside."
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

/**
 * Register this deployment's signing key to the organization's account on the
 * public graph, in one act: the account is read from the public graph
 * (`GET /users/me`, the identity the registration names), the statement is
 * signed with the key (outbound-service.ts, signedRegistration), and the
 * account sends it to `POST /publishers`. It decides who speaks for the
 * deployment outside, so it is an administrator's act from a signed-in
 * session, and it is on the log of acts like every other.
 */
export async function registerPublisherOutside(input: { declaredInterest?: string | null; actor: GateActor }): Promise<Record<string, unknown>> {
  let graph;
  try {
    graph = await publicGraph();
  } catch (err) {
    if (err instanceof OutboundError) throw new OutwardError("NO_ROUTE_OUT", NO_ACCOUNT_WORDS);
    throw err;
  }
  let me: { status: number; json: Record<string, any> };
  try {
    me = await call(graph, "GET", "/users/me");
  } catch (err) {
    throw new OutwardError("PUBLIC_GRAPH_UNREACHABLE", `The public graph could not be reached, so nothing was sent: ${err instanceof Error ? err.message.slice(0, 300) : "no answer"}`, 502);
  }
  const account = me.status === 200 ? String(me.json.user?.external_id ?? "") : "";
  if (!account) {
    throw new OutwardError("PUBLIC_GRAPH_REFUSED", `The public graph did not accept this deployment (${me.status}). An admin of the organization on minerval.ai can see on its Deployments tab whether this deployment's grants were withdrawn or it was retired.`, 409);
  }
  let statement;
  try {
    // Over the connection, the statement names this deployment, as the public graph checks.
    const { liveConnection } = await import("./public-graph-client.js");
    statement = await signedRegistration(account, (await liveConnection())?.deploymentId ?? null);
  } catch (err) {
    if (err instanceof OutboundError) throw new OutwardError(err.code, err.message, 409);
    throw err;
  }
  const interest = input.declaredInterest?.trim();
  const answer = await act({
    kind: "register_publisher",
    by: { actor: input.actor },
    method: "POST",
    path: "/publishers",
    // The account the key is registered to, by its id there: what the registration acted on.
    publicRef: typeof me.json.user?.id === "string" ? me.json.user.id : null,
    body: {
      public_key: statement.public_key,
      hosting: statement.hosting,
      signature: statement.signature,
      ...(interest ? { declared_interest: interest } : {}),
    },
  });
  return {
    account: { external_id: account, name: me.json.user?.display_name ?? null },
    publisher_id: answer.publisher_id ?? null,
    key_id: answer.key_id ?? null,
    hosting: answer.hosting ?? statement.hosting,
    in_words: answer.in_words ?? null,
  };
}
