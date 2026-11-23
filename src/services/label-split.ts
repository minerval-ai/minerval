/**
 * The split: a members-only deployment's `public` becomes three labels
 * (src/labels.ts, "The layers at the bottom"; #1203).
 *
 * Before it, one label holds three kinds of row: the public graph's own,
 * which the mirror brings in; what the organization released outside; and
 * the organization's own material that every member reads. The split gives
 * each its label, once:
 *
 *   public      keeps the public graph's rows (origin 'mirror') and nothing
 *               else. No run works there afterwards.
 *   published   takes what passed the gate to outside and the record of its
 *               leaving and of what came back.
 *   members     takes everything else that was at `public`: the base label,
 *               where work that names no label is done.
 *
 * It runs at start (src/index.ts), after migrations and before anything is
 * served or any worker starts, on a members-only deployment whose `labels`
 * names no base layer. It cannot be a migration, because a migration does
 * not know whether the deployment is members-only. It is one transaction
 * on the owner's connection, behind a lock, so two processes starting
 * together do it once, and it is logged in administrative_events.
 *
 * A row's label never changes (src/labels.ts), and this is the one
 * exception: every row moved here was at a label that meant three things,
 * and is moved to the label that says which. The guards that refuse a
 * change of label bind the cleared role and not the owner, so they stand
 * aside for this transaction and for nothing else. No key can collide,
 * because before the split no row was at either new label.
 *
 * The public graph is never split, and neither is an open deployment: its
 * visitors read `public`, so that is its base.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { armEnforcement } from "../db/enforcement.js";
import { loadConfig, type Config } from "../config.js";
import { PUBLIC_LABEL, labelLayers, noteLabelLayers } from "../labels.js";
import { membersOnly } from "../permissions.js";
import { clearanceFixedBySettings, knownProviderNames } from "../provider-labels.js";
import { logAdministrativeEvent } from "./permission-service.js";

/** The names the two new labels take unless the deployment's settings say otherwise. */
export const MEMBERS_LABEL_NAME = "members";
export const PUBLISHED_LABEL_NAME = "published";

const SPLIT_REASON =
  "The split restamps every row that was at `public` with the label that says which of three things it is, in every labelled table, and defines the two labels: the owner's to do, once.";

const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(SPLIT_REASON, fn);

export const PUBLIC_GRAPH_DESCRIPTION =
  "The public graph's own material, as the mirror brings it in. Anyone may read it. Nothing in this deployment writes here.";
export const PUBLISHED_DESCRIPTION =
  "What this organization released outside: what passed the gate to outside, what was sent, and what came back about it. " +
  "Anyone may read it. It is this organization's own and not the public graph's.";
export const MEMBERS_DESCRIPTION =
  "This organization's own material that every member reads. Work that names no other label is done here, and nobody outside reads it unless it is released.";

/** The split could not be made, with what whoever runs the deployment has to do. */
export class LabelSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelSplitError";
  }
}

/**
 * The tables of the gate to outside's destination side and of the outbound
 * and inbound work, with which of a table's rows at `public` are of a
 * release outside. `null`: every row of the table is. Each condition names
 * the row as `t`. Rows these leave behind belong to an internal release to
 * every member, and go to the base label with everything else.
 */
const PUBLISHED_ROWS: Readonly<Record<string, string | null>> = {
  received_releases: "t.to_outside",
  release_acts: "EXISTS (SELECT 1 FROM received_releases rr WHERE rr.id = t.release_id AND rr.to_outside)",
  received_pages: "EXISTS (SELECT 1 FROM received_releases rr WHERE rr.id = t.release_id AND rr.to_outside)",
  received_parts:
    "EXISTS (SELECT 1 FROM received_pages rp JOIN received_releases rr ON rr.id = rp.release_id WHERE rp.id = t.page_id AND rr.to_outside)",
  received_nodes: "EXISTS (SELECT 1 FROM received_releases rr WHERE rr.id = t.release_id AND rr.to_outside)",
  outbound_proposals: null,
  outbound_packages: null,
  outbound_sends: null,
  inbound_contributions: null,
  outward_acts: null,
  gates: "EXISTS (SELECT 1 FROM redaction_policies p WHERE p.boundary_id = t.boundary_id AND p.to_outside)",
  redaction_policies: "t.to_outside",
  // A label's face is shown outside where that label has a gate to outside:
  // it is how the label is named to readers there. Every member still reads
  // it, since the base label reads what was published.
  label_faces: "EXISTS (SELECT 1 FROM redaction_policies p WHERE p.from_label = t.for_label AND p.to_outside)",
};

/**
 * Rows at `public` that the mirror's applier wrote into a table with no
 * `origin` column, and which therefore stay: what a batch changed on a
 * mirrored node carries the batch's sequence, and a change this deployment
 * made to a node of its own carries none.
 */
const MIRRORED_WITHOUT_ORIGIN: Readonly<Record<string, string>> = {
  node_changes: "t.sequence IS NULL",
};

/** The judgment tables a version recorded "beside" another may point into (judgment_inputs.input_judgment_id). */
const JUDGMENT_TABLES = ["assessments", "quantity_estimates", "question_assessments", "artifact_assessments", "argument_evaluations"] as const;

export interface LabelSplitResult {
  /** Whether this call made the split. False where it was already made, or is not this deployment's to make. */
  split: boolean;
  base: string;
  published: string;
  /** One line per thing done, for the start log. */
  lines: string[];
}

/** The names the split uses: the deployment's settings where they say, else the fixed ones. */
export function splitLabelNames(config: Pick<Config, "membersLabel" | "publishedLabel"> = loadConfig()): { base: string; published: string } {
  return { base: config.membersLabel || MEMBERS_LABEL_NAME, published: config.publishedLabel || PUBLISHED_LABEL_NAME };
}

type LayerRow = { name: string; layer: string | null; created_at: Date };
const LAYERS_SQL = `SELECT name, layer, created_at FROM labels`;

/**
 * Split this deployment's `public` into the three layers, if it is a
 * members-only deployment that has not been split. Safe to call at every
 * start and from every process: it does nothing once the base layer is
 * named.
 */
export async function ensureLabelSplit(config: Config = loadConfig()): Promise<LabelSplitResult> {
  const unsplit = (): LabelSplitResult => ({ split: false, base: labelLayers().base, published: labelLayers().published, lines: [] });
  if (!membersOnly(config)) return unsplit();
  const names = splitLabelNames(config);

  const before = await asOwner(() => rawQuery<LayerRow>(LAYERS_SQL));
  if (before.some((l) => l.layer === "base")) {
    noteLabelLayers(before);
    return unsplit();
  }
  refuseTakenNames(before, names);

  // Two labels are about to exist. Where `public` was the only one, the
  // database starts holding reads to a clearance now, and every process of
  // the deployment is given time to notice before a row can carry either
  // (db/enforcement.ts). That is deliberate: a members-only deployment holds
  // material that is not for everyone, and the database should hold it to
  // that.
  await armEnforcement();

  const lines = await asOwner(() =>
    withTransaction(async (tx): Promise<string[] | null> => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('minerval:label-split'))`);
      const now = await tx.query<LayerRow>(LAYERS_SQL);
      if (now.some((l) => l.layer === "base")) return null;
      refuseTakenNames(now, names);
      return split(tx, names, config);
    })
  );

  const after = await asOwner(() => rawQuery<LayerRow>(LAYERS_SQL));
  noteLabelLayers(after);
  return { split: lines !== null, base: labelLayers().base, published: labelLayers().published, lines: lines ?? [] };
}

function refuseTakenNames(labels: ReadonlyArray<{ name: string }>, names: { base: string; published: string }): void {
  if (names.base === names.published || names.base === PUBLIC_LABEL || names.published === PUBLIC_LABEL) {
    throw new LabelSplitError(
      `MEMBERS_LABEL ("${names.base}") and PUBLISHED_LABEL ("${names.published}") must be two different names, and neither may be "${PUBLIC_LABEL}".`
    );
  }
  for (const [name, setting, what] of [
    [names.base, "MEMBERS_LABEL", "the organization's own material that every member reads"],
    [names.published, "PUBLISHED_LABEL", "what the organization released outside"],
  ] as const) {
    if (labels.some((l) => l.name === name)) {
      throw new LabelSplitError(
        `This deployment already defines a label named "${name}", so "${PUBLIC_LABEL}" was not split: the split needs that name for ` +
          `${what}, and a label is never renamed. Set ${setting} to another name (a short lower-case word) and start again. ` +
          `Nothing was changed.`
      );
    }
  }
}

async function split(tx: TxQuery, names: { base: string; published: string }, config: Config): Promise<string[]> {
  const { base, published } = names;
  const lines: string[] = [];

  // 1. The labels. The trigger on `labels` covers every table for the two
  //    new ones in this same transaction.
  await tx.query(
    `INSERT INTO labels (name, description, layer) VALUES ($1, $2, 'base'), ($3, $4, 'published')`,
    [base, MEMBERS_DESCRIPTION, published, PUBLISHED_DESCRIPTION]
  );
  await tx.query(`UPDATE labels SET layer = 'public_graph', description = $2 WHERE name = $1`, [PUBLIC_LABEL, PUBLIC_GRAPH_DESCRIPTION]);
  lines.push(`defined "${base}" (the base label) and "${published}", and marked "${PUBLIC_LABEL}" as the public graph's`);

  // 2. The rows. Every labelled table, read from the catalog so that none
  //    is missed: what the mirror brought stays, what belongs to a release
  //    outside goes to the published label, and the rest to the base.
  const tables = await tx.query<{ name: string; mirrors: boolean }>(
    `SELECT c.relname::text AS name,
            EXISTS (SELECT 1 FROM pg_attribute o WHERE o.attrelid = c.oid AND o.attname = 'origin' AND NOT o.attisdropped)
              AND EXISTS (SELECT 1 FROM pg_constraint k
                           WHERE k.conrelid = c.oid AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%''mirror''%') AS mirrors
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
      ORDER BY c.relname`
  );
  const known = new Set(tables.map((t) => t.name));
  for (const table of [...Object.keys(PUBLISHED_ROWS), ...Object.keys(MIRRORED_WITHOUT_ORIGIN)]) {
    if (!known.has(table)) throw new LabelSplitError(`The split names the table "${table}", which is not a labelled table here. Nothing was changed.`);
  }
  let toPublished = 0;
  let toBase = 0;
  const local = (t: { name: string; mirrors: boolean }) =>
    `t.sensitivity_label = $2` +
    (t.mirrors ? ` AND t.origin <> 'mirror'` : "") +
    (MIRRORED_WITHOUT_ORIGIN[t.name] ? ` AND ${MIRRORED_WITHOUT_ORIGIN[t.name]}` : "");
  // The published rows first. A condition reads another table's flags and
  // never its label, so the order among them does not matter.
  for (const t of tables) {
    if (!(t.name in PUBLISHED_ROWS)) continue;
    const which = PUBLISHED_ROWS[t.name];
    const moved = await tx.query<{ n: string }>(
      `WITH moved AS (UPDATE ${quoted(t.name)} t SET sensitivity_label = $1 WHERE ${local(t)}${which ? ` AND ${which}` : ""} RETURNING 1)
       SELECT count(*) AS n FROM moved`,
      [published, PUBLIC_LABEL]
    );
    toPublished += Number(moved[0]?.n ?? 0);
  }
  for (const t of tables) {
    const moved = await tx.query<{ n: string }>(
      `WITH moved AS (UPDATE ${quoted(t.name)} t SET sensitivity_label = $1 WHERE ${local(t)} RETURNING 1)
       SELECT count(*) AS n FROM moved`,
      [base, PUBLIC_LABEL]
    );
    toBase += Number(moved[0]?.n ?? 0);
  }
  lines.push(`restamped ${toBase} row(s) to "${base}" and ${toPublished} to "${published}" across ${tables.length} labelled tables; the mirror's rows stay at "${PUBLIC_LABEL}"`);

  // The other columns that name a label. An internal release to every
  // member named `public` as its destination and now names the base label;
  // a version recorded beside a local one at `public` is beside it still.
  await tx.query(`UPDATE releases SET to_label = $1 WHERE to_label = $2`, [base, PUBLIC_LABEL]);
  await tx.query(`UPDATE redaction_policies SET to_label = $1 WHERE to_label = $2`, [base, PUBLIC_LABEL]);
  await tx.query(`UPDATE redaction_policies SET from_label = $1 WHERE from_label = $2`, [base, PUBLIC_LABEL]);
  await tx.query(
    `UPDATE judgment_inputs i SET input_label = $1
      WHERE i.input_label = $2
        AND NOT (${JUDGMENT_TABLES.map((j) => `EXISTS (SELECT 1 FROM ${j} v WHERE v.id = i.input_judgment_id AND v.origin = 'mirror')`).join(" OR ")})`,
    [base, PUBLIC_LABEL]
  );

  // 3. What each label reads. Every label read the members' material
  //    without saying so, because it was `public`; now it says so.
  const pairs = await tx.query<{ label: string }>(
    `INSERT INTO label_reads (label, reads)
     SELECT l.name, $1 FROM labels l WHERE l.layer IS NULL
     ON CONFLICT DO NOTHING RETURNING label`,
    [base]
  );
  if (pairs.length > 0) lines.push(`recorded that ${pairs.map((p) => `"${p.label}"`).sort().join(", ")} read${pairs.length === 1 ? "s" : ""} "${base}", as ${pairs.length === 1 ? "it" : "they"} did while it was "${PUBLIC_LABEL}"`);

  // 4. Grants and keys. A grant or a credential at `public` was at the
  //    members' layer.
  await tx.query(`UPDATE permission_grants SET label = $1 WHERE label = $2`, [base, PUBLIC_LABEL]);
  for (const table of ["api_keys", "oauth_tokens", "oauth_authorization_requests"]) {
    await tx.query(`UPDATE ${table} SET work_label = $1 WHERE work_label = $2`, [base, PUBLIC_LABEL]);
  }
  // Whoever set the deployment up was granted every label there was. The
  // base label is one now.
  await tx.query(
    `INSERT INTO permission_grants (permission, account_id, label, granted_via)
     SELECT p.permission, a.account_id, $1, 'first_administrator'
       FROM (SELECT DISTINCT account_id FROM permission_grants
              WHERE granted_via = 'first_administrator' AND permission = 'administer' AND removed_at IS NULL AND account_id IS NOT NULL) a
      CROSS JOIN (VALUES ('read'), ('read_sources')) AS p(permission)
      WHERE NOT EXISTS (SELECT 1 FROM permission_grants g
                         WHERE g.account_id = a.account_id AND g.permission = p.permission AND g.label = $1 AND g.removed_at IS NULL)`,
    [base]
  );

  // 5. Providers. `public` was cleared for every provider, so both new
  //    labels start cleared for each provider set up here: nothing changes
  //    until an administrator unticks a box. Where the settings fix the
  //    clearance nothing is stored, and the preflight says which lines the
  //    setting needs (src/preflight.ts, provider_labels).
  if (clearanceFixedBySettings(config)) {
    lines.push(`PROVIDER_LABELS fixes which providers are sent each label's text: add "${base}" and "${published}" to each provider's line that should serve them`);
  } else {
    const providers = knownProviderNames(config);
    await tx.query(
      `INSERT INTO provider_clearances (provider, label)
       SELECT p, l FROM unnest($1::text[]) AS p CROSS JOIN unnest($2::text[]) AS l
       ON CONFLICT DO NOTHING`,
      [providers, [base, published]]
    );
    lines.push(`cleared the ${providers.length} provider(s) set up here for "${base}" and "${published}", as they were for "${PUBLIC_LABEL}"`);
  }

  await logAdministrativeEvent(tx, "labels_split", null, {
    // `label` is the base label, as every entry about a label names its label.
    label: base,
    published,
    rows_to_base: String(toBase),
    rows_to_published: String(toPublished),
  });
  return lines;
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;
