import { z } from "zod";
import { MODELS } from "./llm/models.js";
import {
  isSupportedModelId,
  unresolvableModelIdMessage,
} from "./llm/providers/routing.js";

const DEFAULT_DB_URL =
  "postgresql://episteme:episteme_dev@localhost:5432/episteme";

// A model-ID field: defaults to an Anthropic API ID and accepts any ID that
// RESOLVES TO A KNOWN PROVIDER — "claude-…", "gpt-…"/"o3", or an OpenRouter
// "vendor/model" (see src/llm/providers/routing.ts). Bedrock-style
// "us.anthropic.*" IDs resolve to nothing and are still rejected with the
// original helpful message, because they 404 against the Anthropic API
// (issue #11).
const modelId = (defaultId: string) =>
  z
    .string()
    .superRefine((id, ctx) => {
      if (!isSupportedModelId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: unresolvableModelIdMessage(id),
        });
      }
    })
    .default(defaultId);

const configSchema = z.object({
  env: z
    .enum(["development", "staging", "production"])
    .default("development"),
  port: z.coerce.number().default(3000),
  host: z.string().default("0.0.0.0"),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Database — either a full URL or individual fields (for ECS Secrets Manager)
  databaseUrl: z.string(),
  dbHost: z.string().optional(),
  dbPort: z.coerce.number().optional(),
  dbUser: z.string().optional(),
  dbName: z.string().optional(),
  dbPassword: z.string().optional(),

  // API auth — comma-separated entries of "key" or "key:contributor_external_id".
  // Binding a key to a contributor lets contribution/appeal endpoints derive the
  // acting identity from the authenticated key instead of trusting a body field
  // (issue #10). Unbound keys still authenticate but cannot act as a contributor.
  apiKeys: z
    .string()
    .transform((s) => s.split(",").map((k) => k.trim().split(":")[0]!))
    .default(""),
  apiKeyContributors: z
    .string()
    .transform((s) => {
      const map: Record<string, string> = {};
      for (const entry of s.split(",")) {
        const sep = entry.indexOf(":");
        if (sep === -1) continue;
        const key = entry.slice(0, sep).trim();
        const contributor = entry.slice(sep + 1).trim();
        if (key && contributor) map[key] = contributor;
      }
      return map;
    })
    .default(""),

  // CORS
  corsOrigins: z.string().default(""),

  // Public web frontend base URL, used to build human-readable claim-page
  // links returned by the MCP server (#73) and to send OAuth users to the
  // consent page.
  publicWebBaseUrl: z.string().default("https://minerval.ai"),

  // This API's own public base URL — the OAuth issuer identifier and the base
  // for the endpoint URLs advertised in /.well-known metadata. Must match
  // what MCP clients dial (https://api.claimgraph.io in production).
  publicApiBaseUrl: z.string().default("http://localhost:3000"),

  // Persistent citation URL base (#290). Empty (the default) makes citations
  // carry the claim-page URL under publicWebBaseUrl. Once the w3id.org
  // namespace is registered (docs/infrastructure.md), set this to
  // "https://w3id.org/minerval/claim" so the cutover to permanent
  // identifiers is a config change, not a code change.
  citationUrlBase: z.string().default(""),

  // OpenAI — embeddings AND the OpenAI LLM provider (one key serves both).
  openaiApiKey: z.string().default(""),

  // Anthropic API
  anthropicApiKey: z.string().default(""),
  // OpenRouter — the "vendor/model" provider (src/llm/providers/openrouter.ts).
  openrouterApiKey: z.string().default(""),
  awsRegion: z.string().default("us-east-1"),

  // Accounts / owls (#70, owl economy)
  // Face value of one owl — the platform's unit of account — in micro-USD.
  // $4 ≈ one claim assessment (~$1 of frontier-model work at the same 4×
  // margin usageMarkupMultiplier applied in the metered era).
  owlPriceMicroUsd: z.coerce.number().positive().default(4_000_000),
  // Per-run CAPS for bounded agentic operations, in owls (fractions
  // allowed) — the most a run may cost, not a fixed price. Everything is
  // metered at cost-plus; the cap is charged up front, the unused fraction
  // settles back after the run, and overage past the cap is absorbed. Set
  // each cap near the operation's average cost so the figure on the button
  // is honest. See src/services/owl.ts. Open-ended work (deep
  // decomposition, grants) is budgeted, not capped per run.
  capClaimProposalOwls: z.coerce.number().default(1),
  capAssessmentOwls: z.coerce.number().default(1),
  capSourceIngestOwls: z.coerce.number().default(0.1),
  capExtensionAnalysisOwls: z.coerce.number().default(0.1),
  capExtensionChatOwls: z.coerce.number().default(0.1),
  capTextAnalysisOwls: z.coerce.number().default(0.1),
  // Free tier: a one-time signup grant (the "see a claim you care about,
  // get it assessed" hook — 5 owls = 5 free claims) plus a small monthly
  // trickle so returning users always have something. 0 disables either.
  signupGrantOwls: z.coerce.number().default(5),
  monthlyGrantOwls: z.coerce.number().default(1),
  // Owls earned per kudos point of an accepted contribution (the old 1–5
  // scale from claim importance, now paid in the spendable currency at a
  // deliberately retuned rate: 0.25 owl/point → $1–$5 face per acceptance).
  contributionAwardOwlPerPoint: z.coerce.number().default(0.25),
  // Per-key rate limit on agentic endpoints (requests/hour, 0 = unlimited).
  // A blunt in-memory backstop against runaway clients; the real spend
  // guardrail is the owl balance.
  agenticRateLimitPerHour: z.coerce.number().default(30),

  // Stripe (#309). Empty/placeholder secret key = payments off: owls can't
  // be purchased (free grants still work) and /billing/checkout returns 503.
  // The swap keys off the secret LOOKING like a Stripe key ("sk_…") because
  // infra provisions placeholder secrets before they're populated — see
  // stripeConfigured() in src/services/billing-service.ts.
  stripeSecretKey: z.string().default(""),
  // Signing secret for the /billing/webhook endpoint ("whsec_…"), from the
  // Stripe dashboard's webhook-endpoint config. Required for purchases to be
  // credited — without it every webhook delivery is rejected.
  stripeWebhookSecret: z.string().default(""),
  // Purchase packs: "owls:cents" pairs, comma-separated. Larger packs price
  // owls below the $4 face value — the bulk discount.
  owlPacks: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((entry) => entry.trim().split(":"))
        .filter((parts) => parts.length === 2)
        .map(([owls, cents]) => ({
          owls: Number(owls),
          priceCents: Number(cents),
        }))
        .filter((p) => p.owls > 0 && p.priceCents > 0)
    )
    .default("5:2000,15:5500,40:14000,125:40000"),
  // Multiplier applied to derived model cost at the metering insert
  // (usage-service). Usage rows stay internal cost observability (the bill
  // is the owl ledger), but the marked-up denomination is kept so historic
  // rows and margin math stay comparable. Raw provider cost is recoverable
  // by dividing usage rows by the multiplier in effect when they were
  // written; changing it only affects new rows.
  usageMarkupMultiplier: z.coerce.number().positive().default(4),

  // Reputation / good-faith policy (#71)
  // Hourly cap on contributions per contributor (0 = unlimited)...
  contributionRateLimitPerHour: z.coerce.number().default(10),
  // ...tightened for low-reputation (< 50) or brand-new (< 24h) accounts to
  // blunt sybil floods. Reputation itself is governed by constants in
  // src/services/reputation-service.ts (deltas, thresholds), not env config —
  // the rules are policy, not deployment tuning.
  newContributorRateLimitPerHour: z.coerce.number().default(3),

  // Browser extension (#72)
  // Cap on claims extracted per analyzed page — extension pages are ephemeral
  // reading surfaces, not corpus ingestion, so keep fan-out tight by default.
  extensionMaxClaims: z.coerce.number().default(25),

  // Budget limits (0 = unlimited)
  llmHourlyCallLimit: z.coerce.number().default(0),
  llmDailyCallLimit: z.coerce.number().default(0),
  llmHourlyTokenLimit: z.coerce.number().default(0),
  llmDailyTokenLimit: z.coerce.number().default(0),

  // SQS queues
  sqsUrlExtractionQueue: z.string().default(""),
  sqsClaimPipelineQueue: z.string().default(""),

  // Processing
  // The pipeline epoch every newly created claim is stamped with
  // (claims.pipeline_epoch). Bump the default whenever the prompts/constitution
  // change materially enough that claims minted before the change form a
  // distinct cohort (different claim bar, importance standard, or decomposition
  // behavior) — that makes "which claims predate fix X" a query instead of
  // archaeology, and lets scripts/archive-legacy-claims.ts retire a cohort
  // wholesale. NULL pipeline_epoch = legacy claims from before stamping existed.
  // Current epoch: the owl-economy allocation core (§19 amendment — composite
  // queue priority with stakes/yield/staleness as ordering inputs distinct
  // from importance, express lane for paid orders, cadence reassessment).
  pipelineEpoch: z.string().default("2026-08-owl-economy"),
  matchingTopK: z.coerce.number().default(20),
  // Quantity caps to bound graph fan-out (0 = unlimited). The dominant cost
  // driver is extraction count, since each extracted claim seeds a tree.
  extractionMaxClaims: z.coerce.number().default(0),
  // Validity floor on extracted claims (#157 phase 3). The Extractor scores
  // each proposition with a confidence that it IS a well-formed claim; below
  // this floor the extraction is dropped (and counted in the job result)
  // instead of entering the graph. Deliberately a low BACKSTOP against
  // obvious non-claims ("i am"), not a quality judgment — judging claim
  // well-formedness belongs to agents (the intake reviewer, the Steward),
  // per the constitution's "Judgment over Mechanism". 0 disables.
  extractionMinConfidence: z.coerce.number().default(0.3),
  // Importance prior for user-proposed claims admitted through intake review
  // (#157). Deliberately below the 0.5 default: an approved suggestion enters
  // the importance-ordered steward queue behind corpus work rather than ahead
  // of it, and Steward effort (including decomposition depth) scales with
  // importance, so a typed-in seed can no longer command a full contested-
  // debate subtree by default. The Steward revises it with a considered
  // judgment like any other prior.
  proposedClaimImportancePrior: z.coerce.number().default(0.3),

  // --- Allocation core: composite queue priority (the background lane) ---
  // Legible weights for the drain's ordering key (priority-service.ts):
  // priority = importance + wYield×yield + wContest×contestation
  //          + wStake×sat(stakes) + wStale×sat(staleness) + provenance boost.
  // Inputs to judgment about ORDERING — stakes/money never touch importance.
  priorityYieldWeight: z.coerce.number().default(0.3),
  priorityContestationWeight: z.coerce.number().default(0.2),
  priorityStakeWeight: z.coerce.number().default(0.5),
  // Stakes saturate at this many owls: the 6th owl on one claim buys less
  // queue position than the 1st, so wealth can't monopolize the lane.
  priorityStakeSaturationOwls: z.coerce.number().default(5),
  priorityStalenessWeight: z.coerce.number().default(0.2),
  priorityStalenessSaturationDays: z.coerce.number().default(90),
  // User-proposed claims outrank equal-priority corpus work (#284): a human
  // cared enough to type it in.
  priorityUserProvenanceBoost: z.coerce.number().default(0.15),
  // Model tiering: background claims at/above this composite priority run on
  // the strong model (empty = tiering off, everything uses stewardModel).
  // Paid express orders always use the strong model when set — the buyer is
  // paying for the real thing.
  stewardStrongModel: z.string().default(""),
  stewardStrongMinPriority: z.coerce.number().default(1.2),
  // The allocation scheduler (workers/allocation-scheduler.ts): how often to
  // refresh pending priorities and check assessed claims for staleness
  // (0 disables), and the reassessment-inflow cap per sweep — a bounded
  // producer so cadence can never cascade the queue (#295's R<1).
  allocationSweepIntervalHours: z.coerce.number().default(6),
  stalenessBaseDays: z.coerce.number().default(60),
  stalenessMaxPerSweep: z.coerce.number().default(5),
  // Grant policy 'maintain': in-scope assessments older than this many days
  // are due for a funded refresh.
  grantMaintainCadenceDays: z.coerce.number().default(30),

  // The Steward owns decomposition + assessment in one tool-use loop, so its
  // iteration cap is a pure runaway backstop, NOT a work budget — set it high.
  // The real spend guardrail is the global LLM budget tracker plus stewardMaxRuns.
  stewardMaxIterations: z.coerce.number().default(200),
  // Cap the total number of Steward invocations per process (0 = unlimited).
  // This is how we bound spend predictably for tests/deploys — far better than a
  // decomposition-depth limit. Unprocessed claims remain embedded stubs, so dedup
  // still works and the claim count can converge; importance-prioritized
  // processing is a follow-up.
  stewardMaxRuns: z.coerce.number().default(0),
  // Economic brake on decomposition depth (#98/#68). When the Steward mints a
  // NEW subclaim, we auto-enqueue a full Steward pass for it — which itself
  // decomposes with web_search. For a subclaim the Steward judged BELOW this
  // importance, we skip that enqueue and leave it an embedded stub (still
  // embedded/matchable, just not recursively decomposed). Uncontested bedrock
  // (settled math/definitions) now scores low importance, so this stops the
  // "one physics claim spawns a whole textbook" explosion at its economic root
  // without a blunt depth cap. 0.25 = the ontology's "peripheral" ceiling, so
  // only genuinely peripheral subclaims are gated; set 0 to disable.
  stewardEnqueueMinImportance: z.coerce.number().default(0.25),
  // Blast-radius backstop on a single Steward run (#157 phase 3): the maximum
  // number of NEW subclaims one run may mint (add_decomposition_edge). This is
  // a runaway guard in the constitution's "mechanism as backstop" sense — the
  // judgment about how far to decompose stays with the Steward and the
  // importance brake above; a run that hits this cap is told to link existing
  // claims or stop, and the recursion (child runs) is bounded economically by
  // stewardEnqueueMinImportance, not by this. 0 disables.
  stewardMaxNewSubclaimsPerRun: z.coerce.number().default(20),
  // Blast-radius backstop on a single Steward run (#278): the maximum number
  // of claim instances one run may record (record_claim_instance). Recording
  // instances is a cheap side effect of evidence reading the Steward does
  // anyway — this cap only stops a runaway loop from ballooning a run, it is
  // not a target. web_search is capped at 5 calls per run, so the default
  // leaves room for a couple of instances per source read. 0 disables.
  stewardMaxInstancesPerRun: z.coerce.number().default(10),
  // Elicit domain connector for the Steward (#299): scholarly search over
  // Elicit's remote MCP server. Empty key (the default) disables the
  // connector entirely — the Steward's toolset simply omits the elicit_*
  // tools. Every call costs real money beyond tokens, so this is opt-in
  // per deployment.
  elicitApiKey: z.string().default(""),
  elicitMcpUrl: z.string().default("https://elicit.com/api/mcp"),
  // Importance gate (§19): only claims at or above this importance get the
  // Elicit tools in their Steward run's toolset. Default 0.75 sits between
  // the constitution's Major (≈0.6) and Central (≈0.9) anchors — Elicit is
  // likely overkill for most claims, so only the highest-importance ones
  // are offered it. 0 offers it on every claim (when the key is set).
  stewardElicitMinImportance: z.coerce.number().default(0.75),
  // Per-run backstop on Elicit calls, mirroring web_search's max_uses: the
  // judgment about whether to call at all stays with the Steward, but one
  // run cannot burn unbounded provider spend. 0 disables the cap.
  stewardElicitMaxCallsPerRun: z.coerce.number().default(3),
  // Cap the total number of Curator invocations per process (0 = unlimited),
  // mirroring stewardMaxRuns for predictable test/deploy spend.
  curatorMaxRuns: z.coerce.number().default(0),
  // Probability (0..1) that a newly *created* top-level claim triggers a proactive
  // Curator neighborhood sweep. 0 disables the proactive path (escalation-only);
  // 1 sweeps every new claim. Still bounded by curatorMaxRuns + the LLM budget.
  curatorSweepRate: z.coerce.number().default(1),

  // Governance — model IDs. Any provider-resolvable ID works (see
  // src/llm/providers/routing.ts); the defaults below are Anthropic
  // (src/llm/models.ts).
  // The Matcher is an agentic search loop; a small model suffices since the
  // judgment is "same proposition?" over candidates it retrieves itself.
  matcherModel: modelId(MODELS.haiku),
  // The Steward assesses AND decomposes the "main" claims — the load-bearing
  // epistemic work. Default Sonnet keeps tests cheap; production sets
  // STEWARD_MODEL=claude-fable-5 so the most important claims get the deepest
  // judgment (issue #77). The importance-priority drain means Fable only ever
  // runs on the top of the queue.
  stewardModel: modelId(MODELS.sonnet),
  // The Curator adjudicates merges/splits and proposes structure — recognizing
  // duplicates saturates, but a contested split is judgment, so production runs
  // it on Fable (CURATOR_MODEL).
  curatorModel: modelId(MODELS.sonnet),
  // Shared by the Contribution Reviewer. The Audit Agent has its own knob
  // (auditModel) so it can run on Opus without also upgrading the reviewer.
  governanceModel: modelId(MODELS.sonnet),
  auditModel: modelId(MODELS.sonnet),
  // Arbitration is the highest-stakes governance call; production sets
  // ARBITRATION_MODEL=claude-fable-5.
  arbitrationModel: modelId(MODELS.sonnet),
  // The extension agent judges on-page phrasings against graph state and
  // powers the extension chat — user-facing latency-sensitive work (#72).
  extensionModel: modelId(MODELS.sonnet),
  // The corpus-run scorer's LLM judge (#99). Grades agent OUTPUT quality against
  // the constitution, so it should be a capable model distinct from the agent
  // under test — never let an agent grade its own trace with its own framing.
  // Default Sonnet; raise to Opus/Fable for a higher-confidence judge.
  judgeModel: modelId(MODELS.sonnet),
  enableContributions: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  // Audit invocation (#180). The sweep period: at most one pattern_analysis
  // sweep per this many hours (skipped when the period saw no review
  // decisions). 0 disables the scheduler entirely — event-triggered audits
  // (overturns, bad-faith flags) still run.
  auditSweepIntervalHours: z.coerce.number().default(24),
  // A suspension that has stood unexamined this many days gets a
  // contributor_review audit asking whether it should still hold.
  auditStaleSuspensionDays: z.coerce.number().default(14),

  // SQS governance queues
  sqsContributionQueue: z.string().default(""),
  sqsArbitrationQueue: z.string().default(""),
  sqsStewardQueue: z.string().default(""),
  sqsCuratorQueue: z.string().default(""),
  sqsAuditQueue: z.string().default(""),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const rawDatabaseUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

  _config = configSchema.parse({
    env: process.env.ENVIRONMENT,
    port: process.env.PORT,
    host: process.env.HOST,
    logLevel: process.env.LOG_LEVEL,
    databaseUrl: rawDatabaseUrl,
    dbHost: process.env.DB_HOST,
    dbPort: process.env.DB_PORT,
    dbUser: process.env.DB_USERNAME,
    dbName: process.env.DB_NAME,
    dbPassword: process.env.DB_PASSWORD,
    apiKeys: process.env.API_KEYS,
    apiKeyContributors: process.env.API_KEYS,
    corsOrigins: process.env.CORS_ORIGINS,
    publicWebBaseUrl: process.env.PUBLIC_WEB_BASE_URL,
    publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL,
    citationUrlBase: process.env.CITATION_URL_BASE,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    awsRegion: process.env.AWS_REGION,
    owlPriceMicroUsd: process.env.OWL_PRICE_MICRO_USD,
    capClaimProposalOwls: process.env.CAP_CLAIM_PROPOSAL_OWLS,
    capAssessmentOwls: process.env.CAP_ASSESSMENT_OWLS,
    capSourceIngestOwls: process.env.CAP_SOURCE_INGEST_OWLS,
    capExtensionAnalysisOwls: process.env.CAP_EXTENSION_ANALYSIS_OWLS,
    capExtensionChatOwls: process.env.CAP_EXTENSION_CHAT_OWLS,
    capTextAnalysisOwls: process.env.CAP_TEXT_ANALYSIS_OWLS,
    signupGrantOwls: process.env.SIGNUP_GRANT_OWLS,
    monthlyGrantOwls: process.env.MONTHLY_GRANT_OWLS,
    contributionAwardOwlPerPoint: process.env.CONTRIBUTION_AWARD_OWL_PER_POINT,
    extensionMaxClaims: process.env.EXTENSION_MAX_CLAIMS,
    agenticRateLimitPerHour: process.env.AGENTIC_RATE_LIMIT_PER_HOUR,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    owlPacks: process.env.OWL_PACKS,
    usageMarkupMultiplier: process.env.USAGE_MARKUP_MULTIPLIER,
    contributionRateLimitPerHour: process.env.CONTRIBUTION_RATE_LIMIT_PER_HOUR,
    newContributorRateLimitPerHour:
      process.env.NEW_CONTRIBUTOR_RATE_LIMIT_PER_HOUR,
    llmHourlyCallLimit: process.env.LLM_HOURLY_CALL_LIMIT,
    llmDailyCallLimit: process.env.LLM_DAILY_CALL_LIMIT,
    llmHourlyTokenLimit: process.env.LLM_HOURLY_TOKEN_LIMIT,
    llmDailyTokenLimit: process.env.LLM_DAILY_TOKEN_LIMIT,
    sqsUrlExtractionQueue: process.env.SQS_URL_EXTRACTION_QUEUE,
    sqsClaimPipelineQueue: process.env.SQS_CLAIM_PIPELINE_QUEUE,
    pipelineEpoch: process.env.PIPELINE_EPOCH,
    matchingTopK: process.env.MATCHING_TOP_K,
    extractionMaxClaims: process.env.EXTRACTION_MAX_CLAIMS,
    extractionMinConfidence: process.env.EXTRACTION_MIN_CONFIDENCE,
    proposedClaimImportancePrior:
      process.env.PROPOSED_CLAIM_IMPORTANCE_PRIOR,
    priorityYieldWeight: process.env.PRIORITY_YIELD_WEIGHT,
    priorityContestationWeight: process.env.PRIORITY_CONTESTATION_WEIGHT,
    priorityStakeWeight: process.env.PRIORITY_STAKE_WEIGHT,
    priorityStakeSaturationOwls: process.env.PRIORITY_STAKE_SATURATION_OWLS,
    priorityStalenessWeight: process.env.PRIORITY_STALENESS_WEIGHT,
    priorityStalenessSaturationDays:
      process.env.PRIORITY_STALENESS_SATURATION_DAYS,
    priorityUserProvenanceBoost: process.env.PRIORITY_USER_PROVENANCE_BOOST,
    stewardStrongModel: process.env.STEWARD_STRONG_MODEL,
    stewardStrongMinPriority: process.env.STEWARD_STRONG_MIN_PRIORITY,
    allocationSweepIntervalHours: process.env.ALLOCATION_SWEEP_INTERVAL_HOURS,
    stalenessBaseDays: process.env.STALENESS_BASE_DAYS,
    stalenessMaxPerSweep: process.env.STALENESS_MAX_PER_SWEEP,
    grantMaintainCadenceDays: process.env.GRANT_MAINTAIN_CADENCE_DAYS,
    stewardMaxIterations: process.env.STEWARD_MAX_ITERATIONS,
    stewardMaxRuns: process.env.STEWARD_MAX_RUNS,
    stewardEnqueueMinImportance: process.env.STEWARD_ENQUEUE_MIN_IMPORTANCE,
    stewardMaxNewSubclaimsPerRun:
      process.env.STEWARD_MAX_NEW_SUBCLAIMS_PER_RUN,
    stewardMaxInstancesPerRun: process.env.STEWARD_MAX_INSTANCES_PER_RUN,
    elicitApiKey: process.env.ELICIT_API_KEY,
    elicitMcpUrl: process.env.ELICIT_MCP_URL,
    stewardElicitMinImportance: process.env.STEWARD_ELICIT_MIN_IMPORTANCE,
    stewardElicitMaxCallsPerRun: process.env.STEWARD_ELICIT_MAX_CALLS_PER_RUN,
    curatorMaxRuns: process.env.CURATOR_MAX_RUNS,
    curatorSweepRate: process.env.CURATOR_SWEEP_RATE,
    matcherModel: process.env.MATCHER_MODEL,
    stewardModel: process.env.STEWARD_MODEL,
    curatorModel: process.env.CURATOR_MODEL,
    governanceModel: process.env.GOVERNANCE_MODEL,
    auditModel: process.env.AUDIT_MODEL,
    arbitrationModel: process.env.ARBITRATION_MODEL,
    extensionModel: process.env.EXTENSION_MODEL,
    judgeModel: process.env.JUDGE_MODEL,
    enableContributions: process.env.ENABLE_CONTRIBUTIONS,
    auditSweepIntervalHours: process.env.AUDIT_SWEEP_INTERVAL_HOURS,
    auditStaleSuspensionDays: process.env.AUDIT_STALE_SUSPENSION_DAYS,
    sqsContributionQueue: process.env.SQS_CONTRIBUTION_QUEUE,
    sqsArbitrationQueue: process.env.SQS_ARBITRATION_QUEUE,
    sqsStewardQueue: process.env.SQS_STEWARD_QUEUE,
    sqsCuratorQueue: process.env.SQS_CURATOR_QUEUE,
    sqsAuditQueue: process.env.SQS_AUDIT_QUEUE,
  });

  // If DATABASE_URL is the default and individual DB fields are set, construct URL
  if (_config.databaseUrl === DEFAULT_DB_URL && _config.dbHost) {
    const user = _config.dbUser ?? "episteme";
    const password = _config.dbPassword ?? "";
    const host = _config.dbHost;
    const port = _config.dbPort ?? 5432;
    const name = _config.dbName ?? "episteme";
    _config = {
      ..._config,
      databaseUrl: `postgresql://${user}:${password}@${host}:${port}/${name}`,
    };
  }

  // The constitution's "strongest model for non-saturating assessment" mandate
  // (#77) lives entirely in deploy-time env — the code defaults keep tests and
  // local dev cheap on Sonnet, so out of the box the defaults invert the
  // mandate (#100). Production must therefore say explicitly which model each
  // load-bearing agent runs (the CDK stack does; this catches a deploy that
  // regresses it). Any other environment gets a once-per-process warning so a
  // new setup — e.g. the corpus harness — doesn't run assessment on the cheap
  // tier without anyone choosing that.
  const defaultedModelEnvs = [
    "STEWARD_MODEL",
    "CURATOR_MODEL",
    "AUDIT_MODEL",
    "ARBITRATION_MODEL",
  ].filter((k) => !process.env[k]);
  if (defaultedModelEnvs.length > 0) {
    if (_config.env === "production") {
      _config = null;
      throw new Error(
        `Missing model env(s) in production: ${defaultedModelEnvs.join(", ")}. ` +
          "The load-bearing agents (Steward/Curator/Audit/Arbitration) must " +
          "run an explicitly chosen tier (issue #77) — set the env(s) rather " +
          "than silently falling back to the cheap default."
      );
    }
    if (!process.env.VITEST) {
      console.warn(
        `[config] ${defaultedModelEnvs.join(", ")} not set — the ` +
          "Steward/Curator/Audit/Arbitration agents will run on the cheap " +
          `default (${MODELS.sonnet}). Fine for local dev; set the env(s) ` +
          "(production uses claude-fable-5) if this environment does real " +
          "assessment work."
      );
    }
  }

  return _config;
}
