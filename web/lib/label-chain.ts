// What a label reads, followed to the end, and who reads at a label through
// that chain. The database follows `label_reads` the same way (src/db/
// clearance.ts: "every label it reads, followed to the end"), so a holder
// of board, where board reads finance and finance reads staff, reads staff.
// The labels page says so: its counts include those readers, its "also
// reads" shows the whole chain, and adding a pair says first who it widens
// reading for (app/admin/labels).

export interface ChainLabel {
  name: string;
  /** The labels it reads directly (its `label_reads` pairs). */
  reads: string[];
}

export interface ChainGrant {
  label: string | null;
  account: { id: string; display_name: string | null } | null;
  group: string | null;
}

/** Every label each label reads, directly or through another, never itself or public. */
export function readsThrough(labels: readonly ChainLabel[], extra?: { label: string; reads: string }): Map<string, Set<string>> {
  const direct = new Map<string, string[]>(labels.map((l) => [l.name, [...l.reads]]));
  if (extra) direct.set(extra.label, [...(direct.get(extra.label) ?? []), extra.reads]);
  const out = new Map<string, Set<string>>();
  for (const l of direct.keys()) {
    const seen = new Set<string>();
    const stack = [...(direct.get(l) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === l || next === "public" || seen.has(next)) continue;
      seen.add(next);
      stack.push(...(direct.get(next) ?? []));
    }
    out.set(l, seen);
  }
  return out;
}

/** The labels a label reads only through another, each with the first label on the way. */
export function readsIndirectly(label: string, labels: readonly ChainLabel[]): Array<{ label: string; via: string }> {
  const own = labels.find((l) => l.name === label);
  if (!own) return [];
  const through = readsThrough(labels);
  const out: Array<{ label: string; via: string }> = [];
  for (const d of own.reads) {
    for (const t of through.get(d) ?? []) {
      if (t !== label && !own.reads.includes(t) && !out.some((o) => o.label === t)) out.push({ label: t, via: d });
    }
  }
  return out;
}

export interface Holders {
  accounts: Map<string, string>;
  groups: Set<string>;
}

const holdersOf = (grants: readonly ChainGrant[], label: string): Holders => {
  const accounts = new Map<string, string>();
  const groups = new Set<string>();
  for (const g of grants) {
    if (g.label !== label) continue;
    if (g.account) accounts.set(g.account.id, g.account.display_name ?? g.account.id);
    if (g.group) groups.add(g.group);
  }
  return { accounts, groups };
};

const merge = (into: Holders, from: Holders) => {
  for (const [id, name] of from.accounts) into.accounts.set(id, name);
  for (const g of from.groups) into.groups.add(g);
};

/**
 * Who reads at a label: those granted read at it, and those granted read at
 * a label that reads it, directly or through another. Each person and group
 * once, however many ways they reach it.
 */
export function readersOf(
  label: string,
  labels: readonly ChainLabel[],
  grants: readonly ChainGrant[],
): { direct: Holders; through: Array<{ label: string; holders: Holders }>; all: Holders } {
  const direct = holdersOf(grants, label);
  const all: Holders = { accounts: new Map(direct.accounts), groups: new Set(direct.groups) };
  const through: Array<{ label: string; holders: Holders }> = [];
  for (const [other, reads] of readsThrough(labels)) {
    if (other === label || !reads.has(label)) continue;
    const holders = holdersOf(grants, other);
    through.push({ label: other, holders });
    merge(all, holders);
  }
  return { direct, through, all };
}

/**
 * What adding the pair "label also reads `reads`" would widen: for each
 * label that would newly be read, the people and groups who would newly
 * read it. Empty when the pair adds nothing (it is already read through
 * another label).
 */
export function wideningOf(
  label: string,
  reads: string,
  labels: readonly ChainLabel[],
  grants: readonly ChainGrant[],
): Array<{ label: string; holders: Holders }> {
  const before = readsThrough(labels);
  const after = readsThrough(labels, { label, reads });
  const reachersBefore = (target: string) =>
    [...before.entries()].filter(([l, r]) => l === target || r.has(target)).map(([l]) => l);
  const out: Array<{ label: string; holders: Holders }> = [];
  const gained = new Set<string>();
  for (const [l, r] of after) for (const t of r) if (!before.get(l)?.has(t)) gained.add(t);
  for (const target of gained) {
    const had = new Set<string>();
    const hadGroups = new Set<string>();
    for (const l of reachersBefore(target)) {
      const h = holdersOf(grants, l);
      for (const id of h.accounts.keys()) had.add(id);
      for (const g of h.groups) hadGroups.add(g);
    }
    const holders: Holders = { accounts: new Map(), groups: new Set() };
    for (const [l, r] of after) {
      if (!r.has(target) || before.get(l)?.has(target)) continue;
      const h = holdersOf(grants, l);
      for (const [id, name] of h.accounts) if (!had.has(id)) holders.accounts.set(id, name);
      for (const g of h.groups) if (!hadGroups.has(g)) holders.groups.add(g);
    }
    out.push({ label: target, holders });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** "Mei Lin, Tomás Ek and the group finance-leads", or "nobody". */
export function holdersInWords(h: Holders): string {
  const names = [...h.accounts.values(), ...[...h.groups].map((g) => `the group ${g}`)];
  if (names.length === 0) return "nobody yet";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const holdersCount = (h: Holders) => h.accounts.size + h.groups.size;
