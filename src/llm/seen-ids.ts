/**
 * The ids a run has been shown, and the one rule for reading a mistyped id
 * against them (#470, #884, #934, #935, #952).
 *
 * A model copying a uuid from one tool call into the next sometimes gets it
 * wrong: a hex digit added, dropped or changed, or one id's first group
 * spliced onto another's tail. The read then names no node, and a model told
 * only "not found" has filed the miss as a fault in the graph, over and over
 * (#934 holds four such sightings, every one an id one character away from
 * what the run had been shown). PR #914 gave the Matcher a repair against the
 * ids its searches returned; this module is that repair for every agent.
 *
 * The tool loops (llm/client.ts) keep one record per run: every uuid in the
 * run's opening messages and in every tool result it gets back, with the
 * node's wording where the result gave it beside the id. A tool runs inside
 * the record's scope, so a read that misses can ask what the run has seen
 * (seenIdsInRun) without each agent threading it through. The reads repair
 * against it (tools/id-repair.ts); writes never do, and offer the nearest
 * ids instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolExecution } from "./tool-output.js";

type MessageParam = Anthropic.MessageParam;

const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Characters in a uuid's first group: the part a model most often carries over intact. */
export const UUID_FIRST_GROUP_CHARS = 8;

/** How much of a node's wording the record keeps beside its id. */
const SEEN_TEXT_CHARS = 160;

/** The labels kept for one id: enough to say what it was seen as. */
const MAX_LABELS_PER_ID = 3;

/**
 * Keys whose value is an id the run did not get from the graph: the id it
 * asked for, echoed back in a correction or a miss. Recording it would make
 * a mistyped id look like one the run had been shown.
 */
const ECHO_KEYS = new Set(["requested_id"]);

/** The codes a read or a write answers with when an id names nothing. */
export const ID_MISS_CODES = [
  "CLAIM_NOT_FOUND",
  "INVALID_CLAIM_ID",
  "ARGUMENT_NOT_FOUND",
  "INVALID_ARGUMENT_ID",
] as const;
export type IdMissCode = (typeof ID_MISS_CODES)[number];

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_EXACT.test(value.trim());
}

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SEEN_TEXT_CHARS ? `${flat.slice(0, SEEN_TEXT_CHARS - 1)}…` : flat;
}

export interface SeenId {
  id: string;
  /** The node's wording, when a result gave it beside the id. */
  text: string | null;
  /** Where the id was seen: the key that held it, under its parent's ("assessment.id", "subclaims.edge_id"). */
  seenAs: string[];
}

/** The wording an object gives for the id under `key`, if any. */
function textBeside(obj: Record<string, unknown>, key: string): string | null {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return null;
  };
  if (key === "id") return pick("canonical_form", "text", "canonical_text");
  if (key === "claim_id" || key === "node_id") {
    // A row about something else that names its claim (an instance, a
    // finding) has an `id` of its own, and its `text` is not the claim's.
    return "id" in obj ? pick("canonical_form", "claim_text") : pick("canonical_form", "text", "claim_text");
  }
  if (key.endsWith("_id")) {
    const base = key.slice(0, -3);
    return pick(`${base}_text`, `${base}_canonical_form`);
  }
  return null;
}

export class SeenIds {
  private readonly ids = new Map<string, SeenId>();

  get size(): number {
    return this.ids.size;
  }

  has(id: unknown): boolean {
    return typeof id === "string" && this.ids.has(normalize(id));
  }

  get(id: unknown): SeenId | null {
    return typeof id === "string" ? (this.ids.get(normalize(id)) ?? null) : null;
  }

  all(): SeenId[] {
    return [...this.ids.values()];
  }

  /** Record one id, keeping the first wording and the first few labels it was seen under. */
  add(id: string, text: string | null = null, seenAs: string | null = null): void {
    if (!isUuid(id)) return;
    const key = normalize(id);
    const entry = this.ids.get(key) ?? { id: key, text: null, seenAs: [] };
    if (!entry.text && text) entry.text = clip(text);
    if (seenAs && entry.seenAs.length < MAX_LABELS_PER_ID && !entry.seenAs.includes(seenAs)) {
      entry.seenAs.push(seenAs);
    }
    this.ids.set(key, entry);
  }

  /** Every uuid in free text: a prompt, a prose tool result, a page_url. */
  addText(text: string): void {
    for (const m of text.matchAll(UUID_ANYWHERE)) this.add(m[0]);
  }

  /** Every uuid in a parsed JSON value, with the wording beside it where there is one. */
  addValue(value: unknown, key: string | null = null, parent: string | null = null): void {
    if (typeof value === "string") {
      if (isUuid(value)) this.add(value, null, key ? (parent ? `${parent}.${key}` : key) : null);
      else this.addText(value);
      return;
    }
    if (Array.isArray(value)) {
      // An array is transparent: its elements are seen under its own key.
      for (const item of value) this.addValue(item, key, parent);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (ECHO_KEYS.has(k)) continue;
        if (typeof v === "string" && isUuid(v)) {
          this.add(v, textBeside(obj, k), key ? `${key}.${k}` : k);
        } else {
          this.addValue(v, k, key);
        }
      }
    }
  }

  /**
   * A tool's result. A result that is itself a miss (an id that named
   * nothing, a refused write) adds nothing: what it carries is the id the
   * run asked for and the ids already in this record.
   */
  addToolOutput(output: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      this.addText(output);
      return;
    }
    const code = (parsed as { code?: unknown } | null)?.code;
    if ((ID_MISS_CODES as readonly unknown[]).includes(code)) return;
    this.addValue(parsed);
  }

  /** The run's opening messages: its prompt, and on a resumed run the transcript so far. */
  addMessages(messages: readonly MessageParam[]): void {
    for (const message of messages) {
      if (typeof message.content === "string") {
        this.addText(message.content);
        continue;
      }
      for (const block of message.content) {
        if (block.type === "text") this.addText(block.text);
        else if (block.type === "tool_result") {
          if (typeof block.content === "string") this.addToolOutput(block.content);
          else for (const part of block.content ?? []) if (part.type === "text") this.addToolOutput(part.text);
        }
      }
    }
  }

  /** The rule below, against this record. */
  resolve(requested: unknown, opts: { excludeExact?: boolean } = {}): IdResolution {
    return resolveId(this.ids.keys(), requested, opts);
  }

  /** The ids nearest `requested`, nearest first (its own entry left out). */
  nearest(requested: unknown, limit: number): SeenId[] {
    if (typeof requested !== "string") return this.all().slice(0, limit);
    const req = normalize(requested);
    return this.all()
      .filter((s) => s.id !== req)
      .map((s) => ({ s, d: editDistance(req, s.id), p: sharedPrefix(req, s.id) }))
      .sort((a, b) => a.d - b.d || b.p - a.p)
      .slice(0, limit)
      .map(({ s }) => s);
  }
}

export type IdResolution =
  /** The id is one of the known ids, as given. */
  | { kind: "exact"; id: string }
  /** Exactly one known id is what the given one most plausibly meant. */
  | { kind: "repaired"; id: string; rule: IdRepairRule }
  /** More than one known id fits; none is chosen. */
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

export type IdRepairRule = "one_character" | "first_group";

/**
 * The one rule for reading a mistyped id against ids the run has been shown.
 * An id is a candidate for `requested` when it is one character away (one
 * added, dropped or changed: #934's id had 13 hex digits in its last group,
 * #952's had 11) or when it begins with the same first group (#470's splice
 * of one id's head onto another's tail, or the head alone). A repair needs
 * exactly one candidate under the two rules together: two ids that both fit
 * are a guess, and no guess is made.
 *
 * `excludeExact` leaves the requested id itself out of the candidates, for
 * a caller that already knows it names nothing (a read that missed).
 */
export function resolveId(
  known: Iterable<string>,
  requested: unknown,
  opts: { excludeExact?: boolean } = {}
): IdResolution {
  if (typeof requested !== "string" || requested.trim().length === 0) return { kind: "none" };
  const req = normalize(requested);
  const candidates: string[] = [];
  let exact: string | null = null;
  for (const raw of known) {
    const id = normalize(raw);
    if (id === req) {
      exact = id;
      continue;
    }
    const firstGroup =
      req.length >= UUID_FIRST_GROUP_CHARS && id.startsWith(req.slice(0, UUID_FIRST_GROUP_CHARS));
    if (firstGroup || withinOneEdit(req, id)) {
      if (!candidates.includes(id)) candidates.push(id);
    }
  }
  if (exact && !opts.excludeExact) return { kind: "exact", id: exact };
  if (candidates.length === 1) {
    const id = candidates[0]!;
    return { kind: "repaired", id, rule: withinOneEdit(req, id) ? "one_character" : "first_group" };
  }
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "none" };
}

/** Whether `a` becomes `b` by adding, dropping or changing one character. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  if (t.length - s.length > 1) return false;
  let i = 0;
  while (i < s.length && s[i] === t[i]) i++;
  // Same length: one change; otherwise the longer one has one extra here.
  return s.length === t.length ? s.slice(i + 1) === t.slice(i + 1) : s.slice(i) === t.slice(i + 1);
}

/** Levenshtein distance, for ranking near ids. Ids are short; the table is 37 by 37. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * What is wrong with an id's shape, in words a model can act on, or null
 * when it has the shape of a uuid. "Not a full uuid" alone was read as a
 * fault in the tool (#952): the model was sure it had copied the id.
 */
export function describeIdShape(id: unknown): string | null {
  if (typeof id !== "string" || id.trim() === "") return "no id was given";
  const trimmed = id.trim();
  if (UUID_EXACT.test(trimmed)) return null;
  const groups = trimmed.split("-");
  const expected = [8, 4, 4, 4, 12];
  if (groups.length !== 5) {
    return `it has ${groups.length} hyphen-separated group${groups.length === 1 ? "" : "s"}, where a uuid has 5 (8-4-4-4-12 hex digits)`;
  }
  const wrong = groups
    .map((g, i) => ({ g, i }))
    .filter(({ g, i }) => g.length !== expected[i] || !/^[0-9a-f]+$/i.test(g));
  const ordinal = ["first", "second", "third", "fourth", "last"];
  return wrong
    .map(({ g, i }) =>
      /^[0-9a-f]*$/i.test(g)
        ? `its ${ordinal[i]} group has ${g.length} hex digit${g.length === 1 ? "" : "s"}, where a uuid has ${expected[i]}`
        : `its ${ordinal[i]} group "${g}" is not all hex digits`
    )
    .join("; ");
}

// ---- the run's record, in scope for its tools ---------------------------------

const store = new AsyncLocalStorage<SeenIds>();

/** The record of the run whose tool is executing, or null outside a tool loop. */
export function seenIdsInRun(): SeenIds | null {
  return store.getStore() ?? null;
}

/** Run `fn` with `record` as the run's record (a test, or a caller outside the loops). */
export function withSeenIds<T>(record: SeenIds, fn: () => T): T {
  return store.run(record, fn);
}

/**
 * The loops' side of the record: built from the run's opening messages
 * (extending `record` when the caller keeps one across loops, as the
 * Matcher's retry does), and `call`, which runs one tool inside the
 * record's scope and then records what the tool returned.
 */
export function observeRun(
  initialMessages: readonly MessageParam[],
  record: SeenIds = new SeenIds()
): { record: SeenIds; call: <T extends ToolExecution>(run: () => Promise<T>) => Promise<T> } {
  record.addMessages(initialMessages);
  return {
    record,
    call: async <T extends ToolExecution>(run: () => Promise<T>): Promise<T> => {
      const output = await store.run(record, run);
      record.addToolOutput(typeof output === "string" ? output : output.text);
      return output;
    },
  };
}

/**
 * Whether a thrown error is the database refusing a malformed uuid (22P02). The query builder wraps the
 * database's error in its own, with the code on the cause, so both places are looked at.
 */
export function isMalformedIdError(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "22P02" || e?.cause?.code === "22P02";
}
