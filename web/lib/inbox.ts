import "server-only";
import type { MyPermissions } from "./account-api";
import { fetchConnections, fetchParties, fetchSetupChecklist, type SetupChecklist } from "./admin-api";
import { attentionItems } from "./health";
import { fetchGateQueue, fetchOutbound, fetchShowings, type QueueItem } from "./inside-api";
import { fetchPublicRequests, fetchSaidBack } from "./outside-api";
import type { WorkCounts } from "./work-counts";

// What waits on a member of a private deployment, from every part of it: the
// inbox page (app/inbox) lists it, and the sidebar counts it
// (app/api/work/counts). Every read is the API's, made as the person, and
// each is asked only of a person whose permissions can act on what it
// answers. A read that fails leaves its part out; it never stops the rest.

export type InboxGroup = "decisions" | "setup" | "sharing" | "public";
export type Tone = "info" | "warn" | "bad" | "plain";

export interface InboxItem {
  key: string;
  group: InboxGroup;
  icon: "review" | "warn" | "money" | "globe" | "replies" | "outbox" | "file";
  tone: Tone;
  title: string;
  /** Node text, shown in the serif beside the title's facts. */
  node?: string | null;
  /** A boundary: the label written at, and the label or "outside" it goes to. */
  boundary?: { from: string; to: string };
  party?: string;
  facts: string[];
  pill?: { text: string; tone: "ok" | "warn" | "bad" | "info" | "neu" };
  /** Since when it has waited (ISO), for the age column. */
  since?: string | null;
  action: { href: string; label: string };
}

export interface Inbox {
  items: InboxItem[];
  checklist: SetupChecklist | null;
  deployment: string | null;
  /** Open requests on the public graph that nobody here has adopted. */
  openPublicRequests: number;
}

const has = (mine: MyPermissions, ...ps: string[]) => ps.some((p) => mine.permissions.includes(p));
const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const oldest = (dates: Array<string | null | undefined>) =>
  dates.filter((d): d is string => !!d).sort()[0] ?? null;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

export async function loadInbox(who: string, mine: MyPermissions): Promise<Inbox> {
  const releases = has(mine, "release");
  const directs = has(mine, "direct");
  const administers = has(mine, "administer");
  const outward = has(mine, "direct", "release");

  const [queue, checklist, showings, requests, saidBack, outbound, parties] = await Promise.all([
    releases ? safe(fetchGateQueue(who)) : null,
    administers ? safe(fetchSetupChecklist(who)) : null,
    directs ? safe(fetchShowings(who)) : null,
    outward ? safe(fetchPublicRequests(who)) : null,
    outward ? safe(fetchSaidBack(who)) : null,
    directs ? safe(fetchOutbound(who)) : null,
    safe(fetchParties(who)),
  ]);

  const items: InboxItem[] = [];
  let openPublicRequests = 0;

  // What waits at a gate on the person's decision, one line for each party they release for.
  if (queue) {
    const byParty = new Map<string, { name: string; items: QueueItem[] }>();
    for (const item of queue.items) {
      const party = item.decide_for[0];
      if (!party) continue;
      const entry = byParty.get(party.id) ?? { name: party.name, items: [] };
      entry.items.push(item);
      byParty.set(party.id, entry);
    }
    for (const [id, { name, items: waiting }] of byParty) {
      const pages = new Set(waiting.map((i) => i.page_id ?? i.item_id));
      const reports = waiting.filter((i) => i.kind_of_thing === "report").length;
      items.push({
        key: `gate-${id}`,
        group: "decisions",
        icon: "review",
        tone: "info",
        title: `${plural(pages.size, "item")} wait for your release`,
        party: name,
        facts: [
          plural(waiting.length, "part"),
          ...(reports > 0 ? [`${plural(reports, "agent's report", "agents' reports")}`] : []),
        ],
        since: oldest(waiting.map((i) => i.waiting_since)),
        action: { href: `/gate?party=${encodeURIComponent(id)}`, label: "Review" },
      });
    }
  }

  // What the deployment needs from an administrator, each in a short line (lib/health.ts).
  if (checklist) {
    for (const a of attentionItems(checklist)) {
      items.push({
        key: `setup-${a.key}`,
        group: "setup",
        icon: "warn",
        tone: a.tone,
        title: a.title,
        facts: [a.consequence],
        pill: a.owner === "operator" ? { text: "Operator", tone: "neu" } : undefined,
        action: { href: a.href, label: a.action },
      });
    }
  }

  // Pages whose redaction or check waits for money.
  if (showings) {
    for (const row of showings.asked) {
      if (row.ended_at) continue;
      const unpaid = row.pages.filter(
        (p) => (p.stage === "to_redact" || p.stage === "to_check") && /fund/i.test(p.stage_in_words),
      );
      if (unpaid.length === 0) continue;
      items.push({
        key: `unpaid-${row.showing_id}`,
        group: "sharing",
        icon: "money",
        tone: "plain",
        title: unpaid.some((p) => p.stage === "to_check") ? "Check of a redaction unpaid" : "Redaction unpaid",
        node: row.node,
        boundary: { from: row.page_label, to: row.shown_to },
        facts: [],
        action: { href: `/showings/${row.showing_id}`, label: "Pay" },
      });
    }
  }

  if (requests) {
    const open = requests.requests.filter(
      (r) => r.here.length === 0 && ["open", "addressed", "in_progress"].includes(r.state_on_the_public_graph),
    );
    openPublicRequests = open.length;
    const bearing = open.filter((r) => r.bears_on.length > 0);
    if (bearing.length > 0) {
      items.push({
        key: "public-requests",
        group: "public",
        icon: "globe",
        tone: "plain",
        title:
          bearing.length === 1
            ? `Public request: ${bearing[0].ask}`
            : `${plural(bearing.length, "public request")} bear on nodes here`,
        facts: bearing.length === 1 ? [`bears on ${plural(bearing[0].bears_on.length, "node")} here`] : [],
        pill: { text: "open", tone: "neu" },
        since: oldest(bearing.map((r) => r.filed_at)),
        action: { href: "/admin/outside/requests", label: directs ? "Adopt" : "View" },
      });
    }
  }

  if (saidBack) {
    for (const c of saidBack.contributions) {
      if (c.repeats || c.reassessment !== "not paid for") continue;
      items.push({
        key: `reply-${c.id}`,
        group: "public",
        icon: "replies",
        tone: "plain",
        title: `${c.type.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())} from a reader`,
        node: c.node,
        facts: [],
        pill: { text: "reassessment unpaid", tone: "warn" },
        since: c.received_at,
        action: { href: "/admin/outside/said-back", label: "Fund" },
      });
    }
  }

  if (outbound) {
    const byShowing = new Map<string, { node: string | null; waiting: number }>();
    for (const n of outbound.nodes) {
      const waiting = n.packages.filter((p) => p.sends.length === 0).length;
      if (n.sent !== "by_a_person_each_time" || waiting === 0) continue;
      const entry = byShowing.get(n.showing_id) ?? { node: n.node, waiting: 0 };
      entry.waiting += waiting;
      byShowing.set(n.showing_id, entry);
    }
    for (const [id, { node, waiting }] of byShowing) {
      items.push({
        key: `outbox-${id}`,
        group: "public",
        icon: "outbox",
        tone: "plain",
        title: `${plural(waiting, "package")} ready to send outside`,
        node,
        facts: [],
        action: { href: `/outbound#showing-${id}`, label: "Send" },
      });
    }
  }

  const own = parties?.find((p) => p.is_own_organization);
  return {
    items,
    checklist,
    deployment: own && own.name !== "This organization" ? own.name : null,
    openPublicRequests,
  };
}

/** The counts beside the sidebar's entries. */
export async function loadWorkCounts(who: string, mine: MyPermissions): Promise<WorkCounts> {
  const inbox = await loadInbox(who, mine);
  const administers = has(mine, "administer");
  const checklist = inbox.checklist;
  const connections = administers ? await safe(fetchConnections(who)) : null;
  const review = inbox.items
    .filter((i) => i.group === "decisions")
    .reduce((n, i) => n + Number(/^(\d+)/.exec(i.title)?.[1] ?? 0), 0);
  const health: WorkCounts["health"] = !checklist
    ? null
    : checklist.preflight?.agent_work === "refused"
      ? "bad"
      : attentionItems(checklist).length > 0
        ? "warn"
        : "ok";
  const failing = connections?.connections.some((c) => c.enabled && c.state.status === "failing");
  const withdrawn = connections?.connections.some((c) => c.tools.some((t) => t.withdrawn && t.offered === false && t.listed));
  return {
    deployment: inbox.deployment,
    inbox: inbox.items.length,
    review,
    public_requests: inbox.openPublicRequests,
    replies: inbox.items.filter((i) => i.key.startsWith("reply-")).length,
    health,
    connections: connections ? (failing ? "bad" : withdrawn ? "warn" : "ok") : null,
  };
}
