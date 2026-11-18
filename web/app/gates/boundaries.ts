import {
  fetchGateBacklog,
  fetchGates,
  fetchPolicies,
  type BacklogLine,
  type Gate,
  type GateBacklog,
  type Gates,
  type PolicySummary,
} from "@/lib/inside-api";
import { fetchMandatesPage, type MandateListRow } from "@/lib/account-api";
import type { Tone } from "@/components/work/ui";

// A boundary is a label and where its material goes, another label or
// outside: one gate (GET /gates, GET /gate/backlog) and one redaction policy
// (GET /redaction-policies), which share an id (a policy's boundary_id is its
// gate's gate_id). A person may see a boundary's settings, only its backlog,
// or only its policy; each is a boundary all the same, with what is unknown
// left out.

export interface BoundaryRow {
  id: string;
  /** The label things are written at; null when the person does not read it. */
  from: string | null;
  /** The destination label, or "outside". */
  to: string;
  outside: boolean;
  gate: Gate | null;
  backlog: GateBacklog["gates"][number] | null;
  /** The in-force version, from the side that names the label where the person reads it. */
  policy: PolicySummary | null;
}

const OUTSIDE = "outside this deployment";

export async function loadBoundaries(externalId: string): Promise<{
  rows: BoundaryRow[];
  gates: Gates | null;
  backlog: GateBacklog | null;
}> {
  const [gates, backlog, policies] = await Promise.all([
    fetchGates(externalId).catch(() => null),
    fetchGateBacklog(externalId).catch(() => null),
    fetchPolicies(externalId).catch(() => [] as PolicySummary[]),
  ]);
  const byId = new Map<string, BoundaryRow>();
  const row = (id: string): BoundaryRow => {
    let r = byId.get(id);
    if (!r) {
      r = {
        id,
        from: null,
        to: "",
        outside: false,
        gate: null,
        backlog: null,
        policy: null,
      };
      byId.set(id, r);
    }
    return r;
  };
  for (const g of gates?.gates ?? []) {
    const r = row(g.gate_id);
    r.gate = g;
    // A gate whose label the person does not read is named by words, not by its label.
    const namedBy = (g as Gate & { from_named_by?: string }).from_named_by;
    r.from = namedBy === undefined || namedBy === "its label" ? g.from : null;
    r.outside = g.to_outside;
    r.to = g.to_outside ? "outside" : g.to;
  }
  for (const b of backlog?.gates ?? []) {
    const r = row(b.gate_id);
    r.backlog = b;
    if (!r.from && b.from) r.from = b.from;
    if (!r.to) {
      r.outside = b.to === OUTSIDE || b.to === "outside";
      r.to = r.outside ? "outside" : b.to;
    }
  }
  for (const p of policies) {
    const r = row(p.boundary_id);
    // One row a boundary, from the side that names the label where the person reads it.
    if (!r.policy || (!r.policy.from_label && p.from_label)) r.policy = p;
    if (!r.from && p.from_label) r.from = p.from_label;
    if (!r.to) {
      r.outside = p.released_to === OUTSIDE;
      r.to = r.outside ? "outside" : p.released_to;
    }
  }
  const rows = [...byId.values()].sort(
    (a, b) => Number(a.outside) - Number(b.outside) || (a.from ?? "~").localeCompare(b.from ?? "~") || a.to.localeCompare(b.to)
  );
  return { rows, gates, backlog };
}

// ---- words ---------------------------------------------------------------

/** A kind of thing at a gate, short; the API's own words go in the title. */
export const KIND_SHORT: Record<string, string> = {
  page: "A node's page",
  answer: "An answer to a request",
  taken_up: "That a request was taken up",
  funding: "Funding",
  mandate: "A mandate",
  message: "An answer to a message",
  petition: "A run's petition",
  statement: "A statement of spend",
  report: "An agent's report",
  proposal: "A proposed wording",
};

export function kindName(kind: string, kinds?: Record<string, string>): string {
  if (kind === "*") return "Everything";
  const words = KIND_SHORT[kind] ?? kinds?.[kind] ?? kind;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The three modes of a gate (src/services/gate-kinds.ts GATE_MODES), as a pill says them. */
export const MODES: Record<string, { label: string; tone: Tone; line: string }> = {
  open: {
    label: "Open",
    tone: "neu",
    line: "Goes as written; nothing is removed",
  },
  redactor: {
    label: "Redactor",
    tone: "info",
    line: "Redacted and audited, then goes",
  },
  person: {
    label: "Person decides",
    tone: "warn",
    line: "Redactor proposes, release holders decide",
  },
};

export const SCOPE_SHORT: Record<string, string> = {
  boundary: "Whole boundary",
  mandate: "Mandate",
  under: "Node and under",
  request: "Request",
};

/** What a backlog line waits on (HOLDERS), in the four groups a row shows. */
const WAITING_GROUPS: Array<{
  key: string;
  label: string;
  tone: Tone;
  holders: string[];
}> = [
  { key: "funds", label: "funds", tone: "warn", holders: ["funds"] },
  {
    key: "redactor",
    label: "Redactor",
    tone: "neu",
    holders: ["redactor_run", "redactor"],
  },
  { key: "audit", label: "audit", tone: "neu", holders: ["check"] },
  {
    key: "people",
    label: "people",
    tone: "info",
    holders: ["person", "waiting_on_person"],
  },
  { key: "delayed", label: "delayed", tone: "neu", holders: ["delayed"] },
];

export function waitingGroups(lines: BacklogLine[]): Array<{ key: string; label: string; tone: Tone; items: number }> {
  return WAITING_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    tone: g.tone,
    items: lines.filter((l) => g.holders.includes(l.waiting_on)).reduce((n, l) => n + l.items, 0),
  })).filter((g) => g.items > 0);
}

export function waitingOn(lines: BacklogLine[], group: string): number {
  const g = WAITING_GROUPS.find((w) => w.key === group);
  return g ? lines.filter((l) => g.holders.includes(l.waiting_on)).reduce((n, l) => n + l.items, 0) : 0;
}

export function oldestHours(lines: BacklogLine[]): number | null {
  return lines.length === 0 ? null : Math.max(...lines.map((l) => l.oldest_waiting_hours));
}

/** Hours waited, short: "6h", "2d". */
export function hoursShort(hours: number | null): string {
  if (hours === null) return "—";
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A policy's fingerprint, short enough to tell versions apart. */
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 4)} ${hash.slice(4, 8)} …${hash.slice(-4)}` : hash;
}

/** The mandates the person reads, for naming them and for choosing one. Empty when the read fails. */
export async function readableMandates(externalId: string): Promise<MandateListRow[]> {
  try {
    return (await fetchMandatesPage({ state: "any", order: "recent", limit: 100 }, externalId)).mandates;
  } catch {
    return [];
  }
}
