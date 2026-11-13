/**
 * What the mirror feed carries: the one list of replicated tables and
 * columns (docs/mirror.md).
 *
 * A private deployment reads the public graph from a local mirror, which
 * advances by applying signed batches of full public rows. The mirrored rows
 * live in the same tables as the deployment's own, marked `origin =
 * 'mirror'`. This file says which tables travel, and for each of them which
 * columns: every column of a replicated table is replicated unless it is
 * named in `leftOut` with the reason. The publisher builds its rows from this
 * list (mirror-feed-service.ts), the applier writes only these columns
 * (mirror-apply-service.ts), and the database refuses any other writer of
 * them on a mirrored row (the mirror_row_guard triggers).
 *
 * A column is left out for one of three reasons, and the kind decides who
 * may write it on a mirrored row:
 *
 *   local      this deployment's own working state on the row (a claim's
 *              place in the Steward's queue, the tagging lease). The
 *              deployment writes it; the guard lets it.
 *   generated  computed by the database from replicated columns.
 *   withheld   belongs to something that is not mirrored (money, a table
 *              outside this list). It keeps its default on a mirrored row
 *              and nothing local may write it there.
 *
 * Two columns are handled once for every table and so are named in none:
 * `origin` (the applier writes 'mirror') and `sensitivity_label` (only rows
 * at the public label are published, and the applier writes that label on
 * every mirrored row: where a deployment has more than one label, a row is
 * never public by omission).
 *
 * Adding a column to a replicated table means deciding here whether it
 * travels (tests/unit/services/mirror-manifest.test.ts fails until it is
 * either replicated or left out with a reason). A column that is local also
 * needs the guard's trigger on that table to name it, in a migration
 * (tests/db/mirror-guard.test.ts holds the two together).
 *
 * Tables are listed parents first: a row is written after every row it
 * points to, and removed before them.
 */
import { createHash } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  answerRelations,
  argumentEvaluations,
  argumentInstances,
  argumentSubclaims,
  arguments_,
  assessments,
  claimInstances,
  claimLinks,
  claimRelationships,
  claims,
  feedContributions,
  feedRequestTargets,
  feedRequests,
  judgmentInputs,
  quantityCuts,
  quantityDefinitions,
  quantityEstimates,
  quantityReadings,
  questionAssessments,
  sourceInterests,
  sourceSegments,
  sources,
} from "../db/schema.js";
import { canonicalContent } from "./run-log.js";

export type LeftOutKind = "local" | "generated" | "withheld";

export interface LeftOut {
  kind: LeftOutKind;
  reason: string;
}

interface TableEntry {
  table: PgTable;
  /** Columns that do not travel, each with why. */
  leftOut?: Record<string, LeftOut>;
  /**
   * Local columns the applier sets when it first writes a mirrored row, as
   * SQL expressions. Everything else local takes its default.
   */
  onInsert?: Record<string, string>;
  /** A local column the applier sets to now() whenever it changes the row. */
  touchOnWrite?: string;
  /**
   * The table has a key besides its primary key that the public graph
   * reuses (an edge removed and added again, a document segmented afresh),
   * so a batch's removals from it are applied before its writes.
   */
  removeBeforeWrite?: boolean;
  /**
   * The order rows are written in, as an ORDER BY over the table's columns.
   * The judgment tables allow one current row for a node at a label, so the
   * row that stopped being current is written before the one that became it.
   */
  writeOrder?: string;
  /**
   * What the applier does to a mirrored row the public graph has withdrawn
   * while rows of this deployment's own still point to it, as an SQL
   * assignment that marks it as gone (empty where the table has no such
   * mark). Without one the row is deleted and those rows follow their
   * foreign keys. The tables that have one are those a deployment's own
   * work hangs off: a claim (edges, instances, judgments at any label; the
   * state 'deprecated' already means "gone, but still referenced"), an
   * argument (a label's evaluation of it, the passages recorded as making
   * it), an instance (a label's reading of it) and a source (a label's
   * instances from it). So a batch deletes nothing a deployment recorded
   * on them. A row is also kept while a kept row points to it: a withdrawn
   * argument that is kept keeps its claim.
   */
  keepWhenReferenced?: string;
  /**
   * A parent the foreign keys do not state. A judgment_inputs row names its
   * judgment by kind and id, with no key.
   */
  parentByKind?: { kindColumn: string; idColumn: string; tables: Record<string, string> };
}

const STEWARD_QUEUE =
  "The Steward's work queue is the claim row, and the queue is this deployment's own: a mirrored claim is taken up here only when an action on it is funded.";
const TAGGING_QUEUE =
  "The tagging queue is the claim row, and the queue is this deployment's own.";
const MONEY =
  "Names a budget job in the publisher's ledger. Money is not mirrored, so the id would resolve to nothing here.";

/**
 * A current judgment is unique for a node, or for a node and a label where
 * the deployment has more than one (db/schema.ts, idx_assessments_current).
 * Every mirrored judgment is at the one label, so either way the rows of a
 * batch that are no longer current go first.
 */
const NOT_CURRENT_FIRST = "is_current ASC, id ASC";

const ENTRIES: readonly TableEntry[] = [
  {
    table: claims,
    leftOut: {
      queue_priority: {
        kind: "local",
        reason: "The order of this deployment's own queue, from its own mandates and demand.",
      },
      steward_state: { kind: "local", reason: STEWARD_QUEUE },
      steward_trigger: { kind: "local", reason: STEWARD_QUEUE },
      steward_context: { kind: "local", reason: "Retired; nothing reads or writes it." },
      steward_error: { kind: "local", reason: STEWARD_QUEUE },
      steward_error_reason: { kind: "local", reason: STEWARD_QUEUE },
      stewarded_at: { kind: "local", reason: STEWARD_QUEUE },
      steward_requeued: { kind: "local", reason: STEWARD_QUEUE },
      steward_attempts: { kind: "local", reason: STEWARD_QUEUE },
      tagged_at: { kind: "local", reason: TAGGING_QUEUE },
      tagging_leased_at: { kind: "local", reason: TAGGING_QUEUE },
      tagging_attempts: { kind: "local", reason: TAGGING_QUEUE },
      updated_at: {
        kind: "local",
        reason:
          "Moved by every queue transition on the publisher, so it would send each claim again whenever its Steward was queued. Here it is when the applier last changed the row.",
      },
      text_search: { kind: "generated", reason: "Generated by the database from text." },
    },
    // A mirrored claim inserted with the defaults would be pending for the
    // Steward and untagged, and both drains would spend this deployment's
    // budget redoing the public graph's work. 'deferred' is the existing
    // state that keeps a claim embedded and matchable but out of the drain.
    onInsert: { steward_state: "'deferred'", tagged_at: "now()" },
    touchOnWrite: "updated_at",
    keepWhenReferenced: "state = 'deprecated'",
  },
  { table: quantityDefinitions },
  { table: quantityCuts },
  { table: claimRelationships, removeBeforeWrite: true },
  { table: claimLinks, removeBeforeWrite: true },
  { table: answerRelations, removeBeforeWrite: true },
  {
    table: sources,
    // A document has no state to mark: it is kept as it was last sent.
    keepWhenReferenced: "",
    leftOut: {
      party_id: {
        kind: "withheld",
        reason:
          "Points to parties, which is not mirrored: whose material a source is belongs to a private deployment, and the public graph's sources have none.",
      },
    },
  },
  { table: sourceSegments, removeBeforeWrite: true },
  {
    table: arguments_,
    keepWhenReferenced: `retired_at = COALESCE(retired_at, now()), retired_reason = COALESCE(retired_reason, 'Withdrawn by the public graph.')`,
    leftOut: {
      lean_check_id: {
        kind: "withheld",
        reason:
          "Points to lean_checks, which is not mirrored: the mathematics tables are a feature of their own and stay with the publisher for now.",
      },
    },
  },
  { table: argumentSubclaims, removeBeforeWrite: true },
  {
    table: claimInstances,
    keepWhenReferenced: `detached_at = COALESCE(detached_at, now()), detached_reason = COALESCE(detached_reason, 'Withdrawn by the public graph.')`,
  },
  { table: argumentInstances },
  { table: quantityReadings },
  {
    table: assessments,
    leftOut: { funded_by_job_id: { kind: "withheld", reason: MONEY } },
    writeOrder: NOT_CURRENT_FIRST,
  },
  {
    table: quantityEstimates,
    leftOut: { funded_by_job_id: { kind: "withheld", reason: MONEY } },
    writeOrder: NOT_CURRENT_FIRST,
  },
  {
    table: questionAssessments,
    leftOut: { funded_by_job_id: { kind: "withheld", reason: MONEY } },
    writeOrder: NOT_CURRENT_FIRST,
  },
  { table: argumentEvaluations, writeOrder: NOT_CURRENT_FIRST },
  { table: sourceInterests },
  {
    table: judgmentInputs,
    leftOut: {
      input_label: {
        kind: "withheld",
        reason:
          "Points to labels, which is not mirrored. It is set only on a row that says which version at another label a judgment was made beside, and a graph that publishes has one label and so has no such row.",
      },
    },
    parentByKind: {
      kindColumn: "judgment_kind",
      idColumn: "judgment_id",
      tables: {
        assessment: "assessments",
        quantity_estimate: "quantity_estimates",
        question_assessment: "question_assessments",
      },
    },
  },
  // The public record that is not rows of the graph: contributions on
  // nodes, and requests with the nodes they bear on. The publisher fills
  // these from its own `contributions` and `requests` before each cut
  // (mirror-feed-service.ts, refreshFeedRecords), with their public
  // columns and no account, and they travel like any table here. A
  // deployment that shows pages outside finds in them what the public said
  // back (inbound-service.ts), and any deployment finds the requests it
  // may take up (request-adoption-service.ts).
  { table: feedContributions },
  { table: feedRequests },
  { table: feedRequestTargets, removeBeforeWrite: true },
];

/**
 * What is not mirrored, by group, with the reason. A table is mirrored only
 * if it is in the list above, so nothing here is needed to keep a table out;
 * it is written down so that the choice can be read and argued with.
 */
export const NOT_MIRRORED: Record<string, string> = {
  "agent_runs, agent_steps, setup_parts, llm_usage":
    "Run transcripts and usage. A mirrored judgment keeps its run_id, which names a run on the publisher and resolves to nothing here; the transcript is read on the public graph.",
  "contributors, api_keys, oauth_*, assistant_*, pages":
    "Private to an account.",
  "owl_ledger, actions, action_allocations, mandate_valuations, grants, regrants, budget_jobs, assessment_orders, petitions, mandate_*, lookouts, correspondents, bounties, prize_*":
    "Money and the attention it buys. A private deployment has its own ledger and its own mandates.",
  "jobs, enqueue_events, queue_depth_snapshots, agent_sessions, node_messages":
    "Working state of the publisher's own queues and inboxes.",
  "contributions, contribution_reviews, appeals, arbitration_results, reputation_events":
    "The public graph's contribution record names accounts and is its own working state. What a contribution on a node said, of what type, about which published page and where its review stands travels in feed_contributions, without the account. The review's reasoning does not travel yet.",
  "tags, taggings":
    "The topical vocabulary is not in the feed yet. A mirrored claim arrives marked as tagged, so it is not sent to this deployment's tagger, and carries no tags.",
  "source_events":
    "Recorded by each deployment's own watchers, which cover a mirrored source like any other; a mirrored copy would collide with the local row for the same notice.",
  "claim_provenance_edges, claim_provenance_roots, claim_source_maps, claim_instance_readings, claim_instance_reading_log, source_relationships, examinations, examination_*, reading_citations, audit_notes":
    "The provenance story and examinations of sources: left for a later feed version.",
  "requests, request_targets, request_work":
    "The public graph's own working state. A request's words, where it stands and the nodes it bears on travel in feed_requests and feed_request_targets. The work done on a request, and a request's bearing on a source, do not travel yet.",
  "claim_formalizations, lean_checks, proof_attempts, attachments":
    "The mathematics feature's tables.",
  "agent_findings, agent_reports, audit_*, consistency_*, curation_requests, reconciliation_events":
    "The public graph's own governance record.",
};

export interface ReplicatedParent {
  /** The column on this table. */
  column: string;
  /** The replicated table it points to. */
  table: string;
}

export interface ReplicatedTable {
  /** The table's SQL name. */
  name: string;
  /**
   * The columns that say which row of the public graph this is, in order:
   * the primary key, without `origin`.
   */
  key: readonly string[];
  /**
   * The key is not an id of its own but names other rows (an argument and
   * an edge), so this deployment can hold a row of its own with the same
   * key, and the table's primary key ends with `origin` to let the two
   * stand side by side (db/schema.ts, the origin column). The applier's
   * conflict target is then the key and the origin, and a local row with
   * the key is no collision.
   */
  keyPerGraph: boolean;
  /** Replicated columns in the table's own order, key included. */
  columns: readonly string[];
  leftOut: Readonly<Record<string, LeftOut>>;
  /** Columns left out that this deployment may write on a mirrored row. */
  localColumns: readonly string[];
  /** Local and generated columns: what the guard does not compare. */
  unguardedColumns: readonly string[];
  /** Foreign keys from replicated columns to other replicated tables. */
  parents: readonly ReplicatedParent[];
  /** Replicated columns that point into this same table. */
  selfReferences: readonly string[];
  parentByKind?: TableEntry["parentByKind"];
  onInsert: Readonly<Record<string, string>>;
  touchOnWrite?: string;
  keepWhenReferenced?: string;
  removeBeforeWrite: boolean;
  writeOrder: string;
  /** Column name, SQL type and nullability of each replicated column. */
  shape: ReadonlyArray<{ name: string; type: string; notNull: boolean }>;
}

/** Handled for every table at once; see the header. */
const EVERY_TABLE = new Set(["origin", "sensitivity_label"]);

function build(): ReplicatedTable[] {
  const replicatedNames = new Set(ENTRIES.map((e) => getTableConfig(e.table).name));
  return ENTRIES.map((entry) => {
    const config = getTableConfig(entry.table);
    const leftOut = entry.leftOut ?? {};
    const primaryKey = config.primaryKeys[0]
      ? config.primaryKeys[0].columns.map((c) => c.name)
      : config.columns.filter((c) => c.primary).map((c) => c.name);
    const key = primaryKey.filter((c) => c !== "origin");
    const replicated = config.columns.filter((c) => !EVERY_TABLE.has(c.name) && !(c.name in leftOut));
    const columns = replicated.map((c) => c.name);
    const parents: ReplicatedParent[] = [];
    const selfReferences: string[] = [];
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const column = ref.columns[0]!.name;
      if (!columns.includes(column)) continue;
      const target = getTableConfig(ref.foreignTable as PgTable).name;
      if (target === config.name) selfReferences.push(column);
      else if (replicatedNames.has(target)) parents.push({ column, table: target });
    }
    const kinds = (kind: LeftOutKind) =>
      Object.entries(leftOut)
        .filter(([, v]) => v.kind === kind)
        .map(([name]) => name);
    return {
      name: config.name,
      key,
      keyPerGraph: primaryKey.includes("origin"),
      columns,
      leftOut,
      localColumns: kinds("local"),
      unguardedColumns: [...kinds("local"), ...kinds("generated")],
      parents,
      selfReferences,
      parentByKind: entry.parentByKind,
      onInsert: entry.onInsert ?? {},
      touchOnWrite: entry.touchOnWrite,
      keepWhenReferenced: entry.keepWhenReferenced,
      removeBeforeWrite: entry.removeBeforeWrite === true,
      writeOrder: entry.writeOrder ?? key.map((k) => `${k} ASC`).join(", "),
      shape: replicated.map((c) => ({ name: c.name, type: c.getSQLType(), notNull: c.notNull })),
    };
  });
}

let _tables: ReplicatedTable[] | null = null;

/** The replicated tables, parents first. */
export function replicatedTables(): readonly ReplicatedTable[] {
  return (_tables ??= build());
}

export function replicatedTable(name: string): ReplicatedTable | undefined {
  return replicatedTables().find((t) => t.name === name);
}

/**
 * Raised by hand when a migration changes what a mirrored column's values
 * mean without changing any column (a status renamed in place, say). The
 * column list cannot show such a change, and a batch cut before it must not
 * be applied by code written after it.
 */
export const REPLICATED_MEANING_VERSION = 1;

/**
 * One hash over the mirrored tables' shape: which tables, which columns,
 * their types and nullability, and the meaning version. A batch states the
 * shape it was cut in, and an applier applies a batch only when that is its
 * own shape, so a row can never be written into a table it does not fit.
 */
export function replicatedShape(): string {
  const shape = {
    meaning: REPLICATED_MEANING_VERSION,
    tables: replicatedTables().map((t) => ({ name: t.name, key: t.key, columns: t.shape })),
  };
  return createHash("sha256").update(canonicalContent(shape), "utf8").digest("hex");
}
