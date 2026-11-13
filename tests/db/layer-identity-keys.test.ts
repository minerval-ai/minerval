/**
 * Identity is per layer (db/schema.ts, "The layer").
 *
 * A unique key on a labelled table that does not hold `sensitivity_label`
 * is one key for the whole deployment. Work at a label can then be stopped
 * by a row at a label it does not read, and the refusal tells it the row
 * is there (unseen_collision_guard), which is information going down a
 * label with no gate. So every unique key of every labelled table is here:
 * it holds the label, or it is listed below with the reason work at one
 * label cannot meet another label's row under it, or with the reason it
 * was left for now. A failure means a key was added or changed. Give it
 * `sensitivity_label` (before `origin`, where the table is replicated) and
 * ask src/services/layer-service.ts what a write does where a layer below
 * holds the key, or add it to the list with its reason.
 */
import { describe, expect, it } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { withSystemClearance } from "../../src/db/clearance.js";

/** The row a key names carries one label, and every row under the key is written at it. */
const PINNED = "Each row is written at the label of the row its key names, by work at that label, so no two labels hold the same key.";
/** The key names a row by an id only its own label's work could know. */
const OWN_PARENT = "The key names a row of the writer's own (a run, a page, a package, a claim it made), which work at a label that does not read it cannot name.";
/** A request's rows are its own label's: work above acts on a request of its own, taken up from it. */
const REQUESTS_OWN =
  "A request's rows are written at the request's label. Work at a label that reads it acts on a request of its own, taken up from this one and linked to it (services/request-adoption-service.ts), and writes nothing under the request below, so no two labels hold the same key.";

const KEPT: Record<string, string> = {
  uq_action_allocations_live_placement:
    "Money is whole across labels by design (docs/architecture.md, \"Money\"): a mandate has one live placement on a ledger row, and the placement is found through the money views, which every label reads.",
  uq_actions_group_variant:
    "The ledger's key carries the label in its text where several labels can work on one subject (groupAtLabel: `assess:<node> @<label>`), and otherwise names a row that has one label (a request, a plan, a lookout, an audit), at which the ledger row is written.",
  uq_adopted_requests_request: REQUESTS_OWN,
  idx_request_targets_unique: REQUESTS_OWN,
  uq_request_work_taken_up: REQUESTS_OWN,
  uq_agent_reports_dedupe_key:
    "One report for the whole deployment on purpose: a repeat at another label is recorded as a sighting at that label and changes nothing on the report (report-service.ts), and the exact-key check before the insert is made seeing every label.",
  uq_agent_steps_chained: OWN_PARENT,
  assistant_pages_share_token_unique: "A random token minted for the page: nothing else can produce it.",
  uq_audit_runs_dedupe_key:
    "The key is made from the id of a row with one label (a contribution, a bounty, a page and its round, a prize claim, a source) by work on that row, or carries the label in its text where a sweep opens one audit at each label (keyAtLabel).",
  claim_predictions_pkey: "A prediction fixture's record, written by a script (scripts/predictions.ts) and by no run.",
  idx_claim_predictions_fixture: "As claim_predictions_pkey.",
  uq_connection_tools_name: PINNED,
  uq_connections_tool_prefix:
    "A name an administrator chooses. It prefixes the connection's tools in every run offered it, and a run is offered the connections at every label it reads, so the name has to be one for all of them. An administrator who names one that is taken at a label they do not read is told it is taken. Left as it was.",
  uq_file_sets_slug: "A name an administrator chooses, as uq_connections_tool_prefix: a set is mounted by its name in every run that reads its label. Left as it was.",
  uq_file_set_files_path: PINNED,
  uq_file_set_keeps_source: "A file kept from a set is the set's own material and is written at the set's label, whichever run keeps it; the key is that source's id.",
  events_pkey: "A sequence number the database assigns.",
  uq_inbound_contributions_public: "A contribution delivered from the public graph, keyed by its id there and always written at `public` by the worker that fetches it (inbound-service.ts).",
  ingest_focuses_pkey: "The ledger key of an ingest, which carries the label in its text (groupAtLabel).",
  uq_lookout_feeds_url: PINNED,
  uq_mandate_events_ref: PINNED,
  mandate_valuations_grant_id_action_id_pk: PINNED,
  uq_outbound_packages_hash: OWN_PARENT,
  uq_outbound_packages_sequence: OWN_PARENT,
  outward_settings_pkey: "A standing choice of the deployment, always at `public`, written as the tables' owner.",
  prize_claims_contribution_id_unique: PINNED,
  uq_prize_claim_live_per_claimant: "One live claim for a claimant on a formal statement: the claimant's own, on the public graph's prizes.",
  uq_published_page_packages_hash: OWN_PARENT,
  uq_published_page_packages_sequence: OWN_PARENT,
  uq_published_pages_showing_node: OWN_PARENT,
  uq_publishers_live_key: "A publisher's signing key, recorded on the public graph, which has one label.",
  uq_redaction_policies_version: "A boundary's policy has two rows by design, one for each side, told apart by `side` in the key and each written at its side's label (redaction-policy.ts).",
  uq_report_sendings_report: PINNED,
  setup_parts_kind_name_hash_pk:
    "One part for a text across every label on purpose, stored seeing every label (setup-service.ts). A part first stored by a run at one label is not readable by a run at a label that does not read it: src/labels.ts names that as later work, and it is not changed here.",
  uq_setup_parts_version: "As setup_parts_kind_name_hash_pk: versions are numbered across every label.",
  uq_showing_pages_version: OWN_PARENT,
  uq_showing_parts_position: OWN_PARENT,
  uq_showings_live: PINNED,
  uq_shown_parts_position: OWN_PARENT,
  idx_source_events_unique: "Derived mechanically from the document and written at the document's label whoever finds it (src/labels.ts): a document's row at each label has its own.",
  idx_source_segments_order: "As idx_source_events_unique: a document's segments carry the document's label, and each row of a document recorded at two labels has its own.",
  idx_stated_views_contribution: PINNED,
  // Where `public` is the only label a node has one current judgment; the
  // step that turns enforcement on swaps each of these for one that holds
  // the label (minerval_enforcement_sync).
  idx_assessments_current: "One label, one current judgment: replaced by idx_assessments_current_at_label where a second label exists.",
  idx_argument_evaluations_current: "As idx_assessments_current.",
  idx_quantity_estimates_current: "As idx_assessments_current.",
  idx_question_assessments_current: "As idx_assessments_current.",
};

/** The four that exist only while `public` is the only label. */
const ONE_LABEL_ONLY = new Set([
  "idx_assessments_current",
  "idx_argument_evaluations_current",
  "idx_quantity_estimates_current",
  "idx_question_assessments_current",
]);

describe("the unique keys of labelled tables", () => {
  it("each hold the label, or are listed with the reason they do not", async () => {
    const keys = await withSystemClearance("A test reads the catalog.", () =>
      rawQuery<{ table_name: string; index_name: string; per_layer: boolean }>(
        `SELECT c.relname::text AS table_name, ix.relname::text AS index_name,
                EXISTS (SELECT 1 FROM unnest(i.indkey::int2[]) AS k(attnum)
                          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                         WHERE a.attname = 'sensitivity_label') AS per_layer
           FROM pg_index i
           JOIN pg_class ix ON ix.oid = i.indexrelid
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND i.indisunique AND c.relkind IN ('r', 'p')
            AND EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
            AND NOT (i.indnkeyatts = 1 AND i.indpred IS NULL
                     AND (SELECT a.attname FROM pg_attribute a
                           WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id')
          ORDER BY c.relname, ix.relname`
      )
    );
    expect(keys.length).toBeGreaterThan(40);
    const unexplained = keys.filter((k) => !k.per_layer && !(k.index_name in KEPT)).map((k) => `${k.table_name}.${k.index_name}`);
    expect(
      unexplained,
      "These unique keys of labelled tables do not hold sensitivity_label and are not listed with a reason. " +
        "A key that is one for the whole deployment lets work at a label be stopped by, and told of, a row it may not read."
    ).toEqual([]);
    const names = new Set(keys.filter((k) => !k.per_layer).map((k) => k.index_name));
    const stale = Object.keys(KEPT).filter((name) => !names.has(name) && !ONE_LABEL_ONLY.has(name));
    expect(stale, "These keys are listed as kept and either no longer exist or now hold the label; take them off the list.").toEqual([]);
    for (const [name, reason] of Object.entries(KEPT)) expect(reason.length, name).toBeGreaterThan(20);
  });

  it("the guard against an unseen collision asks nothing about a key that holds the label", async () => {
    const [guard] = await withSystemClearance("A test reads the catalog.", () =>
      rawQuery<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'minerval_unseen_collision_guard'`)
    );
    expect(guard!.src).toContain("CONTINUE WHEN 'sensitivity_label' = ANY (columns)");
  });
});
