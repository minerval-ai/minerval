import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
  customType,
} from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

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

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------
export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    text: text("text").notNull(),
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
    childrenAssessed: integer("children_assessed").notNull().default(0),
    childrenTotal: integer("children_total").notNull().default(0),
    // How load-bearing the claim is (0..1), a revisable judgment set by the
    // Steward. Scales proportional effort and orders the Steward work queue so
    // important claims are processed first under a run budget (§"Claim Importance
    // and Proportional Effort"). 0.5 = default/medium until judged.
    importance: real("importance").notNull().default(0.5),
    // How live the dispute around the claim is (0..1), recorded separately from
    // importance (#172 phase 1). Today importance fuses consequence-if-wrong
    // with contestability; splitting the contestability half out is the first
    // step toward scheduling on stakes × expected-yield instead of one fused
    // score. Recorded by the Extractor (prior) and the Steward (authoritative)
    // but NOT yet read by the queue, the deferral brake, or effort selection —
    // phase 2/3 of #172. NULL = not yet judged, deliberately distinct from 0
    // ("judged settled").
    contestation: real("contestation"),
    // --- Steward work-queue state: the claim row IS the queue ---
    // A claim with steward_state='pending' is awaiting (re)processing by its
    // Steward; the drain always picks the highest-`importance` pending claim, so
    // under a budget the most load-bearing claims are stewarded and the rest stay
    // "embedded stubs". Re-triggers (a changed subclaim, a Curator action) just
    // set this back to 'pending', coalescing a propagation storm into one slot.
    // Lifecycle: pending → running → done | error (→ pending again on re-trigger).
    // 'deferred' is a low-importance subclaim intentionally held OUT of the drain
    // (#98 economic brake): created and embedded/matchable but not recursively
    // decomposed. A re-trigger promotes it back to 'pending'.
    stewardState: text("steward_state").notNull().default("pending"),
    stewardTrigger: text("steward_trigger"),
    stewardContext: text("steward_context"),
    stewardError: text("steward_error"),
    stewardedAt: timestamp("stewarded_at", { withTimezone: true }),
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
  },
  (table) => [
    index("idx_claims_state").on(table.state),
    index("idx_claims_updated").on(table.updatedAt),
    // Drain ordering: among pending claims, highest importance first. The partial
    // index keeps it small (only the live work queue) and fast as the graph grows.
    index("idx_claims_steward_queue")
      .on(table.importance.desc(), table.updatedAt)
      .where(sql`steward_state = 'pending'`),
    // Keyword search (`text_search @@ websearch_to_tsquery(...)`) scans this,
    // not the heap, as the graph grows.
    index("idx_claims_text_search").using("gin", table.textSearch),
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
    argumentId: uuid("argument_id").references(() => arguments_.id, {
      onDelete: "set null",
    }),
    reasoning: text("reasoning").notNull(),
    confidence: real("confidence").notNull().default(1.0),
    createdBy: text("created_by").notNull().default("decomposer"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cr_unique").on(
      table.parentClaimId,
      table.childClaimId,
      table.relationType
    ),
    index("idx_cr_parent").on(table.parentClaimId),
    index("idx_cr_child").on(table.childClaimId),
    check(
      "no_self_reference",
      sql`${table.parentClaimId} != ${table.childClaimId}`
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
    status: text("status").notNull(),
    // Verdict confidence: how sure the Steward is that `status` is the right
    // reading of the evidence. Meta by design; NOT the probability that the
    // claim is true (a claim can be confidently contested).
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
    // "claude-fable-5" — a verdict is only as trustworthy as its assessor, so
    // the assessor is recorded on the verdict, not just in llm_usage. Nullable:
    // legacy rows predate the column and degrade gracefully (date only in UI).
    model: text("model"),
    isCurrent: boolean("is_current").notNull().default(true),
    subclaimSummary: jsonb("subclaim_summary").notNull().default({}),
    trigger: text("trigger"),
    triggerContext: text("trigger_context"),
    assessedAt: timestamp("assessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_assessments_current")
      .on(table.claimId)
      .where(sql`${table.isCurrent} = true`),
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
    content: text("content").notNull(),
    evidenceUrls: text("evidence_urls").array().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_arguments_claim").on(table.claimId)]
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
    // Does the inference go through granting its premises?
    //   holds | holds_with_caveats | fails | contested
    // "contested" is for a framework whose validity is itself live-disputed
    // (the ASSUMES case, constitution §7).
    verdict: text("verdict").notNull(),
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
    isCurrent: boolean("is_current").notNull().default(true),
    createdBy: text("created_by").notNull().default("claim_steward"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_argument_evaluations_argument").on(table.argumentId),
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
  url: text("url").unique(),
  title: text("title").notNull(),
  contentHash: text("content_hash").unique(),
  rawContent: text("raw_content"),
  sourceType: text("source_type").notNull().default("unknown"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    originalText: text("original_text").notNull(),
    context: text("context"),
    summaryContext: text("summary_context"),
    // Whether this source asserts the canonical claim ("affirms") or its
    // negation/contrary ("denies"). Lets a claim and its denial share one
    // canonical node while preserving which side each source takes, so the
    // disagreement lives on the claim instead of in two mirror-image pages.
    stance: text("stance").notNull().default("affirms"),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_instances_claim").on(table.claimId),
    index("idx_instances_source").on(table.sourceId),
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
    // before multi-provider support keep their true provider.
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
    jobId: uuid("job_id"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_llm_usage_user_time").on(table.userId, table.createdAt),
    index("idx_llm_usage_key_time").on(table.apiKeyId, table.createdAt),
    index("idx_llm_usage_time").on(table.createdAt),
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
    // refund | escrow_hold | escrow_refund | admin_adjust
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
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewStatus: text("review_status").notNull().default("pending"),
    // Why the reviewer escalated (#178). Written by escalate_to_arbitrator so
    // the reason reaches the Arbitrator even when no review row was recorded;
    // the review record, when present, carries the fuller reasoning.
    escalationReason: text("escalation_reason"),
    mergeTargetClaimId: uuid("merge_target_claim_id").references(
      () => claims.id
    ),
    proposedCanonicalForm: text("proposed_canonical_form"),
    // 'propose_source' intake (#157): the stored document awaiting review. A
    // source row is inert until extraction runs — it appears in no read path
    // except through claim instances — so storing the submission verbatim
    // before review is safe.
    sourceId: uuid("source_id").references(() => sources.id),
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
  },
  (table) => [
    index("idx_contributions_claim").on(table.claimId),
    index("idx_contributions_contributor").on(table.contributorId),
    index("idx_contributions_status").on(table.reviewStatus),
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
// reconciliation_events
//
// An append-only audit log of the Curator's re-individuation surgery (§18):
// every merge and split primitive records what it changed, in enough detail to
// be reversed. `reversed` flags an event that has been undone.
// ---------------------------------------------------------------------------
export const reconciliationEvents = pgTable("reconciliation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 'merge' | 'create_claim' | 'add_edge' | 'remove_edge' | 'reassign_instance'
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
  },
  (table) => [
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
  },
  (table) => [
    index("idx_audit_findings_status").on(table.status, table.createdAt),
    index("idx_audit_findings_contributor").on(table.contributorId),
    index("idx_audit_findings_contribution").on(table.contributionId),
  ]
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
export type NewAuditFinding = typeof auditFindings.$inferInsert;
