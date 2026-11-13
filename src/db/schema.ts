import {
  pgTable,
  pgView,
  uuid,
  text,
  real,
  integer,
  bigint,
  numeric,
  boolean,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  unique,
  index,
  check,
  customType,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";

// Custom pgvector type
const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    // Postgres returns vectors as '[0.1,0.2,...]'
    const str = String(value);
    return str
      .slice(1, -1)
      .split(",")
      .map(Number);
  },
});

// Custom tsvector type. The column is GENERATED ALWAYS from claims.text in
// the database (so it can never drift or be forgotten on insert) and is
// therefore read-only from the ORM.
const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tsvector";
  },
});

// Raw bytes (attachment bodies). Postgres bytea round-trips as a Buffer
// through node-postgres; Drizzle ships no bytea column, so this is the type.
const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// labels: who may read a row (src/labels.ts)
//
// A label is a row here, never a value in an enum or a CHECK, because each
// deployment defines its own and may define several restricted ones that are
// unrelated to each other. Labels are not ranked. Which labels a holder of
// one may also read is the pairs in label_reads: whoever is cleared for
// `label` may also read rows labelled `reads`. A label always reads itself,
// which needs no pair.
//
// The public graph has one label, 'public' (seeded by the migration that
// created the table), and no pairs. The rows that carry a label hold it in
// sensitivity_label, stamped from the run or request that writes them
// (currentLabel in llm/usage-context.ts). Two kinds of row carry one:
// what a run writes (the graph's content: nodes, edges, arguments, tags,
// definitions and formal statements; judgments and what each rested on;
// sources and what is read from them: instances, readings, provenance,
// examinations; the run itself and what it writes about itself: its
// steps, its usage rows, the parts of its setup, the investigations,
// reports, findings and audits it opens; and the rows work is asked for
// and governed with: requests, messages, petitions, mandates and their
// decisions, lookouts, correspondents, reviews, rulings, the audit trail),
// and work waiting to be done or resumed (a job, a ledger action, an
// order, a paused session), which hands its label to the run that later
// takes it up (runAtLabel). A claim and a source are both: work that
// starts from the claim or the source itself, with no row of its own to
// wait in, runs at that row's label. So are a mandate, a lookout, a
// correspondent and a request: the work that is theirs is opened at their
// label, whichever sweep starts it. The tables with no label are the
// accounts and keys, the owl ledger and payouts, the platform's own
// switches and counters, and the two tables here. One kind of row takes
// its label from neither a run nor a request: what is derived mechanically
// from a document (its segments, the notices against it) carries the
// document's label. Where a second label exists, every read and write is
// held to a clearance by row-level security on these tables (db/clearance.ts).
// ---------------------------------------------------------------------------
export const labels = pgTable(
  "labels",
  {
    name: text("name").primaryKey(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A label's name is written into a connection's settings (the clearance
    // a connection reads with, db/clearance.ts), so the table holds it to
    // the plain word the administrator's route already requires
    // (services/label-admin-service.ts): nothing in a name can end the
    // setting it is written in.
    // And not the word null, which in the array a connection's clearance
    // is written as is no label at all.
    check("labels_name_plain", sql`${table.name} ~ '^[a-z][a-z0-9_-]{0,62}$' AND ${table.name} <> 'null'`),
  ]
);

export const labelReads = pgTable(
  "label_reads",
  {
    label: text("label")
      .notNull()
      .references(() => labels.name),
    reads: text("reads")
      .notNull()
      .references(() => labels.name),
  },
  (table) => [
    primaryKey({ columns: [table.label, table.reads] }),
    // 'public' reads no other label: what it read, everyone would read.
    check("ck_label_reads_public_reads_nothing", sql`${table.label} <> 'public'`),
  ]
);

// The label column of a row that carries one. It is sensitivity_label, not
// label, because some tables that will need one already have a `label` that
// is a display name (actions, source_segments).
//
// The default is for an insert that does not say its label, and it is the
// label of the connection the insert arrives on (minerval_default_label(),
// defined in the migration that set it; db/clearance.ts says how a
// connection gets its label). So a write that forgot its stamp inside a
// run lands at the run's label, which is what the stamp would have said.
// Where the connection carries no label the default is 'public' only while
// 'public' is the one label the deployment has, which is every write on the
// public graph. Where a second label exists and nothing says which one the
// row is for, the insert is refused: a row is never public by omission.
const sensitivityLabelColumn = () =>
  text("sensitivity_label")
    .notNull()
    .default(sql`minerval_default_label()`)
    .references(() => labels.name);

// The one label a credential works at (src/server/request-labels.ts): an API
// key's, and an access token's. It is `work_label` and not sensitivity_label
// because it does not say who may read the row. A key and a token are the
// account's own and carry no label of that kind, and the step that holds
// every table with a sensitivity_label column to a clearance must not take
// these tables for labelled ones. A credential minted before a deployment
// had a second label works at 'public', which was the only label there was.
const workLabelColumn = () =>
  text("work_label")
    .notNull()
    .default("public")
    .references(() => labels.name);

// ---------------------------------------------------------------------------
// parties: whose material a source is (src/permissions.ts)
//
// Every private source belongs to a party: the organization that runs the
// deployment, or an outside party that supplied the material (a customer, a
// supplier, a developer whose system is being evaluated). A deployment holds
// material from as many parties as it deals with, so a party is a row and an
// engagement is never a new graph or a new account. The permission to
// release is granted for one party's material (permission_grants.party_id).
//
// At most one row is the organization itself (is_own_organization). The
// public graph has no parties and its sources have none.
// ---------------------------------------------------------------------------
export const parties = pgTable(
  "parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isOwnOrganization: boolean("is_own_organization").notNull().default(false),
    // The administrator who added it. Null only for a row no person added.
    createdBy: uuid("created_by").references((): AnyPgColumn => contributors.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One party per name, however it is capitalized.
    uniqueIndex("uq_parties_name").on(sql`lower(${table.name})`),
    uniqueIndex("uq_parties_own_organization")
      .on(table.isOwnOrganization)
      .where(sql`is_own_organization`),
  ]
);

// ---------------------------------------------------------------------------
// permission_grants: who may do what in a private deployment
// (src/permissions.ts)
//
// One row is one grant of one permission to one subject, and the same row
// later records its removal. Rows are never deleted or rewritten, so the
// table is the log of every grant and removal as well as the state: a grant
// is live while removed_at is null.
//
// The subject is an account or a named group, never both. A group is a name
// the identity provider put in a person's sign-in (account_groups); the
// grant reaches whoever's latest sign-in carried that name.
//
// The scope depends on the permission: the two reading permissions are held
// at a label, releasing is held for one party's material, and the rest have
// no scope. The CHECKs hold a row to that, so a grant that reads as wider
// than it was meant cannot be written.
//
// granted_via says how the grant came to be when no administrator made it:
// the deployment's first-administrator setting, or the operator key. Those
// are the two cases where granted_by is null.
//
// The public graph grants nothing and the table stays empty there.
// ---------------------------------------------------------------------------
export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    permission: text("permission").notNull(),
    accountId: uuid("account_id").references((): AnyPgColumn => contributors.id),
    groupName: text("group_name"),
    label: text("label").references(() => labels.name),
    partyId: uuid("party_id").references(() => parties.id),
    grantedBy: uuid("granted_by").references((): AnyPgColumn => contributors.id),
    grantedVia: text("granted_via").notNull().default("administrator"),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedBy: uuid("removed_by").references((): AnyPgColumn => contributors.id),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "ck_permission_grants_permission",
      sql`${table.permission} IN ('direct', 'release', 'fund', 'read', 'read_sources', 'administer')`
    ),
    check(
      "ck_permission_grants_subject",
      sql`(${table.accountId} IS NULL) <> (${table.groupName} IS NULL)`
    ),
    check(
      "ck_permission_grants_label_scope",
      sql`(${table.label} IS NOT NULL) = (${table.permission} IN ('read', 'read_sources'))`
    ),
    check(
      "ck_permission_grants_party_scope",
      sql`(${table.partyId} IS NOT NULL) = (${table.permission} = 'release')`
    ),
    check(
      "ck_permission_grants_granted_via",
      sql`${table.grantedVia} IN ('administrator', 'first_administrator', 'operator')`
    ),
    check(
      "ck_permission_grants_granted_by",
      sql`(${table.grantedBy} IS NOT NULL) = (${table.grantedVia} = 'administrator')`
    ),
    check(
      "ck_permission_grants_removal",
      sql`(${table.removedBy} IS NULL) OR (${table.removedAt} IS NOT NULL)`
    ),
    // One live grant of a permission, at a scope, per subject: granting what
    // is already held is refused, not stacked.
    uniqueIndex("uq_permission_grants_live_account")
      .on(
        table.accountId,
        table.permission,
        sql`coalesce(${table.label}, '')`,
        sql`coalesce(${table.partyId}, '00000000-0000-0000-0000-000000000000'::uuid)`
      )
      .where(sql`removed_at IS NULL AND account_id IS NOT NULL`),
    uniqueIndex("uq_permission_grants_live_group")
      .on(
        table.groupName,
        table.permission,
        sql`coalesce(${table.label}, '')`,
        sql`coalesce(${table.partyId}, '00000000-0000-0000-0000-000000000000'::uuid)`
      )
      .where(sql`removed_at IS NULL AND group_name IS NOT NULL`),
    index("idx_permission_grants_log").on(table.grantedAt),
  ]
);

// ---------------------------------------------------------------------------
// account_groups: the groups a person's latest sign-in carried
//
// The API never asks the identity provider anything. The web tier passes
// the group names from the sign-in's claims when it provisions the account,
// and they replace the account's rows here. asserted_at is that sign-in's
// time: a membership counts toward group grants only while it is recent
// (SIGN_IN_VALID_HOURS, src/permissions.ts), because a person removed from
// a group at the provider is not reported here by anything but their next
// sign-in.
// ---------------------------------------------------------------------------
export const accountGroups = pgTable(
  "account_groups",
  {
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => contributors.id, { onDelete: "cascade" }),
    groupName: text("group_name").notNull(),
    assertedAt: timestamp("asserted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.groupName] }),
    index("idx_account_groups_group").on(table.groupName),
  ]
);

// ---------------------------------------------------------------------------
// administrative_events: what administrators changed besides grants
//
// Append-only. A grant and its removal are logged in permission_grants
// itself. The other acts an administrator's permission covers change who
// may read or release without leaving a row that says so: defining a label,
// saying which label reads which (label_reads holds only what is true now),
// adding a party, and setting whose material a source is. Each writes one
// row here in the same transaction as the change, with what was changed in
// `detail`.
//
// `action` is a name the code gives the act ('label_defined',
// 'label_read_added', 'label_read_removed', 'party_added', 'own_organization_named',
// 'source_party_set', 'owls_created', 'standing_mandate_created'). It is not
// held to a list here, so that a later kind
// of administrative act is a new name and not a migration. actor_id is the
// administrator who did it; null only for a change no person made.
// ---------------------------------------------------------------------------
export const administrativeEvents = pgTable(
  "administrative_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: text("action").notNull(),
    actorId: uuid("actor_id").references((): AnyPgColumn => contributors.id),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_administrative_events_time").on(table.createdAt)]
);

// ---------------------------------------------------------------------------
// origin: which graph a row belongs to
//
// A private deployment holds a mirror of the public graph in the same tables
// as its own rows, because edges and judgments reference claims.id. A row
// that the mirror's applier wrote from the public graph's signed feed is
// 'mirror'; every other row is 'local', which is every row on the public
// graph. The tables that carry the column are the replicated ones
// (services/mirror-manifest.ts).
//
// A mirrored row is the public graph's, so nothing local may change what was
// replicated: the mirror_row_guard triggers (the migration that added the
// column) refuse an insert, update or delete of a 'mirror' row from any
// session but the applier's, apart from the columns that are this
// deployment's own working state on a claim (its queue state and the like).
// The triggers fire only for rows whose origin is 'mirror', so they do
// nothing where there are none.
//
// Identity is per graph. Where a replicated table has a key besides its id
// (a source's address, an edge's two nodes and relation, a link's pair, a
// question's pair of answers, a document's segment order, an argument's
// grouping of an edge, a quantity's definition, a claim's cut of a
// quantity), the unique index ends with `origin`. So a row this
// deployment made and the public graph's row for the same thing are two
// rows, the mirrored one always applies, and nothing this deployment holds
// can stop its mirror. Among a deployment's own rows the key is what it
// was, and on the public graph, where every row is 'local', the index
// holds exactly what it held before.
// ---------------------------------------------------------------------------
export const ROW_ORIGINS = ["local", "mirror"] as const;
export type RowOrigin = (typeof ROW_ORIGINS)[number];

const originColumn = () => text("origin").notNull().default("local");

const originCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} IN ('local', 'mirror')`);

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------
export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    text: text("text").notNull(),
    // What kind of node this is (constitution §2, §7a): a claim about a
    // proposition, a quantity (a value the discourse estimates), or a
    // question. NODE_KINDS in src/schemas/kinds.ts. A quantity's definition
    // and estimates live in quantity_definitions and quantity_estimates, a
    // question's standing in question_assessments; `assessments` holds
    // verdicts on propositions only.
    kind: text("kind").notNull().default("claim"),
    claimType: text("claim_type").notNull().default("empirical_derived"),
    // Claim lifecycle: 'active' (live), 'merged' (merge loser, aliased to the
    // survivor via mergedInto), 'deprecated' (reversed curator-created claim,
    // soft-deleted since downstream rows may reference it), 'archived' (retired
    // pipeline-epoch cohort, see scripts/archive-legacy-claims.ts). Keep in
    // sync with claimStateEnum in src/schemas/common.ts. Non-active claims stay
    // readable by direct id but leave search, matching, browse, trees, and the
    // steward queue — all read paths filter state = 'active' (allowlist, so any
    // new state defaults to hidden).
    state: text("state").notNull().default("active"),
    mergedInto: uuid("merged_into").references((): any => claims.id),
    decompositionStatus: text("decomposition_status")
      .notNull()
      .default("pending"),
    // How load-bearing the claim is (0..1), a revisable judgment set by the
    // Steward. Scales proportional effort and orders the Steward work queue so
    // important claims are processed first under a run budget (§"Claim Importance
    // and Proportional Effort"). 0.5 = default/medium until judged.
    importance: real("importance").notNull().default(0.5),
    // How live the claim is in the discourse (0..1), disputed or actively
    // consulted, recorded separately from importance (#172 phase 1). Today
    // importance fuses consequence-if-wrong with liveness; splitting the
    // liveness half out is the first step toward scheduling on stakes ×
    // expected-yield instead of one fused score. Recorded by the Extractor (prior) and the Steward (authoritative),
    // and read by the composite queue priority below.
    contestation: real("contestation"),
    // Composite BACKGROUND-QUEUE priority (the allocation core): the drain's
    // ordering key, computed from importance + expected yield (marginal_yield,
    // contestation) + user/grant stakes + staleness + provenance with legible
    // config weights (src/services/priority-service.ts). Deliberately a
    // SEPARATE column from importance: money and demand may buy queue
    // position, never epistemic standing (§19 as amended). Refreshed at
    // enqueue and by the allocation scheduler's sweep.
    queuePriority: real("queue_priority").notNull().default(0.5),
    // --- Steward work-queue state: the claim row IS the queue ---
    // A claim with steward_state='pending' is awaiting (re)processing by its
    // Steward; the drain always picks the highest-`importance` pending claim, so
    // under a budget the most load-bearing claims are stewarded and the rest stay
    // "embedded stubs". Re-triggers (a changed subclaim, a Curator action) just
    // set this back to 'pending', coalescing a propagation storm into one slot;
    // a re-trigger on a 'running' claim sets steward_requeued instead (#482).
    // Lifecycle: pending → running → done | error (→ pending again on re-trigger).
    // 'deferred' is a low-importance subclaim intentionally held OUT of the drain
    // (#98 economic brake): created and embedded/matchable but not recursively
    // decomposed. A re-trigger promotes it back to 'pending'.
    stewardState: text("steward_state").notNull().default("pending"),
    stewardTrigger: text("steward_trigger"),
    // Retired: messages for the Steward live in node_messages (the node's
    // inbox), whole. Nothing reads or writes this column; it stays only so
    // historical migrations that wrote it still apply.
    stewardContext: text("steward_context"),
    stewardError: text("steward_error"),
    // The class of steward_error, one of a few fixed words safe to publish
    // (steward-park-reason.ts). steward_error is raw text for logs and the
    // service-scoped report; every public surface shows this instead (#846).
    stewardErrorReason: text("steward_error_reason"),
    // While 'running' this is the run's lease: set when a lane claims the row
    // and refreshed by the run's heartbeat, so only a dead run goes stale
    // (steward-lease.ts).
    stewardedAt: timestamp("stewarded_at", { withTimezone: true }),
    // A message arrived while the claim was 'running' (#482). The row stays
    // 'running' — flipping it to 'pending' mid-run handed the claim to a
    // second lane while the first run was still writing — and the run's
    // release turns it into 'pending' so the message still gets its pass.
    stewardRequeued: boolean("steward_requeued").notNull().default(false),
    // Consecutive failed Steward attempts on this claim. Transient failures (API
    // budget/credit outage, 429, 5xx, network) return the claim to 'pending'
    // WITHOUT counting here — they are not the claim's fault (#97). Only genuine
    // logic errors increment it; the claim parks as 'error' once it hits the
    // attempt cap, so a truly poison claim stops spinning while a transient
    // outage never permanently strands the graph.
    stewardAttempts: integer("steward_attempts").notNull().default(0),
    // --- Steward-seeded prior (#285) ---
    // When a parent claim's Steward mints this claim as a subclaim during
    // decomposition, it may seed a prior credence (its probability the subclaim
    // is true) and a brief preliminary note. Deliberately columns on the claim
    // row, NOT an assessments row: the seed must never satisfy an is_current
    // assessment query, appear in assessment history, or move the claim out of
    // "unassessed" — it is a hint that lowers the eventual Steward's activation
    // energy, colorable in scan-over-many views but never a verdict. Read paths
    // stop serving it the moment the claim gains a current assessment. The
    // decomposition path only: Extractor-minted claims never carry one (their
    // source would bias the prior). NULL = no seed.
    seedCredence: real("seed_credence"),
    seedNote: text("seed_note"),
    // Which claim's Steward wrote the seed — the provenance the mechanical
    // "preliminary" disclaimer names. SET NULL so the seed survives its author.
    seedSourceClaimId: uuid("seed_source_claim_id").references(
      (): any => claims.id,
      { onDelete: "set null" }
    ),
    // Why the canonical form is stated in the direction it is (#360). A claim
    // and its denial are one node, so the form has a polarity and every
    // instance's stance is read against it. The direction is chosen on the
    // proposition's own terms (the affirmative form of the question as the
    // discourse poses it), never inherited from whichever source arrived
    // first; this note records the Matcher's one-sentence reason so a later
    // agent re-judging the wording does not silently re-invert it and flip
    // every recorded stance. NULL for claims minted before the note existed
    // or by paths that do not run the Matcher's direction judgment.
    canonicalDirectionNote: text("canonical_direction_note"),
    // Domain tags (docs/mathematics.md §2.1, §3.4): the skill names whose
    // domain skills (skills/<name>/SKILL.md) and tools a run on this claim
    // carries. A recorded admin judgment, never a filter: the Extractor emits
    // a prior, a new subclaim inherits its parent's tags, the Steward's
    // set_claim_domains is authoritative, and the backfill script tags the
    // pre-skills cohort by embedding centroid. Empty = no domain skill.
    domains: text("domains").array().notNull().default([]),
    // Which path wrote `domains`: extractor | matcher | inherited | steward |
    // backfill. NULL = never tagged.
    domainsSource: text("domains_source"),
    // --- Tagging queue: the claim row IS the queue, as for the Steward ---
    // NULL = awaiting the tagger (a new claim, a backfill candidate, or a
    // claim whose canonical form changed and must be re-read). Set when a
    // tagger run has attached its tags (or found none worth attaching). The
    // tags themselves live in `taggings` (subject_kind = 'claim').
    taggedAt: timestamp("tagged_at", { withTimezone: true }),
    // The drain's lease: set when a worker takes the row, cleared when the
    // run settles. A lease older than the reclaim window is a crashed worker
    // and the row is retaken; a leased row never looks tagged.
    taggingLeasedAt: timestamp("tagging_leased_at", { withTimezone: true }),
    // Consecutive failed tagger attempts; a claim parks out of the drain at
    // the cap (tagging-pipeline.ts), the same poison-row discipline as
    // steward_attempts. Transient failures do not count.
    taggingAttempts: integer("tagging_attempts").notNull().default(0),
    embedding: vector("embedding"),
    textSearch: tsvector("text_search").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${claims.text})`
    ),
    // Which pipeline epoch minted this claim (config.pipelineEpoch at creation).
    // An epoch names a prompt/constitution era; when agent behavior changes
    // materially, the epoch is bumped and the previous cohort can be archived
    // wholesale (scripts/archive-legacy-claims.ts). NULL = legacy claims created
    // before stamping existed (the pre-2026-07 physics seed cohort).
    pipelineEpoch: text("pipeline_epoch"),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this node (src/labels.ts), stamped from the usage context
    // when it is minted. Work that starts from the claim itself, outside any
    // run, runs at this label.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_claims_origin", table.origin),
    index("idx_claims_state").on(table.state),
    check("ck_claims_kind", sql`${table.kind} IN ('claim', 'quantity', 'question')`),
    index("idx_claims_updated").on(table.updatedAt),
    // Drain ordering: among pending claims, highest composite priority first.
    // The partial index keeps it small (only the live work queue) and fast as
    // the graph grows.
    index("idx_claims_steward_queue")
      .on(table.queuePriority.desc(), table.updatedAt)
      .where(sql`steward_state = 'pending'`),
    // Keyword search (`text_search @@ websearch_to_tsquery(...)`) scans this,
    // not the heap, as the graph grows.
    index("idx_claims_text_search").using("gin", table.textSearch),
    // "Every claim tagged mathematics" is a query the skilled mandates and the
    // backfill run; GIN serves the array-overlap operators.
    index("idx_claims_domains").using("gin", table.domains),
    // The tagging drain: only the untagged live rows, highest importance
    // first, so under a budget the load-bearing claims are labelled first.
    index("idx_claims_tagging_queue")
      .on(table.importance.desc(), table.updatedAt)
      .where(sql`tagged_at IS NULL AND state = 'active'`),
  ]
);

// ---------------------------------------------------------------------------
// tags — the graph's open topical vocabulary (#272)
// ---------------------------------------------------------------------------
// A tag names a topic claims are ABOUT ("Vaccine safety", "Prime numbers",
// "Monetary policy"): the reader's and the agents' navigation layer over the
// embedding space, which the decomposition graph does not provide. Three
// things it is not: not `claims.claim_type` (the proposition-kind facet), not
// `claims.domains` (the closed list of skill names that select an agent's
// prompt and tools), and not a verdict of any kind. The vocabulary is open
// and grows as claims land; each tag carries its own embedding so the tagger
// can find an existing tag by meaning before minting a near-duplicate, and a
// merge lifecycle (`merged_into`) so the vocabulary can be tidied without
// rewriting history.
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // URL-safe identity: lowercase, hyphenated, unique. The stable handle in
    // filters (`?tag=vaccine-safety`) and links.
    slug: text("slug").notNull(),
    // Reader-facing name, Title Case noun phrase.
    name: text("name").notNull(),
    // One or two sentences delimiting the topic: what falls under it and,
    // where it matters, what does not. Embedded together with the name.
    description: text("description").notNull().default(""),
    embedding: vector("embedding"),
    // active | merged. A merged tag keeps its row (links resolve, history
    // stays honest) and points at the survivor.
    status: text("status").notNull().default("active"),
    mergedInto: uuid("merged_into").references((): any => tags.id, {
      onDelete: "set null",
    }),
    // Who minted it: tagger | cluster_seed | operator | steward | curator.
    createdBy: text("created_by").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_tags_slug").on(table.slug),
    index("idx_tags_status").on(table.status),
    check("ck_tags_status", sql`${table.status} IN ('active', 'merged')`),
  ]
);

// ---------------------------------------------------------------------------
// taggings — a tag attached to a subject, as a traced judgment
// ---------------------------------------------------------------------------
// Polymorphic on purpose: claims are the first subject, but a source's topics,
// a mandate's scope, and an agent report's area are the same relation, and
// one join table with a `subject_kind` serves them all without a migration
// per kind. The cost is that the subject carries no FK; claims are never
// deleted (they change state), so the rows cannot orphan in practice, and a
// read always joins through the subject table it names. Every row records
// which path attached it (`source`), how confident that path was, why, and
// the agent run it came from, so "why is this claim tagged X" has an answer.
export const TAG_SUBJECT_KINDS = ["claim", "source", "mandate"] as const;
export type TagSubjectKind = (typeof TAG_SUBJECT_KINDS)[number];

export const taggings = pgTable(
  "taggings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    // tagger | cluster_seed | steward | curator | operator. The tagger
    // replaces only its own rows on a re-run; a judgment recorded by an
    // administrator or an operator stands until that path removes it.
    source: text("source").notNull(),
    confidence: real("confidence"),
    reasoning: text("reasoning"),
    // The agent_runs row that attached it (no FK, like llm_usage).
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_taggings_tag_subject").on(
      table.tagId,
      table.subjectKind,
      table.subjectId
    ),
    index("idx_taggings_subject").on(table.subjectKind, table.subjectId),
    index("idx_taggings_tag").on(table.tagId, table.subjectKind),
    check(
      "ck_taggings_subject_kind",
      sql`${table.subjectKind} IN ('claim', 'source', 'mandate')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// claim_relationships
// ---------------------------------------------------------------------------
export const claimRelationships = pgTable(
  "claim_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentClaimId: uuid("parent_claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    childClaimId: uuid("child_claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("requires"),
    // On an 'answers' edge (KIND_RELATION_TYPES in src/schemas/kinds.ts):
    // why the answer is in the question's set, its quality, its prominence,
    // or both (§7a). NULL on every other edge.
    answerBasis: text("answer_basis"),
    // Which named argument(s) an edge belongs to is NOT a column here: it is
    // the argument_subclaims relation below, so one edge can be grouped under
    // several arguments of the same claim (constitution §7, #437). An edge
    // with no membership row is part of the claim's ungrouped basis.
    reasoning: text("reasoning").notNull(),
    confidence: real("confidence").notNull().default(1.0),
    createdBy: text("created_by").notNull().default("decomposer"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_claim_relationships_origin", table.origin),
    // One edge for a parent, a child and a relation, in each graph (the
    // origin column, above).
    uniqueIndex("idx_cr_unique").on(
      table.parentClaimId,
      table.childClaimId,
      table.relationType,
      table.origin
    ),
    index("idx_cr_parent").on(table.parentClaimId),
    index("idx_cr_child").on(table.childClaimId),
    check(
      "no_self_reference",
      sql`${table.parentClaimId} != ${table.childClaimId}`
    ),
    check(
      "ck_cr_answer_basis",
      sql`${table.answerBasis} IS NULL OR (${table.relationType} = 'answers' AND ${table.answerBasis} IN ('quality', 'prominence', 'both'))`
    ),
  ]
);

// ---------------------------------------------------------------------------
// claim_links (#436)
// ---------------------------------------------------------------------------
// Lateral, symmetric, non-evaluative relations between claims (constitution
// §19's third direction). Kept OUT of claim_relationships on purpose: that
// table is the dependency graph propagation walks, and a see-also must never
// be read as a premise. The pair is stored in canonical order (a < b), so
// one row represents the link in both directions and the unique index
// catches a reverse-direction duplicate; the check also rules out self-links.
export const claimLinks = pgTable(
  "claim_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimAId: uuid("claim_a_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    claimBId: uuid("claim_b_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // CLAIM_LINK_KINDS in src/schemas/common.ts.
    kind: text("kind").notNull(),
    reasoning: text("reasoning").notNull(),
    createdBy: text("created_by").notNull().default("curator"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_claim_links_origin", table.origin),
    uniqueIndex("idx_claim_links_unique").on(
      table.claimAId,
      table.claimBId,
      table.kind,
      table.origin
    ),
    index("idx_claim_links_b").on(table.claimBId),
    check("ck_claim_links_ordered", sql`${table.claimAId} < ${table.claimBId}`),
    check(
      "ck_claim_links_kind",
      sql`${table.kind} IN ('related', 'rival_explanation', 'counterpart_position')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// assessments
// ---------------------------------------------------------------------------
export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // One of assessmentStatusEnum (src/schemas/common.ts): verified |
    // supported | inconclusive | doubtful | contradicted | unknown. Plain
    // text, no CHECK; migration 0066 retired contested and unsupported (#524).
    status: text("status").notNull(),
    // Verdict confidence: how sure the Steward is that `status` is the right
    // reading of the evidence. Meta by design; NOT the probability that the
    // claim is true (a claim can be confidently inconclusive).
    confidence: real("confidence").notNull(),
    // Credence: the Steward's probability that the claim, as stated, is true.
    // Nullable by design (constitution §7): where a single number would be
    // false precision (normative/evaluative claims, entangled composites) no
    // credence is stated, and the omission is itself information.
    claimCredence: real("claim_credence"),
    // Reader-facing explanation shown front-and-centre on the claim page: a
    // welcoming, encyclopedia-style account of the best state of knowledge and
    // where credible disagreement lies. Distinct from reasoningTrace, which is
    // the transparent audit detail. Nullable for back-compat: assessments
    // written before this split fall back to reasoningTrace in the UI.
    summary: text("summary"),
    reasoningTrace: text("reasoning_trace").notNull(),
    // Marginal yield (0..1): the Steward's exit judgment of how much another,
    // stronger pass would improve this assessment (#172 phase 1). Near zero
    // once an uncontested fact is assessed or a values dispute is mapped to
    // its terminal disagreement; high when the pass hit evidence it could not
    // fully digest. Recorded but not yet read by scheduling — phase 3 of #172
    // will derive re-assessment priority from it. NULL = not stated (legacy
    // assessments predate the field); an unassessed claim's yield is treated
    // as maximal by convention.
    marginalYield: real("marginal_yield"),
    // Raw API id of the model that produced this assessment (#294), e.g.
    // "claude-opus-5-5" — a verdict is only as trustworthy as its assessor, so
    // the assessor is recorded on the verdict, not just in llm_usage. Nullable:
    // legacy rows predate the column and degrade gracefully (date only in UI).
    model: text("model"),
    // Funding disclosure (§19 "Queue Priority and Paid Attention"): when the
    // run that wrote this assessment was paid for — an assessment order or a
    // grant's budget job — the payer's job id is stamped here MECHANICALLY
    // from the usage context (never by the agent), so "who funded this
    // verdict" is always answerable. NULL = ordinary system work.
    fundedByJobId: uuid("funded_by_job_id"),
    // The skills the writing run had loaded when it wrote this (skill
    // names), stamped from the usage context by update_claim_assessment, so
    // "which assessments were made under the Mathematics skill" is a query.
    // NULL = legacy rows from before skills existed; [] = a run that had
    // loaded none.
    skills: text("skills").array(),
    // The agent run that wrote this assessment, stamped from the usage
    // context (never by the agent), so the transcript behind a verdict is
    // one join away. Such a run is kept for good. No FK, like llm_usage.run_id.
    // NULL = written outside a traced run, or before the column existed and
    // not matched by the backfill in the migration that added it.
    runId: uuid("run_id"),
    // Whether what this judgment was made against was recorded with it
    // (judgment_inputs, #566). False on judgments from before that record,
    // which therefore cannot be said to be stale or fresh by it.
    inputsRecorded: boolean("inputs_recorded").notNull().default(false),
    isCurrent: boolean("is_current").notNull().default(true),
    subclaimSummary: jsonb("subclaim_summary").notNull().default({}),
    trigger: text("trigger"),
    triggerContext: text("trigger_context"),
    assessedAt: timestamp("assessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The retired status this row carried before migration 0066 relabeled
    // it (#524, #848): 'contested' (now inconclusive) or 'unsupported' (now
    // unknown). Backfilled by migration 0112 from the note 0066 appended to
    // reasoning_trace. A Steward never writes it, so a node clears it when it
    // is re-judged; set on a current row, it means the status is provisional,
    // not a finding. NULL on every other row.
    relabeledFrom: text("relabeled_from"),
    // Who may read this verdict (src/labels.ts), stamped from the usage
    // context by update_claim_assessment, never by the agent.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_assessments_origin", table.origin),
    // One current verdict per claim, where the deployment has one label,
    // which is how the public graph runs: this is the index it has always
    // had, and it is what tells the planner that a claim has at most one
    // current row, which the plans of every read of the judgment in force
    // rest on.
    //
    // Where a deployment has more than one label a node may carry a version
    // at each, written by work at that label and replaced only by it
    // (src/labels.ts, "A judgment at each label"), and this index cannot
    // hold. The step that turns enforcement on (minerval_enforcement_sync)
    // drops it there and creates idx_assessments_current_at_label in its
    // place, unique on the claim and the label, and puts this one back when
    // the last other label goes. So the database, not this file, says which
    // of the two exists, and a later migration must not name either (a test
    // holds that). The same holds for the current-row indexes on
    // argument_evaluations, quantity_estimates and question_assessments.
    // Which version a reader goes by is the *_in_force views' to say, at
    // the end of this file.
    uniqueIndex("idx_assessments_current")
      .on(table.claimId)
      .where(sql`${table.isCurrent} = true`),
    // The change stream reads assessments in the order they were written
    // (services/graph-change-service.ts, #562 / #563).
    index("idx_assessments_assessed_at").on(table.assessedAt, table.id),
  ]
);

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------
export const arguments_ = pgTable(
  "arguments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    name: text("name"),
    description: text("description"),
    stance: text("stance").notNull(),
    // What an argument about a quantity shows about its value (§7): the
    // Steward's words and, where the argument places the value on its axis,
    // a range ({side: at|about|between|above|below, low, high, inclusive}).
    // valueShownSchema in src/schemas/kinds.ts. NULL for arguments about
    // propositions, which carry a stance instead.
    shows: jsonb("shows"),
    content: text("content").notNull(),
    // The accepted Lean check that makes this a machine-checked argument
    // (docs/mathematics.md §2.3), when it is one. It replaced a
    // /lean-checks/<id> entry in the old evidence_urls column (#541); the
    // badge, the claim record and the attempt stats read it.
    leanCheckId: uuid("lean_check_id").references((): AnyPgColumn => leanChecks.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft retirement by the claim's Steward (retire_argument, #741): an
    // argument that no longer belongs on the claim (§7) is retired, but
    // the row and its evaluations stay as history. Readers that list a
    // claim's arguments skip retired ones; its subclaims were released to
    // the basis (or their other arguments) when it was retired.
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredReason: text("retired_reason"),
    // Set when the Curator merges this argument into another on the same
    // claim (§5, #541): the two were one inference to one conclusion. The
    // absorbed row is kept as an alias, retired with the reason, its
    // evaluations as history; its instances and premise groupings moved to
    // the survivor. Cleared by the merge's undo.
    mergedInto: uuid("merged_into").references((): AnyPgColumn => arguments_.id, {
      onDelete: "set null",
    }),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_arguments_origin", table.origin),index("idx_arguments_claim").on(table.claimId)]
);

// ---------------------------------------------------------------------------
// argument_evidence_backlog (#541)
// ---------------------------------------------------------------------------
// Source URLs that were attached to an argument without a passage or a
// stance: the old arguments.evidence_urls column, and URLs PATCH
// /claims/:id is still given. A URL is not an instance (§4 asks for the
// passage and how it stands), so each is sent to the claim's Steward, who
// reads the source and records an instance if it makes, attacks or
// mentions the argument. sent_at marks the message; the row stays as the
// record of what was attached.
export const argumentEvidenceBacklog = pgTable(
  "argument_evidence_backlog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    argumentId: uuid("argument_id")
      .notNull()
      .references((): AnyPgColumn => arguments_.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [uniqueIndex("idx_argument_evidence_backlog_url").on(table.argumentId, table.url)]
);

// ---------------------------------------------------------------------------
// argument_instances (#541)
// ---------------------------------------------------------------------------
// Where a source makes, attacks or mentions an argument: the counterpart of
// claim_instances for the argument layer (§4, §7). An argument is canonical
// and belongs to no one who makes it; each row is one passage's use of it.
// Instances are provenance. They do not set the written form (fidelity
// governs the passage's reading, recorded here, not the argument), do not
// rate the inference, and bear only weakly on whether the argument belongs
// on its claim (§7). A retired argument keeps its instances, and new ones
// may still be recorded on it: retiring preserves its record.
export const argumentInstances = pgTable(
  "argument_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The argument the passage makes, attacks or mentions. Null while the
    // passage is unplaced: ingestion found reasoning about a claim that
    // matched none of the claim's arguments, and only the claim's Steward
    // creates arguments (Part VIII), so the passage waits on the claim
    // (claim_id) for the Steward to place or dismiss. Exactly one of the
    // two is set (ck_argument_instances_placed).
    argumentId: uuid("argument_id").references((): AnyPgColumn => arguments_.id, {
      onDelete: "cascade",
    }),
    claimId: uuid("claim_id").references((): AnyPgColumn => claims.id, { onDelete: "cascade" }),
    // An unplaced passage's side on its claim as canonically worded: for,
    // against, or null where it cannot be told (a passage attacking
    // reasoning, or a quantity, which has no sides). A placed passage takes
    // its side from its argument. Flipped when a merge joins the claim to
    // its negation.
    direction: text("direction"),
    // Set when the claim's Steward dismisses an unplaced passage (it makes
    // no argument the claim's page should carry, or none at all): the row
    // is kept as provenance with the reason.
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedReason: text("dismissed_reason"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // The passage as this source states (or attacks, or mentions) the
    // argument, verbatim.
    verbatimText: text("verbatim_text").notNull(),
    context: text("context"),
    // ARGUMENT_INSTANCE_STANCES in schemas/common.ts: advances | criticizes
    // | mentions. Free text, like claim_instances.stance.
    stance: text("stance").notNull(),
    // ARGUMENT_READINGS: how well the passage states the argument (full |
    // premise_unstated | strawman). Null when not judged, as for a mention.
    reading: text("reading"),
    // On an argument about a quantity: what the source says the argument
    // shows, as stated, in the valueShownSchema shape. The argument's own
    // `shows` is the graph's judgment; a source's different range from the
    // same inference is recorded here, as §4 records a source's figure.
    statedShows: jsonb("stated_shows"),
    speaker: text("speaker"),
    publication: text("publication"),
    sourceDate: text("source_date"),
    link: text("link"),
    // claim_steward | researcher | matcher (ingestion)
    createdBy: text("created_by").notNull(),
    segmentId: uuid("segment_id").references((): AnyPgColumn => sourceSegments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_argument_instances_origin", table.origin),
    index("idx_argument_instances_argument").on(table.argumentId),
    index("idx_argument_instances_claim").on(table.claimId),
    index("idx_argument_instances_source").on(table.sourceId),
    check(
      "ck_argument_instances_placed",
      sql`(${table.argumentId} IS NULL) <> (${table.claimId} IS NULL)`
    ),
  ]
);

// ---------------------------------------------------------------------------
// argument_subclaims
// ---------------------------------------------------------------------------
// Argument membership (#437): which decomposition edges a named argument
// groups. Many-to-many on purpose — constitution §7 says different arguments
// may share subclaims while arranging them differently, which a single
// argument_id on the edge could not express. Membership points at the EDGE
// (not the child claim) so the relation type travels with it and a grouping
// can never dangle: deleting the edge, or the argument, removes the row.
// An edge with no row here is one of the claim's ungrouped basis edges.
// Invariant (enforced in relationship-service, not by the FKs): the
// argument's claim is the edge's parent claim.
export const argumentSubclaims = pgTable(
  "argument_subclaims",
  {
    argumentId: uuid("argument_id")
      .notNull()
      .references(() => arguments_.id, { onDelete: "cascade" }),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => claimRelationships.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_argument_subclaims_origin", table.origin),
    // In each graph (the origin column, above): a grouping this deployment
    // recorded and the public graph's own of the same edge are two rows.
    primaryKey({ columns: [table.argumentId, table.relationshipId, table.origin] }),
    index("idx_argument_subclaims_relationship").on(table.relationshipId),
  ]
);

// ---------------------------------------------------------------------------
// argument_evaluations
// ---------------------------------------------------------------------------
// The steward's judgment of a named argument (issue #173): whether the
// inference goes through granting its premises, and which premises currently
// bear the weight. The argument row itself stays structural (its written form
// states the inference without judging it); this table is the epistemic
// overlay, derived within the claim's assessment process so it tracks premise
// assessments rather than drifting as a fire-once verdict.
export const argumentEvaluations = pgTable(
  "argument_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    argumentId: uuid("argument_id")
      .notNull()
      .references(() => arguments_.id, { onDelete: "cascade" }),
    // How far the conclusion follows if the premises hold (#540):
    //   certain | likely | slight | none
    // A rating of the inference, not of the conclusion: whether the premises
    // hold is read from their own assessments. Rows written under the older
    // holds | holds_with_caveats | fails | contested scale are history only
    // (is_current = false since migration 0072).
    verdict: text("verdict").notNull(),
    // The Steward's judgment that the argument, taken alone and with its
    // premises as they are now assessed, settles its conclusion (§7). Lapses
    // with its premises: reconsidered whenever one of them is reassessed.
    decisive: boolean("decisive").notNull().default(false),
    // Reader-facing prose (2–4 sentences, §12 voice): whether the inference
    // goes through and which premises, given their current assessments, the
    // argument lives or dies on — those premises referenced inline as
    // [[claim:<uuid>]], same syntax as the written form.
    content: text("content").notNull(),
    // Provenance: the claim assessment this evaluation was derived under. An
    // evaluation whose assessment is no longer current is detectably stale.
    // SET NULL (not cascade): assessment rows are append-only history, but an
    // evaluation should survive its provenance pointer.
    assessmentId: uuid("assessment_id").references(() => assessments.id, {
      onDelete: "set null",
    }),
    // On a quantity, the estimate the evaluation was made under (§7, §10):
    // a quantity has no verdict, so its evaluations are dated against its
    // estimates instead of its assessments.
    estimateId: uuid("estimate_id").references((): AnyPgColumn => quantityEstimates.id, {
      onDelete: "set null",
    }),
    isCurrent: boolean("is_current").notNull().default(true),
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this evaluation (src/labels.ts), stamped from the usage
    // context when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_argument_evaluations_origin", table.origin),
    index("idx_argument_evaluations_argument").on(table.argumentId),
    // One for each node where the deployment has one label, and one for
    // each node and label (idx_argument_evaluations_current_at_label) where it has more:
    // see idx_assessments_current.
    uniqueIndex("idx_argument_evaluations_current")
      .on(table.argumentId)
      .where(sql`${table.isCurrent} = true`),
  ]
);

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  // One row for an address in each graph (uq_sources_url_origin, below).
  url: text("url"),
  title: text("title").notNull(),
  // SHA-256 of raw_content, written when the text is first stored
  // (services/source-content.ts). Not unique: one document can be held at
  // two addresses.
  contentHash: text("content_hash"),
  rawContent: text("raw_content"),
  sourceType: text("source_type").notNull().default("unknown"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Facts about the document that need no judgment (#507, phase 3), written
  // by the facts fetcher (services/source-facts-service.ts) from the page's
  // own metadata and, where the document has a DOI, from Crossref. Each is
  // filled once and never overwritten by a later guess; null means nobody
  // could find it, which the source page says rather than hides.
  authors: text("authors").array(),
  publisher: text("publisher"),
  // ISO-8601 to whatever precision is known ("2023", "2023-05",
  // "2023-05-14"): the same convention as claim_instances.source_date, so
  // the precision is the length of the string and needs no column of its own.
  publishedDate: text("published_date"),
  // Lower case, without the resolver prefix.
  doi: text("doi"),
  // A copy in a public web archive, so a page that changes or disappears
  // can still be read as it was.
  archivedUrl: text("archived_url"),
  factsCheckedAt: timestamp("facts_checked_at", { withTimezone: true }),
  // SHA-256 of the URL as a web page's identity (services/page-url.ts): the
  // key the browser extension looks a page up by, so a reader of a page the
  // graph holds as a source sees the passages recorded from it
  // (services/recorded-page-service.ts). Not unique: two rows whose URLs
  // differ only in what normalization drops are the same page. Set when the
  // row is created and filled for older rows at startup; '' marks a URL that
  // is not a web page, null one not yet looked at.
  pageUrlHash: text("page_url_hash"),
  // Who may read this document (src/labels.ts): the label of the run or
  // request that first recorded it.
  sensitivityLabel: sensitivityLabelColumn(),
  // Which graph the row belongs to (the origin column, above).
  origin: originColumn(),
  // Whose material this is (parties above): the organization itself or an
  // outside party that supplied it. Null on the public graph, where no
  // source belongs to a party, and until an administrator says. Each change
  // is logged in administrative_events.
  partyId: uuid("party_id").references(() => parties.id),
}, (table) => [
  originCheck("ck_sources_origin", table.origin),
  // A document this deployment recorded and the public graph's row for the
  // same address are two rows (the origin column, above). A read by
  // address takes one of them (services/mirrored-node-service.ts,
  // oneSourceForAddressSql).
  uniqueIndex("uq_sources_url_origin").on(table.url, table.origin),
  index("idx_sources_doi").on(table.doi),
  index("idx_sources_content_hash").on(table.contentHash),
  index("idx_sources_page_url_hash").on(table.pageUrlHash),
  // The one list of source kinds: SOURCE_KIND_DESCRIPTIONS in
  // src/schemas/common.ts (tests/unit/schemas/source-kinds.test.ts holds the
  // two together).
  check(
    "ck_sources_source_type",
    sql`${table.sourceType} IN ('dataset', 'official_statistics', 'transcript', 'treaty', 'court_record', 'legislation', 'journal_article', 'preprint', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'standard', 'news_article', 'opinion', 'press_release', 'blog_post', 'social_media_post', 'reference_work', 'broadcast', 'webpage', 'shown_page', 'published_page', 'unknown')`
  ),
]);

// ---------------------------------------------------------------------------
// source_events (#507, phase 3)
//
// What has happened to a document since it was published: a correction, a
// retraction, an expression of concern, an update, a removal. Facts with a
// date and, where there is one, the notice that announced them. Written by
// the watchers (the Crossref poll, the facts fetcher's DOI check), never by
// an agent's judgment, and claim-independent: what a retraction means for a
// given claim is that claim's Steward's to say.
// ---------------------------------------------------------------------------
export const sourceEvents = pgTable(
  "source_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // SOURCE_EVENT_KINDS in src/schemas/common.ts.
    kind: text("kind").notNull(),
    // When it happened, as the notice dates it; null when it does not.
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The notice itself, where there is one. Part of the identity of an
    // event: one paper can carry two corrections.
    noticeUrl: text("notice_url").notNull().default(""),
    note: text("note"),
    // Which watcher recorded it ("crossref_poll", "facts_fetch").
    detectedBy: text("detected_by").notNull(),
    // Who may read this row (src/labels.ts): the label of the source the
    // notice is against, whoever recorded it. A notice is looked up about
    // the document and holds no judgment of the run that asked.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_source_events_unique").on(table.sourceId, table.kind, table.noticeUrl),
    check(
      "ck_source_events_kind",
      sql`${table.kind} IN ('correction', 'retraction', 'expression_of_concern', 'update', 'removal')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// source_segments (#507, phase 4)
//
// A document's own structure: its sections, and within them the passages,
// tables, notes, and references, in order. The source page follows this
// structure rather than any claim's, and every annotation on the page (an
// instance, an examination's coverage, a finding) is anchored to a segment,
// so that the many claims a document carries share one map of it.
//
// Offsets index the document's READABLE text (htmlToText of raw_content),
// the same text provenance_read_source returns and the quote check reads,
// so an offset an agent sees and an offset stored here agree. text_hash is
// the sha256 of the segment's text, so a later copy of the document that
// differs can be detected rather than silently mis-anchored.
// ---------------------------------------------------------------------------
export const sourceSegments = pgTable(
  "source_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // The enclosing section; null at the top level.
    parentId: uuid("parent_id").references((): AnyPgColumn => sourceSegments.id, {
      onDelete: "cascade",
    }),
    // Position in document order, across the whole source.
    ordinal: integer("ordinal").notNull(),
    // A section's heading, a table's caption number; null for a passage.
    label: text("label"),
    // SOURCE_SEGMENT_KINDS in src/schemas/common.ts.
    kind: text("kind").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    textHash: text("text_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts): the source's label, whoever
    // segmented it, because the segments are computed from the document's
    // text. Not `label` above, which is the heading a reader sees.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_source_segments_origin", table.origin),
    uniqueIndex("idx_source_segments_order").on(table.sourceId, table.ordinal, table.origin),
    index("idx_source_segments_parent").on(table.parentId),
    check(
      "ck_source_segments_kind",
      sql`${table.kind} IN ('section', 'passage', 'table', 'note', 'reference')`
    ),
    check("ck_source_segments_span", sql`${table.charStart} >= 0 AND ${table.charEnd} >= ${table.charStart}`),
  ]
);

// ---------------------------------------------------------------------------
// examinations (#507, phase 5)
//
// An in-depth check of one document, as a record of its own: what was asked
// (the brief and the facets to check: the data, the quotation, the method),
// who asked and why (while assessing a claim, or as a review of the document
// itself), what was actually examined (coverage, by segment and facet), and
// what was found, each finding anchored to the passage it is about.
//
// There is no verdict on the source and no accept/reject on a finding.
// Findings stay attributed to the run that produced them; each claim's
// Steward decides what a finding means for its claim and cites it from its
// reading (reading_citations), and the Audit agent may annotate a finding
// about the document (audit_notes). That is how a fair picture of a source
// builds up from many claims' work without any one viewpoint owning it.
// ---------------------------------------------------------------------------
export const examinations = pgTable(
  "examinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // EXAMINATION_SCOPES: 'claim' (commissioned while assessing a claim) or
    // 'document' (a review of the document for its own sake).
    scope: text("scope").notNull(),
    // EXAMINATION_TRIGGERS: who decided to spend on it. 'claim' (a Steward),
    // 'request' (whoever funded a request bearing on the document, #865),
    // 'mandate' (a Grantmaker, before #602 kept mandate research off the
    // graph), or 'mechanical' (never written).
    trigger: text("trigger").notNull(),
    // The commissioning claim, for a claim-scoped examination. SET NULL: the
    // findings are about the document and outlive the claim.
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "set null" }),
    grantId: uuid("grant_id"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    brief: text("brief").notNull(),
    // What to check, as short labels ("data", "quotation", "method").
    facets: text("facets").array().notNull(),
    requestedBy: text("requested_by").notNull(),
    // The request a document review was asked for in (#865): its runs take
    // up that request, and every stage of it records onto this one
    // examination. SET NULL: the findings are the document's and outlive it.
    requestId: uuid("request_id").references((): AnyPgColumn => requests.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_examinations_source").on(table.sourceId),
    index("idx_examinations_claim").on(table.claimId),
    index("idx_examinations_request").on(table.requestId),
    check("ck_examinations_scope", sql`${table.scope} IN ('claim', 'document')`),
    check("ck_examinations_trigger", sql`${table.trigger} IN ('claim', 'request', 'mechanical', 'mandate')`),
  ]
);

/** Which parts of the document an examination actually looked at, for which facet. */
export const examinationCoverage = pgTable(
  "examination_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    examinationId: uuid("examination_id")
      .notNull()
      .references(() => examinations.id, { onDelete: "cascade" }),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => sourceSegments.id, { onDelete: "cascade" }),
    facet: text("facet").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_examination_coverage_unique").on(table.examinationId, table.segmentId, table.facet),
  ]
);

/** What an examination found, anchored to a passage. No status: findings are attributed, never ruled on. */
export const examinationFindings = pgTable(
  "examination_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    examinationId: uuid("examination_id")
      .notNull()
      .references(() => examinations.id, { onDelete: "cascade" }),
    // The passage the finding is about. SET NULL if the document is
    // re-segmented; the evidence still quotes it.
    segmentId: uuid("segment_id").references(() => sourceSegments.id, { onDelete: "set null" }),
    facet: text("facet").notNull(),
    statement: text("statement").notNull(),
    // The located passage, computation, or comparison the finding rests on.
    evidence: text("evidence").notNull(),
    createdBy: text("created_by").notNull().default("researcher"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_examination_findings_examination").on(table.examinationId)]
);

/** A claim Steward's reading citing a finding it relied on. Written by that claim's Steward. */
export const readingCitations = pgTable(
  "reading_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => claimInstanceReadings.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => examinationFindings.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_reading_citations_unique").on(table.readingId, table.findingId),
    index("idx_reading_citations_finding").on(table.findingId),
  ]
);

/** The Audit agent's attributed note on a finding about the document itself. */
export const auditNotes = pgTable(
  "audit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => examinationFindings.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    createdBy: text("created_by").notNull().default("audit_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_audit_notes_finding").on(table.findingId)]
);

// ---------------------------------------------------------------------------
// claim_instances
// ---------------------------------------------------------------------------
export const claimInstances = pgTable(
  "claim_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // The passage as THIS source stated it: provenance, the author's wording
    // and framing (§4). Every source's excerpt is equally verbatim to itself;
    // the column was `original_text` until #360, a name that implied the
    // first source's wording had precedence over the others' and that the
    // canonical form derived from it. Neither is true: the canonical form
    // states the proposition, and each instance records one voice on it.
    verbatimText: text("verbatim_text").notNull(),
    // The canonical form the EXTRACTOR proposed for this passage (§3), kept
    // next to the verbatim text it was proposed for. The Matcher has the
    // last word on a new claim's wording (url-extraction.ts stores its
    // rewrite as claims.text), and until this column existed the proposal
    // was discarded — so who authored the graph's language, and whether the
    // second author improved it, was unmeasurable (#334, 2026-08-11). Null
    // for instances recorded without a proposal (a Steward sighting of an
    // existing claim).
    proposedCanonicalForm: text("proposed_canonical_form"),
    context: text("context"),
    summaryContext: text("summary_context"),
    // Whether this source asserts the canonical claim ("affirms"), its
    // negation/contrary ("denies"), or states the proposition as an open
    // question without endorsing either side ("poses", #445: a survey
    // stating a conjecture), or only refers to it, citing it or reporting
    // the debate without taking a side ("mentions"). Lets a claim and its
    // denial share one canonical node while preserving which side each
    // source takes, so the disagreement lives on the claim instead of in two
    // mirror-image pages. Values are INSTANCE_STANCES in schemas/common.ts;
    // the column is free text, so a new value needs no migration.
    stance: text("stance").notNull().default("affirms"),
    // Kinds (§4, §7a). An instance of a quantity states its value
    // (stance 'states'): the figure as the source gives it, in the estimate
    // shape (quantityEstimateSchema in src/schemas/kinds.ts), and the
    // quantity's argument that rests on it, if one does. An instance of a
    // question asks it ('asks') or answers it ('answers'), and an answering
    // instance names the answer node its answer matches. A figure read from
    // a table has no sentence: its verbatim_text is empty, and read paths
    // serve it as null.
    statedEstimate: jsonb("stated_estimate"),
    // A probability the source states for the claim (§4): what the source
    // said, recorded with its instance, never the graph's own credence.
    statedProbability: real("stated_probability"),
    argumentId: uuid("argument_id").references((): AnyPgColumn => arguments_.id, {
      onDelete: "set null",
    }),
    answerClaimId: uuid("answer_claim_id").references((): AnyPgColumn => claims.id, {
      onDelete: "set null",
    }),
    confidence: real("confidence").notNull().default(1.0),
    // Attribution metadata (#278/#281), all nullable — many instances won't
    // have all of these. Who asserted it (the speaker/author, which for a
    // quote is the person quoted, not the outlet reporting it), where it
    // appeared (the publication/outlet), when (as stated by the source,
    // ISO-8601 to whatever precision is known: "2023", "2023-05", or
    // "2023-05-14" — text, because partial dates are common and ISO text
    // still sorts), and a deep link to the statement itself where it differs
    // from the source document's URL (an anchor, a tweet inside a thread).
    speaker: text("speaker"),
    publication: text("publication"),
    sourceDate: text("source_date"),
    link: text("link"),
    // Which agent recorded the instance: "extractor" (ingest-time extraction,
    // the historical default) or "claim_steward" (encountered during
    // assessment web search, #278).
    createdBy: text("created_by").notNull().default("extractor"),
    // The passage of the source this instance's verbatim text sits in
    // (#507), found by locating the text in the segmented document. Null
    // until the source is segmented, or when the text cannot be found in it
    // (which the quote check reports separately).
    segmentId: uuid("segment_id").references(() => sourceSegments.id, {
      onDelete: "set null",
    }),
    // Detached by the claim's Steward: the source does not assert, deny or
    // pose this proposition, so the instance no longer belongs to the claim.
    // The row is kept, never deleted, because provenance edges, readings and
    // the reading log reference it; every read that shows or weighs a
    // claim's instances filters on detached_at IS NULL. Reattaching clears
    // all three columns.
    detachedAt: timestamp("detached_at", { withTimezone: true }),
    detachedReason: text("detached_reason"),
    detachedBy: text("detached_by"),
    // The Steward's chosen position for this instance on the claim page,
    // 1 first; null follows the default order (the provenance story's
    // order, then the date of the statement). Set only by set_instance_order.
    displayRank: integer("display_rank"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_claim_instances_origin", table.origin),
    check(
      "ck_instances_stated_probability",
      sql`${table.statedProbability} IS NULL OR (${table.statedProbability} >= 0 AND ${table.statedProbability} <= 1)`
    ),
    index("idx_instances_claim").on(table.claimId),
    index("idx_instances_segment").on(table.segmentId),
    index("idx_instances_source").on(table.sourceId),
  ]
);

// ---------------------------------------------------------------------------
// claim_provenance_edges (#286)
//
// Graph-shaped provenance, done PER CLAIM. The edge runs from one source's
// assertion of a claim (a claim_instances row) to the document that assertion
// draws on (a sources row).
//
// Why not source-to-source, as #286's sketch proposed: a bibliography is a
// document-level fact and our question is claim-level. A paper cites forty
// works; at most a couple bear on any one proposition, and a document-level
// edge cannot say which. Scoping the edge to the claim is what keeps the map
// about the claim instead of about the literature.
//
// Why the target is a SOURCE and not another instance: the upstream document
// frequently does not assert the claim at all. A news article asserting C
// commonly rests on a study that states only the narrower finding C was built
// from, so requiring the target to be an instance would drop exactly the edge
// the map exists to show. Where the target does also assert the claim,
// to_instance_id carries it and the propagation chain (#280) is a join away.
//
// Every edge is a JUDGMENT recorded by an agent that read both documents, never
// an import of a citation index. `evidence` is the structural guard: it holds
// the located passage in the asserting source where it draws on the target, so
// an edge copied from declared metadata has nothing to put in the field.
// ---------------------------------------------------------------------------
export const claimProvenanceEdges = pgTable(
  "claim_provenance_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The asserting side: this source's assertion of this claim. The claim
    // is reached through the instance and is deliberately not denormalized
    // here: a merge or a split moves instances between claims (§5), and an
    // edge is a property of the assertion, so it must move with it rather
    // than keep a stale claim of its own.
    fromInstanceId: uuid("from_instance_id")
      .notNull()
      .references(() => claimInstances.id, { onDelete: "cascade" }),
    // The document drawn upon.
    toSourceId: uuid("to_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // Set when the upstream document ALSO asserts this claim, so the chain of
    // who-said-it-after-whom is directly traversable. SET NULL, not cascade:
    // losing the instance must not silently delete a real dependency edge.
    toInstanceId: uuid("to_instance_id").references(() => claimInstances.id, {
      onDelete: "set null",
    }),
    // CLAIM_PROVENANCE_RELATION_TYPES in src/schemas/common.ts.
    relationType: text("relation_type").notNull(),
    // PROVENANCE_FIDELITY: what survived the crossing. The field no citation
    // index anywhere holds, and the reason this map is worth building.
    fidelity: text("fidelity").notNull().default("unclear"),
    // The located passage in the asserting source where it draws on the
    // target — a quotation or an unambiguous locator. notNull by design: it
    // is what makes an unread, metadata-copied edge structurally awkward to
    // write rather than merely discouraged.
    evidence: text("evidence").notNull(),
    reasoning: text("reasoning").notNull(),
    // How sure the recording agent is that the dependency is real and this
    // is its kind. A judgment, never adjusted by mechanism: whether the
    // target was opened is recorded beside it instead, so a reader can
    // discount for themselves.
    confidence: real("confidence").notNull().default(0.5),
    // Whether the agent opened the target document, or judged the edge from
    // the asserting source's own description of it. Recorded rather than
    // used to cap confidence (Part VIII): the fact is what the Steward and
    // the reader need, and the confidence stays the agent's.
    targetRead: boolean("target_read").notNull().default(false),
    // The agent key of the writer: the Steward, or an instrument it launched.
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_cpe_unique").on(
      table.fromInstanceId,
      table.toSourceId,
      table.relationType
    ),
    index("idx_cpe_to_source").on(table.toSourceId),
  ]
);

// ---------------------------------------------------------------------------
// source_relationships (#286)
//
// The thin claim-INDEPENDENT layer: facts about a pair of documents that stay
// true whatever proposition is being traced. Deliberately short. These are
// what let a map say that five sources are three voices, which is exactly the
// concentration a reader should see and which no claim-scoped edge can state.
//
// `shares_authorship` is symmetric and stored canonically (smaller uuid as
// parent) so one relation cannot enter twice as its own mirror.
// ---------------------------------------------------------------------------
export const sourceRelationships = pgTable(
  "source_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentSourceId: uuid("parent_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    childSourceId: uuid("child_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // SOURCE_RELATION_TYPES in src/schemas/common.ts.
    relationType: text("relation_type").notNull(),
    reasoning: text("reasoning").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_sr_unique").on(
      table.parentSourceId,
      table.childSourceId,
      table.relationType
    ),
    index("idx_sr_parent").on(table.parentSourceId),
    index("idx_sr_child").on(table.childSourceId),
    check(
      "sr_no_self_reference",
      sql`${table.parentSourceId} != ${table.childSourceId}`
    ),
  ]
);

// ---------------------------------------------------------------------------
// claim_instance_readings (#286)
//
// What the Steward (or an instrument working for it) concluded from actually
// opening one source and reading it against the claim it is an instance of.
// Kept off claim_instances deliberately: an instance is the Extractor's record
// of what a document said, and this is a later agent's judgment about it. Same
// separation as assessments and claims. The claim is reached through the
// instance, so a reading follows its instance through merges and splits.
//
// This is the richest thing the map produces and the main payload the Steward
// weighs. A stance count treats every instance as one vote; this says which of
// those votes rest on evidence the source actually has.
// ---------------------------------------------------------------------------
export const claimInstanceReadings = pgTable(
  "claim_instance_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => claimInstances.id, { onDelete: "cascade" }),
    // INSTANCE_SUPPORT_READINGS: whether the source's OWN evidence bears the
    // assertion it makes. Explicitly not whether the claim is true — that
    // judgment stays with the Steward (§9).
    support: text("support").notNull().default("unclear"),
    // What this source is USING the claim for: the context of deployment.
    // Prose, because the interesting cases are not enumerable ("cited in
    // passing to motivate a policy proposal it does not otherwise argue for").
    deployment: text("deployment"),
    // The reader's note on this appearance, in reader-facing register (§12).
    note: text("note"),
    // QUOTE_CHECK_RESULTS — mechanical, never model-written.
    quoteCheck: text("quote_check").notNull().default("no_stored_content"),
    // Whether a Steward should open this source itself, and why. The direct
    // answer to "what should I read closely", which is the whole point of
    // handing this to assessment.
    worthReading: boolean("worth_reading").notNull().default(false),
    worthReadingReason: text("worth_reading_reason"),
    // Whether the agent actually read the source's stored content, or was
    // working from metadata and the excerpt alone. A map that could not open
    // its sources should say so rather than look complete.
    sourceRead: boolean("source_read").notNull().default(false),
    // The model that produced the reading and the agent key that wrote it.
    model: text("model"),
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this reading (src/labels.ts): the label of the run that
    // first recorded it. A re-read replaces the reading in place and leaves
    // this as it was; the log row each re-read appends carries its own.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    // One current reading per instance; a re-map overwrites in place. The
    // edges and the map summary carry the durable record.
    uniqueIndex("idx_cir_instance").on(table.instanceId),
  ]
);

// ---------------------------------------------------------------------------
// claim_instance_reading_log (#507)
//
// Every reading as it was recorded, append-only. claim_instance_readings keeps
// the current reading per instance and is overwritten on a re-read; this keeps
// the earlier ones, so a source's history can say that a Steward first found
// it overstating and later, after a correction, found it sound.
// ---------------------------------------------------------------------------
export const claimInstanceReadingLog = pgTable(
  "claim_instance_reading_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => claimInstances.id, { onDelete: "cascade" }),
    support: text("support").notNull(),
    note: text("note"),
    sourceRead: boolean("source_read").notNull().default(false),
    worthReading: boolean("worth_reading").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_cirl_instance").on(table.instanceId)]
);

// ---------------------------------------------------------------------------
// claim_source_maps (#286)
//
// The per-claim READING: what the support rests on, in the graph's voice
// (§12). One row per claim, refreshed in place — it is a derived account of
// the current edges, and the edges plus readings are the durable record.
//
// `material` is the gate on the claim page: most claims' provenance is
// unremarkable and saying so on every page would be clutter. The reader-facing
// prose surfaces only where the structure actually bears on how the evidence
// should be read.
// ---------------------------------------------------------------------------
export const claimSourceMaps = pgTable(
  "claim_source_maps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // Reader-facing account of what the support rests on. Plain prose, no
    // edge-type names (§12). Figures are fine where they inform; what #286
    // rules out is a figure deciding in place of the Steward's reasoning.
    summary: text("summary").notNull(),
    // Whether the structure is worth surfacing on the claim page at all.
    material: boolean("material").notNull().default(false),
    // Bookkeeping, for the audit-minded view and for staleness decisions.
    sourcesConsidered: integer("sources_considered").notNull().default(0),
    sourcesRead: integer("sources_read").notNull().default(0),
    edgesRecorded: integer("edges_recorded").notNull().default(0),
    model: text("model"),
    mappedBy: text("mapped_by").notNull().default("claim_steward"),
    mappedAt: timestamp("mapped_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [uniqueIndex("idx_csm_claim").on(table.claimId)]
);

// ---------------------------------------------------------------------------
// claim_provenance_roots (#507)
//
// Where a claim's story begins. The map reads top to bottom from its origins,
// and a source with no recorded upstream edge is one of two quite different
// things: a confirmed origin (the transcript of the meeting, the statistics
// release) or simply untraced (nobody has yet followed it upstream). Shown
// alike, the second passes for the first.
//
// Most of the distinction is derived, not stored: a source the claim's edges
// lead upward from is not a top node at all, and a top node whose kind is a
// primary one (PRIMARY_SOURCE_KINDS) reads as an origin on that basis. This
// table holds only the Steward's judgment where it overrides or confirms the
// derivation: an origin the kind does not reveal, or a mislabelled
// "transcript" demoted to untraced. Claim-scoped, because the same document
// can be where one claim begins and a late restatement of another.
//
// Keyed on the claim rather than an instance: an underlying source (a document
// the claim draws on that does not state it) can be the origin and has no
// instance to hang from. A merge therefore leaves these rows with the loser;
// the survivor's Steward re-records them when it refreshes the stale map.
// ---------------------------------------------------------------------------
export const claimProvenanceRoots = pgTable(
  "claim_provenance_roots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // PROVENANCE_ROOT_STATUSES in src/schemas/common.ts.
    status: text("status").notNull(),
    // Why: what was looked for upstream and not found, or what makes this the
    // first record. The reader sees it on the origin's card.
    basis: text("basis").notNull(),
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_cpr_claim_source").on(table.claimId, table.sourceId),
    check("ck_cpr_status", sql`${table.status} IN ('origin', 'untraced')`),
  ]
);

// ---------------------------------------------------------------------------
// source_interests (§9)
//
// A stake a source's author or publisher has in what the source says: a
// developer describing its own system, a company reporting on its own
// product, the funder of a study. It is a fact about the source, recorded by
// the agent that noticed it (record_source_interest), and never a finding
// against the source: what the source says stays evidence, and each claim's
// Steward weighs it knowing the stake.
//
// `claim_id` sets the scope. NULL: the interest holds for whatever this
// source says about the party's own affairs. A claim id: it holds for that
// one claim. A read for a claim prefers the claim's own record and falls back
// to the source-wide one (services/source-interest-service.ts).
//
// Append-only. A new row for the same source and scope supersedes the older
// one for readers, and the older rows stay as the history. Nothing here is
// updated or deleted.
// ---------------------------------------------------------------------------
export const sourceInterests = pgTable(
  "source_interests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "cascade" }),
    // Who has the stake, as a name.
    party: text("party").notNull(),
    // What they stand to gain or lose, in a sentence or two.
    stake: text("stake").notNull(),
    recordedBy: text("recorded_by").notNull(),
    // The agent run that recorded it, from the usage context. No FK, like
    // llm_usage.run_id.
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_source_interests_origin", table.origin),
    index("idx_source_interests_source").on(table.sourceId, table.claimId, table.createdAt),
    index("idx_source_interests_claim")
      .on(table.claimId)
      .where(sql`claim_id IS NOT NULL`),
  ]
);

// ---------------------------------------------------------------------------
// connections: an organization's data, read where it lives
// (src/connections.ts)
//
// A connection points the deployment at one MCP server over a system the
// organization or one of its parties runs: a warehouse, a wiki, a ticket or
// log store. Administrators add and change them, and each change is a row in
// administrative_events. The public graph has none.
//
// What a connection holds:
//   - where the server is and how to speak to it (url, transport). The
//     transport is a name the code knows ('streamable_http', 'sse') and is
//     not held to a list here, so that a later one is not a migration.
//   - how to authenticate: credential_env is the NAME of the environment
//     variable that holds the credential, never the credential, and
//     credential_header the header it is sent in. NULL credential_env means
//     the server asks for none.
//   - whose system it is (party_id) and what that party stands to gain or
//     lose from what the system shows (stake). Both are carried by every
//     reading kept from it: the source belongs to the party, and the stake
//     is recorded on it in source_interests.
//   - its one label (sensitivity_label): who may read what comes through it.
//     A run is offered the connection only when its label reads this one.
//     The column has the shared default like every labelled table; the
//     service that adds a connection always states the label.
//   - calls_per_minute: a rate its administrator may set, across all runs,
//     because calls cost the organization's system and no owls, so a run's
//     budget does not bound them. NULL sets none.
//   - timeout_seconds: how long a call may go unanswered before it is given
//     up, since the run that made it waits.
//   - the state an administrator sees: when the server last answered, and
//     the last failure to reach it.
//
// tool_prefix names the connection in tool names: an agent is offered the
// server's tool `run_query` as `<tool_prefix>__run_query`, so two
// connections' tools cannot collide with each other or with a built-in tool.
// ---------------------------------------------------------------------------
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    toolPrefix: text("tool_prefix").notNull(),
    transport: text("transport").notNull().default("streamable_http"),
    url: text("url").notNull(),
    credentialEnv: text("credential_env"),
    credentialHeader: text("credential_header").notNull().default("Authorization"),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    stake: text("stake").notNull(),
    sensitivityLabel: sensitivityLabelColumn(),
    callsPerMinute: integer("calls_per_minute"),
    timeoutSeconds: integer("timeout_seconds").notNull().default(120),
    // Off: no run is offered its tools. A connection is never deleted, since
    // calls and kept readings refer to it.
    enabled: boolean("enabled").notNull().default(true),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastAnsweredAt: timestamp("last_answered_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdBy: uuid("created_by").references((): AnyPgColumn => contributors.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_connections_name").on(sql`lower(${table.name})`),
    uniqueIndex("uq_connections_tool_prefix").on(table.toolPrefix),
    check("ck_connections_rate", sql`${table.callsPerMinute} IS NULL OR ${table.callsPerMinute} > 0`),
    check("ck_connections_timeout", sql`${table.timeoutSeconds} > 0`),
  ]
);

// ---------------------------------------------------------------------------
// connection_tools: a connection's tools as an administrator last saw them,
// and which of them are offered to agents
//
// One row per tool the server listed when an administrator last looked:
// its name, description, input schema and the server's own markings
// (annotations, where `readOnlyHint` is the server's word that the tool
// only reads: a hint, shown beside the tool, never proof). definition_hash
// is taken over those four, so a later change to any of them shows.
//
// `offered` is the administrator's choice, tool by tool, and nothing is
// offered that was not picked. A pick holds for the definition it was made
// on: when the server's tool no longer matches definition_hash, or is no
// longer listed, or the connection's address changes, the tool stops being
// offered (offered false, withdrawn_at and withdrawn_reason set) until an
// administrator looks again and picks it again. `listed` says whether the
// server still listed the tool at the last look.
//
// sensitivity_label is the connection's: a tool's name, description and
// input schema are the organization's system describing itself, the same
// whoever looks, so the row is derived from the connection and carries its
// label (src/labels.ts). Whoever may not read the connection may not read
// what its tools are called.
// ---------------------------------------------------------------------------
export const connectionTools = pgTable(
  "connection_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    inputSchema: jsonb("input_schema").notNull(),
    annotations: jsonb("annotations"),
    definitionHash: text("definition_hash").notNull(),
    listed: boolean("listed").notNull().default(true),
    seenAt: timestamp("seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    offered: boolean("offered").notNull().default(false),
    offeredBy: uuid("offered_by").references((): AnyPgColumn => contributors.id),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    // 'changed' | 'missing' | 'address_changed': a name the code gives.
    withdrawnReason: text("withdrawn_reason"),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [uniqueIndex("uq_connection_tools_name").on(table.connectionId, table.name)]
);

// ---------------------------------------------------------------------------
// connection_calls: every call an agent made through a connection
//
// One row per call: which tool, with what arguments, when, and what came
// back. The result is stored whole as text with its SHA-256, whatever part
// of it the agent was shown, so that a reading kept later is the reading as
// it was made. outcome is NULL while the call is in flight, then
// 'answered', 'tool_error' (the system answered with an error) or 'failed'
// (no answer: unreachable, credential refused, timed out), with `error`
// saying which.
//
// A call is not a source. When an agent's work rests on one it keeps it
// (keep_reading): source_id then names the source row made from the call,
// and kept_at when. Calls nobody kept stay here as the record of what was
// asked of the organization's system, and are what calls_per_minute counts.
//
// sensitivity_label is the label of the run that made the call, like
// anything a run writes: the arguments are the run's own words, stored with
// what came back. That label always reads the connection's, or the run
// would not have been offered the tool. party_id is the connection's when
// the call was made: whose material came back does not depend on who asked.
// A source kept from the call takes both from here.
//
// run_id, agent and claim_id are the calling run's, from the usage context,
// with no foreign keys, like llm_usage.
// ---------------------------------------------------------------------------
export const connectionCalls = pgTable(
  "connection_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    arguments: jsonb("arguments").notNull(),
    calledAt: timestamp("called_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    durationMs: integer("duration_ms"),
    outcome: text("outcome"),
    error: text("error"),
    result: text("result"),
    resultHash: text("result_hash"),
    resultChars: integer("result_chars"),
    runId: uuid("run_id"),
    agent: text("agent"),
    claimId: uuid("claim_id"),
    partyId: uuid("party_id").references(() => parties.id),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    keptAt: timestamp("kept_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    // The rate check counts a connection's calls in the last minute, and an
    // administrator's list reads them newest first.
    index("idx_connection_calls_connection_time").on(table.connectionId, table.calledAt),
    index("idx_connection_calls_source")
      .on(table.sourceId)
      .where(sql`source_id IS NOT NULL`),
  ]
);

// ---------------------------------------------------------------------------
// file_sets: files of any kind, taken in as a set (src/file-sets.ts)
//
// The third way material comes into a private deployment, beside a document
// and a connection: data exports, logs, evaluation transcripts, code, too
// large or too raw to be documents. Agents explore a set by running
// commands in a sandbox the deployment runs, with no network. The public
// graph has none.
//
// What a set holds:
//   - a name people and agents know it by, and a slug: a short lower-case
//     word that is the set's directory name in the store and in the
//     sandbox, and the first part of the address of every file kept from
//     it. `description` is what whoever added it says it holds.
//   - where its files are. origin is 'upload' (files streamed in through
//     the route and kept in the deployment's store) or 'directory' (a
//     directory already under the root the operator configured, read where
//     it lies). storage_key is the set's path under the store or under that
//     root, never an absolute path: the API and the sandbox mount the same
//     files at different places. Both names are the code's and not held to
//     a list here.
//   - whose material it is (party_id) and what that party stands to gain or
//     lose from what the files show (stake), as a connection has. Both are
//     carried by every source kept from the set.
//   - its one label (sensitivity_label): who may read its files. A run is
//     offered the set only when the label it works at reads this one. The
//     column has the shared default like every labelled table; the service
//     that adds a set always states the label.
//   - state: 'open' while files are being uploaded, 'hashing' while a
//     registered directory is walked, then 'closed', or 'failed' with
//     `problem` saying why. A set is closed once filled: no file is added,
//     changed or removed afterwards, and new files are a new set. Only a
//     closed set is offered to a run.
//   - file_count, total_bytes and manifest_hash, written when it closes.
//     manifest_hash is one SHA-256 over every file's hash and path, so it
//     fixes the whole set.
//   - enabled: false switches it off, so no run is offered it. A set is
//     never deleted, since calls and kept sources refer to it.
// ---------------------------------------------------------------------------
export const fileSets = pgTable(
  "file_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    origin: text("origin").notNull(),
    storageKey: text("storage_key").notNull(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    stake: text("stake").notNull(),
    sensitivityLabel: sensitivityLabelColumn(),
    state: text("state").notNull().default("open"),
    problem: text("problem"),
    fileCount: integer("file_count").notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    manifestHash: text("manifest_hash"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references((): AnyPgColumn => contributors.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_file_sets_name").on(sql`lower(${table.name})`),
    uniqueIndex("uq_file_sets_slug").on(table.slug),
  ]
);

// ---------------------------------------------------------------------------
// file_set_files: a set's manifest
//
// One row per file: its path inside the set, its size, and the SHA-256
// taken when it was added. Rows are written while the set fills and never
// changed afterwards.
//
// sensitivity_label is the set's: a path can say as much as the file it
// names (a person, a customer, a project), and a hash answers whether a
// known file is in the set. The row is derived from the set, the same
// whoever asks, so it carries the set's label (src/labels.ts).
// ---------------------------------------------------------------------------
export const fileSetFiles = pgTable(
  "file_set_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileSetId: uuid("file_set_id")
      .notNull()
      .references(() => fileSets.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [uniqueIndex("uq_file_set_files_path").on(table.fileSetId, table.path)]
);

// ---------------------------------------------------------------------------
// sandbox_calls: every command an agent ran in the sandbox
//
// One row per command: the command line, the files the agent gave with it
// (a script, usually; `files` holds each one's path, text and SHA-256), the
// sets it could read (`file_sets`: each one's id, name, slug, manifest hash
// and where it was mounted), when, and what came back. The output is stored
// whole as text with its SHA-256, whatever part of it the agent was shown.
// outcome is NULL while the command is running, then how it ended:
// 'exited' (with exit_code), 'timed_out', 'memory', 'output_ceiling',
// 'scratch_full', 'killed', or 'failed' when the sandbox gave no answer
// (`error` says why). `written` lists the files the command wrote in its
// scratch directory, each with its size and hash; their contents are not
// kept. sandbox_version, sandbox_image and python name what it ran in.
//
// A call is not a source. When an agent's work rests on one it keeps it
// (keep_analysis): source_id then names the source row made from the call,
// and kept_at when.
//
// sensitivity_label is the label of the run that ran the command, like
// anything a run writes: the command and any script are the run's own
// words, stored with what they produced. That label always reads the label
// of every set the command could read, or the run would not have been
// offered them. A source kept from the call takes its label from here.
//
// run_id, agent and claim_id are the calling run's, from the usage context,
// with no foreign keys, like llm_usage.
// ---------------------------------------------------------------------------
export const sandboxCalls = pgTable(
  "sandbox_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    command: text("command").notNull(),
    files: jsonb("files").notNull().default([]),
    fileSets: jsonb("file_sets").notNull().default([]),
    calledAt: timestamp("called_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    durationMs: integer("duration_ms"),
    outcome: text("outcome"),
    exitCode: integer("exit_code"),
    error: text("error"),
    output: text("output"),
    outputHash: text("output_hash"),
    outputChars: integer("output_chars"),
    written: jsonb("written"),
    writtenNotListed: integer("written_not_listed"),
    sandboxVersion: text("sandbox_version"),
    sandboxImage: text("sandbox_image"),
    python: text("python"),
    runId: uuid("run_id"),
    agent: text("agent"),
    claimId: uuid("claim_id"),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    keptAt: timestamp("kept_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    // The lists read them newest first.
    index("idx_sandbox_calls_time").on(table.calledAt),
    // A set's page lists and counts the commands that had it mounted
    // (file_sets @> '[{"id": ...}]').
    index("idx_sandbox_calls_file_sets").using("gin", table.fileSets),
    index("idx_sandbox_calls_source")
      .on(table.sourceId)
      .where(sql`source_id IS NOT NULL`),
  ]
);

// ---------------------------------------------------------------------------
// file_set_keeps: a file of a set, or a passage of one, kept as a source
//
// One row per source made by keep_file: which file, and for a passage which
// lines (first_line and last_line, counted from 1; both NULL for the whole
// file). The source is derived mechanically from the file and is the same
// whoever asks, so it carries the set's label and party, and the same file
// or passage kept twice is one source and one row. For the same reason the
// row does not say which run kept it or for which node: a run at a label
// that reads the set's may keep a file, and the row is at the set's label
// (sensitivity_label): it says which file of the set work has rested on,
// and which lines of it.
// ---------------------------------------------------------------------------
export const fileSetKeeps = pgTable(
  "file_set_keeps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileSetId: uuid("file_set_id")
      .notNull()
      .references(() => fileSets.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => fileSetFiles.id, { onDelete: "cascade" }),
    firstLine: integer("first_line"),
    lastLine: integer("last_line"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    keptAt: timestamp("kept_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_file_set_keeps_source").on(table.sourceId),
    index("idx_file_set_keeps_set").on(table.fileSetId),
  ]
);

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    input: jsonb("input").notNull(),
    result: jsonb("result"),
    error: text("error"),
    // Attribution for per-token metering (#70): the account and API key that
    // requested this job. Workers restore these into the LLM usage context so
    // background agent calls (extraction, matching) are billed to the
    // requesting user, not lost as anonymous work. Null = system-initiated.
    userId: uuid("user_id").references(() => contributors.id, {
      onDelete: "set null",
    }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    // The label of the work that made this job (src/labels.ts). The worker
    // that picks the job up runs at it, so what it extracts and enqueues
    // keeps the label the request or run had.
    sensitivityLabel: sensitivityLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("idx_jobs_status").on(table.status)]
);

// ---------------------------------------------------------------------------
// contributors
//
// The single account table (issue #70): a *user* (API consumer) and a
// *contributor* (graph editor) are the same identity — one human, one row.
// `externalId` is the auth subject in the form "<provider>:<subject>"
// (e.g. "github:12345"), minted by the web app's sign-in flow; the API never
// talks to the auth provider itself. Consumer concerns (API keys, usage,
// credits) and contributor concerns (reputation, owl awards — #71) both hang off
// this row.
// ---------------------------------------------------------------------------
export const contributors = pgTable("contributors", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: text("external_id").unique(),
  displayName: text("display_name").notNull(),
  email: text("email").unique(),
  avatarUrl: text("avatar_url"),
  reputationScore: real("reputation_score").notNull().default(50),
  contributionsAccepted: integer("contributions_accepted").notNull().default(0),
  contributionsRejected: integer("contributions_rejected").notNull().default(0),
  contributionsEscalated: integer("contributions_escalated")
    .notNull()
    .default(0),
  // Lifetime owls EARNED from accepted contributions (#71 recognition, now
  // paid in the spendable currency) — denormalized SUM of the owl_ledger's
  // contribution_award rows, in face-value micro-USD, for cheap profile and
  // leaderboard reads. Lifetime-earned (not balance) so spending owls never
  // lowers a contributor's standing; owl_ledger is the source of truth.
  owlsEarnedMicroUsd: bigint("owls_earned_micro_usd", { mode: "number" })
    .notNull()
    .default(0),
  // Lifetime PRIZE owls (docs/mathematics.md §8.7): the owl_ledger's
  // prize_award rows, kept apart from owlsEarnedMicroUsd so the leaderboard
  // keeps its meaning — a prize is an answer bought, not standing earned.
  // Excluded from the leaderboard sum.
  owlsPrizedMicroUsd: bigint("owls_prized_micro_usd", { mode: "number" })
    .notNull()
    .default(0),
  // Barred from filing prize claims (§8.4): mandate funders and program
  // contractors, set by the operator. The route gate refuses with 403.
  prizeIneligible: boolean("prize_ineligible").notNull().default(false),
  // Good-faith-free / bad-faith-pay standing (#71):
  //   'good'     — contribution is free (always, even when rejected on merits).
  //   'must_pay' — a suspected-bad-faith flag was recorded; contributing now
  //                requires a deposit/fee. No payment rail exists yet, so this
  //                state returns 402 DEPOSIT_REQUIRED at POST /contributions
  //                (the payment seam, like the consumer credits ledger).
  //                Restored to 'good' when the flag is overturned on appeal.
  contributionStanding: text("contribution_standing").notNull().default("good"),
  badFaithFlags: integer("bad_faith_flags").notNull().default(0),
  isVerified: boolean("is_verified").notNull().default(false),
  isSuspended: boolean("is_suspended").notNull().default(false),
  suspensionReason: text("suspension_reason"),
  // When the current suspension was imposed (#180) — lets the audit sweep
  // find suspensions that have stood unexamined for too long. Cleared on
  // unsuspension so it always describes the live suspension.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// api_keys
//
// DB-backed API keys (#70). A user mints keys from the dashboard; the key is
// shown once and only its SHA-256 hash is stored. Keys are high-entropy random
// strings, so a fast unsalted hash is the correct construction (unlike
// passwords) — it gives O(1) lookup by hash with no oracle risk.
//
// scope:
//   'user'    — a normal consumer key; acts as its owning user.
//   'service' — a trusted first-party key (e.g. the web frontend's BFF key)
//               that may additionally act ON BEHALF OF another user via the
//               x-acting-user header. Never issued from the public dashboard.
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // First characters of the plaintext key (e.g. "epk_a1b2c3d4"), kept so the
    // dashboard can identify a key without ever storing the key itself.
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scope: text("scope").notNull().default("user"),
    // The label every request made with this key works at, fixed when the
    // key is minted and never changed: an outside agent holding the key
    // does not choose a label call by call.
    workLabel: workLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("idx_api_keys_user").on(table.userId)]
);

// ---------------------------------------------------------------------------
// llm_usage
//
// The per-token meter (#70): one row per LLM call, written at the single
// chokepoint in src/llm/client.ts. Captured at token granularity from day one
// because backfill is impossible; a credits ledger (Stripe metered billing)
// can later decrement against these rows without schema upheaval — see
// src/services/billing-service.ts for the seam.
//
// userId/apiKeyId null = system-initiated governance work (Steward sweeps,
// audits, contribution review), which is deliberately NOT billed to users:
// the metered surface is user-initiated agentic work (extraction, matching).
// ---------------------------------------------------------------------------
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => contributors.id, {
      onDelete: "set null",
    }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    // Which agent made the call (extractor, matcher, steward, curator,
    // contribution_reviewer, dispute_arbitrator, audit, ...) — set by the
    // agent's entry point via the usage context.
    agent: text("agent").notNull().default("unknown"),
    model: text("model").notNull(),
    // Which backend served the call: anthropic | openai | openrouter (see
    // src/llm/providers/routing.ts). Defaults to anthropic so rows written
    // before multi-provider support keep their true provider. Non-token
    // spend (docs/mathematics.md §6.3) meters here too — provider `lean`,
    // `elicit`, `pangram`, `anthropic_code_execution`, or `anthropic_web_search`, model carrying the pinned
    // identity (`lean-checker/<pin_id>`, `elicit/search_papers`) — so every
    // escrow, budget-job, and cost-estimate query that sums cost_micro_usd
    // sees real money the token columns cannot.
    provider: text("provider").notNull().default("anthropic"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    // Derived cost in micro-USD (1e-6 USD) from src/llm/pricing.ts at insert
    // time, so historical rows keep the price that was in effect when the
    // tokens were spent.
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    // External (non-token) usage, §6.3: how much of what was consumed —
    // checker wall milliseconds, Elicit calls, container seconds — with the
    // unit named so a per-provider cost query can be re-derived from units
    // if a price changes. NULL on ordinary token rows.
    externalUnits: numeric("external_units"),
    externalUnitKind: text("external_unit_kind"),
    jobId: uuid("job_id"),
    // The claim whose stewardship this call served (#217): makes per-claim
    // cost a query instead of unrecoverable — the marginal-cost half of the
    // allocation estimate. Plain uuid (like jobId): metering must stay a
    // cheap, unconditional insert.
    claimId: uuid("claim_id"),
    // The agent run this call belongs to (#334 L0): joins a usage row to its
    // agent_runs row, making per-run cost exact instead of approximated by
    // per-claim grouping (cost-estimate-service). Plain uuid, no FK, for the
    // same reason as jobId/claimId: metering stays a cheap, unconditional
    // insert, and a run row written fire-and-forget may not exist yet.
    runId: uuid("run_id"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request the call was made for (src/labels.ts).
    // A usage row holds counts and cost, never content, but it says that a
    // run happened, on which claim and for whom.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_llm_usage_user_time").on(table.userId, table.createdAt),
    index("idx_llm_usage_key_time").on(table.apiKeyId, table.createdAt),
    index("idx_llm_usage_time").on(table.createdAt),
    index("idx_llm_usage_claim").on(table.claimId),
    // Budget pacing sums a job's metered cost on every check — the hottest
    // read of the highest-volume table; it must not seq-scan.
    index("idx_llm_usage_job").on(table.jobId),
    index("idx_llm_usage_run").on(table.runId),
  ]
);

// ---------------------------------------------------------------------------
// agent_runs / agent_steps
//
// The trace substrate (#334 L0, from #274): one agent_runs row per agent
// invocation (opened by withAgent in src/llm/usage-context.ts), and one
// agent_steps row per turn of the tool-use loop — the full transcript that
// previously died with the process. Domain artifacts (assessments.
// reasoning_trace, audit_log) remain the summaries; these tables are the raw
// material under them, for eval consumption, debugging, and — later — the
// production monitors.
//
// Deliberately span-shaped (run → ordered steps with timestamps) so an
// OTel/Langfuse exporter stays an adapter, never a migration (#334 §4).
//
// Writes are fire-and-forget from the hot path by default (like llm_usage):
// tracing does not fail or slow an agent run, so there are no FKs to domain
// tables and consumers must tolerate a run row without steps or an
// unfinished run (finished_at NULL after a crash). A run whose every step
// was written is sealed (log_hash, sealed_at), which is how a reader tells
// a whole log from a partial one; RUN_LOG_MODE=record makes the run wait on
// that seal (#552). Retention is the operator's policy knob:
// traces are large, TRACE_LEVEL=off disables writes entirely (the production
// default until a retention job exists), and rows are safe to prune by
// started_at — nothing joins to them by FK except agent_steps, which cascades.
// ---------------------------------------------------------------------------
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Which agent ran: steward | curator | matcher | extractor | judge | ...
    // — same vocabulary as llm_usage.agent.
    agent: text("agent").notNull(),
    // Attribution snapshot of the usage context at open time (plain uuids, no
    // FKs — same reasoning as llm_usage).
    userId: uuid("user_id"),
    jobId: uuid("job_id"),
    claimId: uuid("claim_id"),
    requestId: text("request_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // 'ok' | 'error'; NULL while running (or forever, if the process died).
    outcome: text("outcome"),
    error: text("error"),
    // Step count at finish — a cheap completeness check against agent_steps
    // (fire-and-forget step inserts can individually fail).
    steps: integer("steps").notNull().default(0),
    // The skills the run had in hand (skill names): those in its prompt when
    // it opened (usually none) and each it loaded with load_skill, updated
    // at every load; NULL for runs that never opened a skills list.
    skills: text("skills").array(),
    // Whether the run wrote to the graph (db/graph-writes.ts), set on its
    // first graph write. A run that did is kept for good; the retention
    // sweep (workers/trace-retention.ts) expires only the others.
    wroteToGraph: boolean("wrote_to_graph").notNull().default(false),
    // The commit the code that ran was built from (config.gitSha); NULL for
    // runs before it was recorded and for local runs.
    commitSha: text("commit_sha"),
    // Why the run's transcript is private (llm/run-visibility.ts): its
    // agent's inputs are not public by construction, or it called a tool
    // that reads private data or that no one has classified. Empty = public.
    // A reason is only ever added while the run is live; nothing removes one
    // except a release that names it (a grant conversation that has closed).
    privateReasons: text("private_reasons").array().notNull().default(sql`'{}'::text[]`),
    // The seal (#552; services/run-log.ts): the hash the run's chain of
    // steps reached, and when the run closed with every step written. NULL
    // on a run still open, on one that lost a step, and on runs from before
    // steps were chained. A sealed run's log can be checked against log_hash.
    logHash: text("log_hash"),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    // The label the run wrote at (src/labels.ts): every labelled row it
    // wrote carries the same one, and so does its prompt step's setup.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_agent_runs_agent_time").on(table.agent, table.startedAt),
    // The retention sweep reads only the runs it may expire.
    index("idx_agent_runs_expirable")
      .on(table.startedAt)
      .where(sql`wrote_to_graph = false`),
    index("idx_agent_runs_claim").on(table.claimId),
    index("idx_agent_runs_job").on(table.jobId),
  ]
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    // Client-side sequence within the run (0-based). Unique within a run
    // for chained steps (the partial index below); steps recorded before
    // the chain were not held to that.
    seq: integer("seq").notNull(),
    // 'assistant' (one model turn: stop reason + full content blocks) or
    // 'tool_results' (the executed tools of that turn: name, input, output).
    kind: text("kind").notNull(),
    content: jsonb("content").notNull(),
    // The hash chain (#552; services/run-log.ts): the hash of the step
    // before this one (the run's genesis hash for step 0), and this step's
    // own, taken over prev_hash, seq, kind and the content as stored. NULL
    // on steps recorded before the chain.
    prevHash: text("prev_hash"),
    hash: text("hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run the step belongs to (src/labels.ts), taken from
    // the run when it opened and not from whatever is in the air when the
    // queued write lands (services/trace-service.ts). The hash chain covers
    // prev_hash, seq, kind and content, not this column: the label a run
    // worked at is under the chain in its prompt step's setup.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_agent_steps_run").on(table.runId, table.seq),
    uniqueIndex("uq_agent_steps_chained")
      .on(table.runId, table.seq)
      .where(sql`hash IS NOT NULL`),
  ]
);

// ---------------------------------------------------------------------------
// setup_parts — the versioned parts of agent runs' setups (#552 groundwork)
//
// One row per distinct text of a setup part: the constitution, a role prompt
// (system block with the constitution and date removed), a tool descriptor.
// Identity is (kind, name, hash); `version` numbers the texts of one
// (kind, name) in order of first sighting and never changes. A run's prompt
// step records which parts it ran under (services/setup-service.ts).
// `public` marks text the API may serve: the constitution and role prompts
// that match the repository's code; other parts are served by hash only.
// ---------------------------------------------------------------------------
export const setupParts = pgTable(
  "setup_parts",
  {
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    public: boolean("public").notNull().default(false),
    sourcePath: text("source_path"),
    firstSeenCommit: text("first_seen_commit"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run that first stored this text (src/labels.ts). A
    // part is stored once and shared by every run that used the same text,
    // so this is the label of the first sighting and stays that way.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.name, table.hash] }),
    uniqueIndex("uq_setup_parts_version").on(table.kind, table.name, table.version),
    check("ck_setup_parts_kind", sql`${table.kind} IN ('constitution', 'role', 'tool')`),
  ]
);

// ---------------------------------------------------------------------------
// enqueue_events
//
// Orchestration telemetry (#334 L0, #217's fan-out half): one row per enqueue
// through the queue-service chokepoint — who (source agent run) caused what
// (target queue + trigger). This is the data that answers "when an agent of
// type Y runs in situation A, how many agents of type X does it enqueue",
// reconstructs propagation trees for cascade-stability analysis (#295's
// empirical R), and measures how much of a propagation storm the steward's
// pending-slot coalescing (#182) actually absorbs (`coalesced`).
//
// Source attribution rides in from the ambient usage context; a NULL
// source_agent means the enqueue came from a route/worker outside any agent
// run (e.g. ingestion intake). Writes are fire-and-forget (like llm_usage and
// the trace tables): telemetry never fails or slows an enqueue. Plain uuids,
// no FKs, safe to prune by created_at.
// ---------------------------------------------------------------------------
export const enqueueEvents = pgTable(
  "enqueue_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Target queue: steward | curator | contribution | arbitration | audit |
    // claim_pipeline | url_extraction.
    queue: text("queue").notNull(),
    // The message's situation taxonomy: StewardMessage.trigger,
    // curation request source, ArbitrationMessage.trigger, AuditMessage.
    // auditType. NULL for queues whose messages carry no trigger.
    trigger: text("trigger"),
    // Target-side attribution, when the message names one.
    claimId: uuid("claim_id"),
    jobId: uuid("job_id"),
    contributionId: uuid("contribution_id"),
    // Source-side attribution, snapshotted from the usage context: which
    // agent run did the enqueuing (join agent_runs via source_run_id for the
    // full causal lineage), and which claim's work it was doing.
    sourceAgent: text("source_agent"),
    sourceRunId: uuid("source_run_id"),
    sourceClaimId: uuid("source_claim_id"),
    // Steward lane only: true when the enqueue APPENDED to an existing
    // pending slot (absorbed by #182's coalescing), false when it created
    // the slot. NULL for the other queues, which have no slots.
    coalesced: boolean("coalesced"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request that enqueued (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_enqueue_events_queue_time").on(table.queue, table.createdAt),
    index("idx_enqueue_events_source_run").on(table.sourceRunId),
    index("idx_enqueue_events_claim").on(table.claimId),
  ]
);

// ---------------------------------------------------------------------------
// queue_depth_snapshots
//
// Periodic depth samples (#217): the steward lane by state plus the open
// action ledger, persisted so fan-out spikes and silent pile-ups are visible
// over time instead of only at the moment someone hits GET /queue. Written by
// the queue-depth sampler worker on a period key, so concurrent instances
// record each period at most once. Safe to prune by created_at.
// ---------------------------------------------------------------------------
export const queueDepthSnapshots = pgTable(
  "queue_depth_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // '<unix period number>' for the sampling interval in effect; UNIQUE so
    // one row per period across processes (losers' inserts no-op).
    periodKey: text("period_key").unique(),
    // Extracted for cheap charting; the full detail rides in `detail`.
    stewardPending: integer("steward_pending").notNull().default(0),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_queue_depth_snapshots_time").on(table.createdAt)]
);

// ---------------------------------------------------------------------------
// eval_runs
//
// The eval-run registry (#334 L1): scorecard history as a table, so "how did
// this metric move across the last N runs" is a query instead of file
// archaeology. Written by corpus:score alongside its file artifacts; read by
// corpus:runs and corpus:compare (db:<id> refs). In the corpus database this
// table is deliberately EXCLUDED from corpus:reset's truncate list — the
// graph is disposable, the history of measurements of it is not. The
// committed corpus/scorecards/ files remain the cross-machine record;
// this is the queryable local one, and the seam the noise-band compare
// machinery (#334 L2) will read.
// ---------------------------------------------------------------------------
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cluster: text("cluster").notNull(),
    // What produced this row: 'score' today; 'corpus_run', 'model_swap',
    // 'golden' etc. as the harness grows.
    kind: text("kind").notNull().default("score"),
    // The run's configuration fingerprint (pipelineEpoch, git commit, agent +
    // judge models) — comparisons only mean something within a fingerprint.
    config: jsonb("config").notNull(),
    // The full scorecard JSON, null if the run was registered but not scored.
    scorecard: jsonb("scorecard"),
    // Where the file artifacts (report.md, trace.jsonl, scorecard.md) live.
    runDir: text("run_dir"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_eval_runs_cluster_time").on(table.cluster, table.createdAt)]
);

// ---------------------------------------------------------------------------
// claim_predictions (#334 S6, from #296)
//
// A prediction is an ordinary claim with a lifecycle the rest of the graph
// lacks: it RESOLVES, and reality — not a judge, not consensus — grades the
// credence the Steward assigned. This is the one objective calibration
// handle the project has, so predictions carry, one row per claim, what
// makes them resolvable: the criterion, the date by which the world settles
// it, and the source of truth that settles it. Credence is not frozen here;
// assessment history already keeps every verdict with its timestamp, and the
// scorer reads the last credence stated before resolution (scripts/corpus/
// prediction-score.ts) — the contemporaneous belief, never a later revision.
// A market or community probability captured at seeding is the baseline the
// Minerval-vs-crowd comparative needs. A resolved row keeps its outcome and a
// note on how it was settled; scoring only ever reads resolved rows.
// ---------------------------------------------------------------------------
export const claimPredictions = pgTable(
  "claim_predictions",
  {
    claimId: uuid("claim_id")
      .primaryKey()
      .references(() => claims.id, { onDelete: "cascade" }),
    // The fixture entry this row was seeded from (corpus/predictions/), so
    // seeding is idempotent and a resolution can name the question by id.
    // Null for predictions that arrive by other paths.
    fixtureId: text("fixture_id"),
    resolutionCriterion: text("resolution_criterion").notNull(),
    // The date by which the outcome is knowable; the scorer uses it (or the
    // earlier actual resolution) as the cutoff for the credence it grades.
    resolutionDate: date("resolution_date").notNull(),
    operationalization: text("operationalization").notNull(),
    domain: text("domain"),
    baselineProbability: real("baseline_probability"),
    baselineSource: text("baseline_source"),
    baselineAt: timestamp("baseline_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // true = the claim as stated came true; false = it did not. Null = open.
    outcome: boolean("outcome"),
    resolutionNote: text("resolution_note"),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of whatever seeded the prediction (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_claim_predictions_fixture").on(table.fixtureId),
    index("idx_claim_predictions_due").on(table.resolutionDate),
  ]
);

// ---------------------------------------------------------------------------
// owl_ledger
//
// The one spendable balance: owls, the platform's unit of account (1 owl =
// OWL_PRICE_MICRO_USD of face value, ~$4 ≈ one claim assessment). Every earn
// and every spend is an explicit signed row in face-value micro-USD, and
// balance = SUM(amount_micro_usd) — no derived drawdown against llm_usage
// (which remains internal cost observability, not the bill). Positive rows:
// purchases (Stripe packs), signup/monthly free grants, contribution awards,
// escrow refunds. Negative rows: flat-price charges, escrow holds, clawbacks.
//
// idempotencyKey is UNIQUE so every grant path is safely re-runnable: Stripe
// webhook retries ("stripe:<session_id>"), the one-time signup grant
// ("signup:<user_id>"), and the monthly trickle ("monthly:<user_id>:<YYYY-MM>")
// each credit exactly once.
//
// claimId / contributionId / jobId attribute the row for the account-page
// history ("1 owl — assessment of claim X"); they never affect the balance.
// jobId points at the budgeted-jobs entity (escrow holds/refunds) and is a
// plain uuid until that table lands.
// ---------------------------------------------------------------------------
export const owlLedger = pgTable(
  "owl_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    // Signed face value in micro-USD (1e-6 USD), matching
    // llm_usage.cost_micro_usd so cost/price arithmetic never converts units.
    amountMicroUsd: bigint("amount_micro_usd", { mode: "number" }).notNull(),
    // purchase | signup_grant | monthly_grant | contribution_award | charge |
    // refund | escrow_hold | escrow_refund | admin_adjust | owl_created
    // (OWL_REASONS in src/services/owl-ledger-service.ts has them all)
    reason: text("reason").notNull().default("purchase"),
    // For charges/refunds: the priced operation (claim_proposal,
    // source_ingest, extension_analysis, …) — see src/services/owl.ts.
    op: text("op"),
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    contributionId: uuid("contribution_id").references(() => contributions.id, {
      onDelete: "set null",
    }),
    jobId: uuid("job_id"),
    idempotencyKey: text("idempotency_key").unique(),
    stripeEventId: text("stripe_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_owl_ledger_user_time").on(table.userId, table.createdAt),
    index("idx_owl_ledger_contribution").on(table.contributionId),
  ]
);

// ---------------------------------------------------------------------------
// usage_reports: what this deployment reports of its own owl spend
//
// A members-only deployment on the metered price reports, for each closed
// UTC day, the owls its runs spent: one total and nothing else
// (docs/usage-report.md; src/services/usage-report-service.ts). A row is
// one report. `body` is the report exactly as it is sent, character for
// character, written when the report is prepared and never changed, so an
// administrator can read before sending what will leave, and afterwards
// what left. It is text and not jsonb for that reason: jsonb would reorder
// it.
//
// A period's report is not rewritten. If a later count of the same day
// differs, the correction is a new row with the next `revision`, and both
// are sent. `deployment_id` is minted with the first report and repeated on
// every one, so that two deployments reporting under one account are told
// apart.
//
// The sending columns are the only ones that change: when the public graph
// acknowledged the report (`sent_at`, `sent_via` 'online', `receipt`), or
// when it was written to a file to be handed over (`sent_via` 'file',
// `receipt` holding the file's name), and the last failed attempt. Empty
// on the public graph, which reports to no one.
//
// The table carries no label. A report is a day, a total and identifiers,
// taken over runs at every label, and it is made to leave the deployment:
// nothing in it is a run's or a person's words.
// ---------------------------------------------------------------------------
export const usageReports = pgTable(
  "usage_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull(),
    // The UTC day the report is of.
    period: date("period").notNull(),
    // 0 for the day's first report; each correction takes the next number.
    revision: integer("revision").notNull().default(0),
    body: text("body").notNull(),
    // sha256 of `body`, hex.
    bodyHash: text("body_hash").notNull(),
    // The total the body states, in millionths of an owl, kept beside it so
    // that a recount can be compared without parsing the body.
    spentMicroOwls: bigint("spent_micro_owls", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // 'online' | 'file'; null until sent.
    sentVia: text("sent_via"),
    receipt: jsonb("receipt"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("uq_usage_reports_period_revision").on(table.period, table.revision),
    index("idx_usage_reports_unsent").on(table.period).where(sql`${table.sentAt} IS NULL`),
  ]
);

// ---------------------------------------------------------------------------
// usage_reports_received: what other deployments reported to this one
//
// The receiving side of the same report (POST /usage-reports): a private
// deployment sends its report to the public graph under the organization's
// account, and it is recorded here against that account, as it was sent.
// Nothing reads these rows to bill yet. One row per account, deployment,
// period and revision: the same report sent again is recognized by its
// hash and changes nothing, and a different report for a period already
// reported is refused unless it is the next revision. Empty on a
// deployment nobody reports to.
//
// No label here either: the same day, total and identifiers, held against
// the account that sent them, as the owl ledger holds an account's money.
// ---------------------------------------------------------------------------
export const usageReportsReceived = pgTable(
  "usage_reports_received",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id").notNull(),
    period: date("period").notNull(),
    revision: integer("revision").notNull().default(0),
    // The report as received, in canonical form (keys sorted, no spaces),
    // which is the form a deployment sends it in.
    body: text("body").notNull(),
    bodyHash: text("body_hash").notNull(),
    // The total the body states, in millionths of an owl.
    spentMicroOwls: bigint("spent_micro_owls", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_usage_reports_received").on(
      table.accountId,
      table.deploymentId,
      table.period,
      table.revision
    ),
  ]
);

// ---------------------------------------------------------------------------
// assessment_orders
//
// A user's purchase of one Steward assessment of one claim — the demand side
// of the owl economy. Orders run on the EXPRESS lane: dispatched ahead of the
// background importance-ordered drain (a purchase doesn't queue), with the
// run's spend attributed to the ordering user via the usage context.
//
// Charge-at-start: the order is created UNCHARGED (chargeEntryId null) and
// the owl is debited by the dispatcher at the moment the Steward run begins —
// so a pending order cancels free, and a user is never charged for work that
// hasn't started. A proposal-funded order (contributionId set) was already
// paid by the claim_proposal charge and is never charged again.
//
// Lifecycle: pending → running → done | failed (refunded if charged);
// pending → cancelled (free). A transient failure returns the order to
// pending WITH its charge intact, so the retry doesn't double-charge.
// ---------------------------------------------------------------------------
export const assessmentOrders = pgTable(
  "assessment_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // Set when this order was funded by an accepted claim proposal's charge.
    contributionId: uuid("contribution_id").references(() => contributions.id, {
      onDelete: "set null",
    }),
    priceMicroUsd: bigint("price_micro_usd", { mode: "number" }).notNull(),
    // The owl_ledger debit that paid for this order; null until charged.
    chargeEntryId: uuid("charge_entry_id").references(() => owlLedger.id, {
      onDelete: "set null",
    }),
    // pending | running | done | cancelled | failed
    status: text("status").notNull().default("pending"),
    error: text("error"),
    // The label of the request or run that placed the order (src/labels.ts);
    // the Steward pass the order buys runs at it.
    sensitivityLabel: sensitivityLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // The express drain: oldest pending first. Partial index = just the lane.
    index("idx_orders_pending")
      .on(table.createdAt)
      .where(sql`status = 'pending'`),
    index("idx_orders_user_time").on(table.userId, table.createdAt),
    index("idx_orders_claim").on(table.claimId),
    // One OPEN order per user per claim and label, enforced: two racing
    // clicks (or a network retry) must join one order, not charge twice. An
    // order is for a pass at its label (src/labels.ts), so one person may
    // have one open at each label they may start work at.
    uniqueIndex("uq_orders_open_per_claim")
      .on(table.userId, table.claimId, table.sensitivityLabel)
      .where(sql`status IN ('pending', 'running')`),
  ]
);

// ---------------------------------------------------------------------------
// actions — the action ledger, the mechanical contract of the allocation
// engine.
//
// One row per potential action the graph could take. Rows that are
// ALTERNATIVE ways of doing the same thing (assess this claim with the
// standard model vs. the strong model vs., later, with more effort or
// research tools) share an exclusion_group: at most one sibling ever
// runs. This table directly and mechanically governs execution — the
// executors are dumb loops over covered rows, and every judgment (what
// is valuable, which variant, how much to back) lives upstream in
// mandate_valuations and action_allocations.
// ---------------------------------------------------------------------------

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // assess | reassess | ingest | grant_planning (a registry, extensible)
    kind: text("kind").notNull(),
    // Siblings sharing this key are mutually exclusive alternatives,
    // e.g. 'assess:<claim_id>' or 'ingest:<url>'.
    exclusionGroup: text("exclusion_group").notNull(),
    // The way of doing it: standard | strong (| strong+elicit, ...).
    variant: text("variant").notNull().default("standard"),
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "cascade",
    }),
    // Non-claim targets: a source URL, a grant id.
    targetRef: text("target_ref"),
    // Human description for surfaces (never a bare id).
    label: text("label").notNull(),
    // Shared, objective expected cost (refreshed from cost estimates).
    costEstMicroUsd: bigint("cost_est_micro_usd", { mode: "number" })
      .notNull(),
    // open | running | done | superseded | cancelled
    status: text("status").notNull().default("open"),
    meteredCostMicroUsd: bigint("metered_cost_micro_usd", { mode: "number" }),
    // The budget job the run's llm_usage metering was attributed to (the
    // largest funder's job), stamped at completion. Lets escrow accounting
    // subtract ledger-consumed metering from a job's llm_usage total so a
    // self-funded run is never counted twice.
    meteredJobId: uuid("metered_job_id"),
    // The label of the work that opened this row (src/labels.ts), which the
    // run that executes it works at. Not `label`, which is the display name
    // above. A row is reused for the next piece of work on its group: while
    // it is open or running it keeps its label, and a finished row that is
    // opened again takes the label of the work that reopens it
    // (LABEL_ON_REOPEN_SQL in services/action-service.ts).
    sensitivityLabel: sensitivityLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_actions_group_variant").on(
      table.exclusionGroup,
      table.variant
    ),
    index("idx_actions_status_kind").on(table.status, table.kind),
    index("idx_actions_claim").on(table.claimId),
    index("idx_actions_metered_job").on(table.meteredJobId),
  ]
);

export type Action = typeof actions.$inferSelect;

// ---------------------------------------------------------------------------
// mandate_valuations — each mandate's own opinions, sparse.
//
// A mandate values only the actions it knows and cares about, by its own
// definition of importance (the AI Math mandate holds no opinion on a
// politics claim). Values are written by the mandate's valuer: a formula
// (the General mandate's allocation policy, run in bulk), a scoped
// formula, or its Grantmaker's judgment. Value is perspectival and lives
// here; cost is shared and lives on the action row.
// ---------------------------------------------------------------------------

export const mandateValuations = pgTable(
  "mandate_valuations",
  {
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    valueEst: real("value_est").notNull(),
    rationale: text("rationale"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the work that wrote the valuation and its rationale
    // (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.actionId] }),
    index("idx_mandate_valuations_action").on(table.actionId),
  ]
);

// ---------------------------------------------------------------------------
// action_allocations — money placed on actions; the engine's only input.
//
// An allocation targets an exclusion GROUP ("get this claim assessed"),
// optionally pinned to one variant row ("...with the strong model"). An
// unpinned allocation counts toward every sibling's coverage and is
// consumed by whichever wins; a pinned allocation counts only toward its
// variant and is RELEASED back to its funder if a sibling wins instead
// (a vote for a losing way of doing it is returned, not spent). An
// action runs exactly when its coverage (pinned + unpinned unspent
// allocations) meets its expected cost; the metered cost of the run is
// split across the covering allocations pro rata.
// ---------------------------------------------------------------------------
export const actionAllocations = pgTable(
  "action_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exclusionGroup: text("exclusion_group").notNull(),
    // Pinned variant; NULL = any variant in the group.
    actionId: uuid("action_id").references(() => actions.id, {
      onDelete: "cascade",
    }),
    // Denormalized convenience for claim-scoped queries.
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "cascade",
    }),
    // The funder: exactly one of a mandate or a person directly.
    grantId: uuid("grant_id").references(() => grants.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => contributors.id, {
      onDelete: "cascade",
    }),
    amountMicroUsd: bigint("amount_micro_usd", { mode: "number" }).notNull(),
    // The funder's consumed share of runs this allocation helped cover.
    spentMicroUsd: bigint("spent_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    // Set when a losing sibling's pinned allocation was returned.
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // A COMMISSION (commission-service.ts) is an allocation that pays for a
    // run whole: its amount is the run's budget, chosen by whoever paid, and
    // the row runs as soon as it has one. These say who commissioned it (an
    // agent role, or 'person'), the brief the run's agent reads, the reason
    // for the public record, and the run that paid when an agent spent from
    // its own budget (the chain a petition is routed along). NULL on the
    // allocator's increments.
    commissionedBy: text("commissioned_by"),
    brief: text("brief"),
    reason: text("reason"),
    parentActionId: uuid("parent_action_id").references((): AnyPgColumn => actions.id, {
      onDelete: "set null",
    }),
    // The label of the work that placed the money, which is the label its
    // brief and reason are read at (src/labels.ts). The money itself is
    // read and settled whole, whatever the label, through
    // minerval_whole.allocation_money (db/money.ts): what a run costs is
    // split across every allocation that covers it.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_action_allocations_group").on(table.exclusionGroup),
    index("idx_action_allocations_parent").on(table.parentActionId),
    index("idx_action_allocations_claim").on(table.claimId),
    index("idx_action_allocations_grant").on(table.grantId),
    index("idx_action_allocations_user").on(table.userId),
    // Exactly one funder, positive money, spend never past the amount —
    // the invariants the comments promise, enforced.
    check(
      "ck_action_allocations_one_funder",
      sql`(grant_id IS NULL) <> (user_id IS NULL)`
    ),
    check("ck_action_allocations_amount", sql`amount_micro_usd > 0`),
    check(
      "ck_action_allocations_spent",
      sql`spent_micro_usd >= 0 AND spent_micro_usd <= amount_micro_usd`
    ),
    // A mandate holds at most one LIVE placement per (group, pin): the
    // backstop under the allocators' advisory locks. Fully spent or
    // released rows are history and don't block re-funding a later pass.
    uniqueIndex("uq_action_allocations_live_placement")
      .on(
        table.grantId,
        table.exclusionGroup,
        sql`(COALESCE(${table.actionId}::text, ''))`
      )
      .where(
        sql`released_at IS NULL AND grant_id IS NOT NULL AND spent_micro_usd < amount_micro_usd`
      ),
  ]
);


// ---------------------------------------------------------------------------
// budget_jobs
//
// An escrowed owl budget funding open-ended work — the entity behind every
// operation whose cost can't be a flat price: deep decomposition today,
// grantor agents later. Funding writes an owl_ledger escrow_hold (the owls
// leave the spendable balance immediately); real spend accrues against the
// budget via llm_usage rows attributed with job_id = this row's id; and on
// completion/cancellation the unspent remainder returns via escrow_refund.
//
// At the budget floor the job PAUSES (status 'paused_budget') with a
// checkpoint describing progress — it never silently dies mid-run — and a
// top-up (another escrow_hold) resumes it.
//
// Named budget_jobs because `jobs` is the ingestion-pipeline table.
// ---------------------------------------------------------------------------
export const budgetJobs = pgTable(
  "budget_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    // deep_decomposition | (grantor_agent, …)
    kind: text("kind").notNull(),
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    // Total escrowed (sum of holds), face-value micro-USD.
    budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    // running | paused_budget | completed | cancelled | failed
    status: text("status").notNull().default("running"),
    // Progress the job reports as it works and when it pauses — what the job
    // page renders ("assessed 7 of ~12, budget exhausted at claim X").
    checkpoint: jsonb("checkpoint"),
    error: text("error"),
    // The label of the request or run that funded this job (src/labels.ts).
    // The passes a deep-decomposition job pays for run at it.
    sensitivityLabel: sensitivityLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_budget_jobs_user_time").on(table.userId, table.createdAt),
    index("idx_budget_jobs_running")
      .on(table.updatedAt)
      .where(sql`status = 'running'`),
  ]
);

// ---------------------------------------------------------------------------
// grants
//
// A grantmaker's mandate: an escrowed owl budget (the budget_jobs row, kind
// 'grant') + a SCOPE (a claim's subtree and/or a topic query) + a POLICY for
// how to spend attention there + public attribution. Scales from a person
// with 20 owls ("keep my subdomain's cruxes fresh") to an institution
// funding a whole area through a grantor agent.
//
// Policies:
//   deepen   — steward the scope's pending/deferred claims, buying the depth
//              the background economics wouldn't (like deep_decomposition).
//   cover    — get every in-scope claim at least one assessment, breadth
//              first.
//   maintain — reassess in-scope claims whose assessment has gone stale.
//   agent    — a grantor agent surveys the scope and proposes an allocation
//              plan (stored on `plan`); the funder approves it before an owl
//              is spent, then execution is mechanical.
//
// Grant work runs on the grant's own budget (steward runs metered to the
// budget job) and records claim_stakes (source 'grant') for attribution and
// background-priority subsidy. Assessments produced under a grant carry
// funded_by_job_id — the §19 disclosure that funding is visible, while the
// verdict's standards never change.
// ---------------------------------------------------------------------------
export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    funderUserId: uuid("funder_user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    budgetJobId: uuid("budget_job_id")
      .notNull()
      .references(() => budgetJobs.id, { onDelete: "cascade" }),
    // The mandate's working title, shown ONLY on the funder's own dashboard.
    // Never rendered on claim surfaces: funding disclosures there describe
    // the arrangement ("a funded mandate"), not the party (§12/§19).
    name: text("name").notNull(),
    // Scope: a subtree root and/or a keyword query — at least one.
    scopeClaimId: uuid("scope_claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    scopeQuery: text("scope_query"),
    // deepen | cover | maintain | agent
    policy: text("policy").notNull(),
    // planning | pending_approval | active | completed | cancelled
    // (budget pauses live on the budget job; the grant status is the
    // mandate's lifecycle).
    status: text("status").notNull().default("active"),
    // The grantor agent's proposed allocation (policy 'agent'):
    // [{claim_id, action: 'assess'|'deepen', rationale}], plus the agent's
    // overall strategy note. Executed in order once approved.
    plan: jsonb("plan"),
    planCursor: integer("plan_cursor").notNull().default(0),
    // The full Grantmaker-drafted mandate (title, objective, plan, quote,
    // notes) copied here at funding time — the public dashboard's text.
    // Agent-authored, never funder-authored.
    mandate: jsonb("mandate"),
    // Platform-run mandates (Minerval's own: Mathematics, AI Economics, …)
    // get pride of place on the public /mandates page.
    isPlatform: boolean("is_platform").notNull().default(false),
    // Optional spend rate: at most this much metered cost per UTC day
    // (0 = no rate cap, pace bounded by escrow alone). Shared mandate
    // infrastructure — Minerval's General mandate paces itself
    // with this, and any funder can set one on their own mandate.
    dailyBudgetMicroUsd: bigint("daily_budget_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    // The mandate's own figures for pricing and pacing work: cost priors,
    // the re-check cadence, attempt bounds, sweep and scan settings
    // (services/allocation-policy-service.ts). Null = the shared defaults.
    // The General mandate's row governs the platform's own work. No agent
    // writes this column; scripts/seed-platform-mandates.ts is the one
    // writer. A row from before #855, when a Grantmaker tool set it, may
    // hold keys since removed, which the loader ignores.
    allocationPolicy: jsonb("allocation_policy"),
    // The Grantmaker's own working memory: a document it reads in full at
    // the start of every review pass and rewrites as it works — its map
    // of the territory, source backlog, strategy, open questions. Owned
    // entirely by the agent; a mandate-scale mission is impossible
    // without durable working state between passes.
    workspace: text("workspace"),
    // While a program officer (or the Grantmaker, deciding escalations) is
    // working this mandate's inbox: one at a time, so petitions that arrive
    // together are decided together, side by side. Expires on its own.
    officerLeaseUntil: timestamp("officer_lease_until", { withTimezone: true }),
    // How far the inbox collector (mandate-event-service.ts) has read the
    // graph for this mandate: events are what happened after this. Null
    // until the first scan, which starts from then rather than replaying
    // the mandate's history.
    eventsScannedAt: timestamp("events_scanned_at", { withTimezone: true }),
    // The domain skills this mandate's Grantmaker carries (skill names): its
    // conversation and review passes splice these views in. They select the
    // Grantmaker's view and nothing else; the agents that write to the graph
    // take their skills from the claim, never from the funder.
    skills: text("skills").array().notNull().default([]),
    // The public approval behind a platform-funded mandate (#529): the
    // reviewed pull request that put Minerval's money behind the
    // Grantmaker's draft, who merged it, and the draft's hash. Null for
    // every mandate a person funds and for the seeded standing mandates.
    platformApproval: jsonb("platform_approval"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the request or run that created the mandate
    // (src/labels.ts). A mandate decides for its work: its plan, its review
    // and planning rows, its sittings and its events are opened at this label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_grants_funder").on(table.funderUserId, table.createdAt),
    index("idx_grants_status").on(table.status),
  ]
);

// ---------------------------------------------------------------------------
// regrants
//
// A grant funding another grant. All grants live on the same level: any
// mandate can be funded separately (user contributions) AND fund other
// mandates — carving budget out for ingestion run by another Grantmaker,
// splitting basic research from applications, and so on. A regrant moves
// escrowed budget from the source grant's budget job to the target's:
// the amount counts against the source's committed money (headroom and
// pause checks include it) and joins the target's refund basis, so when
// the target settles with unspent budget the source's share flows back
// into its escrow, pro rata with the target's user contributors.
// ---------------------------------------------------------------------------
export const regrants = pgTable(
  "regrants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromGrantId: uuid("from_grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    toGrantId: uuid("to_grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    amountMicroUsd: bigint("amount_micro_usd", { mode: "number" }).notNull(),
    // The Grantmaker's one-line why, recorded with the transfer.
    note: text("note"),
    // Unspent share returned to the source when the target settled.
    refundedMicroUsd: bigint("refunded_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the work that moved the money, which is the label its
    // note is read at. The amounts are read whole through
    // minerval_whole.regrant_money (db/money.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_regrants_from").on(table.fromGrantId),
    index("idx_regrants_to").on(table.toGrantId),
    check("ck_regrants_amount", sql`amount_micro_usd > 0`),
    check(
      "ck_regrants_refunded",
      sql`refunded_micro_usd >= 0 AND refunded_micro_usd <= amount_micro_usd`
    ),
  ]
);

// ---------------------------------------------------------------------------
// grant_sources
//
// The ingestion-pipeline record: one row per source a grant ingested (an
// 'ingest' plan item executed). What the public mandate dashboard's
// pipeline view digs into: joined through claim_instances it answers
// "where are the claims coming from" and "what do they look like"
// (importance and contestation distributions per source, match vs create
// rates), and the Grantmaker's analytics tools read the same rows.
// ---------------------------------------------------------------------------

export const grantSources = pgTable(
  "grant_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // The extraction job, for status ("queued/processing/completed/failed").
    jobId: uuid("job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_grant_sources_grant").on(table.grantId, table.createdAt),
  ]
);

export type GrantSource = typeof grantSources.$inferSelect;

// ---------------------------------------------------------------------------
// source_extractions
//
// One row per extraction of a source: what it was read FOR. A whole-document
// extraction has no focus; a scoped ingest names one in the words of the
// mandate that asked ("this author's claims about monetary policy"), and the
// extractor proposed only the claims bearing on it. The record is what lets
// a source page say honestly how much of a document's argument the graph
// holds, and what lets a later ingest of the same URL, with another focus or
// none, extract what is missing instead of being refused as a duplicate.
// Sources extracted before this table existed have no rows (whole-document,
// by the rule of the time).
// ---------------------------------------------------------------------------
export const sourceExtractions = pgTable(
  "source_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // Null = the whole document.
    focus: text("focus"),
    // The mandate whose ingest this was, when one was.
    grantId: uuid("grant_id").references(() => grants.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    claimsExtracted: integer("claims_extracted").notNull().default(0),
    claimsCreated: integer("claims_created").notNull().default(0),
    claimsMatched: integer("claims_matched").notNull().default(0),
    // Proposals the Matcher could not decide on, even after a second run at
    // the end of the job (#738): kept here (proposal, form, kind, context)
    // rather than dropped, so the source record shows them and a reading
    // that left any does not count as covering the document.
    claimsUndecided: integer("claims_undecided").notNull().default(0),
    undecided: jsonb("undecided"),
    // What the Extractor reported about the document itself (#740):
    // unreadable | not_the_document | injected_instructions, with its note.
    // A reading with a problem does not count as covering the document.
    documentProblem: text("document_problem"),
    documentProblemNote: text("document_problem_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_source_extractions_source").on(table.sourceId, table.createdAt)]
);

export type SourceExtraction = typeof sourceExtractions.$inferSelect;

// ---------------------------------------------------------------------------
// ingest_focuses
//
// The focus of a scoped ingest action, keyed by its exclusion group
// (INGEST_GROUP(url, focus)): ledger rows carry only a target_ref, and the
// focus is what the executor hands the extractor.
// ---------------------------------------------------------------------------
export const ingestFocuses = pgTable("ingest_focuses", {
  exclusionGroup: text("exclusion_group").primaryKey(),
  url: text("url").notNull(),
  focus: text("focus").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // The label of the work that first opened the scoped ingest (src/labels.ts).
  sensitivityLabel: sensitivityLabelColumn(),
});

// ---------------------------------------------------------------------------
// lookouts
//
// A standing watch a mandate funds: a cheap agent with a brief (scope in
// words, where to look, what to look out for), a set of triggers, and a
// bounded, delegated slice of the mandate's spending judgment. It runs
// when a trigger fires (a heartbeat on its own cadence, an input event
// queued by a poller or a person), reads the graph and the open web, and
// answers one question: has anything happened that warrants work in
// scope? Its outputs are work, never conclusions: a pass or an ingest it
// commissions within the limit its Grantmaker set (commission_limit), or
// raises to the mandate's program officers, and a note for the
// Grantmaker's next review pass. Importance and assessments are beyond its
// reach by construction.
//
// Scope is the brief's words: "this claim and what it turns on" is one
// shape, "the retraction record for sources behind the nutrition claims"
// or "new arXiv preprints on X" are others. Which happenings fall under
// the brief is the lookout's judgment, never a keyword filter's.
// ---------------------------------------------------------------------------
export const lookouts = pgTable(
  "lookouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The funding mandate. Every run is a `lookout_run` action covered
    // from its escrow (fundGrantSelfActions), so a lookout can never
    // outspend the mandate that stands it up.
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // The brief, written by the Grantmaker: scope, where to look, what
    // to look out for, what to leave alone. Read in full every run.
    brief: text("brief").notNull(),
    // active | paused | retired
    status: text("status").notNull().default("active"),
    // Heartbeat cadence in hours; 0 = event-driven only.
    heartbeatHours: integer("heartbeat_hours").notNull().default(24),
    // Input kinds beyond the heartbeat this lookout wakes on:
    // ["retraction", "manual", ...] — see LOOKOUT_TRIGGER_KINDS.
    triggers: jsonb("triggers").notNull().default([]),
    // Per-lookout model override; null = config.lookoutModel.
    model: text("model"),
    // The most the lookout may commission on its own for one item, from the
    // mandate's money; above it, or at 0, it raises the item to the
    // mandate's program officers. The Grantmaker delegates this much of its
    // spending judgment and no more.
    commissionLimitMicroUsd: bigint("commission_limit_micro_usd", { mode: "number" }).notNull().default(0),
    // The graph feed: the part of the graph the lookout follows (nodes, with
    // everything beneath them, and tags), and how far through the change
    // stream it has read.
    territoryClaimIds: uuid("territory_claim_ids").array().notNull().default(sql`'{}'::uuid[]`),
    territoryTagIds: uuid("territory_tag_ids").array().notNull().default(sql`'{}'::uuid[]`),
    changesCursor: text("changes_cursor"),
    // The lookout's own durable notes, read back every run: what it has
    // already seen and flagged, sources checked and when, what to watch.
    workspace: text("workspace"),
    // The run-end note, recorded on the mandate's public page.
    lastNote: text("last_note"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    // When the heartbeat next falls due. The reconcile sweep opens a
    // lookout_run row when this has passed or an unconsumed event waits.
    nextDueAt: timestamp("next_due_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    runs: integer("runs").notNull().default(0),
    flags: integer("flags").notNull().default(0),
    // Who set it up: 'grantmaker:review' | 'grantmaker:chat' | 'seed'.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run that set the lookout up (src/labels.ts). A
    // lookout decides for its work: its runs, its feed polls and the events
    // a timer queues for it are at this label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_lookouts_grant").on(table.grantId, table.createdAt),
    index("idx_lookouts_due")
      .on(table.nextDueAt)
      .where(sql`status = 'active'`),
    check(
      "ck_lookouts_status",
      sql`${table.status} IN ('active', 'paused', 'retired')`
    ),
    check("ck_lookouts_heartbeat", sql`${table.heartbeatHours} >= 0`),
  ]
);

export type Lookout = typeof lookouts.$inferSelect;

// ---------------------------------------------------------------------------
// lookout_events
//
// Inputs queued for a lookout by something other than its heartbeat: a
// retraction the Crossref poller matched to a source in the graph, a note
// a Grantmaker or funder poked it with. Unconsumed events make the lookout
// due; the run reads them all and they are stamped consumed when it ends.
// ---------------------------------------------------------------------------
export const lookoutEvents = pgTable(
  "lookout_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lookoutId: uuid("lookout_id")
      .notNull()
      .references(() => lookouts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // The label of whoever queued it; for an event a timer queues (a
    // retraction, a feed wake), the lookout's (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_lookout_events_pending")
      .on(table.lookoutId, table.createdAt)
      .where(sql`consumed_at IS NULL`),
  ]
);

// ---------------------------------------------------------------------------
// mandate_events — a mandate's inbox: what its work produced since its
// Grantmaker last looked (an assessment on a node it funded, with the
// children that pass surfaced; a decision on a contribution it submitted;
// a source in its pipeline whose extraction finished; a lookout's flag).
// Pending events wake a review
// pass; the pass reads them and marks them consumed
// (mandate-event-service.ts).
// ---------------------------------------------------------------------------

export const mandateEvents = pgTable(
  "mandate_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    claimId: uuid("claim_id"),
    // The row the event is about (an assessment, a contribution, a source,
    // a lookout flag), so a rescan never records it twice.
    refId: uuid("ref_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // The mandate's label (src/labels.ts): events are collected for a
    // mandate, by a timer that works at the mandate's label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_mandate_events_pending")
      .on(table.grantId, table.createdAt)
      .where(sql`consumed_at IS NULL`),
    uniqueIndex("uq_mandate_events_ref").on(table.grantId, table.kind, table.refId),
  ]
);

// ---------------------------------------------------------------------------
// lookout_flags
//
// What a lookout produced: one row per candidate it raised. A `reassess`
// flag points at the claim's assess/reassess action and snapshots the
// assessment at flag time, so the record can later say whether the funded
// pass moved anything — the lookout's precision, read by its Grantmaker
// when deciding whether to keep paying for it. An `ingest` flag records the
// URL appended to the mandate's plan; a `note` is a message for the next
// review pass. A flag stays OPEN while its action is still open or running,
// and a second flag on the same target is folded into it (no duplicates,
// no re-flagging the same retraction every heartbeat).
// ---------------------------------------------------------------------------
export const lookoutFlags = pgTable(
  "lookout_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lookoutId: uuid("lookout_id")
      .notNull()
      .references(() => lookouts.id, { onDelete: "cascade" }),
    // reassess | ingest | note
    kind: text("kind").notNull(),
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "cascade",
    }),
    url: text("url"),
    // The ledger row the flag opened or valued (reassess: the standard
    // variant; ingest: null until the reconcile sweep opens it).
    actionId: uuid("action_id").references(() => actions.id, {
      onDelete: "set null",
    }),
    rationale: text("rationale").notNull(),
    // Historical (#695 to the retirement of valuations): the lookout's
    // urgency 0–10, and the value written on the mandate's behalf after its
    // ceiling clamped it. New flags write neither.
    urgency: real("urgency"),
    valueWritten: real("value_written"),
    // The assessment at flag time (reassess flags), for the precision read.
    statusAtFlag: text("status_at_flag"),
    credenceAtFlag: real("credence_at_flag"),
    assessmentIdAtFlag: uuid("assessment_id_at_flag"),
    // Folded duplicates: how many times the lookout raised this again while
    // it was still open.
    repeats: integer("repeats").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the lookout's run that raised it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_lookout_flags_lookout").on(table.lookoutId, table.createdAt),
    index("idx_lookout_flags_claim").on(table.claimId),
    check(
      "ck_lookout_flags_kind",
      sql`${table.kind} IN ('reassess', 'ingest', 'note')`
    ),
  ]
);

export type LookoutFlag = typeof lookoutFlags.$inferSelect;

// ---------------------------------------------------------------------------
// lookout_feeds
//
// An RSS or Atom feed a lookout follows (#305): an author's blog, a
// publication, a tag or a category. Polling is code and costs nothing; new
// items land in the lookout's inbox (lookout_feed_items), and the feed's
// WAKE RULE says when the waiting items are worth a funded run:
//   batch       — N new items since the last wake, or the oldest has
//                 waited H hours; never more often than every M hours
//   each        — any new item, at most every M hours
//   heartbeat   — never; items wait for the lookout's own heartbeat
//   paused      — never; the feed keeps polling and items keep
//   auto_ingest — no run: each new item goes onto the mandate's plan as an
//                 ingest, up to a daily cap (the Grantmaker's choice only)
// The feed is data, never instructions, as every ingested document is.
// ---------------------------------------------------------------------------
export const lookoutFeeds = pgTable(
  "lookout_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lookoutId: uuid("lookout_id")
      .notNull()
      .references(() => lookouts.id, { onDelete: "cascade" }),
    // The feed document itself (resolved from whatever URL was given).
    url: text("url").notNull(),
    siteUrl: text("site_url"),
    title: text("title"),
    // active | broken (too many failed polls) | removed
    status: text("status").notNull().default("active"),
    wake: text("wake").notNull().default("batch"),
    batchSize: integer("batch_size").notNull().default(10),
    maxWaitHours: integer("max_wait_hours").notNull().default(24),
    minWakeHours: integer("min_wake_hours").notNull().default(4),
    pollHours: integer("poll_hours").notNull().default(6),
    // Untriaged items expire after this many days (counted, never hidden).
    retainDays: integer("retain_days").notNull().default(14),
    // The focus an ingest from this feed carries by default (auto_ingest,
    // and the lookout's triage unless it gives its own): "the author's
    // claims about X". Null = the whole document.
    ingestFocus: text("ingest_focus"),
    // Null until the first poll, which records what is already there
    // without queueing it: subscribing does not flood the inbox.
    seededAt: timestamp("seeded_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastWokeAt: timestamp("last_woke_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),
    // Who added it: 'grantmaker:chat' | 'grantmaker:review' | 'lookout' | …
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run that added the feed (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_lookout_feeds_url").on(table.lookoutId, table.url),
    index("idx_lookout_feeds_due")
      .on(table.nextPollAt)
      .where(sql`status = 'active'`),
    check(
      "ck_lookout_feeds_status",
      sql`${table.status} IN ('active', 'broken', 'removed')`
    ),
    check(
      "ck_lookout_feeds_wake",
      sql`${table.wake} IN ('batch', 'each', 'heartbeat', 'paused', 'auto_ingest')`
    ),
  ]
);

export type LookoutFeed = typeof lookoutFeeds.$inferSelect;

// ---------------------------------------------------------------------------
// lookout_feed_items
//
// The lookout's inbox: one row per item a feed has carried, unique on the
// feed's own id for it, so a re-poll never duplicates. Status:
//   seen     — present at the first poll; recorded, never queued
//   new      — waiting for triage
//   deferred — the lookout chose to come back to it
//   ingested — put on the mandate's plan (by the lookout, or auto_ingest)
//   skipped  — the lookout judged it not worth ingesting (or it already
//              was in the graph or on the plan)
//   expired  — nobody triaged it within the feed's retention
// `body` caches the page the lookout fetched to read it, so an ingest of
// the same URL does not download it again.
// ---------------------------------------------------------------------------
export const lookoutFeedItems = pgTable(
  "lookout_feed_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => lookoutFeeds.id, { onDelete: "cascade" }),
    lookoutId: uuid("lookout_id")
      .notNull()
      .references(() => lookouts.id, { onDelete: "cascade" }),
    // The feed's guid/id for the item, else its link.
    itemKey: text("item_key").notNull(),
    url: text("url"),
    title: text("title"),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    summary: text("summary"),
    // The item's content as the feed carried it (often the whole post).
    content: text("content"),
    body: text("body"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    status: text("status").notNull().default("new"),
    reason: text("reason"),
    // lookout | auto | expiry
    triagedBy: text("triaged_by"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when the poll records the item. The page a lookout later fetches into
    // `body` lands on the row and leaves this as it was.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_lookout_feed_items_key").on(table.feedId, table.itemKey),
    index("idx_lookout_feed_items_inbox")
      .on(table.lookoutId, table.firstSeenAt)
      .where(sql`status IN ('new', 'deferred')`),
    index("idx_lookout_feed_items_url").on(table.url),
    check(
      "ck_lookout_feed_items_status",
      sql`${table.status} IN ('seen', 'new', 'deferred', 'ingested', 'skipped', 'expired')`
    ),
  ]
);

export type LookoutFeedItem = typeof lookoutFeedItems.$inferSelect;

// ---------------------------------------------------------------------------
// correspondents (#563)
//
// A Graph Correspondent: an agent that reads the graph for an audience and
// sends it updates about what deserves its attention (docs/allocation.md,
// "Correspondents"). It is the Lookout's counterpart: a lookout watches the
// world and brings material into the graph; a correspondent reads the graph
// and reports to people. A mandate funds it one `correspondent_run` action
// at a time, out of its escrow and its day like a lookout run, and it is
// woken the same way: a heartbeat, a material change in its scope, a poke.
//
// It holds no private access. Everything it reads (the graph reads, the
// change stream) is the same read MCP and the API serve, so anyone can run
// a correspondent of their own outside Minerval without registering here.
// ---------------------------------------------------------------------------
export const correspondents = pgTable(
  "correspondents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The funding mandate; every run is covered from its escrow.
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // The brief in the Grantmaker's words: what it covers, what matters to
    // its readers, how to read the graph for them, what to leave alone, how
    // to present it. Public, as mandates are.
    brief: text("brief").notNull(),
    // Who the updates are for, in words: "evaluators reviewing X", "the
    // public following Y".
    audience: text("audience").notNull(),
    // What the brief links to: claims (with what lies beneath them) and
    // tags. These answer "which correspondents cover this claim?" and are
    // the mechanical wake filter for graph_change; what deserves the
    // audience's attention is still the run's judgment.
    scopeClaimIds: uuid("scope_claim_ids").array().notNull().default(sql`'{}'::uuid[]`),
    scopeTagIds: uuid("scope_tag_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // active | paused | retired
    status: text("status").notNull().default("active"),
    // Heartbeat cadence in hours (a weekly digest is 168); 0 = event-only.
    heartbeatHours: integer("heartbeat_hours").notNull().default(168),
    // Inputs beyond the heartbeat it wakes on: ["graph_change", "manual"].
    triggers: jsonb("triggers").notNull().default([]),
    // The least time between two runs a change can wake, so a busy scope
    // does not send its readers an update every few minutes. Set by the
    // Grantmaker for the audience; it bounds human attention, which no
    // budget prices. The heartbeat and a poke are not held by it.
    minWakeHours: integer("min_wake_hours").notNull().default(24),
    // Per-correspondent model override; null = config.correspondentModel.
    model: text("model"),
    // Where its reading of the change stream stands (a changes cursor,
    // services/graph-change-service.ts). Changes after it are new to it.
    changesCursor: text("changes_cursor"),
    // Its own durable notes, read back every run.
    workspace: text("workspace"),
    lastNote: text("last_note"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    runs: integer("runs").notNull().default(0),
    updates: integer("updates").notNull().default(0),
    // 'grantmaker:chat' | 'grantmaker:review' | 'seed'
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run that set the correspondent up (src/labels.ts). Its
    // runs and the wakes a timer queues for it are at this label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_correspondents_grant").on(table.grantId, table.createdAt),
    index("idx_correspondents_due")
      .on(table.nextDueAt)
      .where(sql`status = 'active'`),
    check(
      "ck_correspondents_status",
      sql`${table.status} IN ('active', 'paused', 'retired')`
    ),
    check("ck_correspondents_heartbeat", sql`${table.heartbeatHours} >= 0`),
    check("ck_correspondents_min_wake", sql`${table.minWakeHours} >= 0`),
  ]
);

export type Correspondent = typeof correspondents.$inferSelect;

// Inputs queued for a correspondent by something other than its heartbeat:
// a material change in its scope (one wake, never one per change: the run
// reads the change stream from its cursor), or a poke. Unconsumed events
// make it due.
export const correspondentEvents = pgTable(
  "correspondent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    correspondentId: uuid("correspondent_id")
      .notNull()
      .references(() => correspondents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // The label of whoever queued it; for a wake the change scan queues, the
    // correspondent's (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_correspondent_events_pending")
      .on(table.correspondentId, table.createdAt)
      .where(sql`consumed_at IS NULL`),
  ]
);

// A correspondent's plan: what it means to do across runs (follow a
// question until it settles, write a summary once a subtree is assessed,
// ask its Grantmaker for a wider scope), each item open until it marks it
// done or dropped, with a note on what became of it.
export const correspondentPlanItems = pgTable(
  "correspondent_plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    correspondentId: uuid("correspondent_id")
      .notNull()
      .references(() => correspondents.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // open | done | dropped
    status: text("status").notNull().default("open"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the correspondent's run that added it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_correspondent_plan_items").on(table.correspondentId, table.status, table.createdAt),
    check(
      "ck_correspondent_plan_items_status",
      sql`${table.status} IN ('open', 'done', 'dropped')`
    ),
  ]
);

// One update a correspondent published: structured items for agents (a
// node, the reason it deserves attention, the changes behind it), a prose
// rendering for people, and what it did not cover: the changes in its
// window it did not mention (computed by the mechanism, never the agent)
// and what in scope it has not looked at (the agent's own account).
// Served at /correspondents/:id/updates and as an Atom feed.
export const correspondentUpdates = pgTable(
  "correspondent_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    correspondentId: uuid("correspondent_id")
      .notNull()
      .references(() => correspondents.id, { onDelete: "cascade" }),
    // The mandate that paid for the run, so every update can say so.
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // The prose rendering, in Markdown.
    body: text("body").notNull(),
    // [{ claim_id, reason, change_ids: [] }]
    items: jsonb("items").notNull().default([]),
    // { changes: [{ change_id, claim_id, kind }], changes_total, unexamined }
    notCovered: jsonb("not_covered").notNull().default({}),
    // The window of the change stream this update read: from the cursor it
    // started at to the one it ended at.
    changesFrom: text("changes_from"),
    changesTo: text("changes_to"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the correspondent's run that published it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_correspondent_updates_feed").on(table.correspondentId, table.createdAt),
  ]
);

export type CorrespondentUpdate = typeof correspondentUpdates.$inferSelect;

// ---------------------------------------------------------------------------
// consistency_sweeps
//
// One Consistency Checker sweep (#330; docs/allocation.md, "Consistency
// sweeps"): the agent's read of one partition of the graph (a tag, or the
// residual bucket of claims no sweepable tag covers). The row is the
// coverage record the scheduler reads ("tag X last swept at T"), and its
// note is the checker's memory of the partition: the next sweep of the
// same partition is briefed with it.
// ---------------------------------------------------------------------------
export const consistencySweeps = pgTable(
  "consistency_sweeps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for the residual bucket (or a whole-graph sweep).
    tagId: uuid("tag_id").references(() => tags.id, { onDelete: "set null" }),
    // 'tag' | 'residual' | 'graph': what the sweep covered.
    partition: text("partition").notNull(),
    // running | done | error
    status: text("status").notNull().default("running"),
    // agent_runs.id of the checker's run (no FK: traces are pruned).
    runId: uuid("run_id"),
    // Assessed claims in the partition when the sweep started.
    claimsInScope: integer("claims_in_scope").notNull().default(0),
    // The ledger variant a funded sweep ran as ('standard' | 'strong'),
    // null for an eval or one-off sweep (#756): what the per-variant cost
    // and yield the sweep's pricing and variant choice read are keyed on.
    variant: text("variant"),
    // What the sweep's run was metered at, in micro-USD (null when it ran
    // without a pass meter): the observed cost per node (#756).
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    flagsRaised: integer("flags_raised").notNull().default(0),
    note: text("note"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The label of the run that swept (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_consistency_sweeps_tag").on(table.tagId, table.startedAt),
    index("idx_consistency_sweeps_started").on(table.startedAt),
    check(
      "ck_consistency_sweeps_partition",
      sql`${table.partition} IN ('tag', 'residual', 'graph')`
    ),
    check(
      "ck_consistency_sweeps_status",
      sql`${table.status} IN ('running', 'done', 'error')`
    ),
  ]
);

export type ConsistencySweep = typeof consistencySweeps.$inferSelect;

// ---------------------------------------------------------------------------
// consistency_flags
//
// A place where assessments do not cohere, as judged by the Consistency
// Checker: reasoning that conflicts with a neighbor's, evidence recorded
// under one claim that another's assessment never weighed, a verdict that
// is not a defensible function of what it rests on. One row per flag,
// naming the PRIMARY claim (the one whose Steward reconciles) and every
// claim in the tension.
// Like lookout_flags, a flag is a candidate, never a conclusion: it
// enqueues the primary's Steward, and its expected_gain goes to the General
// mandate's officers with the flag; whether the pass is commissioned is
// theirs to decide under the operating policy. The assessment at flag time is
// snapshotted so precision ("did the pass move anything?") is a query.
// ---------------------------------------------------------------------------
export const consistencyFlags = pgTable(
  "consistency_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sweepId: uuid("sweep_id").references(() => consistencySweeps.id, {
      onDelete: "set null",
    }),
    // CONSISTENCY_FLAG_KINDS (consistency-service.ts).
    kind: text("kind").notNull(),
    primaryClaimId: uuid("primary_claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // Every claim in the tension, primary first.
    claimIds: uuid("claim_ids").array().notNull(),
    // The claim's standard assess/reassess row when the flag was raised.
    actionId: uuid("action_id").references(() => actions.id, {
      onDelete: "set null",
    }),
    rationale: text("rationale").notNull(),
    // The checker's estimate (0–1) that a fresh pass changes the primary's
    // verdict or reasoning materially: the formula's expected-gain input.
    expectedGain: real("expected_gain").notNull(),
    statusAtFlag: text("status_at_flag"),
    credenceAtFlag: real("credence_at_flag"),
    assessmentIdAtFlag: uuid("assessment_id_at_flag"),
    repeats: integer("repeats").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the sweep that raised it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_consistency_flags_primary").on(table.primaryClaimId, table.createdAt),
    index("idx_consistency_flags_action").on(table.actionId),
    index("idx_consistency_flags_sweep").on(table.sweepId),
  ]
);

export type ConsistencyFlag = typeof consistencyFlags.$inferSelect;

// ---------------------------------------------------------------------------
// grant_conversations
//
// Grantmaking is a conversation, not a form: a funder talks a mandate
// through with the grantmaker agent (best model, constitution loaded), the
// agent surveys the graph, quotes expected costs in owls, and drafts a
// mandate; nothing is escrowed until the funder explicitly funds the draft.
// The transcript is the record of that negotiation; the drafted mandate and
// the eventual grant link ride alongside.
// ---------------------------------------------------------------------------

export const grantConversations = pgTable(
  "grant_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    // active | proposed | funded | declined | abandoned
    status: text("status").notNull().default("active"),
    // [{role: 'user'|'assistant', content, at}] — the visible transcript.
    // Tool traffic stays internal.
    messages: jsonb("messages").notNull().default([]),
    // The agent's drafted mandate once the conversation converges:
    // {title, objective, scope_claim_id?, scope_query?, plan: {strategy,
    //  items: [...]}, expected_cost_owls, notes}. Null until proposed.
    mandate: jsonb("mandate"),
    // Set when the mandate was funded and became a grant.
    grantId: uuid("grant_id").references(() => grants.id, {
      onDelete: "set null",
    }),
    // The Grantmaker's turn runs in the background after the funder's
    // message is saved. Set while a turn holds the conversation; the
    // heartbeat is refreshed while it runs, so a turn whose process died
    // (a deploy, a crash) reads as lost rather than as running forever.
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    turnHeartbeatAt: timestamp("turn_heartbeat_at", { withTimezone: true }),
    // Why the last turn failed; cleared when the next turn starts.
    turnError: text("turn_error"),
    // The running turn's reply as the Grantmaker writes it, saved about once
    // a second so whoever is reading the conversation sees it form. Cleared
    // when the turn ends: the finished reply is in messages.
    turnPartial: text("turn_partial"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the request that opened the conversation (src/labels.ts).
    // Its turns are in `messages`, on this row.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_grant_convos_user").on(table.userId, table.createdAt),
  ]
);

export type GrantConversation = typeof grantConversations.$inferSelect;

// ---------------------------------------------------------------------------
// assistant_conversations, assistant_held_actions, assistant_allowances
//
// The Assistant (#646, #619, #312): an agent that works for one user, with
// the account's own tools. A conversation is the user's: private, deletable,
// and the only place its text is kept besides the run log.
// ---------------------------------------------------------------------------
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    // The user's first message, shortened: what the conversation list shows.
    title: text("title").notNull().default(""),
    // Where the user is: 'web' today.
    surface: text("surface").notNull().default("web"),
    // The node page the conversation was opened from, if any: {node_id}.
    origin: jsonb("origin"),
    // The model the user chose for this conversation; null is the default.
    model: text("model"),
    // [{role, content, at, citations?, worked?, cost_micro_usd?, run_id?,
    //   cards?, stopped?}]: the visible transcript. Tool traffic is in the
    // run log, which is private.
    messages: jsonb("messages").notNull().default([]),
    // What the conversation has cost its user so far.
    spentMicroUsd: bigint("spent_micro_usd", { mode: "number" }).notNull().default(0),
    // Kinds of held action the user allows without asking, for this
    // conversation alone (assistant_allowances holds the account's).
    allowedKinds: jsonb("allowed_kinds").notNull().default([]),
    // The turn protocol is the granting conversation's: a turn runs in the
    // background, refreshes a heartbeat, and saves the reply as it forms.
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    turnHeartbeatAt: timestamp("turn_heartbeat_at", { withTimezone: true }),
    turnError: text("turn_error"),
    turnPartial: text("turn_partial"),
    // The running turn's one-line progress note and its cost so far.
    turnNote: text("turn_note"),
    // What the running turn has done so far, newest last: [{tool, about}].
    turnActivity: jsonb("turn_activity"),
    turnCostMicroUsd: bigint("turn_cost_micro_usd", { mode: "number" }).notNull().default(0),
    // Set by the user's stop button; the running turn ends at its next step.
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the request that opened the conversation (src/labels.ts).
    // Its turns are in `messages`, on this row.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_assistant_convos_user").on(table.userId, table.updatedAt),
  ]
);

export type AssistantConversation = typeof assistantConversations.$inferSelect;

export const assistantHeldActions = pgTable(
  "assistant_held_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    // The account tool the Assistant called, and the kind it belongs to.
    tool: text("tool").notNull(),
    kind: text("kind").notNull(),
    // Exactly what the Assistant passed: what runs if the user presses.
    input: jsonb("input").notNull(),
    // held | running | done | declined | failed
    status: text("status").notNull().default("held"),
    // True when the user had allowed this kind and it ran without a card.
    auto: boolean("auto").notNull().default(false),
    // The tool's answer once it ran: {ok, status, body}.
    result: jsonb("result"),
    // The label of the Assistant's turn that made the call (src/labels.ts).
    // The call runs at it when the user presses, however long after.
    sensitivityLabel: sensitivityLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_assistant_held_convo").on(table.conversationId, table.createdAt),
  ]
);

export type AssistantHeldAction = typeof assistantHeldActions.$inferSelect;

export const assistantAllowances = pgTable("assistant_allowances", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => contributors.id, { onDelete: "cascade" }),
  // Kinds of held action the account allows without asking, in every
  // conversation.
  kinds: jsonb("kinds").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A page: something made for a user to keep (a brief, a ranked list, a
// table), by their Assistant or their own agent. Markdown, with embeds that
// show nodes of the graph as they stand when the page is read. Private to
// its user.
export const assistantPages = pgTable(
  "assistant_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // What the graph held for each embedded node when the page was saved:
    // {id: {status, standing, estimate}}. The page marks what has moved.
    snapshot: jsonb("snapshot").notNull().default({}),
    // Earlier saves, newest last: [{title, body, saved_at}].
    versions: jsonb("versions").notNull().default([]),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The label of the run or request that made the page (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_assistant_pages_user").on(table.userId, table.savedAt)]
);

export type AssistantPage = typeof assistantPages.$inferSelect;

// ---------------------------------------------------------------------------
// oauth_clients
//
// OAuth 2.1 clients for the remote MCP server (#73 follow-up): hosted MCP
// clients (Claude.ai / Cowork, etc.) register themselves via RFC 7591 dynamic
// client registration, then send users through the authorize/consent flow.
// `clientId` is the public OAuth client_id; the secret (confidential clients
// only) is stored hashed like API keys — high-entropy random material, so a
// fast unsalted SHA-256 is the right construction.
// ---------------------------------------------------------------------------
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  // NULL for public clients (token_endpoint_auth_method 'none'), which prove
  // possession via PKCE instead of a secret.
  clientSecretHash: text("client_secret_hash"),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method")
    .notNull()
    .default("client_secret_basic"),
  logoUri: text("logo_uri"),
  clientUri: text("client_uri"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// oauth_authorization_requests
//
// One row per authorize→consent→code round-trip. Created (pending) when the
// client hits GET /oauth/authorize; the web consent page approves or denies
// it on behalf of the signed-in user; approval mints the single-use
// authorization code (stored hashed). The row is the code's audit trail:
// which client, which user, which PKCE challenge, when it was consumed.
// ---------------------------------------------------------------------------
export const oauthAuthorizationRequests = pgTable(
  "oauth_authorization_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope"),
    state: text("state"),
    // PKCE is mandatory (OAuth 2.1); only S256 is accepted.
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
    // RFC 8707 resource indicator sent by MCP clients; stored for audit.
    resource: text("resource"),
    status: text("status").notNull().default("pending"), // pending|approved|denied|consumed
    // The consenting account; set at approval.
    userId: uuid("user_id").references(() => contributors.id, {
      onDelete: "cascade",
    }),
    codeHash: text("code_hash").unique(),
    // The label the person approving named for the tokens this consent
    // issues; null until it is approved, and where the approval named none
    // (a deployment whose only label is 'public').
    workLabel: text("work_label").references(() => labels.name),
    // The consent window: an unapproved request dies after this.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // The minted code's own (shorter) lifetime.
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  }
);

// ---------------------------------------------------------------------------
// oauth_tokens
//
// Access and refresh tokens, stored hashed. `grantId` groups every token ever
// issued for one user consent (the initial exchange plus each refresh
// rotation) so refresh-token reuse can revoke the whole grant at once.
// ---------------------------------------------------------------------------
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenType: text("token_type").notNull(), // 'access' | 'refresh'
    scope: text("scope"),
    // The label every request made with this token works at: the one the
    // person named when they approved the consent, carried through each
    // refresh. Fixed for the life of the grant.
    workLabel: workLabelColumn(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_oauth_tokens_grant").on(table.grantId),
    index("idx_oauth_tokens_user").on(table.userId),
  ]
);

// ---------------------------------------------------------------------------
// contributions
// ---------------------------------------------------------------------------
export const contributions = pgTable(
  "contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable for intake contributions (#157): a 'propose_claim' or
    // 'propose_source' suggestion has no target claim while pending — nothing
    // touches the claims table until review accepts it. On acceptance the
    // materialized (or matched) claim id is written here, so accepted intake
    // rows read like any other contribution on their claim's page.
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "cascade",
    }),
    contributorId: uuid("contributor_id")
      .notNull()
      .references(() => contributors.id),
    contributionType: text("contribution_type").notNull(),
    content: text("content").notNull(),
    evidenceUrls: text("evidence_urls").array().notNull().default([]),
    // Research a mandate funds submits what it finds as contributions
    // (Part VIII): the mandate, shown as "a funded mandate" and never by
    // name (§12/§19), and the budget job its review is metered to. A
    // mandate's contribution builds no one's reputation and earns no owls.
    grantId: uuid("grant_id").references((): AnyPgColumn => grants.id, {
      onDelete: "set null",
    }),
    fundedByJobId: uuid("funded_by_job_id"),
    // The research run that submitted it, when one did: its review is paid
    // from the contribution budget that run was delegated.
    researchRunId: uuid("research_run_id").references((): AnyPgColumn => researchRuns.id, {
      onDelete: "set null",
    }),
    // What reviewing it cost, metered across every attempt. NULL until a
    // review has run.
    reviewCostMicroUsd: bigint("review_cost_micro_usd", { mode: "number" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewStatus: text("review_status").notNull().default("pending"),
    // Why the reviewer escalated (#178). Written by record_review_decision's
    // escalate (formerly escalate_to_arbitrator) so the reason reaches the
    // Arbitrator first; the review record carries the fuller reasoning.
    escalationReason: text("escalation_reason"),
    // Why the Arbitrator sent the contribution to humans with
    // flag_for_human_review (#713): a human opening the case reads why, and
    // the action is not a quiet one (§11, §15).
    humanReviewReason: text("human_review_reason"),
    mergeTargetClaimId: uuid("merge_target_claim_id").references(
      () => claims.id
    ),
    // A contribution about one of the node's arguments (#541): the argument
    // an add_instance says a source makes, a propose_split would divide, or
    // a propose_merge would join with merge_target_argument_id (both on the
    // contribution's node). Null for a contribution about the node itself.
    argumentId: uuid("argument_id").references((): AnyPgColumn => arguments_.id, {
      onDelete: "set null",
    }),
    mergeTargetArgumentId: uuid("merge_target_argument_id").references((): AnyPgColumn => arguments_.id, {
      onDelete: "set null",
    }),
    proposedCanonicalForm: text("proposed_canonical_form"),
    // 'propose_source' intake (#157): the stored document awaiting review. A
    // source row is inert until extraction runs — it appears in no read path
    // except through claim instances — so storing the submission verbatim
    // before review is safe.
    sourceId: uuid("source_id").references(() => sources.id),
    // A `challenge` filed against a formal statement during its review
    // period (docs/mathematics.md §5.6): which statement it names. An upheld
    // challenge returns the statement to 'reviewed' and pays the review
    // award. SET NULL so the contribution outlives a retired statement.
    challengedFormalizationId: uuid("challenged_formalization_id").references(
      (): any => claimFormalizations.id,
      { onDelete: "set null" }
    ),
    // A `challenge` filed against an accepted prize claim inside its
    // challenge window (§8.5): which prize claim it names. Admission by the
    // Reviewer pauses that claim's window.
    challengedPrizeClaimId: uuid("challenged_prize_claim_id").references(
      (): any => prizeClaims.id,
      { onDelete: "set null" }
    ),
    // A contribution made through a published page on its node
    // (docs/outward-acts.md, "What the public says back"): a challenge to
    // the page, or a proposal to the node made from it. Which page it
    // names. It is reviewed as any contribution on the node is. The graph
    // that published the page learns of it from the mirror's feed. SET NULL
    // so the contribution outlives a publication.
    aboutPublishedPageId: uuid("about_published_page_id").references(
      (): any => publishedPages.id,
      { onDelete: "set null" }
    ),
    // Crash-safe processing claim, mirroring the Steward's stewarded_at
    // reclaim (#218): the pipeline handler atomically stamps this before
    // running, so duplicate messages (recovery-sweep re-enqueues, SQS
    // redelivery, multi-process races) no-op, and a claim older than the
    // reclaim window counts as abandoned. One column serves both the
    // pending->review and escalated->arbitration phases — their statuses are
    // disjoint.
    reviewClaimedAt: timestamp("review_claimed_at", { withTimezone: true }),
    // Attempts consumed in the current phase (reset on escalation). The
    // recovery sweep stops re-driving a row at the attempt cap so a poisoned
    // contribution cannot burn LLM spend forever.
    reviewAttempts: integer("review_attempts").notNull().default(0),
    // The label of the request or run that submitted this (src/labels.ts).
    // Its review runs at it, whichever worker or sweep picks it up, and so
    // does its arbitration when the reviewer escalates.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_contributions_claim").on(table.claimId),
    index("idx_contributions_contributor").on(table.contributorId),
    index("idx_contributions_status").on(table.reviewStatus),
    index("idx_contributions_research_run").on(table.researchRunId).where(sql`research_run_id IS NOT NULL`),
  ]
);

// ---------------------------------------------------------------------------
// stated_views (§4)
//
// A view an account states on a node to the graph directly: what the
// speaker submitted, in its own terms. It is filed as a contribution
// (contribution_type 'state_view') so that it passes the Contribution
// Reviewer like any outside material, and its text is stored as a source
// (contributions.source_id) when it is submitted. When the Reviewer admits
// it, the statement becomes an instance of the node, `instance_id` is set,
// and the speaker's declared stake is recorded in source_interests. From
// then on the instance is the graph's record of the view: it follows the
// node through merges and splits, and reads take the node and the stance
// from it. This row keeps what was said as it was said, and what has to be
// remembered between submission and admission.
//
// Nothing here is updated after admission, and a later statement by the
// same account on the same node is a new row with a new source: both stay,
// dated, and the newer is the one shown as current.
//
// The row holds the speaker's statement, reasons and stake as text, and the
// stake is written nowhere else until admission, so it carries a label of
// its own (src/labels.ts): the label of the request that filed it, the same
// as the source and the contribution written beside it.
// ---------------------------------------------------------------------------
export const statedViews = pgTable(
  "stated_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contributionId: uuid("contribution_id")
      .notNull()
      .references(() => contributions.id, { onDelete: "cascade" }),
    // Null until the Reviewer admits the statement.
    instanceId: uuid("instance_id").references(() => claimInstances.id, {
      onDelete: "set null",
    }),
    // How the speaker stands toward the node, in its own terms:
    // STATED_VIEW_STANCES in src/schemas/common.ts. Free text, like
    // claim_instances.stance, so a new value needs no migration.
    stance: text("stance").notNull(),
    // A probability the speaker gives for a claim, against the claim as
    // worded when it was stated.
    statedProbability: real("stated_probability"),
    // A figure the speaker gives for a quantity, in the estimate shape
    // (quantityEstimateSchema in src/schemas/kinds.ts).
    statedEstimate: jsonb("stated_estimate"),
    // The view, in the speaker's words.
    statement: text("statement").notNull(),
    // The speaker's reasons, when it gave any. Admitted reasons go to the
    // node's Steward and are heard as §14 requires.
    reasons: text("reasons"),
    // What the speaker says it stands to gain or lose by the answer. Null
    // when it declared that it has no stake.
    stake: text("stake"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("idx_stated_views_contribution").on(table.contributionId),
    index("idx_stated_views_instance").on(table.instanceId),
    check(
      "ck_stated_views_probability",
      sql`${table.statedProbability} IS NULL OR (${table.statedProbability} >= 0 AND ${table.statedProbability} <= 1)`
    ),
  ]
);

// ---------------------------------------------------------------------------
// contribution_reviews
// ---------------------------------------------------------------------------
export const contributionReviews = pgTable("contribution_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  contributionId: uuid("contribution_id")
    .notNull()
    .references(() => contributions.id, { onDelete: "cascade" }),
  decision: text("decision").notNull(),
  reasoning: text("reasoning").notNull(),
  confidence: real("confidence").notNull(),
  policyCitations: text("policy_citations").array().notNull().default([]),
  // Suspected bad faith (#71) — distinct from rejected-on-the-merits. Only
  // meaningful alongside a 'reject' decision; drives the contributor's
  // must-pay standing and a reputation penalty. Appealable like any review.
  suspectedBadFaith: boolean("suspected_bad_faith").notNull().default(false),
  // 'spam' | 'vandalism' | 'sybil' | 'misinformation' when flagged.
  badFaithCategory: text("bad_faith_category"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  reviewedBy: text("reviewed_by").notNull().default("contribution_reviewer"),
  // True once an audit re-review replaced this decision (#180): the row stays
  // as history, but exactly one non-superseded review is live per contribution
  // and get_recent_decisions shows only live ones.
  superseded: boolean("superseded").notNull().default(false),
  // The label of the run that reviewed (src/labels.ts).
  sensitivityLabel: sensitivityLabelColumn(),
});

// ---------------------------------------------------------------------------
// appeals
// ---------------------------------------------------------------------------
export const appeals = pgTable(
  "appeals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contributionId: uuid("contribution_id")
      .notNull()
      .references(() => contributions.id, { onDelete: "cascade" }),
    originalReviewId: uuid("original_review_id")
      .notNull()
      .references(() => contributionReviews.id),
    appellantId: uuid("appellant_id")
      .notNull()
      .references(() => contributors.id),
    appealReasoning: text("appeal_reasoning").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: text("status").notNull().default("pending"),
    // Crash-safe arbitration claim + attempt cap — same recovery mechanics as
    // contributions.review_claimed_at (#218).
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    arbitrationAttempts: integer("arbitration_attempts").notNull().default(0),
    // The label of the request or run that filed the appeal (src/labels.ts);
    // the arbitration it asks for runs at it.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_appeals_contribution").on(table.contributionId),
    index("idx_appeals_status").on(table.status),
  ]
);

// ---------------------------------------------------------------------------
// arbitration_results
// ---------------------------------------------------------------------------
export const arbitrationResults = pgTable("arbitration_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  contributionId: uuid("contribution_id")
    .notNull()
    .references(() => contributions.id, { onDelete: "cascade" }),
  appealId: uuid("appeal_id").references(() => appeals.id),
  outcome: text("outcome").notNull(),
  decision: text("decision").notNull(),
  reasoning: text("reasoning").notNull(),
  // Bad-faith finding by the second instance (#213), mirroring the review
  // columns: only meaningful alongside an 'uphold_original' outcome, and the
  // consequences apply only when the case arrived by escalation (an appealed
  // rejection already applied its outcome). Appealable like any finding.
  suspectedBadFaith: boolean("suspected_bad_faith").notNull().default(false),
  // 'spam' | 'vandalism' | 'sybil' | 'misinformation' when flagged.
  badFaithCategory: text("bad_faith_category"),
  consensusAchieved: boolean("consensus_achieved"),
  modelVotes: jsonb("model_votes"),
  humanReviewRecommended: boolean("human_review_recommended")
    .notNull()
    .default(false),
  arbitratedAt: timestamp("arbitrated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  arbitratedBy: text("arbitrated_by").notNull().default("dispute_arbitrator"),
  // The label of the run that ruled (src/labels.ts).
  sensitivityLabel: sensitivityLabelColumn(),
});

// ---------------------------------------------------------------------------
// reputation_events
//
// Append-only ledger of every reputation change (#71) — the audit trail that
// makes `contributors.reputation_score` load-bearing instead of a static
// default. One row per change, with the score after applying it, so a
// contributor's standing is always reconstructible and reversible (appeal
// overturns insert a compensating event rather than editing history).
// ---------------------------------------------------------------------------
export const reputationEvents = pgTable(
  "reputation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contributorId: uuid("contributor_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "cascade" }),
    // Nullable so the ledger outlives a deleted contribution/claim.
    contributionId: uuid("contribution_id").references(() => contributions.id, {
      onDelete: "set null",
    }),
    reviewId: uuid("review_id").references(() => contributionReviews.id, {
      onDelete: "set null",
    }),
    delta: real("delta").notNull(),
    scoreAfter: real("score_after").notNull(),
    // 'contribution_accepted' | 'contribution_rejected' | 'bad_faith_flag' |
    // 'appeal_overturned' | 'manual_adjustment'
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request behind the change (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_reputation_events_contributor_time").on(
      table.contributorId,
      table.createdAt
    ),
    index("idx_reputation_events_contribution").on(table.contributionId),
  ]
);

// ---------------------------------------------------------------------------
// curation_requests
//
// The inputs a `curate` ledger action reads (#363). Curation is chosen and
// funded work, not a fire-and-forget message: a Steward's escalation, the
// reconcile-candidate scan, or an operator records a structural concern
// here and opens (or reopens) the anchor claim's `curate:<claim_id>` row;
// the mandates value that row and the engine executor runs it once it is
// covered. One funded run reads every live request on its anchor, the way
// a lookout run reads its queued events, and marks them consumed. A repeat
// of a live request (same anchor, same other claim, same source) is a
// repeat, not a new request.
// ---------------------------------------------------------------------------
export const curationRequests = pgTable(
  "curation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    anchorClaimId: uuid("anchor_claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // The suspected duplicate / counterpart, when the requester knows it.
    otherClaimId: uuid("other_claim_id").references(() => claims.id, {
      onDelete: "cascade",
    }),
    // steward_escalation | consistency_sweep | audit | matcher | reconcile_candidate | operator
    source: text("source").notNull(),
    concern: text("concern").notNull(),
    // reconcile_candidate: the scan's similarity score (0–1). Null otherwise.
    signal: real("signal"),
    // The claim whose Steward escalated (bounds live escalations per claim).
    requestedByClaimId: uuid("requested_by_claim_id").references(
      () => claims.id,
      { onDelete: "set null" }
    ),
    // The escalating agent_runs row, when tracing recorded one.
    requestedByRunId: uuid("requested_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedByActionId: uuid("consumed_by_action_id").references(
      () => actions.id,
      { onDelete: "set null" }
    ),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // The label of the run or request that asked (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_curation_requests_live")
      .on(
        table.anchorClaimId,
        sql`COALESCE(${table.otherClaimId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.source
      )
      .where(sql`consumed_at IS NULL`),
    index("idx_curation_requests_anchor_live")
      .on(table.anchorClaimId)
      .where(sql`consumed_at IS NULL`),
    index("idx_curation_requests_requester_live")
      .on(table.requestedByClaimId)
      .where(sql`consumed_at IS NULL`),
    check(
      "ck_curation_requests_source",
      sql`source IN ('steward_escalation', 'consistency_sweep', 'audit', 'matcher', 'reconcile_candidate', 'operator')`
    ),
  ]
);

export type CurationRequest = typeof curationRequests.$inferSelect;

// ---------------------------------------------------------------------------
// reconciliation_events
//
// An append-only audit log of the Curator's re-individuation surgery (§18):
// every merge and split primitive records what it changed, in enough detail to
// be reversed. `reversed` flags an event that has been undone.
// ---------------------------------------------------------------------------
export const reconciliationEvents = pgTable("reconciliation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 'merge' | 'change_kind' | 'create_claim' | 'add_edge' | 'remove_edge' |
  // 'reassign_instance' | 'link_claims' | 'unlink_claims' | 'set_definition' |
  // 'reclassify' | 'reverse' (a reversal, naming the event it undid)
  operation: text("operation").notNull(),
  reasoning: text("reasoning").notNull().default(""),
  // Operation-specific snapshot sufficient to reverse the change (moved ids,
  // pre-flip stances, deleted edge rows, previous state, …).
  payload: jsonb("payload").notNull().default({}),
  reversed: boolean("reversed").notNull().default(false),
  createdBy: text("created_by").notNull().default("curator"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Who may read this row (src/labels.ts), stamped from the usage context
  // when it is written.
  sensitivityLabel: sensitivityLabelColumn(),
});

// ---------------------------------------------------------------------------
// audit_log
//
// The durable stewardship audit trail (#100). The constitution and the
// Steward's prompt promise one ("Log All Changes", "maintain an accurate audit
// trail", §8/§11), and log_stewardship_decision is where the Steward records
// its reasoning — so those records must outlive the tool result. Append-only:
// one row per logged decision. Distinct from reconciliation_events (the
// Curator's reversible-surgery snapshots) — this is reasoning, not undo state.
// ---------------------------------------------------------------------------
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // Free-form action label, e.g. 'reassessed', 'updated_canonical_form',
    // 'no_action_needed' — the tool schema deliberately leaves this open.
    action: text("action").notNull(),
    reasoning: text("reasoning").notNull().default(""),
    // Which agent logged it. Only the Steward writes today; the column keeps
    // the trail reusable without a schema change.
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request that made the entry (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_audit_log_claim_time").on(table.claimId, table.createdAt)]
);

// ---------------------------------------------------------------------------
// audit_runs
//
// One row per Audit Agent invocation (#180) — created when the audit is
// requested, before it runs. Serves three jobs at once: it is the dedupe
// gate (dedupe_key makes "one sweep per day" and "one audit per bad-faith
// flag" a DB constraint, safe across concurrent ECS tasks), the run's
// identity that findings attach to, and the heartbeat that makes a dormant
// audit subsystem observable — this table being empty IS the #180 bug report.
// ---------------------------------------------------------------------------
export const auditRuns = pgTable(
  "audit_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'decision_audit' | 'pattern_analysis' | 'contributor_review' |
    // 'anomaly_investigation' — the AuditMessage interface.
    auditType: text("audit_type").notNull(),
    context: text("context").notNull().default(""),
    // What caused the run: 'arbitration_overturn' | 'bad_faith_flag' |
    // 'scheduled_sweep' | 'suspension_review' | 'manual'.
    triggeredBy: text("triggered_by").notNull().default("manual"),
    // Idempotency key for triggers that must fire at most once per subject
    // (e.g. 'sweep:2026-07-18', 'bad-faith:<contribution_id>'). Null for
    // triggers that may repeat.
    dedupeKey: text("dedupe_key"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set when the worker finishes the run; a stale null marks a run that
    // was enqueued but never completed.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    findingsCount: integer("findings_count").notNull().default(0),
    // The `audit` ledger action that runs this audit (#363): an audit is
    // funded like any other work, and this row stays its record.
    actionId: uuid("action_id").references(() => actions.id, {
      onDelete: "set null",
    }),
    // The mandate this audit examines, when it examines one (a posted
    // bounty names its posting mandate). Recusal (#363): no mandate values
    // or funds an audit of itself, enforced by a trigger on
    // action_allocations as well as by the valuers.
    subjectGrantId: uuid("subject_grant_id").references(() => grants.id, {
      onDelete: "set null",
    }),
    // A prize audit (docs/mathematics.md §8.6): funded from this bounty's
    // prize-review reserve rather than valued by a mandate.
    bountyId: uuid("bounty_id").references(() => bounties.id, {
      onDelete: "set null",
    }),
    // The label the audit was asked for at (src/labels.ts): the run or
    // request that asked, or, for one a timer opens, the thing audited.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_audit_runs_action").on(table.actionId),
    uniqueIndex("uq_audit_runs_dedupe_key")
      .on(table.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
    index("idx_audit_runs_requested").on(table.requestedAt),
  ]
);

// ---------------------------------------------------------------------------
// audit_findings
//
// Durable audit findings (#180): what flag_issue writes. A finding is the
// decision record every audit consequence must trace to — the audit tools
// that change contributor standing require a finding_id, mirroring the
// every-change-traces-to-its-decision invariant of reputation_events. The
// typed FK columns (claim/contribution/review/contributor) let findings feed
// re-review and appeals; status gives later runs memory, so a sweep doesn't
// rediscover and re-punish the same pattern.
// ---------------------------------------------------------------------------
export const auditFindings = pgTable(
  "audit_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable so the tool still records when invoked outside a tracked run.
    runId: uuid("run_id").references(() => auditRuns.id, {
      onDelete: "set null",
    }),
    // 'low' | 'medium' | 'high' | 'critical'
    severity: text("severity").notNull(),
    // 'decision_quality' | 'consistency' | 'process_compliance' |
    // 'bias_detected' | 'manipulation_suspected'
    category: text("category").notNull(),
    description: text("description").notNull(),
    evidence: text("evidence").notNull(),
    recommendation: text("recommendation").notNull(),
    // 'open' | 'resolved' | 'dismissed'
    status: text("status").notNull().default("open"),
    resolutionNote: text("resolution_note"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Typed targets, all nullable — a finding names what it is about.
    claimId: uuid("claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    contributionId: uuid("contribution_id").references(() => contributions.id, {
      onDelete: "set null",
    }),
    reviewId: uuid("review_id").references(() => contributionReviews.id, {
      onDelete: "set null",
    }),
    contributorId: uuid("contributor_id").references(() => contributors.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the audit run that recorded it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_audit_findings_status").on(table.status, table.createdAt),
    index("idx_audit_findings_contributor").on(table.contributorId),
    index("idx_audit_findings_contribution").on(table.contributionId),
  ]
);

// ---------------------------------------------------------------------------
// claim_formalizations
//
// A claim's formal statement (docs/mathematics.md §5.1): its own table, not
// columns on `claims`, because a statement has a lifecycle with more than
// one live row (a draft beside the published one), prizes and attempts pin
// it by id and by hash, the claims row is hot, and provenance needs columns
// of its own. Statuses: draft | reviewed | published | retired. At most one
// PUBLISHED statement per claim (uq_formalization_published); versions are
// unique per claim and chain through superseded_by.
//
// Two hashes on purpose: source_hash is what a reader or an outside solver
// recomputes from the published text and the pin; expr_hash is what the
// checker compares. The prize terms cite both.
// ---------------------------------------------------------------------------
export const claimFormalizations = pgTable(
  "claim_formalizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // RESTRICT: a statement that prizes and attempts pin must not vanish
    // under a claim delete; the claim is merged or archived, never dropped.
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    language: text("language").notNull().default("lean4"),
    // The pin: e.g. 'mathlib-v4.33.1', 'leanprover/lean4:v4.33.1', the full
    // Mathlib commit SHA, its tag when one exists, and the checker image
    // digest the statement was elaborated in (§5.5).
    pinId: text("pin_id").notNull(),
    leanToolchain: text("lean_toolchain").notNull(),
    mathlibRev: text("mathlib_rev").notNull(),
    mathlibTag: text("mathlib_tag"),
    imageDigest: text("image_digest").notNull(),
    // 'Minerval.S<8 hex of claim id>_v<version>' (§5.4).
    namespace: text("namespace").notNull(),
    // The statement file, verbatim.
    statementSource: text("statement_source").notNull(),
    // sha256 over normalized source + pin, for the public record.
    sourceHash: text("source_hash").notNull(),
    // Structural hash of the elaborated body, for the checker.
    exprHash: text("expr_hash").notNull(),
    // Pretty-printed proposition.
    ppType: text("pp_type").notNull(),
    // Mathlib constants the statement references.
    constants: jsonb("constants").notNull(),
    // Axioms used by any definitions the statement introduces.
    definitionsAxioms: jsonb("definitions_axioms").notNull(),
    // An `example` witnessing satisfiable hypotheses elaborated.
    witnessPresent: boolean("witness_present").notNull(),
    // The statement introduces a definition Mathlib lacks, written by the
    // Steward (or taken from a public formalization project) and declared
    // as its own in the correspondence note (docs/mathematics.md §5.4).
    ownDefinitions: boolean("own_definitions").notNull().default(false),
    // Reader-facing note, graph voice.
    correspondence: text("correspondence"),
    // Audit-facing; may name tools and checks.
    reviewNotes: text("review_notes"),
    status: text("status").notNull().default("draft"),
    // 'claim_steward' | 'contributor:<uuid>'
    authoredBy: text("authored_by").notNull(),
    model: text("model"),
    createdByRunId: uuid("created_by_run_id"),
    reviewedByRunId: uuid("reviewed_by_run_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // published_at + FORMALIZATION_REVIEW_PERIOD_DAYS: no bounty binds
    // before this (§5.6).
    reviewPeriodEndsAt: timestamp("review_period_ends_at", {
      withTimezone: true,
    }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retireReason: text("retire_reason"),
    supersededBy: uuid("superseded_by").references(
      (): any => claimFormalizations.id
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    unique("uq_claim_formalizations_claim_version").on(
      table.claimId,
      table.version
    ),
    uniqueIndex("uq_formalization_published")
      .on(table.claimId)
      .where(sql`status = 'published'`),
    index("idx_claim_formalizations_claim").on(table.claimId),
  ]
);

// ---------------------------------------------------------------------------
// lean_checks
//
// The server-side truth for every check the platform ever runs (§5.1) —
// the Steward's scratch re-run, the solver's iteration, a prize verdict.
// mode: prize | attempt | steward; kind: proof | disproof; verdict:
// accepted | rejected | error (an error is never evidence, §5.2). The
// unique constraint makes a re-run of the same submission under the same
// checker version and mode a no-op, which is the dedup the tools rely on.
// prize_claim_id and attempt_id are plain uuids: prize_claims points back
// at this table by lean_check_id, and a check must be insertable before the
// row that will cite it.
// ---------------------------------------------------------------------------
export const leanChecks = pgTable(
  "lean_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formalizationId: uuid("formalization_id")
      .notNull()
      .references(() => claimFormalizations.id),
    mode: text("mode").notNull(),
    kind: text("kind").notNull(),
    submissionSha256: text("submission_sha256").notNull(),
    // Verbatim, checker header excluded.
    submissionSource: text("submission_source").notNull(),
    // contributor:<uuid> | math_solver | claim_steward
    submittedBy: text("submitted_by").notNull(),
    prizeClaimId: uuid("prize_claim_id"),
    attemptId: uuid("attempt_id"),
    runId: uuid("run_id"),
    verdict: text("verdict").notNull(),
    // The per-gate record (§5.2).
    checks: jsonb("checks").notNull(),
    diagnostics: jsonb("diagnostics").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    // wall_ms, cpu_ms, max_rss_mb, exit_code, killed
    resource: jsonb("resource").notNull(),
    pinId: text("pin_id").notNull(),
    imageDigest: text("image_digest").notNull(),
    checkerVersion: text("checker_version").notNull(),
    // An outside checker's result when requested; never decisive.
    secondOpinion: jsonb("second_opinion"),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    unique("uq_lean_checks_submission").on(
      table.formalizationId,
      table.submissionSha256,
      table.checkerVersion,
      table.mode
    ),
    index("idx_lean_checks_formalization").on(table.formalizationId),
    index("idx_lean_checks_submission_sha256").on(table.submissionSha256),
  ]
);

// ---------------------------------------------------------------------------
// proof_attempts
//
// One row per solver attempt on a published statement (§7.9): the ledger
// action it ran under, its budget ceiling and spend, the notebook, the
// report, and the check that verified its result if any. status: running |
// completed | failed | cancelling | cancelled | refused | budget | orphaned |
// stale_formalization; outcome: proof | disproof | partial | reduction |
// negative | none. heartbeat_at is stamped every turn so the reopen sweep
// can tell a dead worker from a long one.
// ---------------------------------------------------------------------------
export const proofAttempts = pgTable(
  "proof_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id").notNull(),
    formalizationId: uuid("formalization_id")
      .notNull()
      .references(() => claimFormalizations.id),
    actionId: uuid("action_id").references(() => actions.id),
    runId: uuid("run_id"),
    grantId: uuid("grant_id"),
    jobId: uuid("job_id"),
    model: text("model").notNull(),
    // standard | max (§7.2)
    variant: text("variant").notNull(),
    effort: text("effort").notNull(),
    status: text("status").notNull().default("running"),
    outcome: text("outcome"),
    report: jsonb("report"),
    leanProof: text("lean_proof"),
    leanCheckId: uuid("lean_check_id").references(() => leanChecks.id),
    notebook: jsonb("notebook").notNull().default({}),
    // A calibration run on a settled problem (§7.5): exempt from the review
    // period, never a result the claim's status depends on.
    isCalibration: boolean("is_calibration").notNull().default(false),
    // cost_est × (1 + ATTEMPT_OVERAGE_FRACTION): the beforeTurn hook stops
    // the loop here (§7.3).
    ceilingMicroUsd: bigint("ceiling_micro_usd", { mode: "number" }).notNull(),
    spentMicroUsd: bigint("spent_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    turns: integer("turns").notNull().default(0),
    compactions: integer("compactions").notNull().default(0),
    servedModels: jsonb("served_models"),
    // When the report and notebook became public.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_proof_attempts_claim").on(table.claimId),
    index("idx_proof_attempts_status").on(table.status),
    index("idx_proof_attempts_formalization").on(table.formalizationId),
    check("ck_proof_attempts_ceiling", sql`ceiling_micro_usd > 0`),
    check("ck_proof_attempts_spent", sql`spent_micro_usd >= 0`),
  ]
);

// ---------------------------------------------------------------------------
// platform_flags
//
// Operator switches read at runtime without a deploy (§7.3): a
// `solver_paused` row polled by the solver's beforeTurn hook halts a run
// mid-attempt. Key/value so a later switch is a row, not a migration.
// ---------------------------------------------------------------------------
export const platformFlags = pgTable("platform_flags", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// research_runs (#298)
//
// One bounded investigation by the researcher: an instrument an administrator
// (the Claim Steward, or a Grantmaker for its mandate) launches with a task,
// a model tier, and a dollar ceiling, and that answers only to the agent that
// launched it. The row is the durable record of the delegation: what was
// asked, on which model, what it cost, how it ended, the report it returned,
// and the notebook it kept. The researcher writes nothing to the graph
// beyond the provenance tables the Provenance skill gives it; its report is
// context the launching administrator weighs, never a verdict of its own.
// Same shape as proof_attempts, whose solver is the special case of this
// instrument that runs with Lean, no network, and no constitution.
// ---------------------------------------------------------------------------
export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The claim the investigation serves, when it serves one. Cascade: a
    // deleted claim takes its research record with it, as it takes its
    // instances and assessments.
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "cascade" }),
    // The mandate whose Grantmaker launched it, when one did.
    grantId: uuid("grant_id"),
    // The request the run takes up, when a mandate funded one (Part VIII):
    // the request's text is the brief, and the outcome is recorded as work
    // on the request for its keeper to judge.
    requestId: uuid("request_id").references((): AnyPgColumn => requests.id, {
      onDelete: "set null",
    }),
    // The agent key of the launcher (claim_steward, grantmaker) and its
    // agent_runs row, so a report is traceable to the run that asked for it.
    requestedBy: text("requested_by").notNull(),
    requesterRunId: uuid("requester_run_id"),
    // The researcher's own agent_runs row, and the job the spend rides on.
    runId: uuid("run_id"),
    jobId: uuid("job_id"),
    // The launcher's brief, verbatim: the question, the context, and the
    // guidance it wrote for the instrument.
    task: text("task").notNull(),
    model: text("model").notNull(),
    // strong | standard | cheap: the tier the launcher chose.
    modelTier: text("model_tier").notNull(),
    effort: text("effort"),
    // Whether the constitution was prepended to the instrument's prompt.
    includeConstitution: boolean("include_constitution").notNull().default(true),
    // running | completed | no_report | budget | paused | timeout | refused | failed
    status: text("status").notNull().default("running"),
    // The tools the run was offered, by name, so a reader of the report knows
    // what the instrument could and could not do.
    tools: jsonb("tools").notNull().default([]),
    ceilingMicroUsd: bigint("ceiling_micro_usd", { mode: "number" }).notNull(),
    // For research a mandate funds: the budget its Grantmaker delegated for
    // reviewing the contributions it submits (Part VIII). 0 = it submits none.
    contributionBudgetMicroUsd: bigint("contribution_budget_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    spentMicroUsd: bigint("spent_micro_usd", { mode: "number" }).notNull().default(0),
    turns: integer("turns").notNull().default(0),
    servedModels: jsonb("served_models"),
    report: jsonb("report"),
    notebook: jsonb("notebook").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    // A commissioned run (commission kind research): the agent session its
    // report returns to (agent_sessions), or, with none waiting, the node
    // whose inbox gets it. Null on a run launched inline (delegate_research)
    // or for a request.
    replyToSession: uuid("reply_to_session"),
    deliverToNode: uuid("deliver_to_node").references((): AnyPgColumn => claims.id, {
      onDelete: "set null",
    }),
    // The examination of a document this run carried out, when it was
    // launched as one (#507). One direction only: an examination's runs
    // are found from here, its spend is theirs, and a continuation run can
    // serve the same examination.
    examinationId: uuid("examination_id").references((): AnyPgColumn => examinations.id, {
      onDelete: "set null",
    }),
    // The label of the run that launched the investigation (src/labels.ts).
    // The report and the notebook are the researcher's, whose run works at
    // the same label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_research_runs_claim").on(table.claimId),
    index("idx_research_runs_examination").on(table.examinationId),
    index("idx_research_runs_grant").on(table.grantId),
    index("idx_research_runs_request").on(table.requestId),
    index("idx_research_runs_status").on(table.status),
    check("ck_research_runs_ceiling", sql`ceiling_micro_usd > 0`),
    check("ck_research_runs_contribution_budget", sql`contribution_budget_micro_usd >= 0`),
    check("ck_research_runs_spent", sql`spent_micro_usd >= 0`),
  ]
);

// ---------------------------------------------------------------------------
// bounties
//
// A public offer bound to one formalization (§8.1): denominated in owls
// (stored as micro-USD at cost, one owl per dollar of metered work), posted
// by a mandate's Grantmaker in two passes and, at or above the autonomy
// threshold, confirmed by a person, and held against that mandate's escrow
// from the moment it opens until it resolves: its amount is a term in the
// mandate's committed money (src/services/prize-commitment.ts), and the
// payout row is what consumes it. Lifecycle: requested → confirm_pending →
// open → claim_pending → paid | resolved_unpaid | open; open →
// house_result_pending → resolved_internally | open | rebinding; open →
// expired | withdrawn | rebinding. At most one LIVE bounty per claim
// (uq_bounty_live_per_claim). No prize fund exists: the escrow the bounty
// holds against is the only source of the prize.
// ---------------------------------------------------------------------------
export const bounties = pgTable(
  "bounties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    formalizationId: uuid("formalization_id")
      .notNull()
      .references(() => claimFormalizations.id, { onDelete: "restrict" }),
    // lean_statement; reserved: steward_judgment | external_resolution
    conditionType: text("condition_type").notNull().default("lean_statement"),
    // proof | disproof | either
    resolution: text("resolution").notNull().default("either"),
    // Owls at cost (micro-USD).
    amountMicroUsd: bigint("amount_micro_usd", { mode: "number" }).notNull(),
    // requested | confirm_pending | open | claim_pending |
    // house_result_pending | rebinding | paid | resolved_internally |
    // resolved_unpaid | expired | withdrawn
    status: text("status").notNull().default("requested"),
    // The official-rules version in force when posted (§8.10).
    rulesVersion: text("rules_version").notNull(),
    // The mandate whose escrow the bounty holds against (§8.1).
    postedByGrantId: uuid("posted_by_grant_id")
      .notNull()
      .references(() => grants.id),
    rationale: text("rationale").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    // Suspended while any prize claim on the bounty is non-terminal.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    humanConfirmedAt: timestamp("human_confirmed_at", { withTimezone: true }),
    humanConfirmedBy: text("human_confirmed_by"),
    // Withdrawal is prospective only, with notice (BOUNTY_NOTICE_DAYS).
    withdrawEffectiveAt: timestamp("withdraw_effective_at", {
      withTimezone: true,
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request that posted it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_bounties_claim").on(table.claimId),
    index("idx_bounties_status").on(table.status),
    index("idx_bounties_formalization").on(table.formalizationId),
    check("ck_bounties_amount", sql`amount_micro_usd > 0`),
    uniqueIndex("uq_bounty_live_per_claim")
      .on(table.claimId)
      .where(
        sql`status IN ('requested', 'confirm_pending', 'open', 'claim_pending', 'house_result_pending', 'rebinding')`
      ),
  ]
);

// ---------------------------------------------------------------------------
// prize_claims
//
// The money and verification state of one `claim_prize` contribution
// (§8.4), one row per contribution: the contribution carries the written
// account, the review pipeline, appeals, and audit; this row carries the
// state machine. Statuses: queued | checking | check_error | checked |
// in_review | in_challenge_window | payable | defect_award_pending | paid |
// rejected (rejected_stage: check | review | steward) | voided | withdrawn |
// superseded | forfeited. Priority is the contribution's submitted_at;
// tie_group binds claims with equal submitted_at that split a prize. One
// LIVE claim per claimant per statement version
// (uq_prize_claim_live_per_claimant) is the gate's DUPLICATE_LIVE_CLAIM
// refusal, enforced.
// ---------------------------------------------------------------------------
export const prizeClaims = pgTable(
  "prize_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contributionId: uuid("contribution_id")
      .notNull()
      .unique()
      .references(() => contributions.id),
    bountyId: uuid("bounty_id")
      .notNull()
      .references(() => bounties.id),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    formalizationId: uuid("formalization_id")
      .notNull()
      .references(() => claimFormalizations.id),
    claimantId: uuid("claimant_id")
      .notNull()
      .references(() => contributors.id),
    // proof | disproof
    direction: text("direction").notNull(),
    status: text("status").notNull().default("queued"),
    rejectedStage: text("rejected_stage"),
    leanCheckId: uuid("lean_check_id").references(() => leanChecks.id),
    // Checker attempts consumed; `error` requeues up to
    // PRIZE_CHECK_MAX_ATTEMPTS, then check_error holds the statement's queue.
    checkAttempts: integer("check_attempts").notNull().default(0),
    tieGroup: uuid("tie_group"),
    // {decision, reason, result_category, statement_defect, run_id, at}
    stewardDecision: jsonb("steward_decision"),
    // new_result | formalization_of_known_proof | reference_to_prior_work |
    // statement_defect
    resultCategory: text("result_category"),
    defectAwardMicroUsd: bigint("defect_award_micro_usd", { mode: "number" }),
    // Set at acceptance: payment waits until this passes (§8.5). The window
    // pauses only while an admitted challenge is open; the pause total is
    // capped at twice the window.
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }),
    windowPausedMs: bigint("window_paused_ms", { mode: "number" })
      .notNull()
      .default(0),
    auditOutcome: text("audit_outcome"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    signedOffBy: text("signed_off_by"),
    // The winner's steps (§8.7): identity, residency, tax form kind,
    // screening result, recorded by, at.
    payee: jsonb("payee"),
    creditName: text("credit_name"),
    toolsDisclosure: text("tools_disclosure"),
    declarations: jsonb("declarations"),
    rulesVersion: text("rules_version").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the request that submitted it (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_prize_claims_bounty_status").on(table.bountyId, table.status),
    index("idx_prize_claims_claimant").on(table.claimantId),
    index("idx_prize_claims_formalization_status").on(
      table.formalizationId,
      table.status
    ),
    uniqueIndex("uq_prize_claim_live_per_claimant")
      .on(table.claimantId, table.formalizationId)
      .where(
        sql`status IN ('queued', 'checking', 'check_error', 'checked', 'in_review', 'in_challenge_window', 'payable', 'defect_award_pending')`
      ),
    check(
      "ck_prize_claims_defect_award",
      sql`defect_award_micro_usd IS NULL OR defect_award_micro_usd >= 0`
    ),
    check("ck_prize_claims_window_paused", sql`window_paused_ms >= 0`),
  ]
);

// ---------------------------------------------------------------------------
// prize_payouts
//
// The discharge of a prize (§8.7, §8.8). v1 pays in owls (kind 'owls',
// provider 'internal'); the row is written before the owl_ledger
// prize_award row, carrying withholding, the tax form kind (w9 | w8ben),
// and the sanctions screening result, so the grant is refused until all
// three are recorded. `cash` is reserved for a rail; the idempotency key
// (prize:<prize_claim_id>:owls | :cash) is what a provider would receive.
// status: pending | sent | paid | failed | reversed.
// ---------------------------------------------------------------------------
export const prizePayouts = pgTable(
  "prize_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prizeClaimId: uuid("prize_claim_id")
      .notNull()
      .references(() => prizeClaims.id),
    // owls | cash
    kind: text("kind").notNull(),
    amountMicroUsd: bigint("amount_micro_usd", { mode: "number" }).notNull(),
    withholdingMicroUsd: bigint("withholding_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    currency: text("currency").notNull().default("usd"),
    payeeCountry: text("payee_country"),
    taxFormKind: text("tax_form_kind"),
    screeningResult: text("screening_result"),
    provider: text("provider").notNull().default("internal"),
    providerPayeeId: text("provider_payee_id"),
    providerPayoutId: text("provider_payout_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_prize_payouts_claim").on(table.prizeClaimId),
    check("ck_prize_payouts_amount", sql`amount_micro_usd > 0`),
    check(
      "ck_prize_payouts_withholding",
      sql`withholding_micro_usd >= 0 AND withholding_micro_usd <= amount_micro_usd`
    ),
  ]
);

// ---------------------------------------------------------------------------
// attachments
//
// Uploaded files on contributions (§8.4): the Lean source, documents and
// data, and a winner's tax form. Bodies live in Postgres for v1 with a
// `storage` discriminator (db | s3) so an object-store path is a code
// change, not a migration. kind: lean_source | document | dataset | code |
// tax_form; visibility: restricted | public (a Lean source becomes public
// when the Steward accepts the claim; a rejected source stays restricted
// until the bounty closes). Content type is decided by magic bytes against
// an allowlist, never from the client's header.
// ---------------------------------------------------------------------------
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contributionId: uuid("contribution_id")
      .notNull()
      .references(() => contributions.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => contributors.id),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storage: text("storage").notNull().default("db"),
    body: bytea("body"),
    storageKey: text("storage_key"),
    visibility: text("visibility").notNull().default("restricted"),
    // pending | clean | flagged | skipped
    scanStatus: text("scan_status").notNull().default("pending"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the request or run that stored it (src/labels.ts). Who
    // may fetch the bytes is `visibility`, which this does not replace.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_attachments_contribution").on(table.contributionId),
    // Duplicate detection: the same file from another account.
    index("idx_attachments_sha256").on(table.sha256),
    check("ck_attachments_size", sql`size_bytes >= 0`),
    // The body lives where `storage` says it does.
    check(
      "ck_attachments_body_location",
      sql`(storage = 'db' AND body IS NOT NULL) OR (storage = 's3' AND storage_key IS NOT NULL)`
    ),
  ]
);

// agent_reports
//
// The agents' own bug tracker (#366): what raise_issue writes. Every agent
// (and every external agent on the MCP surface) can report, in its own
// words, a system failure, a gap in its tools, or a concrete improvement
// idea. Deliberately NOT audit_log, which is claim-scoped and belongs to the
// claim's history: a report is about the machinery, not the graph, so it
// carries attribution as plain columns (no FKs into agent_runs, which is
// empty when tracing is off, and none into claims, whose history this is
// not part of). Operational telemetry: separately retained, safe to prune by
// last_seen_at.
//
// The same failure recurs across thousands of runs, so the row is an
// upsert: dedupe_key collapses repeats into one row with an occurrence
// count and a last-seen stamp — frequency × severity is the triage signal.
// Reports quote whatever the agent was working on (source text, contribution
// bodies), so body is capped at write time and context_refs holds ids, not
// content.
// ---------------------------------------------------------------------------
export const agentReports = pgTable(
  "agent_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'system_failure' | 'tool_gap' | 'improvement' — reportKindEnum in
    // src/schemas/common.ts.
    kind: text("kind").notNull(),
    // 'blocking' | 'degraded' | 'annoyance' | 'idea' — reportSeverityEnum.
    severity: text("severity").notNull(),
    // One line, written as a claim about what is wrong or what should exist.
    title: text("title").notNull(),
    // What the agent was trying to do, what happened, what it expected, and
    // for improvements the concrete proposal.
    body: text("body").notNull().default(""),
    // The tool / prompt / pipeline the report is about, when there is one.
    surface: text("surface"),
    // 'internal' (our own agents) | 'external' (MCP callers). External
    // reports triage in their own queue: a report is cheap to file and "the
    // reviewer's tool is broken" is a convenient thing for a rejected
    // contributor's agent to claim.
    origin: text("origin").notNull().default("internal"),
    // The reporting agent (steward | curator | matcher | ... | mcp).
    agent: text("agent").notNull(),
    // The model that wrote the report, when known.
    model: text("model"),
    // External reports are attributed to the contributor whose key filed
    // them; null for internal agents.
    reporterContributorId: uuid("reporter_contributor_id").references(
      () => contributors.id,
      { onDelete: "set null" }
    ),
    // Optional pointers (claim id, contribution id, source url, job id) as
    // ids only — never quoted content.
    contextRefs: jsonb("context_refs").notNull().default({}),
    // Attribution snapshotted from the usage context at write time. Plain
    // columns, no FKs: run identity only exists when tracing is on.
    runId: uuid("run_id"),
    jobId: uuid("job_id"),
    claimId: uuid("claim_id"),
    // 'new' | 'triaged' | 'duplicate' | 'actioned' | 'wontfix' |
    // 'withdrawn' — reportStatusEnum. A sighting on an actioned report is a
    // regression and moves it back to new; withdrawn is the reporter's own
    // reversal through update_issue.
    status: text("status").notNull().default("new"),
    // In a deployment that keeps its agents' reports inside
    // (docs/outward-acts.md, "An agent's report, sent to Minerval's
    // maintainers"): what Audit's triage found the report to be about.
    // 'minerval' is the machinery every deployment runs, and only such a
    // report is offered for sending; 'deployment' is this deployment's own
    // setup, data or connections. NULL until triage says.
    about: text("about"),
    triageNote: text("triage_note"),
    // Who moved the status last: an audit run id, a service caller, a name.
    triagedBy: text("triaged_by"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    // For status 'duplicate': the report this one collapses into. Not a
    // self-FK so a triager can point at a row that later gets pruned.
    duplicateOfId: uuid("duplicate_of_id"),
    // Collapses the same report across runs: hash of origin, agent, kind,
    // surface, and the normalized title. Computed server-side, never by
    // the reporter.
    dedupeKey: text("dedupe_key").notNull(),
    // Match-before-write (the findings mechanism, applied here): the
    // report's title + body embedded, so a new report is searched against
    // the reports on record before it is written and the agent is shown a
    // near match instead of minting a paraphrase. Null when embedding was
    // unavailable at write time; the exact-title dedupe key still holds.
    embedding: vector("embedding"),
    // The GitHub issue this report was filed as, on first sighting, when the
    // sync is configured (GITHUB_TOKEN + GITHUB_ISSUES_REPO). Null until the
    // filing succeeds; a report that never made it to GitHub is still a
    // report, so the write never waits on this.
    githubIssueNumber: integer("github_issue_number"),
    githubIssueUrl: text("github_issue_url"),
    githubSyncedAt: timestamp("github_synced_at", { withTimezone: true }),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request that first filed the report
    // (src/labels.ts). A repeat lands on this row and leaves it alone.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_agent_reports_dedupe_key").on(table.dedupeKey),
    index("idx_agent_reports_status_seen").on(table.status, table.lastSeenAt),
    index("idx_agent_reports_agent_seen").on(table.agent, table.lastSeenAt),
    index("idx_agent_reports_origin_status").on(table.origin, table.status),
    // The GitHub sync worker's backlog scan: open reports with no issue yet.
    index("idx_agent_reports_github_pending").on(
      table.githubIssueNumber,
      table.status,
      table.firstSeenAt
    ),
  ]
);

// ---------------------------------------------------------------------------
// agent_report_sightings
//
// Every time a report is seen again — an exact repeat collapsing onto the
// dedupe key, a `joins` answer to the match-before-write search, or a note
// the reporter adds through update_issue — this records who saw it, in what
// run, and what they said. The parent row keeps the count; this keeps the
// accounts, so a maintainer reading the issue sees the new case and not a
// counter, and the Audit Agent can tell a report that recurs across roles
// from one agent repeating itself. Mirrors agent_finding_sightings.
// ---------------------------------------------------------------------------
export const agentReportSightings = pgTable(
  "agent_report_sightings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => agentReports.id, { onDelete: "cascade" }),
    // 'sighting' (the problem occurred again; bumps occurrence_count) |
    // 'note' (an amendment from update_issue; does not).
    kind: text("kind").notNull().default("sighting"),
    // The reporter's account of this occurrence, capped like a report body.
    // Empty for an exact repeat that carried no body.
    body: text("body").notNull().default(""),
    contextRefs: jsonb("context_refs").notNull().default({}),
    agent: text("agent").notNull(),
    model: text("model"),
    runId: uuid("run_id"),
    jobId: uuid("job_id"),
    claimId: uuid("claim_id"),
    seenAt: timestamp("seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run or request that saw it again (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_agent_report_sightings_report").on(table.reportId, table.seenAt),
  ]
);

// ---------------------------------------------------------------------------
// agent_findings
//
// The notable-finding channel (#394): what note_finding writes. A finding is
// something an administrator found in the course of its work that people who
// hold the question would be better for knowing (what most of them believe
// is wrong, or missing, or true for reasons the record now supplies), in
// the graph's voice, published as written on the findings page. It is the
// sibling of agent_reports (the same fire-and-forget channel shape, the same
// no-FK attribution snapshot so a row outlives the trace-retention sweep),
// but a finding is about the world, not the machinery, so it is public, it
// carries typed refs into the graph (checked on write), and it is searchable
// by meaning: the embedding is what lets search_findings show an agent the
// finding already on record, so it can join it rather than mint a paraphrase.
//
// A repeat sighting (an agent passing `joins`) is a row in
// agent_finding_sightings and a bumped sighting_count here; the finding keeps
// its first wording, and the sighting keeps its account.
// ---------------------------------------------------------------------------
export const agentFindings = pgTable(
  "agent_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One sentence in the graph's voice, stating the result as a claim about
    // the world.
    headline: text("headline").notNull(),
    // One to three paragraphs in the graph's voice: what is generally
    // believed, what the record shows, what decides it. Published as written.
    account: text("account").notNull(),
    // The claim the finding is chiefly about. RESTRICT: a published note
    // must not lose its subject; claims change state rather than vanish.
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    // The records the finding rests on, as [{kind, id}] with kind in
    // FINDING_REF_KINDS (finding-service.ts). Every id was checked to exist
    // when written; unresolved refs were dropped and named to the agent.
    refs: jsonb("refs").notNull().default([]),
    // 1..10, the importance of the finding (not of the claim): the ladder is
    // in the note_finding tool description.
    importance: integer("importance").notNull(),
    // Embedding of headline + account, for search_findings.
    embedding: vector("embedding"),
    // Attribution snapshotted from the usage context: plain columns, no FKs,
    // as agent_reports does, so the row survives trace retention.
    agent: text("agent").notNull(),
    model: text("model"),
    runId: uuid("run_id"),
    jobId: uuid("job_id"),
    // The domain skills the noting run carried (assessments.skills likewise).
    skills: text("skills").array(),
    // 'published' | 'withdrawn' — findingStatusEnum in src/schemas/common.ts.
    // Published as written is the rule; withdrawn is the operator's reversal
    // of a note that should not have been made, kept on the row so the id
    // still resolves.
    status: text("status").notNull().default("published"),
    withdrawnNote: text("withdrawn_note"),
    sightingCount: integer("sighting_count").notNull().default(1),
    firstNotedAt: timestamp("first_noted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastNotedAt: timestamp("last_noted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run that noted the finding (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_agent_findings_claim").on(table.claimId, table.lastNotedAt),
    index("idx_agent_findings_status_noted").on(table.status, table.lastNotedAt),
    index("idx_agent_findings_importance").on(table.importance, table.lastNotedAt),
    check(
      "ck_agent_findings_importance",
      sql`${table.importance} BETWEEN 1 AND 10`
    ),
    check(
      "ck_agent_findings_status",
      sql`${table.status} IN ('published', 'withdrawn')`
    ),
  ]
);

// A later run that met the same finding and said so (`joins`). The account
// it wrote is kept: corroboration in its own words, beside the original.
export const agentFindingSightings = pgTable(
  "agent_finding_sightings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => agentFindings.id, { onDelete: "cascade" }),
    account: text("account").notNull().default(""),
    refs: jsonb("refs").notNull().default([]),
    importance: integer("importance"),
    agent: text("agent").notNull(),
    model: text("model"),
    runId: uuid("run_id"),
    jobId: uuid("job_id"),
    notedAt: timestamp("noted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the run that met the finding again (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_agent_finding_sightings_finding").on(table.findingId, table.notedAt),
  ]
);

// ---------------------------------------------------------------------------
// shared_page_analyses
//
// The browser extension's shared cache: what an analysis of a PUBLIC page
// found, so the next reader of that page sees it without re-running the
// pipeline. A page enters only after the server fetched its URL without
// credentials and found the analysis's on-page phrases in that copy
// (services/shared-analysis-service.ts), so nothing here is anything a
// stranger couldn't read. It holds no page text beyond those short phrases,
// and no trace of who analyzed it. Claim status is not stored: it is re-read
// from the graph whenever an entry is served. Keyed by the hash of the
// normalized URL (services/page-url.ts), which is what lookups send.
// ---------------------------------------------------------------------------
export const sharedPageAnalyses = pgTable(
  "shared_page_analyses",
  {
    urlHash: text("url_hash").primaryKey(),
    url: text("url").notNull(),
    // [{ verbatim_text, stance, verdict, why, confidence, claim_id,
    //    proposed_canonical_form }] — see StoredAnnotation.
    annotations: jsonb("annotations").notNull(),
    extracted: integer("extracted").notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this entry (src/labels.ts): the label of the request whose
    // analysis first entered the page. A later analysis replaces the entry
    // in place and leaves this as it was.
    sensitivityLabel: sensitivityLabelColumn(),
  }
  // Lookups ask for every hash sharing a short prefix: a range scan on the
  // primary key (url_hash >= 'abcd' AND url_hash < 'abcdg'), no index of its own.
);

// Type exports
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimRelationship = typeof claimRelationships.$inferSelect;
export type NewClaimRelationship = typeof claimRelationships.$inferInsert;
export type Assessment = typeof assessments.$inferSelect;
export type NewAssessment = typeof assessments.$inferInsert;
export type Argument = typeof arguments_.$inferSelect;
export type NewArgument = typeof arguments_.$inferInsert;
export type ArgumentEvaluation = typeof argumentEvaluations.$inferSelect;
export type NewArgumentEvaluation = typeof argumentEvaluations.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type ClaimInstance = typeof claimInstances.$inferSelect;
export type NewClaimInstance = typeof claimInstances.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Contributor = typeof contributors.$inferSelect;
export type NewContributor = typeof contributors.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type LlmUsage = typeof llmUsage.$inferSelect;
export type NewLlmUsage = typeof llmUsage.$inferInsert;
export type OwlLedgerEntry = typeof owlLedger.$inferSelect;
export type NewOwlLedgerEntry = typeof owlLedger.$inferInsert;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type OAuthAuthorizationRequest =
  typeof oauthAuthorizationRequests.$inferSelect;
export type NewOAuthAuthorizationRequest =
  typeof oauthAuthorizationRequests.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type Contribution = typeof contributions.$inferSelect;
export type NewContribution = typeof contributions.$inferInsert;
export type ContributionReview = typeof contributionReviews.$inferSelect;
export type NewContributionReview = typeof contributionReviews.$inferInsert;
export type Appeal = typeof appeals.$inferSelect;
export type NewAppeal = typeof appeals.$inferInsert;
export type ArbitrationResult = typeof arbitrationResults.$inferSelect;
export type NewArbitrationResult = typeof arbitrationResults.$inferInsert;
export type ReputationEvent = typeof reputationEvents.$inferSelect;
export type NewReputationEvent = typeof reputationEvents.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type AuditRun = typeof auditRuns.$inferSelect;
export type NewAuditRun = typeof auditRuns.$inferInsert;
export type AuditFinding = typeof auditFindings.$inferSelect;
export type AssessmentOrder = typeof assessmentOrders.$inferSelect;
export type NewAssessmentOrder = typeof assessmentOrders.$inferInsert;
export type ActionAllocation = typeof actionAllocations.$inferSelect;
export type NewActionAllocation = typeof actionAllocations.$inferInsert;
export type BudgetJob = typeof budgetJobs.$inferSelect;
export type NewBudgetJob = typeof budgetJobs.$inferInsert;
export type Grant = typeof grants.$inferSelect;
export type NewGrant = typeof grants.$inferInsert;
export type NewAuditFinding = typeof auditFindings.$inferInsert;
export type ClaimFormalization = typeof claimFormalizations.$inferSelect;
export type NewClaimFormalization = typeof claimFormalizations.$inferInsert;
export type LeanCheck = typeof leanChecks.$inferSelect;
export type NewLeanCheck = typeof leanChecks.$inferInsert;
export type ProofAttempt = typeof proofAttempts.$inferSelect;
export type NewProofAttempt = typeof proofAttempts.$inferInsert;
export type PlatformFlag = typeof platformFlags.$inferSelect;
export type Bounty = typeof bounties.$inferSelect;
export type NewBounty = typeof bounties.$inferInsert;
export type PrizeClaim = typeof prizeClaims.$inferSelect;
export type NewPrizeClaim = typeof prizeClaims.$inferInsert;
export type PrizePayout = typeof prizePayouts.$inferSelect;
export type NewPrizePayout = typeof prizePayouts.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type AgentReport = typeof agentReports.$inferSelect;
export type NewAgentReport = typeof agentReports.$inferInsert;
export type AgentFinding = typeof agentFindings.$inferSelect;
export type NewAgentFinding = typeof agentFindings.$inferInsert;
export type AgentFindingSighting = typeof agentFindingSightings.$inferSelect;
export type SharedPageAnalysis = typeof sharedPageAnalyses.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type Tagging = typeof taggings.$inferSelect;
export type NewTagging = typeof taggings.$inferInsert;

// ---------------------------------------------------------------------------
// Node kinds: quantities (constitution §2, §3, §10)
//
// A quantity is a node whose subject is a value: what it measures, in which
// population and under which conditions, and in what unit. The graph's
// estimate of it is a distribution at the precision the evidence supports,
// with the share of probability that lies outside every value (the event
// does not happen, the quantity proves undefined). Estimates are kept apart
// from `assessments` so that table stays a record of verdicts on
// propositions, and a quantity is never "verified".
// ---------------------------------------------------------------------------
export const quantityDefinitions = pgTable("quantity_definitions", {
  claimId: uuid("claim_id")
    .notNull()
    .references(() => claims.id, { onDelete: "cascade" }),
  measures: text("measures").notNull(),
  population: text("population"),
  conditions: text("conditions"),
  // quantityUnitSchema in src/schemas/kinds.ts.
  unit: jsonb("unit").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Who may read this row (src/labels.ts), stamped from the usage context
  // when it is written.
  sensitivityLabel: sensitivityLabelColumn(),
  // Which graph the row belongs to (the origin column, above).
  origin: originColumn(),
}, (table) => [
  originCheck("ck_quantity_definitions_origin", table.origin),
  // One definition for a quantity in each graph (the origin column, above),
  // as every other key a replicated table has besides an id: the public
  // graph's row always applies, whatever this deployment holds.
  primaryKey({ columns: [table.claimId, table.origin] }),
]);

export const quantityEstimates = pgTable(
  "quantity_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // quantityEstimateSchema in src/schemas/kinds.ts: the form (distribution,
    // interval, bound, magnitude, point, none) and its figures.
    estimate: jsonb("estimate").notNull(),
    // Reader-facing account of what is known about the value; `work` is the
    // audit detail, as reasoning_trace is on an assessment.
    summary: text("summary"),
    work: text("work").notNull(),
    // The Steward's exit judgment (#755): how much another, stronger pass
    // would improve this estimate, as on assessments. The valuer reads it
    // from whichever table the node's kind keeps (NODE_MARGINAL_YIELD_SQL).
    marginalYield: real("marginal_yield"),
    model: text("model"),
    fundedByJobId: uuid("funded_by_job_id"),
    // Whether what this judgment was made against was recorded with it
    // (judgment_inputs, #566). False on judgments from before that record,
    // which therefore cannot be said to be stale or fresh by it.
    inputsRecorded: boolean("inputs_recorded").notNull().default(false),
    isCurrent: boolean("is_current").notNull().default(true),
    trigger: text("trigger"),
    triggerContext: text("trigger_context"),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
    // Who may read this estimate (src/labels.ts), as on assessments.sensitivity_label.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_quantity_estimates_origin", table.origin),
    // One for each node where the deployment has one label, and one for
    // each node and label (idx_quantity_estimates_current_at_label) where it has more:
    // see idx_assessments_current.
    uniqueIndex("idx_quantity_estimates_current")
      .on(table.claimId)
      .where(sql`${table.isCurrent} = true`),
    index("idx_quantity_estimates_claim").on(table.claimId),
  ]
);

// A reading of an instrument (a survey, a test, a register, a model) taken
// to indicate the quantity: evidence about it, recorded with what was
// actually measured (§3). How far it speaks to the quantity is the
// Steward's `bearing`, and a claim of its own (bearing_claim_id) when that
// is disputed or load-bearing.
export const quantityReadings = pgTable(
  "quantity_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    measured: text("measured").notNull(),
    figure: text("figure").notNull(),
    bearing: text("bearing").notNull(),
    bearingClaimId: uuid("bearing_claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_quantity_readings_origin", table.origin),index("idx_quantity_readings_claim").on(table.claimId)]
);

// A claim about which side of a figure a quantity lies, where one has a node
// of its own (rare: most such statements are estimates on the quantity). The
// claim's credence must agree with the quantity's estimate, which the
// consistency checks read from here.
export const quantityCuts = pgTable(
  "quantity_cuts",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    quantityId: uuid("quantity_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    value: real("value").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_quantity_cuts_origin", table.origin),
    // One cut for a claim in each graph (the origin column, above): a cut
    // this deployment recorded and the public graph's own for the same
    // claim are two rows, and a read takes one (oneCutForClaimSql in
    // services/mirrored-node-service.ts).
    primaryKey({ columns: [table.claimId, table.origin] }),
    index("idx_quantity_cuts_quantity").on(table.quantityId),
    check("ck_quantity_cuts_direction", sql`${table.direction} IN ('above', 'below')`),
    check("ck_quantity_cuts_self", sql`${table.claimId} != ${table.quantityId}`),
  ]
);

// ---------------------------------------------------------------------------
// Node kinds: questions (constitution §7a, §10)
//
// A question's answers, subquestions and presuppositions are edges in
// claim_relationships from the question ('answers', 'part_of', and the
// ordinary 'assumes'/'requires'); how two answers bear on each other is
// recorded pair by pair in answer_relations; how well answered it is lives
// here.
// ---------------------------------------------------------------------------
export const questionAssessments = pgTable(
  "question_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // QUESTION_STANDINGS in src/schemas/kinds.ts.
    standing: text("standing").notNull(),
    // The answers the assessment favors: one when answered, one or more when
    // leaning, none otherwise. Not foreign keys (a uuid array cannot be);
    // read paths join and drop ids that no longer resolve.
    favoredClaimIds: uuid("favored_claim_ids").array().notNull().default([]),
    summary: text("summary"),
    reasoningTrace: text("reasoning_trace").notNull(),
    // The Steward's note when it judges the set of answers incomplete.
    incomplete: text("incomplete"),
    // How sure the Steward is that the standing is the right reading of the
    // evidence, as an assessment's confidence; and its exit judgment, as on
    // assessments (#755). Null when not stated.
    confidence: real("confidence"),
    marginalYield: real("marginal_yield"),
    model: text("model"),
    fundedByJobId: uuid("funded_by_job_id"),
    // The agent run that wrote it, as on assessments.run_id.
    runId: uuid("run_id"),
    // Whether what this judgment was made against was recorded with it
    // (judgment_inputs, #566). False on judgments from before that record,
    // which therefore cannot be said to be stale or fresh by it.
    inputsRecorded: boolean("inputs_recorded").notNull().default(false),
    isCurrent: boolean("is_current").notNull().default(true),
    trigger: text("trigger"),
    triggerContext: text("trigger_context"),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
    // Who may read this assessment (src/labels.ts), as on assessments.sensitivity_label.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_question_assessments_origin", table.origin),
    // One for each node where the deployment has one label, and one for
    // each node and label (idx_question_assessments_current_at_label) where it has more:
    // see idx_assessments_current.
    uniqueIndex("idx_question_assessments_current")
      .on(table.claimId)
      .where(sql`${table.isCurrent} = true`),
    index("idx_question_assessments_claim").on(table.claimId),
    check(
      "ck_question_assessments_standing",
      sql`${table.standing} IN ('answered', 'leaning', 'open', 'ill_posed', 'unknown')`
    ),
  ]
);

// How two of a question's answers bear on each other (§7a): whether they
// exclude each other or can both hold. Stored in canonical order (a < b), as
// claim_links is, so one row covers both directions.
export const answerRelations = pgTable(
  "answer_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    claimAId: uuid("claim_a_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    claimBId: uuid("claim_b_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    reasoning: text("reasoning"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_answer_relations_origin", table.origin),
    uniqueIndex("idx_answer_relations_pair").on(table.questionId, table.claimAId, table.claimBId, table.origin),
    check("ck_answer_relations_ordered", sql`${table.claimAId} < ${table.claimBId}`),
    check("ck_answer_relations_relation", sql`${table.relation} IN ('excludes', 'compatible')`),
  ]
);

// ---------------------------------------------------------------------------
// requests (constitution Part VIII, Requests)
//
// Something someone could do that would improve what the graph knows: a
// measurement, a document, a proof, an expert's reading. Filed by an
// administrator, a contributor, or a mandate (through the Reviewer); kept
// by the Steward of the one node it bears on, or by the Curator when it
// bears on several or on none the graph holds. The keeper decides when it
// is met. Work on a request is recorded in request_work, and every outcome
// there (including a negative result or a refusal) is a complete one.
// ---------------------------------------------------------------------------
export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ask: text("ask").notNull(),
    // What the judgments it bears on would become under its outcomes.
    why: text("why").notNull(),
    satisfiedBy: text("satisfied_by").notNull(),
    whoCould: text("who_could"),
    // A party the request is put to, in words; NULL = open to anyone.
    addressedTo: text("addressed_to"),
    // What it bears on that the graph does not yet hold, in words.
    bearsOnText: text("bears_on_text"),
    // admin | contributor | mandate. A mandate's request names no party on
    // public surfaces (§12/§19): the label read paths serve is "a funded
    // mandate", and filer_grant_id is for the funder's own dashboard.
    filerKind: text("filer_kind").notNull(),
    // The administrator role that filed it (claim_steward, curator, ...).
    filerAgent: text("filer_agent"),
    filerContributorId: uuid("filer_contributor_id").references(() => contributors.id, {
      onDelete: "set null",
    }),
    filerGrantId: uuid("filer_grant_id").references(() => grants.id, {
      onDelete: "set null",
    }),
    filerRunId: uuid("filer_run_id"),
    // steward | curator, fixed when the request is filed from its targets.
    keeperKind: text("keeper_kind").notNull(),
    keeperClaimId: uuid("keeper_claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    state: text("state").notNull().default("open"),
    stateNote: text("state_note"),
    // What doing the request should cost, in micro-USD: the cost of its
    // `full` row on the action ledger and the ceiling of the run that takes
    // it up. Null until someone states it; a request without one is scoped
    // first (a cheap pass that returns a quote, which becomes this).
    budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Search over what a request asks (the /requests search box and
    // list_requests' `q`), the same hybrid as claims: the embedding of its
    // ask and why for meaning, and a keyword vector for exact terms, weighted
    // so a match in the ask outranks one in its reasons (ask A, why B, what
    // would satisfy it and what it bears on C). The embedding is written on
    // filing and on revision, and is NULL when the embedder was down.
    embedding: vector("embedding"),
    textSearch: tsvector("text_search").generatedAlwaysAs(
      (): SQL => sql`setweight(to_tsvector('english', ${requests.ask}), 'A')
        || setweight(to_tsvector('english', ${requests.why}), 'B')
        || setweight(to_tsvector('english', ${requests.satisfiedBy}), 'C')
        || setweight(to_tsvector('english', coalesce(${requests.bearsOnText}, '')), 'C')`
    ),
    // The label of the run or request that filed it (src/labels.ts). The
    // ledger rows for its work are opened at it.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_requests_state").on(table.state, table.createdAt),
    index("idx_requests_text_search").using("gin", table.textSearch),
    index("idx_requests_keeper").on(table.keeperClaimId),
    check("ck_requests_filer_kind", sql`${table.filerKind} IN ('admin', 'contributor', 'mandate')`),
    check("ck_requests_keeper_kind", sql`${table.keeperKind} IN ('steward', 'curator')`),
    check(
      "ck_requests_keeper_claim",
      sql`(${table.keeperKind} = 'steward') = (${table.keeperClaimId} IS NOT NULL)`
    ),
    check("ck_requests_budget", sql`${table.budgetMicroUsd} IS NULL OR ${table.budgetMicroUsd} > 0`),
    check(
      "ck_requests_state",
      sql`${table.state} IN ('open', 'addressed', 'in_progress', 'met', 'declined', 'withdrawn', 'moot')`
    ),
  ]
);

// What a request bears on: graph nodes, or sources (a request for a
// document's full text, a corrected table).
export const requestTargets = pgTable(
  "request_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
    // The label of the run or request that named the target (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_request_targets_request").on(table.requestId),
    index("idx_request_targets_claim").on(table.claimId),
    uniqueIndex("idx_request_targets_unique").on(
      table.requestId,
      sql`COALESCE(${table.claimId}, ${table.sourceId})`
    ),
    check(
      "ck_request_targets_one",
      sql`(${table.claimId} IS NULL) != (${table.sourceId} IS NULL)`
    ),
  ]
);

export const requestWork = pgTable(
  "request_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    // Who did it, in words a reader can follow ("Researcher", a
    // contributor's display name); the ids below are the record.
    byLabel: text("by_label").notNull(),
    contributorId: uuid("contributor_id").references(() => contributors.id, {
      onDelete: "set null",
    }),
    researchRunId: uuid("research_run_id").references(() => researchRuns.id, {
      onDelete: "set null",
    }),
    // NULL while the work is under way.
    outcome: text("outcome"),
    summary: text("summary").notNull(),
    fundedByJobId: uuid("funded_by_job_id"),
    // For a run on the request's full work: the budget its payer gave it,
    // and what the work was priced at then (the request's budget, a scoping
    // quote or its keeper's figure). A run funded below its price is marked
    // so on the work log, so a starved partial result can be told from a
    // real one (#885). NULL for scoping passes and for work nobody priced.
    budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" }),
    quoteMicroUsd: bigint("quote_micro_usd", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // An account's own statement that it is taking the request up
    // (docs/outward-acts.md, "Taking up a request in public"), as distinct
    // from work a run recorded. It commits the account to doing the work
    // well, not to a result, and funds nothing. `outcome` stays NULL until
    // the account says it will not do the work ('declined', with a reason
    // from a fixed list in decline_reason) or takes the statement back
    // (withdrawn_at). What else followed is read from the record: a page
    // the account published on a node the request bears on.
    takenUp: boolean("taken_up").notNull().default(false),
    declineReason: text("decline_reason"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    // The label of the run that recorded the work (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_request_work_request").on(table.requestId),
    uniqueIndex("uq_request_work_taken_up").on(table.requestId, table.contributorId).where(sql`taken_up`),
    check(
      "ck_request_work_outcome",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('met', 'partly_met', 'negative', 'cannot_be_met', 'declined', 'revise')`
    ),
  ]
);

export type QuantityDefinition = typeof quantityDefinitions.$inferSelect;
export type QuantityEstimateRow = typeof quantityEstimates.$inferSelect;
export type QuestionAssessment = typeof questionAssessments.$inferSelect;
export type RequestRow = typeof requests.$inferSelect;

// A node's inbox: one row per message to its Steward, kept whole until
// a pass reads it. Replaces appending to claims.steward_context, which cut the
// oldest text past 16,000 characters and was invisible to funders and readers.
// A message alone is a note, read on the node's next pass whenever someone
// pays for it; `paid` marks one that came with its pass commissioned. The
// receiving Steward answers each (outcome, outcome_note), and an answer to
// another node's Steward arrives in that node's inbox as a reply
// (trigger message_reply, reply_to set), which opens no work of its own.
export const nodeMessages = pgTable(
  "node_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    // steward, curator, contribution_reviewer, dispute_arbitrator, audit,
    // consistency_checker, lookout, mandate, user, system
    senderKind: text("sender_kind").notNull(),
    senderNodeId: uuid("sender_node_id").references((): AnyPgColumn => claims.id, {
      onDelete: "set null",
    }),
    // What the sender acted through, when it is not a node: a contribution id,
    // a mandate id, an audit run id.
    senderRef: text("sender_ref"),
    body: text("body").notNull(),
    paid: boolean("paid").notNull().default(false),
    replyTo: uuid("reply_to").references((): AnyPgColumn => nodeMessages.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    outcome: text("outcome"),
    outcomeNote: text("outcome_note"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // The session that asked (agent_sessions), when the sender waits for the
    // answer: the answer returns into that session instead of the sender
    // node's inbox.
    replyToSession: uuid("reply_to_session"),
    // The label of whoever sent it (src/labels.ts). A claim left pending by
    // unread messages of one label is taken up at that label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_node_messages_unread")
      .on(table.nodeId, table.createdAt)
      .where(sql`read_at IS NULL`),
    index("idx_node_messages_sender").on(table.senderNodeId),
    check(
      "node_messages_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('changed', 'no_change', 'disagree')`
    ),
  ]
);

// A petition (petition_mandate): a running agent asking the mandate paying
// for it for more money. Decided by a program officer under the mandate's
// operating policy, or by its Grantmaker when the officer escalates. A
// waiting petitioner reads the decision in the same run.
export const petitions = pgTable(
  "petitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    // more_budget | follow_up
    kind: text("kind").notNull(),
    askedMicroUsd: bigint("asked_micro_usd", { mode: "number" }).notNull(),
    plan: text("plan").notNull(),
    why: text("why"),
    ifRefused: text("if_refused"),
    requesterAgent: text("requester_agent"),
    requesterActionId: uuid("requester_action_id").references(() => actions.id, { onDelete: "set null" }),
    requesterNodeId: uuid("requester_node_id").references(() => claims.id, { onDelete: "set null" }),
    // The chain of runs that led to the petitioner: [{action_id, kind, node_id, budget_micro_usd}], root first.
    chain: jsonb("chain").notNull().default([]),
    waiting: boolean("waiting").notNull().default(false),
    // pending | escalated | granted | refused | follow_up
    status: text("status").notNull().default("pending"),
    grantedMicroUsd: bigint("granted_micro_usd", { mode: "number" }),
    decidedBy: text("decided_by"),
    reason: text("reason"),
    // A follow_up decision is commissioned once the petitioner's run has ended.
    followUpCommissionedAt: timestamp("follow_up_commissioned_at", { withTimezone: true }),
    // The session that asked (agent_sessions): the decision returns into it,
    // shown mid-run or resuming it if it paused (session-service.ts).
    replyToSession: uuid("reply_to_session"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // The label of the run that asked (src/labels.ts). A sitting works the
    // petitions of its mandate's label, and a follow-up runs at this one.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_petitions_open").on(table.grantId, table.createdAt).where(sql`status IN ('pending', 'escalated')`),
    check("petitions_kind_check", sql`${table.kind} IN ('more_budget', 'follow_up')`),
    check(
      "petitions_status_check",
      sql`${table.status} IN ('pending', 'escalated', 'granted', 'refused', 'follow_up')`
    ),
  ]
);

// A mandate's inbox: what wants its program officers' attention besides
// petitions. Work a lookout raised, a message addressed to the mandate, the
// outcome of work it paid for, a note from its funder. An officer handles or
// escalates each item; the Grantmaker sees escalated ones.
export const mandateInbox = pgTable(
  "mandate_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    // raised | outcome | funder_note | notice
    kind: text("kind").notNull(),
    targetNodeId: uuid("target_node_id").references(() => claims.id, { onDelete: "set null" }),
    targetRef: text("target_ref"),
    // Who put it here: a lookout's title, an agent role, 'funder', 'system'.
    source: text("source").notNull(),
    summary: text("summary").notNull(),
    // Structured detail: a suggested kind and budget, an outcome's spend.
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    handledBy: text("handled_by"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationNote: text("escalation_note"),
    // The label of the run that raised it (src/labels.ts). A sitting works
    // the items of its mandate's label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_mandate_inbox_open").on(table.grantId, table.createdAt).where(sql`handled_at IS NULL`),
  ]
);

// The decision log: every commission, grant, refusal, decline and note a
// mandate's agents made, with its reason, read back by the next decision and
// by the Grantmaker's review. Public, like everything a mandate does.
export const mandateDecisions = pgTable(
  "mandate_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    // officer | grantmaker | lookout
    decidedBy: text("decided_by").notNull(),
    // petition | commission | decline | note | escalation | policy | terms
    itemKind: text("item_kind").notNull(),
    decision: text("decision").notNull(),
    target: text("target"),
    owlsMicroUsd: bigint("owls_micro_usd", { mode: "number" }),
    reason: text("reason"),
    petitionId: uuid("petition_id").references(() => petitions.id, { onDelete: "set null" }),
    actionId: uuid("action_id").references(() => actions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The label of the run or request that decided (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_mandate_decisions_grant").on(table.grantId, table.createdAt)]
);

// Every version of a mandate's operating policy (the Grantmaker's standing
// instructions to its program officers) and of its terms (the title and
// objective its funder approved), with the note that justified each change.
export const mandatePolicyVersions = pgTable(
  "mandate_policy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    // policy | terms
    part: text("part").notNull(),
    // A policy section (mission, priorities, budgets, petitions, delegation), or null for the whole.
    section: text("section"),
    content: jsonb("content").notNull(),
    note: text("note"),
    author: text("author").notNull(),
    // applied | awaiting_approval (a platform mandate's amended terms)
    status: text("status").notNull().default("applied"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The label of the run or request that wrote the version (src/labels.ts).
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_mandate_policy_versions_grant").on(table.grantId, table.createdAt)]
);

// ---------------------------------------------------------------------------
// agent_sessions: an agent run that pauses while it waits on something it
// asked for (research it commissioned, an answer from another node's
// Steward) and resumes, with its transcript, when the answer arrives
// (session-service.ts). The run ends its turn to wait, as any agent does;
// the session keeps what it read and reasoned, so the answer lands in the
// context that asked for it rather than in a fresh pass.
//
// status: running (the run is live; replies arriving now are shown in its
// next tool result), waiting (paused, nothing back yet), ready (an answer
// arrived; a resumption pass is commissioned), expired (the deadline passed;
// its answers went to the node's inbox), closed (finished).
// ---------------------------------------------------------------------------
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey(),
    role: text("role").notNull(),
    // The node a Steward's session is on; null for agents whose work is not
    // one node's (the Consistency Checker, the Audit Agent, a Correspondent).
    nodeId: uuid("node_id").references(() => claims.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    // What the agent's run was called with, to rebuild it on resumption
    // (engine-executor.ts, runResumeAction). Stewards resume through a pass
    // on their node instead and need none.
    context: jsonb("context"),
    // The conversation so far, in the provider-neutral message form, made
    // portable at suspension (server-tool and thinking blocks become text or
    // are dropped).
    transcript: jsonb("transcript"),
    model: text("model"),
    // What it waits on: [{kind, ref}], kind research (a research run id) or
    // reply (a node message id).
    awaiting: jsonb("awaiting").notNull().default([]),
    // What came back: [{kind, ref, text, at, delivered}].
    replies: jsonb("replies").notNull().default([]),
    // Who paid for the paused run, and what it had left: a resumption is
    // commissioned from the same payer at that budget.
    payer: jsonb("payer"),
    budgetLeftMicroUsd: bigint("budget_left_micro_usd", { mode: "number" }).notNull().default(0),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deadline: timestamp("deadline", { withTimezone: true }),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    resumes: integer("resumes").notNull().default(0),
    // Money granted to the session while it was paused (a petition decided
    // after its run ended): [{grantId, microUsd}], each placed on the pass
    // that resumes it, beside what the paused run had left.
    extraFunding: jsonb("extra_funding").notNull().default([]),
    // Why the paused run's transcript was private (llm/run-visibility.ts).
    // The transcript is the resumed run's opening, so the resumed run takes
    // these reasons on; nothing a run read is made public by resuming it.
    privateReasons: text("private_reasons").array().notNull().default(sql`'{}'::text[]`),
    // The label the paused run worked at (src/labels.ts). The transcript is
    // the resumed run's opening, so the run that resumes it works at the
    // same label, whoever delivers the answer it waited for.
    sensitivityLabel: sensitivityLabelColumn(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_sessions_node").on(table.nodeId, table.status),
    check(
      "agent_sessions_status_check",
      sql`${table.status} IN ('running', 'waiting', 'ready', 'expired', 'closed')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// judgment_inputs: what each judgment was made against (#566)
//
// When a node's judgment is written (a claim's assessment, a quantity's
// estimate, a question's assessment), the state of what it rests on is
// recorded with it, one row per input:
//
//   - 'premise': a node under this one (an edge with this node as parent),
//     with the relation and the id of that node's judgment in force at the
//     time, or NULL when it had none.
//   - 'source': a source attached to this node by a live instance, with the
//     source's content hash when it had one.
//
//   - 'beside': another label's version of this same node that was current
//     when this one was written, at a label this one's label reads, with
//     that label (input_label). A node may carry a version at each label
//     (src/labels.ts), and each is made beside the ones its label reads. An
//     argument's evaluation records the same, and nothing else.
//
// Staleness then follows from versions instead of from someone remembering
// to say so: a judgment is out of date when a premise has been judged again,
// when a premise or a source has been added or removed, or when one of its
// sources has had a correction or a retraction since, and it was made
// against an earlier version when one it was made beside has been replaced
// (services/judgment-inputs-service.ts).
//
// judgment_id points at one of four tables by judgment_kind, so it carries
// no foreign key; the rows are written in the same statement sequence as the
// judgment and never updated. A judgment whose inputs_recorded is false has
// no rows here because none were recorded, not because it rests on nothing.
// ---------------------------------------------------------------------------
export const judgmentInputs = pgTable(
  "judgment_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    judgmentKind: text("judgment_kind").notNull(),
    judgmentId: uuid("judgment_id").notNull(),
    inputKind: text("input_kind").notNull(),
    // 'premise': the node under this one, the edge's relation, and that
    // node's judgment in force when this judgment was written.
    nodeId: uuid("node_id"),
    relationType: text("relation_type"),
    inputJudgmentId: uuid("input_judgment_id"),
    // 'beside': the label of the version in input_judgment_id. It is not
    // this row's own label (sensitivity_label below), which is the label of
    // the version that records it.
    inputLabel: text("input_label").references(() => labels.name),
    // 'source': the source, and its content hash then when it had one.
    sourceId: uuid("source_id"),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who may read this row (src/labels.ts), stamped from the usage context
    // when it is written.
    sensitivityLabel: sensitivityLabelColumn(),
    // Which graph the row belongs to (the origin column, above).
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_judgment_inputs_origin", table.origin),
    index("idx_judgment_inputs_judgment").on(table.judgmentKind, table.judgmentId),
    check(
      "ck_judgment_inputs_judgment_kind",
      sql`${table.judgmentKind} IN ('assessment', 'quantity_estimate', 'question_assessment', 'argument_evaluation')`
    ),
    check("ck_judgment_inputs_input_kind", sql`${table.inputKind} IN ('premise', 'source', 'beside')`),
    check(
      "ck_judgment_inputs_shape",
      sql`(${table.inputKind} = 'premise' AND ${table.nodeId} IS NOT NULL AND ${table.relationType} IS NOT NULL AND ${table.sourceId} IS NULL)
        OR (${table.inputKind} = 'source' AND ${table.sourceId} IS NOT NULL AND ${table.nodeId} IS NULL)
        OR (${table.inputKind} = 'beside' AND ${table.inputJudgmentId} IS NOT NULL AND ${table.inputLabel} IS NOT NULL AND ${table.nodeId} IS NULL AND ${table.sourceId} IS NULL)`
    ),
    // The upkeep that finds versions made beside one that has since been
    // replaced reads these rows by the version they name.
    index("idx_judgment_inputs_beside")
      .on(table.inputJudgmentId)
      .where(sql`${table.inputKind} = 'beside'`),
  ]
);

// ---------------------------------------------------------------------------
// The mirror feed (services/mirror-feed-service.ts, docs/mirror.md)
//
// A deployment that publishes keeps the batches it has cut and, for every
// row it has published, the hash of the replicated columns as last
// published. The next cut compares the tables with those hashes: a row whose
// hash is new or different is sent again whole, and a row that is gone or no
// longer public is sent as a deletion or a retraction. Both tables are empty
// on a deployment that does not publish.
// ---------------------------------------------------------------------------
export const mirrorFeedBatches = pgTable(
  "mirror_feed_batches",
  {
    // Starts at 1 and never repeats or skips: the primary key refuses a
    // repeat, and a batch is written only by a cut that holds the feed's lock
    // and numbers it one past the last.
    sequence: bigint("sequence", { mode: "number" }).primaryKey(),
    // The feed this deployment publishes, minted with its first batch.
    feedId: uuid("feed_id").notNull(),
    // 'snapshot' (every published row) or 'changes'.
    kind: text("kind").notNull(),
    // A cut too large for one batch is split; these name the first batch of
    // the cut and say whether this is its last.
    partFirst: bigint("part_first", { mode: "number" }).notNull(),
    partLast: boolean("part_last").notNull(),
    // The schema the batch was cut from: the number and tag of the newest
    // migration the publisher's code carried.
    migrationNumber: integer("migration_number").notNull(),
    migrationTag: text("migration_tag").notNull(),
    // The hash of the mirrored tables' shape the rows were cut in
    // (replicatedShape in services/mirror-manifest.ts). When it differs from
    // the last batch's, the next cut is a snapshot.
    shape: text("shape").notNull(),
    cutAt: timestamp("cut_at", { withTimezone: true }).notNull(),
    previousHash: text("previous_hash").notNull(),
    batchHash: text("batch_hash").notNull(),
    keyId: text("key_id").notNull(),
    rowCount: integer("row_count").notNull(),
    removalCount: integer("removal_count").notNull(),
    // The batch as signed and served, byte for byte.
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_mirror_feed_batches_hash").on(table.batchHash),
    check("ck_mirror_feed_batches_kind", sql`${table.kind} IN ('snapshot', 'changes')`),
  ]
);

export const mirrorFeedRows = pgTable(
  "mirror_feed_rows",
  {
    tableName: text("table_name").notNull(),
    // The row's key as text; a composite key is joined with '/'.
    rowKey: text("row_key").notNull(),
    // sha256 of the replicated columns as last published.
    rowHash: text("row_hash").notNull(),
    // The batch that last carried the row.
    sequence: bigint("sequence", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tableName, table.rowKey] })]
);

// ---------------------------------------------------------------------------
// The mirror, applied (services/mirror-apply-service.ts)
//
// A deployment that mirrors keeps one row per batch it has applied: the
// newest is where its mirror stands ("the public graph as of ..."), and the
// chain of hashes is what the next batch must follow. A batch it refused is
// recorded with the reason, and nothing of a refused batch is applied.
// ---------------------------------------------------------------------------
export const mirrorAppliedBatches = pgTable("mirror_applied_batches", {
  sequence: bigint("sequence", { mode: "number" }).primaryKey(),
  feedId: uuid("feed_id").notNull(),
  kind: text("kind").notNull(),
  partFirst: bigint("part_first", { mode: "number" }).notNull(),
  partLast: boolean("part_last").notNull(),
  migrationNumber: integer("migration_number").notNull(),
  // When the publisher cut the batch: the mirror shows the public graph as
  // of the newest of these.
  cutAt: timestamp("cut_at", { withTimezone: true }).notNull(),
  previousHash: text("previous_hash").notNull(),
  batchHash: text("batch_hash").notNull(),
  keyId: text("key_id").notNull(),
  // Where the public graph's pages are, as the batch stated it, so that a
  // mirrored judgment's run can be linked to where its transcript is.
  publisherWebBaseUrl: text("publisher_web_base_url"),
  // Rows written and removed, by table.
  counts: jsonb("counts").notNull().default({}),
  // What the batch left for someone to look at: local rows that hang off a
  // claim the public graph merged away, mirrored claims kept as deprecated
  // because local rows reference them, local rows a deletion took with it.
  notes: jsonb("notes").notNull().default({}),
  // Where the batch came from: the feed's address or a file's name.
  receivedFrom: text("received_from"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

// The rows a snapshot has written so far, kept only while the snapshot is
// being applied. A snapshot holds every public row, so when its last batch
// is in, a mirrored row that is not listed here is one the public graph no
// longer has, and it is removed; then the table is emptied. This is what
// lets a mirror start again from a later snapshot when it cannot apply the
// batches in between.
export const mirrorSnapshotRows = pgTable(
  "mirror_snapshot_rows",
  {
    tableName: text("table_name").notNull(),
    rowKey: text("row_key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tableName, table.rowKey] })]
);

export const mirrorRefusals = pgTable(
  "mirror_refusals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // What the batch said of itself; null where it could not be read.
    sequence: bigint("sequence", { mode: "number" }),
    batchHash: text("batch_hash"),
    // One of MIRROR_REFUSAL_CODES (services/mirror-batch.ts).
    code: text("code").notNull(),
    message: text("message").notNull(),
    receivedFrom: text("received_from"),
    refusedAt: timestamp("refused_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_mirror_refusals_at").on(table.refusedAt)]
);

// ---------------------------------------------------------------------------
// mirror_node_changes: what the public graph changed on a node this
// deployment mirrors, as each applied batch found it
// (services/mirror-apply-service.ts, services/mirror-upkeep.ts)
//
// A deployment's own judgments and nodes rest on mirrored ones: a version at
// a private label beside the public assessment, a private node with a
// public premise. When a batch rewords such a node, adds, rewrites or
// retires an argument on it, merges it away or withdraws it, the judgments
// that rest on it were made against the node as it was. Edges, sources and
// judgments are compared from the record a judgment keeps of its inputs
// (judgment_inputs); a wording, an argument and a withdrawal leave no such
// trace once the row is overwritten, so the applier writes what it
// replaced here, in the batch's own transaction.
//
// A row is a fact about the public graph and says nothing of what this
// deployment holds: it is written for every mirrored node the batch
// changed in one of these ways, whether or not anything private rests on
// it, and it carries the label `public` like the rows it describes. The
// Steward's note of what has changed since a judgment reads it
// (llm/agents/steward-changes-note.ts), and a read of the node says when
// the public graph merged or withdrew it.
// ---------------------------------------------------------------------------
export const mirrorNodeChanges = pgTable(
  "mirror_node_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The mirrored node. No foreign key: the row is history, and outlives a
    // node the public graph deleted outright.
    claimId: uuid("claim_id").notNull(),
    // The batch that carried the change, and when the public graph cut it.
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    cutAt: timestamp("cut_at", { withTimezone: true }).notNull(),
    // 'reworded' | 'argument_added' | 'argument_rewritten' |
    // 'argument_retired' | 'argument_removed' | 'merged' | 'withdrawn'
    change: text("change").notNull(),
    // What the change was, in the public graph's own words: the wording
    // before and after, an argument's id and name, the node it was merged
    // into, how it was withdrawn.
    detail: jsonb("detail").notNull().default({}),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    // Who may read this row (src/labels.ts): everyone, as the mirrored
    // rows it describes. The applier names it.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_mirror_node_changes_claim").on(table.claimId, table.appliedAt),
    check(
      "ck_mirror_node_changes_change",
      sql`${table.change} IN ('reworded', 'argument_added', 'argument_rewritten', 'argument_retired', 'argument_removed', 'merged', 'withdrawn')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// steward_slots: the Steward's pending slot for work on a node at a label
// other than the node's own (src/labels.ts, "A judgment at each label")
//
// A node's own row is its queue for work at its own label
// (claims.steward_state and the columns beside it). Work at another label
// that reads the node, such as an internal assessment of a public claim,
// keeps its slot here, one row per node and label, with the same columns
// and the same lifecycle (services/steward-lease.ts says which of the two a
// piece of work uses). So a pass at one label neither waits on nor shows
// itself to a pass at another, and no run writes its bookkeeping into a row
// at a label that is not its own. A row is made the first time work at its
// label is asked for on the node, as 'done' (nothing waiting), and the
// statement that asks then moves it.
//
// The public graph has one label, every piece of work is at its node's own,
// and the table stays empty there.
// ---------------------------------------------------------------------------
export const stewardSlots = pgTable(
  "steward_slots",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    stewardState: text("steward_state").notNull().default("done"),
    stewardTrigger: text("steward_trigger"),
    stewardError: text("steward_error"),
    stewardErrorReason: text("steward_error_reason"),
    stewardedAt: timestamp("stewarded_at", { withTimezone: true }),
    stewardRequeued: boolean("steward_requeued").notNull().default(false),
    stewardAttempts: integer("steward_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The label of the work the slot is for, stamped from the run or the
    // request that first asked for it.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.claimId, table.sensitivityLabel] }),
    index("idx_steward_slots_pending")
      .on(table.sensitivityLabel, table.updatedAt)
      .where(sql`steward_state = 'pending'`),
  ]
);

// ---------------------------------------------------------------------------
// The judgment in force (#566), and a version at each label
//
// A node may carry one current judgment at each label: the current row, for
// that label, of the table its kind keeps (a proposition's verdict in
// `assessments`, a quantity's estimate in `quantity_estimates`, a question's
// standing in `question_assessments`), and the current evaluation of an
// argument in `argument_evaluations`. Each is a version, written by work at
// its label and replaced only by it.
//
// Which versions are in force depends on who is reading. Among the current
// versions a connection's clearance reads, a version is in force unless
// another of them was made at a label that reads its label: that other one
// was made with sight of everything this one saw, and more. A reader who
// holds two labels that do not read each other, each with a version, has
// both in force. Nothing is merged. That rule is written once, in the
// database (minerval_version_standing, in the migration that brought it),
// and everything here reads through it:
//
//   - `<table>_in_force` is the version a reader goes by, one row for each
//     node at most: the version in force, and where several are in force
//     the one made most recently. Every read of "the current judgment" that
//     wants one row for a node goes through one of these four views.
//   - `<table>_versions` is every current version the reader may read, each
//     with its label and whether it is in force for this reader. A read that
//     shows a node's versions side by side, or that wants the version at
//     one label (a run's own), reads these.
//
// On the public graph there is one label and one version, and both
// functions the views call are the constant true, which the planner folds
// away: each view is planned as the plain "where is_current" it was. The
// step that turns enforcement on (minerval_enforcement_sync) points the two
// functions at the rule when a second label is defined.
//
// Read a view to learn what a node's judgment is. Read the table for
// history (every row, current or not) and for the write seam that supersedes
// a current row; nothing writes through a view. A file that mentions
// is_current has to say why (tests/unit/db/judgment-in-force.test.ts).
//
// drizzle-kit writes the views into migrations with their columns spelled
// out, so adding a column to one of the tables regenerates its views: run
// `npm run db:generate` as for any schema change.
// ---------------------------------------------------------------------------
// Each reads its table with its caller's rights (security_invoker): a view
// otherwise reads as its owner, whom the label policies do not bind
// (db/clearance.ts), and would show a cleared connection every label. It is
// said here so that a regenerated view is created with it.
const callersRights = { securityInvoker: true };

/** The version a one-row read takes, as a condition on a judgment table's row. */
const goneBy = (judgments: string, node: AnyPgColumn, label: AnyPgColumn): SQL =>
  sql`minerval_version_gone_by(${sql.raw(`'${judgments}'`)}, ${node}, ${label})`;
/** Whether a current version is in force for the connection reading it. */
const inForce = (judgments: string, node: AnyPgColumn, label: AnyPgColumn): SQL<boolean> =>
  sql<boolean>`minerval_version_in_force(${sql.raw(`'${judgments}'`)}, ${node}, ${label})`;

export const assessmentsInForce = pgView("assessments_in_force").with(callersRights).as((qb) =>
  qb
    .select()
    .from(assessments)
    .where(and(eq(assessments.isCurrent, true), goneBy("assessments", assessments.claimId, assessments.sensitivityLabel)))
);

export const argumentEvaluationsInForce = pgView("argument_evaluations_in_force").with(callersRights).as((qb) =>
  qb
    .select()
    .from(argumentEvaluations)
    .where(
      and(
        eq(argumentEvaluations.isCurrent, true),
        goneBy("argument_evaluations", argumentEvaluations.argumentId, argumentEvaluations.sensitivityLabel)
      )
    )
);

export const quantityEstimatesInForce = pgView("quantity_estimates_in_force").with(callersRights).as((qb) =>
  qb
    .select()
    .from(quantityEstimates)
    .where(
      and(
        eq(quantityEstimates.isCurrent, true),
        goneBy("quantity_estimates", quantityEstimates.claimId, quantityEstimates.sensitivityLabel)
      )
    )
);

export const questionAssessmentsInForce = pgView("question_assessments_in_force").with(callersRights).as((qb) =>
  qb
    .select()
    .from(questionAssessments)
    .where(
      and(
        eq(questionAssessments.isCurrent, true),
        goneBy("question_assessments", questionAssessments.claimId, questionAssessments.sensitivityLabel)
      )
    )
);

export const assessmentVersions = pgView("assessments_versions").with(callersRights).as((qb) =>
  qb
    .select({
      ...getTableColumns(assessments),
      inForce: inForce("assessments", assessments.claimId, assessments.sensitivityLabel).as("in_force"),
    })
    .from(assessments)
    .where(eq(assessments.isCurrent, true))
);

export const argumentEvaluationVersions = pgView("argument_evaluations_versions").with(callersRights).as((qb) =>
  qb
    .select({
      ...getTableColumns(argumentEvaluations),
      inForce: inForce(
        "argument_evaluations",
        argumentEvaluations.argumentId,
        argumentEvaluations.sensitivityLabel
      ).as("in_force"),
    })
    .from(argumentEvaluations)
    .where(eq(argumentEvaluations.isCurrent, true))
);

export const quantityEstimateVersions = pgView("quantity_estimates_versions").with(callersRights).as((qb) =>
  qb
    .select({
      ...getTableColumns(quantityEstimates),
      inForce: inForce("quantity_estimates", quantityEstimates.claimId, quantityEstimates.sensitivityLabel).as(
        "in_force"
      ),
    })
    .from(quantityEstimates)
    .where(eq(quantityEstimates.isCurrent, true))
);

export const questionAssessmentVersions = pgView("question_assessments_versions").with(callersRights).as((qb) =>
  qb
    .select({
      ...getTableColumns(questionAssessments),
      inForce: inForce(
        "question_assessments",
        questionAssessments.claimId,
        questionAssessments.sensitivityLabel
      ).as("in_force"),
    })
    .from(questionAssessments)
    .where(eq(questionAssessments.isCurrent, true))
);

// ---------------------------------------------------------------------------
// Showing a node's page below its label (services/showing-service.ts,
// docs/showing-a-page.md)
//
// A page written at one label can be shown to readers who may not read that
// label: at another label inside the deployment, or outside it. It is one
// act at every boundary. What is shown is the ordinary page, read from the
// rows the Steward's ordinary work wrote, less what a Redactor removed under
// the boundary's policy and less the parts the holders of `release` hold.
//
// Two sets of readers need rows about one showing, and they may share no
// label: the people and runs at the page's label, who see the page whole,
// and the readers on the destination side, who see what was released. So the
// tables come in two families, and a row's sensitivity_label says which side
// it is for.
//
//   At the page's label:        showings, showing_pages, showing_parts,
//                               showing_removals
//   At the destination's label: shown_showings, shown_nodes, shown_pages,
//                               shown_parts, showing_acts, release_rules
//   One row on each side:       redaction_policies
//
// A showing outside the deployment keeps its destination-side rows at
// `public`: what is released to anyone may be read by every member.
//
// The rows on the destination side are written by the showing service as
// the tables' owner, once the route has checked the permission of the
// person acting, or by the step that follows an agent's run. They are the
// one way text reaches a label that does not read the label it was written
// at, and they hold only what was released, with fixed words for the rest.
// A destination-side row does not name the page's label: a label's name is
// not shown to people who may not read it.
//
// The public graph has one label, nothing can be shown below it, and every
// table here stays empty there.
// ---------------------------------------------------------------------------

// A request to show a node's page, as the page's side holds it.
export const showings = pgTable(
  "showings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // The destination: a label, or outside the deployment (to_label null).
    toLabel: text("to_label").references(() => labels.name),
    toOutside: boolean("to_outside").notNull().default(false),
    // The boundary is the pair (the page's label, the destination). Its id
    // is what the destination side knows it by (redaction_policies).
    boundaryId: uuid("boundary_id").notNull(),
    // 'once': the page as it stood when asked. 'standing': each later
    // version follows.
    form: text("form").notNull(),
    // 'node': this node alone. 'under': with what sits under it.
    scope: text("scope").notNull(),
    askedBy: uuid("asked_by").references((): AnyPgColumn => contributors.id),
    // The permissions the person held when they asked, as the record shows
    // them ("direct", "release for <party>", ...).
    askedHolding: text("asked_holding").array().notNull().default([]),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by").references((): AnyPgColumn => contributors.id),
    endedHolding: text("ended_holding").array(),
    // One of END_REASONS in services/showing-service.ts.
    endReason: text("end_reason"),
    // The page's label.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    check("ck_showings_destination", sql`(${table.toLabel} IS NULL) = ${table.toOutside}`),
    check("ck_showings_form", sql`${table.form} IN ('once', 'standing')`),
    check("ck_showings_scope", sql`${table.scope} IN ('node', 'under')`),
    check("ck_showings_not_own_label", sql`${table.toLabel} IS NULL OR ${table.toLabel} <> ${table.sensitivityLabel}`),
    index("idx_showings_node").on(table.nodeId),
    // One live showing of a node across a boundary in each form and scope:
    // asking again for what already stands is refused, not stacked.
    uniqueIndex("uq_showings_live")
      .on(table.nodeId, table.boundaryId, table.form, table.scope)
      .where(sql`ended_at IS NULL AND form = 'standing'`),
  ]
);

// One version of one node's page under a showing: the page as recorded when
// the version was found, and where its redaction, check and gate stand.
export const showingPages = pgTable(
  "showing_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showingId: uuid("showing_id")
      .notNull()
      .references(() => showings.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    // The version of the node's judgment at the page's label this page
    // carries: one of the three judgment tables by kind, so no foreign key.
    judgmentKind: text("judgment_kind").notNull(),
    judgmentId: uuid("judgment_id").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    // to_redact | to_check | at_gate | cannot_cross | overtaken
    stage: text("stage").notNull().default("to_redact"),
    // How many times the redaction has been done: 1, and one more each time
    // the check returned it.
    round: integer("round").notNull().default(1),
    redactActionId: uuid("redact_action_id"),
    auditRunId: uuid("audit_run_id"),
    policyId: uuid("policy_id"),
    // What is always shown when the page is shown: the verdict with its
    // confidence and any credence or estimate, coverage, the sources that
    // exist, the gaps recorded, how the page was made, the removals counted
    // by category. Canonical JSON, hashed as the tree's first leaf.
    header: text("header"),
    headerSalt: text("header_salt"),
    root: text("root"),
    // The parties whose release the verdict takes: every party whose
    // material the version read. Empty means the organization's own.
    restsOn: uuid("rests_on").array().notNull().default([]),
    // The Redactor's own words, which stay at the page's label.
    leastSure: jsonb("least_sure"),
    cannotCrossCategory: text("cannot_cross_category"),
    cannotCrossNote: text("cannot_cross_note"),
    // Audit's answers. `audit_answer` is one of the three fixed answers
    // (FIDELITY_ANSWERS); its reasons stay at the page's label.
    auditAnswer: text("audit_answer"),
    auditReasons: text("audit_reasons"),
    redactorModel: text("redactor_model"),
    redactorRunId: uuid("redactor_run_id"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_showing_pages_version").on(table.showingId, table.nodeId, table.judgmentId),
    index("idx_showing_pages_stage").on(table.stage),
    check(
      "ck_showing_pages_stage",
      sql`${table.stage} IN ('to_redact', 'to_check', 'at_gate', 'cannot_cross', 'overtaken')`
    ),
    check(
      "ck_showing_pages_kind",
      sql`${table.judgmentKind} IN ('assessment', 'quantity_estimate', 'question_assessment')`
    ),
  ]
);

// One part of a page: a paragraph, an argument, a source's reading, a
// subclaim with its bearing. The page is divided mechanically from its
// structure when it is recorded (services/page-parts.ts).
export const showingParts = pgTable(
  "showing_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => showingPages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // One of PART_KINDS in services/page-parts.ts.
    kind: text("kind").notNull(),
    // The kind as a held part is named: "argument:against", "reasoning".
    descriptor: text("descriptor").notNull(),
    // The row the part was read from (an argument, an instance, an edge, a
    // request), where it has one.
    refId: uuid("ref_id"),
    // The part as written. Never changed.
    original: text("original").notNull(),
    salt: text("salt").notNull(),
    // The parties whose release the part takes. Empty means the
    // organization's own.
    restsOn: uuid("rests_on").array().notNull().default([]),
    // Set when the Redactor finishes: the part as it left it, and its hash.
    redacted: text("redacted"),
    marks: jsonb("marks"),
    commitment: text("commitment"),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [uniqueIndex("uq_showing_parts_position").on(table.pageId, table.position)]
);

// One removal the Redactor made inside a part, by its place in the part as
// written. The note is the Redactor's and stays at the page's label.
export const showingRemovals = pgTable(
  "showing_removals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partId: uuid("part_id")
      .notNull()
      .references(() => showingParts.id, { onDelete: "cascade" }),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    category: text("category").notNull(),
    note: text("note").notNull(),
    policyId: uuid("policy_id").notNull(),
    madeInRound: integer("made_in_round").notNull().default(1),
    // A removal the Redactor took back, after the check returned the work.
    takenBackAt: timestamp("taken_back_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_showing_removals_part").on(table.partId),
    check("ck_showing_removals_span", sql`${table.startOffset} >= 0 AND ${table.endOffset} > ${table.startOffset}`),
  ]
);

// The same showing as its destination side reads it. Same id as `showings`.
export const shownShowings = pgTable(
  "shown_showings",
  {
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    toOutside: boolean("to_outside").notNull().default(false),
    boundaryId: uuid("boundary_id").notNull(),
    form: text("form").notNull(),
    scope: text("scope").notNull(),
    askedBy: uuid("asked_by").references((): AnyPgColumn => contributors.id),
    askedHolding: text("asked_holding").array().notNull().default([]),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by").references((): AnyPgColumn => contributors.id),
    endedHolding: text("ended_holding").array(),
    endReason: text("end_reason"),
    // For a showing outside: whether the person who asked chose, then, that
    // each package is sent to the public graph as it is released, with no
    // person sending each one (services/outbound-service.ts). False means a
    // person sends each package.
    sendAsReleased: boolean("send_as_released").notNull().default(false),
    // The destination's label; `public` for a showing outside.
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_shown_showings_node").on(table.nodeId)]
);

// Each node a showing covers, from when it came under it until it left.
// A node with no page yet is "not yet assessed".
export const shownNodes = pgTable(
  "shown_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showingId: uuid("showing_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    // The node it sits under in this showing; null for the node asked for.
    placeParentId: uuid("place_parent_id"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // One of LEFT_REASONS in services/showing-service.ts.
    leftReason: text("left_reason"),
    // When the node was first assessed at the page's label, so a reader can
    // see whether the showing began before or after.
    firstAssessedAt: timestamp("first_assessed_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_shown_nodes_showing").on(table.showingId),
    index("idx_shown_nodes_node").on(table.nodeId),
  ]
);

// One version of a node's page as the destination side reads it. Same id as
// `showing_pages`. The header and its salt are null until the page is shown.
export const shownPages = pgTable(
  "shown_pages",
  {
    id: uuid("id").primaryKey(),
    showingId: uuid("showing_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    // Where the page stands, in the fixed words of PAGE_STAGES.
    stage: text("stage").notNull().default("to_redact"),
    round: integer("round").notNull().default(1),
    // The tree's root, recorded when the Redactor finished and before
    // anyone decided anything. An earlier round's root stays in `roots`.
    root: text("root"),
    roots: jsonb("roots").notNull().default([]),
    headerCommitment: text("header_commitment"),
    header: text("header"),
    headerSalt: text("header_salt"),
    // The parties whose release the verdict takes, by id.
    needs: uuid("needs").array().notNull().default([]),
    auditAnswer: text("audit_answer"),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    // The source this page arrived as at the destination label, once shown.
    sourceId: uuid("source_id"),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [index("idx_shown_pages_showing").on(table.showingId, table.nodeId)]
);

// One part of a shown page as the destination side reads it. Same id as
// `showing_parts`. The text, its marks and its salt are null while held.
export const shownParts = pgTable(
  "shown_parts",
  {
    id: uuid("id").primaryKey(),
    pageId: uuid("page_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    descriptor: text("descriptor").notNull(),
    commitment: text("commitment").notNull(),
    needs: uuid("needs").array().notNull().default([]),
    text: text("text"),
    marks: jsonb("marks"),
    salt: text("salt"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [uniqueIndex("uq_shown_parts_position").on(table.pageId, table.position)]
);

// Everything a person, a rule or the process did on a showing, in order.
// Rows are added and never changed or removed: a hold stays on the record
// after it is lifted, and a release is not taken back.
export const showingActs = pgTable(
  "showing_acts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showingId: uuid("showing_id").notNull(),
    // The page the act is on, and the part; a page with no part is the act
    // on the page itself (its verdict).
    pageId: uuid("page_id"),
    partId: uuid("part_id"),
    // One of ACTS in services/showing-service.ts.
    act: text("act").notNull(),
    // The party the act was made for, where it was made under `release`.
    partyId: uuid("party_id").references(() => parties.id),
    // Who acted; null for an act of the process or of a standing rule.
    actorId: uuid("actor_id").references((): AnyPgColumn => contributors.id),
    // The permissions the actor held when they acted.
    holding: text("holding").array().notNull().default([]),
    ruleId: uuid("rule_id"),
    // A category from a fixed list, never free text.
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_showing_acts_showing").on(table.showingId, table.at),
    index("idx_showing_acts_item").on(table.pageId, table.partId),
  ]
);

// A standing rule a party's holders of `release` set, in words the system
// can apply without judgment (RULE_CONDITIONS in services/showing-service.ts).
export const releaseRules = pgTable(
  "release_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    boundaryId: uuid("boundary_id").notNull(),
    condition: text("condition").notNull(),
    // Whether the rule also releases the page itself, with its verdict.
    coversVerdict: boolean("covers_verdict").notNull().default(false),
    setBy: uuid("set_by").references((): AnyPgColumn => contributors.id),
    setHolding: text("set_holding").array().notNull().default([]),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by").references((): AnyPgColumn => contributors.id),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_release_rules_boundary").on(table.boundaryId),
    check("ck_release_rules_condition", sql`${table.condition} IN ('nothing_removed_and_only_ours', 'only_ours')`),
  ]
);

// The policy for one boundary, versioned. Each version is two rows with the
// same text: one at the page's label, which the Redactor, Audit and the
// assessing Steward read, and one on the destination side, which names no
// label the destination does not read.
export const redactionPolicies = pgTable(
  "redaction_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boundaryId: uuid("boundary_id").notNull(),
    // 'page' or 'destination'.
    side: text("side").notNull(),
    version: integer("version").notNull(),
    // The categories as saved: [{ name, covers, examples }].
    categories: jsonb("categories").notNull(),
    // The whole policy as a reader is given it.
    body: text("body").notNull(),
    // sha256 of `body`.
    hash: text("hash").notNull(),
    // The pair, on the page's side only.
    fromLabel: text("from_label").references(() => labels.name),
    toLabel: text("to_label").references(() => labels.name),
    toOutside: boolean("to_outside").notNull().default(false),
    // Null for the version every boundary starts from.
    savedBy: uuid("saved_by").references((): AnyPgColumn => contributors.id),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_redaction_policies_version").on(table.boundaryId, table.side, table.version),
    check("ck_redaction_policies_side", sql`${table.side} IN ('page', 'destination')`),
    check(
      "ck_redaction_policies_pair",
      sql`(${table.side} = 'page') = (${table.fromLabel} IS NOT NULL)`
    ),
  ]
);

// ---------------------------------------------------------------------------
// A shown page leaves the deployment and is read on the public graph
// (docs/published-pages.md).
//
// Two sides, in one codebase, and a deployment uses one of them.
//
//   In a deployment that shows pages outside: outbound_packages,
//   outbound_sends, outbound_proposals. They are built from the
//   destination-side rows of a showing outside, which are at `public`, by a
//   connection cleared for `public` alone, and they are at `public`
//   themselves: what is released to anyone may be read by every member.
//
//   On a graph that admits published pages: publishers, published_pages,
//   published_page_packages. The public graph has one label and these are
//   at it.
// ---------------------------------------------------------------------------

// One signed package: the state of one node under one showing outside, as
// the outside reads it, at the moment it was built. A node's packages are
// numbered and each names the one before.
export const outboundPackages = pgTable(
  "outbound_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showingId: uuid("showing_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    // The node's id on the public graph: its own for a mirrored node, and
    // for a node that exists only here the node its proposal became.
    publicNodeId: uuid("public_node_id").notNull(),
    sequence: integer("sequence").notNull(),
    // The hash of what the package says apart from its place in the
    // sequence and when it was built: a new package is built when this
    // differs from the last one's.
    contentHash: text("content_hash").notNull(),
    hash: text("hash").notNull(),
    package: jsonb("package").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_outbound_packages_sequence").on(table.showingId, table.nodeId, table.sequence),
    uniqueIndex("uq_outbound_packages_hash").on(table.hash),
  ]
);

// Every time a package or a proposal left, or was handed to a person to
// carry: who did it, how, and what came back. Rows are added and never
// changed.
export const outboundSends = pgTable(
  "outbound_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id"),
    proposalId: uuid("proposal_id"),
    // Who sent it; null when it went under a standing choice.
    sentBy: uuid("sent_by").references((): AnyPgColumn => contributors.id),
    holding: text("holding").array().notNull().default([]),
    underStandingChoice: boolean("under_standing_choice").notNull().default(false),
    // 'https' or 'file'.
    how: text("how").notNull(),
    // 'admitted', 'refused', 'failed' or 'handed_over'.
    result: text("result").notNull(),
    // What the public graph answered, or why it could not be reached.
    detail: text("detail"),
    // The publication's id on the public graph, as its answer to an
    // admitted package gave it. A contribution made there through the page
    // names this id, which is how it is known to be about a page of ours.
    publicPageId: uuid("public_page_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_outbound_sends_package").on(table.packageId),
    check("ck_outbound_sends_how", sql`${table.how} IN ('https', 'file')`),
    check("ck_outbound_sends_result", sql`${table.result} IN ('admitted', 'refused', 'failed', 'handed_over')`),
  ]
);

// A node that exists only in this deployment, proposed to the public graph
// so that its page has a node to appear on. The words are a person's, who
// holds `direct`, and each party the node's wording rests on releases them.
export const outboundProposals = pgTable(
  "outbound_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showingId: uuid("showing_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    // 'claim', 'quantity' or 'question'.
    nodeKind: text("node_kind").notNull().default("claim"),
    // The words to be proposed.
    text: text("text").notNull(),
    writtenBy: uuid("written_by").references((): AnyPgColumn => contributors.id),
    writtenHolding: text("written_holding").array().notNull().default([]),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
    // The parties whose release the words take, and the releases given:
    // [{ party_id, by, holding, at }].
    needs: uuid("needs").array().notNull().default([]),
    releases: jsonb("releases").notNull().default([]),
    // 'waiting_for_release', 'ready', 'sent', 'on_the_public_graph',
    // 'not_admitted' or 'replaced'.
    state: text("state").notNull().default("waiting_for_release"),
    // The contribution the proposal became on the public graph.
    publicContributionId: text("public_contribution_id"),
    publicNodeId: uuid("public_node_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_outbound_proposals_node").on(table.showingId, table.nodeId),
    check(
      "ck_outbound_proposals_state",
      sql`${table.state} IN ('waiting_for_release', 'ready', 'sent', 'on_the_public_graph', 'not_admitted', 'replaced')`
    ),
  ]
);

// An account that has registered a deployment's signing key. The row is a
// public record: who registered it, the key, and where the deployment is
// said to run, in fixed words. A registration is never changed: a new one
// for the same key retires the one before.
export const publishers = pgTable(
  "publishers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => contributors.id),
    keyId: text("key_id").notNull(),
    publicKey: text("public_key").notNull(),
    // One of HOSTING_WORDS in src/published-page/verify.ts.
    hosting: text("hosting").notNull(),
    // What the publisher says of its own interest in what it publishes, in
    // its own words; null where it said nothing.
    declaredInterest: text("declared_interest"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_publishers_live_key").on(table.keyId).where(sql`${table.retiredAt} IS NULL`),
    index("idx_publishers_account").on(table.accountId),
    check("ck_publishers_hosting", sql`${table.hosting} IN ('own_machines', 'minerval', 'third_party')`),
  ]
);

// One node's page under one showing of one publisher: what the packages
// received for it add up to. The contribution is the publisher's
// submission of it to the node, reviewed as any contribution is.
export const publishedPages = pgTable(
  "published_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The account that submitted it, and the key its packages are signed with.
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => contributors.id),
    keyId: text("key_id").notNull(),
    // The showing's id in the publisher's deployment.
    showingId: uuid("showing_id").notNull(),
    nodeId: uuid("node_id")
      .notNull()
      .references((): AnyPgColumn => claims.id),
    contributionId: uuid("contribution_id").references((): AnyPgColumn => contributions.id),
    latestSequence: integer("latest_sequence").notNull().default(0),
    firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_published_pages_showing_node").on(table.keyId, table.showingId, table.nodeId),
    index("idx_published_pages_node").on(table.nodeId),
  ]
);

// Every package received, as signed. Nothing is replaced: a later package
// is a later row.
export const publishedPagePackages = pgTable(
  "published_page_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publishedPageId: uuid("published_page_id")
      .notNull()
      .references((): AnyPgColumn => publishedPages.id),
    sequence: integer("sequence").notNull(),
    hash: text("hash").notNull(),
    // The state the package states: one of the four.
    state: text("state").notNull(),
    package: jsonb("package").notNull(),
    // What the check confirmed and could not show when the package arrived.
    checked: jsonb("checked").notNull(),
    // The package as a source, where it carries a shown page.
    sourceId: uuid("source_id").references((): AnyPgColumn => sources.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_published_page_packages_sequence").on(table.publishedPageId, table.sequence),
    uniqueIndex("uq_published_page_packages_hash").on(table.hash),
  ]
);

// ---------------------------------------------------------------------------
// Outward acts, and what comes back (docs/outward-acts.md)
//
// Showing a page (above) is one way a private graph reaches the public one.
// These tables are the rest: what the public says back about a page it was
// shown, public requests taken up, public mandates and funding from inside,
// keeping the public version of a node current, and an agent's report sent
// to Minerval's maintainers. Every act is a call to a route any account on
// the public graph could call, under the organization's own account.
// ---------------------------------------------------------------------------

// The public graph's contribution record and its requests, as the mirror's
// feed carries them (services/mirror-manifest.ts). On a graph that
// publishes a feed these are filled from `contributions` and `requests`
// just before each cut (mirror-feed-service.ts, refreshFeedRecords), with
// the public columns and no account. On a deployment that mirrors they
// hold what the feed brought. They are tables of their own, and not
// mirrored rows in `contributions` and `requests`, because those tables are
// working state: a mirrored contribution there would be picked up by this
// deployment's own review, and a mirrored request by its own Researcher.
export const feedContributions = pgTable(
  "feed_contributions",
  {
    id: uuid("id").primaryKey(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    contributionType: text("contribution_type").notNull(),
    content: text("content").notNull(),
    evidenceUrls: text("evidence_urls").array().notNull().default([]),
    aboutPublishedPageId: uuid("about_published_page_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    reviewStatus: text("review_status").notNull(),
    sensitivityLabel: sensitivityLabelColumn(),
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_feed_contributions_origin", table.origin),
    index("idx_feed_contributions_claim").on(table.claimId),
    index("idx_feed_contributions_page").on(table.aboutPublishedPageId),
  ]
);

export const feedRequests = pgTable(
  "feed_requests",
  {
    id: uuid("id").primaryKey(),
    ask: text("ask").notNull(),
    why: text("why").notNull(),
    satisfiedBy: text("satisfied_by").notNull(),
    whoCould: text("who_could"),
    addressedTo: text("addressed_to"),
    bearsOnText: text("bears_on_text"),
    state: text("state").notNull(),
    stateNote: text("state_note"),
    filedAt: timestamp("filed_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
    origin: originColumn(),
  },
  (table) => [originCheck("ck_feed_requests_origin", table.origin)]
);

export const feedRequestTargets = pgTable(
  "feed_request_targets",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => feedRequests.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sensitivityLabel: sensitivityLabelColumn(),
    origin: originColumn(),
  },
  (table) => [
    originCheck("ck_feed_request_targets_origin", table.origin),
    index("idx_feed_request_targets_request").on(table.requestId),
    index("idx_feed_request_targets_claim").on(table.claimId),
  ]
);

// Every act of this deployment on the public graph other than sending a
// package (outbound_sends has those): who did it, holding what, or the
// standing choice it went under, what was sent, and what the public graph
// answered. Rows are added and never changed. `sent` holds exactly what
// left, so that the log is also the check on what crossed. At `public`:
// each act is public on the public graph, so every member may read that it
// was made.
export const outwardActs = pgTable(
  "outward_acts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'take_up_request' | 'decline_request' | 'open_public_mandate' |
    // 'public_mandate_message' | 'fund_public_mandate' | 'back_public_mandate' |
    // 'fund_public_node' | 'keep_current' | 'send_report' | 'send_failure_facts'.
    kind: text("kind").notNull(),
    actedBy: uuid("acted_by").references((): AnyPgColumn => contributors.id),
    holding: text("holding").array().notNull().default([]),
    // The standing choice it went under, when nobody acted: its key in outward_settings.
    underStandingChoice: text("under_standing_choice"),
    // The public graph's id for what was acted on: a request, a node, a mandate, a conversation, a report.
    publicRef: text("public_ref"),
    sent: jsonb("sent").notNull().default({}),
    // 'done' | 'refused' | 'failed'.
    result: text("result").notNull(),
    publicGraphSaid: text("public_graph_said"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_outward_acts_at").on(table.at),
    check("ck_outward_acts_result", sql`${table.result} IN ('done', 'refused', 'failed')`),
    check(
      "ck_outward_acts_actor",
      sql`(${table.actedBy} IS NULL) <> (${table.underStandingChoice} IS NULL)`
    ),
  ]
);

// The deployment's standing choices about what goes out with nobody
// acting. One row per choice, the latest; each change is also a row in
// administrative_events with who made it. `told` is the text the person was
// shown about what the choice shows outside, as they were shown it.
//   keep_public_current: { on, public_mandate_id, delay_hours, batch_hours }
//   send_failure_facts:  { on }
//   send_redacted_reports: { on }
export const outwardSettings = pgTable("outward_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  told: text("told").notNull(),
  setBy: uuid("set_by").references((): AnyPgColumn => contributors.id),
  holding: text("holding").array().notNull().default([]),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  sensitivityLabel: sensitivityLabelColumn(),
});

// A contribution made on the public graph through a page this deployment
// published, as it came in with the mirror. The contribution's own text is
// in feed_contributions and is read by one run only: the Contribution
// Reviewer's, at `public`, which writes `summary` here. Work at any other
// label is given the summary and never the text. `repeats` names an
// earlier row that says the same thing: a repeat is counted once and opens
// nothing. The reassessment a contribution opens is at the label the page
// came from, so what became of it is copied here in fixed words for the
// package that tells the outside ('not_funded', 'funded', 'made').
export const inboundContributions = pgTable(
  "inbound_contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicContributionId: uuid("public_contribution_id").notNull(),
    publicPageId: uuid("public_page_id").notNull(),
    showingId: uuid("showing_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    contributionType: text("contribution_type").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // 'to_read' | 'summarized' | 'repeat' | 'set_aside'.
    state: text("state").notNull().default("to_read"),
    summary: text("summary"),
    repeats: uuid("repeats"),
    // For 'set_aside': one of a fixed list (inbound-service.ts).
    setAsideBecause: text("set_aside_because"),
    readByRun: uuid("read_by_run"),
    readAt: timestamp("read_at", { withTimezone: true }),
    actionId: uuid("action_id"),
    // What became of the reassessment it opened, for the outside.
    reassessment: text("reassessment"),
    reassessmentAt: timestamp("reassessment_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_inbound_contributions_public").on(table.publicContributionId),
    index("idx_inbound_contributions_node").on(table.showingId, table.nodeId),
    check("ck_inbound_contributions_state", sql`${table.state} IN ('to_read', 'summarized', 'repeat', 'set_aside')`),
    check(
      "ck_inbound_contributions_reassessment",
      sql`${table.reassessment} IS NULL OR ${table.reassessment} IN ('not_funded', 'funded', 'made')`
    ),
  ]
);

// A public request this deployment works on. The request itself is an
// ordinary request here (request_id), at the label of this row; this row
// links it to the public one it was adopted from. Adopting says nothing
// outside. `taken_up_at` is set when a person said in public, in the
// organization's name, that the graph is taking it up.
export const adoptedRequests = pgTable(
  "adopted_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    publicRequestId: uuid("public_request_id").notNull(),
    adoptedBy: uuid("adopted_by").references((): AnyPgColumn => contributors.id),
    adoptedAt: timestamp("adopted_at", { withTimezone: true }).notNull().defaultNow(),
    takenUpAt: timestamp("taken_up_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_adopted_requests_request").on(table.requestId),
    index("idx_adopted_requests_public").on(table.publicRequestId),
  ]
);

// Keeping the public version of a node current: one row each time a
// version of a mirrored node at another label was replaced, at that
// version's label, so that a member who does not read the label does not
// learn from this table that the node was worked on. `due_at` is when the
// public graph may be asked (the setting's delay and batching); a row that
// is not sent says why in fixed words.
export const keepCurrentQueue = pgTable(
  "keep_current_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id").notNull(),
    // The version that changed, and the private mandate whose money paid for it, where one did.
    versionAt: timestamp("version_at", { withTimezone: true }).notNull(),
    paidByGrantId: uuid("paid_by_grant_id"),
    noticedAt: timestamp("noticed_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // 'waiting' | 'sent' | 'not_sent'.
    state: text("state").notNull().default("waiting"),
    because: text("because"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_keep_current_queue_version").on(table.nodeId, table.versionAt, table.sensitivityLabel),
    index("idx_keep_current_queue_due").on(table.state, table.dueAt),
    check("ck_keep_current_queue_state", sql`${table.state} IN ('waiting', 'sent', 'not_sent')`),
  ]
);

// Where keeping the public version current is left out: for everything a
// mandate pays for (grant_id alone), or for one node under it (both), or
// for one node whoever pays (node_id alone). At the label of the mandate
// or of the person's request, since which nodes are left out says which
// are worked on.
export const keepCurrentExceptions = pgTable(
  "keep_current_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id"),
    nodeId: uuid("node_id"),
    setBy: uuid("set_by").references((): AnyPgColumn => contributors.id),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    index("idx_keep_current_exceptions").on(table.grantId, table.nodeId),
    check("ck_keep_current_exceptions_one", sql`${table.grantId} IS NOT NULL OR ${table.nodeId} IS NOT NULL`),
  ]
);

// An agent's report on its way to Minerval's maintainers: the Redactor's
// pass over the agent's words, at the report's label, and then the sending.
// `title` and `body` are the report's words as they stood when the pass
// began; `removals` are spans of them with the policy category each was
// removed under. What goes is those words with each span replaced by its
// mark, and nothing else of the report but facts in fixed vocabulary
// (report-sending-service.ts, factsOf).
export const reportSendings = pgTable(
  "report_sendings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => agentReports.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    policyId: uuid("policy_id"),
    // [{ id, field: 'title' | 'body', start, end, category, note }]
    removals: jsonb("removals").notNull().default([]),
    actionId: uuid("action_id"),
    // 'to_redact' | 'redacted' | 'sent' | 'not_sent'.
    state: text("state").notNull().default("to_redact"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    redactedByModel: text("redacted_by_model"),
    sentBy: uuid("sent_by").references((): AnyPgColumn => contributors.id),
    sentHolding: text("sent_holding").array().notNull().default([]),
    sentUnderStandingChoice: boolean("sent_under_standing_choice").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    publicReportId: uuid("public_report_id"),
    // What the maintainers' record of it said when last asked: { status, note, issue_url, asked_at }.
    cameBack: jsonb("came_back"),
    // The facts of the failure, sent on their own under the standing choice
    // or by a person: when, and how many sightings they then stated.
    factsSentAt: timestamp("facts_sent_at", { withTimezone: true }),
    factsSeen: integer("facts_seen"),
    factsPublicReportId: uuid("facts_public_report_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sensitivityLabel: sensitivityLabelColumn(),
  },
  (table) => [
    uniqueIndex("uq_report_sendings_report").on(table.reportId),
    check("ck_report_sendings_state", sql`${table.state} IN ('to_redact', 'redacted', 'sent', 'not_sent')`),
  ]
);
