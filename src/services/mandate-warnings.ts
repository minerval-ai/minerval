/**
 * What a funder must see before funding a drafted mandate.
 *
 * The Grantmaker raises in its reply whatever a funder should weigh, but a
 * reply is prose: an agent funding for its user once read past "this stake
 * line would identify you" and funded without asking. So a draft carries its
 * warnings as data, and funding a draft that has any is refused until the
 * caller acknowledges them (POST /grant-conversations/:id/fund,
 * `acknowledge_warnings`), which an agent should do only after its user has
 * read them.
 *
 * Two sources: the Grantmaker records warnings with its draft
 * (propose_mandate's `warnings`), and some follow from the draft alone and
 * are added here whether or not it did (a stake line on an anonymous
 * funder's mandate is public, and may say who they are).
 *
 * A warning's id is a hash of what it says, so the same warning keeps its id
 * when the draft is revised around it, and a changed one needs acknowledging
 * again.
 */
import { createHash } from "node:crypto";

export const WARNING_TOPICS = ["identity", "cost", "scope", "conflict", "other"] as const;
export type WarningTopic = (typeof WARNING_TOPICS)[number];

export interface MandateWarning {
  id: string;
  about: WarningTopic;
  text: string;
  /** "grantmaker" when it recorded the warning; "platform" when the draft alone implies it. */
  raised_by: "grantmaker" | "platform";
}

/** The longest warning the Grantmaker may record: a sentence or two a person reads before paying. */
export const WARNING_MAX_CHARS = 600;
/** The most warnings one draft may carry: past that they stop being read. */
export const WARNINGS_MAX = 8;

function warningId(about: string, text: string): string {
  return `w-${createHash("sha256").update(`${about}\n${text}`).digest("hex").slice(0, 10)}`;
}

/** The Grantmaker's warnings as given to propose_mandate, checked; a problem in words, or the cleaned list. */
export function parseGrantmakerWarnings(
  raw: unknown
): { ok: true; warnings: MandateWarning[] } | { ok: false; problem: string } {
  if (raw === undefined || raw === null) return { ok: true, warnings: [] };
  if (!Array.isArray(raw)) return { ok: false, problem: "warnings must be an array of {about, text}" };
  if (raw.length > WARNINGS_MAX) {
    return { ok: false, problem: `at most ${WARNINGS_MAX} warnings: keep the ones the funder must weigh before paying` };
  }
  const out: MandateWarning[] = [];
  for (const w of raw) {
    const text = typeof (w as { text?: unknown })?.text === "string" ? (w as { text: string }).text.trim() : "";
    if (!text) return { ok: false, problem: "each warning needs its text" };
    if (text.length > WARNING_MAX_CHARS) {
      return { ok: false, problem: `a warning is at most ${WARNING_MAX_CHARS} characters` };
    }
    const aboutRaw = String((w as { about?: unknown }).about ?? "other");
    const about = (WARNING_TOPICS as readonly string[]).includes(aboutRaw) ? (aboutRaw as WarningTopic) : "other";
    out.push({ id: warningId(about, text), about, text, raised_by: "grantmaker" });
  }
  return { ok: true, warnings: out };
}

/** The draft's fields the warnings read. */
interface DraftLike {
  funder_named?: boolean;
  funder_stake?: string | null;
  warnings?: MandateWarning[];
}

/**
 * Every warning on a draft: the Grantmaker's, and those the draft implies.
 * Read on every serialization and on funding, so a draft written before
 * warnings existed is held to them too.
 */
export function draftWarnings(draft: DraftLike | null | undefined): MandateWarning[] {
  if (!draft) return [];
  const own = Array.isArray(draft.warnings) ? draft.warnings : [];
  const implied: MandateWarning[] = [];
  const stake = typeof draft.funder_stake === "string" ? draft.funder_stake.trim() : "";
  if (draft.funder_named === false && stake && !/^none\.?$/i.test(stake)) {
    const text =
      `You chose not to be named, but the stake you declared is shown on the mandate's public ` +
      `page: "${stake}". Check that it cannot identify you before funding; ask the Grantmaker ` +
      `to reword it if it could.`;
    implied.push({ id: warningId("identity", text), about: "identity", text, raised_by: "platform" });
  }
  const seen = new Set<string>();
  return [...implied, ...own].filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)));
}

/**
 * Whether `ack` covers every warning: `true` acknowledges them all, a list
 * acknowledges the ids it names. Returns the warnings left unacknowledged.
 */
export function unacknowledged(warnings: MandateWarning[], ack: unknown): MandateWarning[] {
  if (ack === true) return [];
  const ids = Array.isArray(ack) ? new Set(ack.map(String)) : new Set<string>();
  return warnings.filter((w) => !ids.has(w.id));
}
