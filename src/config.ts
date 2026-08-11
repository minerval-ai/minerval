import { z } from "zod";
import { MODELS } from "./llm/models.js";
import {
  isSupportedModelId,
  unresolvableModelIdMessage,
} from "./llm/providers/routing.js";

const DEFAULT_DB_URL =
  "postgresql://episteme:episteme_dev@localhost:5432/episteme";

// The default scorecard judge panel (JUDGE_MODELS). Exported so the model
// guard test (S7) covers these IDs like any other configured-reachable model.
export const DEFAULT_JUDGE_PANEL = "claude-fable-5,gpt-5.6-sol";

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
  // The two sides of the owl, kept deliberately distinct:
  //
  //   owlPriceMicroUsd — what one owl costs to BUY ($4). Used only for
  //     purchase-pack discount math and price display. The platform's whole
  //     margin lives here, and it is public.
  //   owlCostMicroUsd — what one owl of SPEND covers: one dollar of metered
  //     cost, one for one. Cost is measured in dollars, not owls: an action
  //     that costs a dollar costs a whole owl, regardless of what the owl
  //     sold for. Every ledger/charge/estimate conversion uses this.
  owlPriceMicroUsd: z.coerce.number().positive().default(4_000_000),
  owlCostMicroUsd: z.coerce.number().positive().default(1_000_000),
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
  // scale from claim importance, paid in the spendable currency). OFF at
  // launch (0 = no awards minted): accepted contributions minting
  // spendable owls is a faucet whose gaming surface (sybil contributions
  // past the reviewer) we want to observe before it pays real money. Turn
  // it on deliberately via CONTRIBUTION_AWARD_OWL_PER_POINT (e.g. 0.25
  // owl/point → $1–$5 face per acceptance); the award machinery,
  // idempotency keys, and leaderboard accounting are all live and tested,
  // so enabling is a config change, not a deploy.
  contributionAwardOwlPerPoint: z.coerce.number().default(0),
  // Per-key rate limit on agentic endpoints (requests/hour, 0 = unlimited).
  // A blunt in-memory backstop against runaway clients; the real spend
  // guardrail is the owl balance.
  agenticRateLimitPerHour: z.coerce.number().default(30),

  // Stripe (#309). Empty/placeholder secret key = payments off: owls can't
  // be purchased (free grants still work) and /billing/checkout returns 503.
  // The swap keys off the secret LOOKING like a Stripe key ("sk_…"/"rk_…") because
  // infra provisions placeholder secrets before they're populated — see
  // stripeConfigured() in src/services/billing-service.ts.
  stripeSecretKey: z.string().default(""),
  // Signing secret for the /billing/webhook endpoint ("whsec_…"), from the
  // Stripe dashboard's webhook-endpoint config. Required for purchases to be
  // credited — without it every webhook delivery is rejected.
  stripeWebhookSecret: z.string().default(""),
  // Purchase packs: "owls:cents[:name]" entries, comma-separated. Larger
  // packs price owls below the $4 face value — the bulk discount. The
  // ladder: Clutch (entry, face value), Perch (10% off), Wisdom (25% off),
  // Parliament (50% off — mandate-scale funding; a parliament of owls).
  // A malformed entry FAILS startup rather than silently dropping packs —
  // a typo'd OWL_PACKS must never quietly turn purchases off. An empty
  // string is the explicit way to sell no packs.
  owlPacks: z
    .string()
    .transform((s, ctx) => {
      const entries = s
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const packs = entries.map((entry) => {
        const [owls, cents, name] = entry.split(":");
        const pack = {
          owls: Number(owls),
          priceCents: Number(cents),
          name: name?.trim() || null,
        };
        if (
          !Number.isFinite(pack.owls) ||
          !Number.isFinite(pack.priceCents) ||
          pack.owls <= 0 ||
          pack.priceCents <= 0
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `OWL_PACKS entry "${entry}" is not owls:cents[:name] with positive numbers`,
          });
        }
        return pack;
      });
      return packs;
    })
    .default("5:2000:Clutch,25:9000:Perch,100:30000:Wisdom,500:100000:Parliament"),
  // Reputation / good-faith policy (#71)
  // Hourly cap on contributions per contributor (0 = unlimited)...
  contributionRateLimitPerHour: z.coerce.number().default(10),
  // ...tightened for low-reputation (< 50) or brand-new (< 24h) accounts to
  // blunt sybil floods. Reputation itself is governed by constants in
  // src/services/reputation-service.ts (deltas, thresholds), not env config —
  // the rules are policy, not deployment tuning.
  newContributorRateLimitPerHour: z.coerce.number().default(3),
  // Hourly cap on granting-conversation turns per user (0 = unlimited).
  // Every turn runs the Grantmaker on the best model, synchronously, and
  // deliberately free: nothing is charged until a drafted mandate is funded,
  // because charging people to be told their mandate is unfundable is the
  // wrong incentive. That leaves the turn itself with no cost ceiling of its
  // own, so it needs a rate one. 30 an hour is far above a real design
  // conversation and far below a loop.
  grantConversationRateLimitPerHour: z.coerce.number().default(30),

  // Browser extension (#72)
  // Cap on claims extracted per analyzed page — extension pages are ephemeral
  // reading surfaces, not corpus ingestion, so keep fan-out tight by default.
  extensionMaxClaims: z.coerce.number().default(25),

  // Budget limits (0 = unlimited)
  llmHourlyCallLimit: z.coerce.number().default(0),
  llmDailyCallLimit: z.coerce.number().default(0),
  llmHourlyTokenLimit: z.coerce.number().default(0),
  llmDailyTokenLimit: z.coerce.number().default(0),

  // Agent trace persistence (#334 L0): "full" records agent_runs +
  // agent_steps, "off" records nothing. Unset defaults are resolved in
  // trace-service.ts: off in production (until a retention job exists) and
  // under vitest, full everywhere else — so dev and the corpus harness trace
  // by default.
  traceLevel: z.enum(["off", "full"]).optional(),
  // Trace retention (#334 L0), the drain that lets tracing run in production.
  // Two tiers because the tables differ in kind: agent_steps are the bulk
  // (transcripts) and expire fast; agent_runs are small rows carrying the
  // attribution llm_usage.run_id joins against, so "what did this claim cost"
  // stays answerable long after the transcript is gone. 0 disables a tier —
  // which is what the corpus harness wants, since an eval run keeps
  // everything (#334 §5).
  traceStepRetentionDays: z.coerce.number().default(14),
  traceRunRetentionDays: z.coerce.number().default(90),
  // Enqueue-event telemetry (#334 L0, #217): one tiny row per enqueue through
  // the queue-service chokepoint. Unset resolves in enqueue-events-service.ts:
  // off under vitest, ON everywhere else including production — fan-out data
  // is the point.
  enqueueEvents: z.enum(["on", "off"]).optional(),
  // Queue-depth snapshot cadence (#217): hours between persisted samples of
  // the steward lane + action ledger. 0 disables.
  queueDepthSampleIntervalHours: z.coerce.number().default(6),

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

  // --- Allocation core: expected value / expected cost (background lane) ---
  // The background lane's standard is the ratio of expected marginal VALUE
  // to expected marginal COST across the candidate actions, taken highest
  // ratio first until the day's budget is spent. For assessing a claim the
  // value heuristic (priority-service.ts) is the multiplicative core the
  // essay argues for:
  //   value = importance × contested-factor × expected-quality-gain
  //         + stake boost + provenance boost
  // where contested-factor = floor + (1−floor)×contestation and the gain
  // term is the last pass's marginal_yield (1.0 when unassessed), revived
  // by staleness as evidence drifts. All knobs are legible and printable —
  // heuristics start as guesses and get revised as the eval engine grows.
  // The contested-factor floor: how fundable an uncontested claim stays.
  valueContestationFloor: z.coerce.number().default(0.25),
  // Money never enters the VALUE estimate. Reader contributions toward a
  // claim reduce its effective COST in the selection ratio, and once they
  // cover the expected cost the pass simply runs, funded (steward-pipeline).
  // Days until staleness alone fully revives a claim's expected gain.
  priorityStalenessSaturationDays: z.coerce.number().default(90),
  // User-proposed claims outrank equal-value corpus work (#284): a human
  // cared enough to type it in.
  priorityUserProvenanceBoost: z.coerce.number().default(0.15),
  // Model tiering (empty = tiering off, everything uses stewardModel).
  // When set, every assess/reassess exclusion group gets a 'strong' variant
  // row beside the standard one, and each mandate's allocator decides by
  // MARGINAL return whether the upgrade is worth funding: back the strong
  // sibling only when Δvalue/Δcost clears the day's bar. Paid express
  // orders always use the strong model — the buyer pays for the real thing.
  stewardStrongModel: z.string().default(""),
  // How much more a strong-model pass is expected to be worth than a
  // standard pass of the same claim: value(strong) = value(standard) × this.
  // A guess to be revised by the governing mandate's Grantmaker (it is a
  // policy knob, strong_gain_multiplier); the marginal-return rule does the
  // real work of deciding when the upgrade is bought. Bounded to the same
  // range POLICY_BOUNDS enforces on the agent — env config doesn't get a
  // wider lever than the mandate does.
  strongGainMultiplier: z.coerce.number().min(1).max(5).default(1.3),
  // Expected-cost priors for one Steward pass, in owls, by tier — the EC
  // denominators of the allocators' value/cost ordering. Deliberately not
  // round numbers: they are guesses at the metered average (a sonnet pass
  // vs. a fable pass), and the live rolling average replaces them once
  // enough recent runs exist (cost-estimate-service.ts).
  estStewardRunCostOwls: z.coerce.number().default(0.15),
  estStewardRunCostStrongOwls: z.coerce.number().default(0.9),
  costEstimateWindowDays: z.coerce.number().default(14),
  costEstimateMinRuns: z.coerce.number().default(5),
  // The background lane's total metered spend per UTC day, in owls
  // (0 = uncapped). This replaces "drain the queue": the highest value/cost
  // actions run until the day's budget is gone, and the rest wait.
  backgroundDailyBudgetOwls: z.coerce.number().default(50),
  // The fallback lane: direct budgeted Steward runs with NO mandate behind
  // them, capped only by the owl budget above and attributed to nobody.
  // It exists so a fresh dev database and the test suite can drain a queue
  // without seeding a General mandate, and it engages whenever
  // getGeneralMandate() returns null — which is also true of a mandate that
  // has been COMPLETED or CANCELLED, something its own review pass can now
  // decide. Left implicit, that turns "the platform's mandate closed" into
  // "spend from the config budget instead, off the ledger", which is the
  // one thing the escrow is supposed to prevent. So it is opt-in: absent
  // this flag, a deployment with no active General mandate simply rests.
  // (z.coerce.boolean() would read the STRING "false" as true, so this
  // follows enableContributions' convention instead.)
  backgroundFallbackLaneEnabled: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  // Mandate review passes (kind 'mandate_review'): a mandate's Grantmaker
  // can chain passes within a day (continue_review) when the mission needs
  // the bandwidth — enumerating a big source backlog, a territory survey.
  // This caps how many passes a day the ledger will FUND per mandate: a
  // cost bound on the mechanism, deliberately not a narrowing of the
  // agent's affordances. Each pass is also individually capped and metered.
  // 0 is a deliberate off-switch (no autonomous review passes get funded);
  // negative values are a misconfiguration, refused at startup.
  // 12 was set when review passes were funded beside the daily rate rather
  // than out of it, so the count was the only bound. Now that they compete
  // with the mandate's substantive work for the same room, a mandate that
  // spends a third of its day deliberating is choosing that at the expense
  // of assessments, and 4 is the honest ceiling on a pace nobody would set
  // deliberately. Raise it per-deployment if a mission genuinely needs the
  // bandwidth.
  mandateReviewMaxPassesPerDay: z.coerce.number().int().min(0).default(4),
  // Structural bounds on the AUTONOMOUS review pass's money movement
  // (regrant + spawn_mandate): at most this fraction of the mandate's
  // escrowed budget per pass / per UTC day. The review agent reads
  // attacker-influenceable text (web search, claims, sources) in the same
  // context as tools that move escrow; the "data, never instructions"
  // briefing is guidance, these caps are the control. The owner-driven
  // Grantmaker chat is not bound by them (a human is in the loop).
  mandateReviewMoveFractionPerPass: z.coerce.number().min(0).max(1).default(0.25),
  mandateReviewMoveFractionPerDay: z.coerce.number().min(0).max(1).default(0.5),
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
  // The Grantmaker runs the granting conversation: mandate design, cost
  // quoting, and the authority to refuse mandates that would warp the
  // graph. Always the best available model — this is judgment-heavy,
  // user-facing work where a weak model would be a false economy.
  grantmakerModel: modelId(MODELS.fable),
  // The corpus-run scorer's LLM judge (#99). Grades agent OUTPUT quality against
  // the constitution, so it should be a capable model distinct from the agent
  // under test — never let an agent grade its own trace with its own framing.
  // Default Sonnet; raise to Opus/Fable for a higher-confidence judge.
  judgeModel: modelId(MODELS.sonnet),
  // The judge PANEL for corpus scorecards: comma-separated model IDs, each of
  // which must resolve to a provider. The default pairs Fable with GPT-5.6 Sol
  // — two frontier judges from DIFFERENT vendors, so pipeline output is never
  // graded solely by the vendor family that produced it, and single-judge
  // idiosyncrasies (one model's pet flag) show up as panel disagreement
  // instead of silently becoming the metric. Empty ("") falls back to the
  // single judgeModel above, which keeps tests and cheap local scoring on
  // one Sonnet judge.
  judgeModels: z
    .string()
    .default(DEFAULT_JUDGE_PANEL)
    .transform((s) =>
      s
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    )
    .superRefine((models, ctx) => {
      for (const id of models) {
        if (!isSupportedModelId(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: unresolvableModelIdMessage(id),
          });
        }
      }
    }),
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
    contributionRateLimitPerHour: process.env.CONTRIBUTION_RATE_LIMIT_PER_HOUR,
    grantConversationRateLimitPerHour:
      process.env.GRANT_CONVERSATION_RATE_LIMIT_PER_HOUR,
    newContributorRateLimitPerHour:
      process.env.NEW_CONTRIBUTOR_RATE_LIMIT_PER_HOUR,
    llmHourlyCallLimit: process.env.LLM_HOURLY_CALL_LIMIT,
    llmDailyCallLimit: process.env.LLM_DAILY_CALL_LIMIT,
    traceLevel: process.env.TRACE_LEVEL,
    traceStepRetentionDays: process.env.TRACE_STEP_RETENTION_DAYS,
    traceRunRetentionDays: process.env.TRACE_RUN_RETENTION_DAYS,
    enqueueEvents: process.env.ENQUEUE_EVENTS,
    queueDepthSampleIntervalHours: process.env.QUEUE_DEPTH_SAMPLE_INTERVAL_HOURS,
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
    valueContestationFloor: process.env.VALUE_CONTESTATION_FLOOR,
    owlCostMicroUsd: process.env.OWL_COST_MICRO_USD,
    priorityStalenessSaturationDays:
      process.env.PRIORITY_STALENESS_SATURATION_DAYS,
    priorityUserProvenanceBoost: process.env.PRIORITY_USER_PROVENANCE_BOOST,
    stewardStrongModel: process.env.STEWARD_STRONG_MODEL,
    strongGainMultiplier: process.env.STRONG_GAIN_MULTIPLIER,
    estStewardRunCostOwls: process.env.EST_STEWARD_RUN_COST_OWLS,
    estStewardRunCostStrongOwls: process.env.EST_STEWARD_RUN_COST_STRONG_OWLS,
    costEstimateWindowDays: process.env.COST_ESTIMATE_WINDOW_DAYS,
    costEstimateMinRuns: process.env.COST_ESTIMATE_MIN_RUNS,
    backgroundDailyBudgetOwls: process.env.BACKGROUND_DAILY_BUDGET_OWLS,
    backgroundFallbackLaneEnabled: process.env.BACKGROUND_FALLBACK_LANE_ENABLED,
    mandateReviewMaxPassesPerDay: process.env.MANDATE_REVIEW_MAX_PASSES_PER_DAY,
    mandateReviewMoveFractionPerPass:
      process.env.MANDATE_REVIEW_MOVE_FRACTION_PER_PASS,
    mandateReviewMoveFractionPerDay:
      process.env.MANDATE_REVIEW_MOVE_FRACTION_PER_DAY,
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
    grantmakerModel: process.env.GRANTMAKER_MODEL,
    judgeModel: process.env.JUDGE_MODEL,
    judgeModels: process.env.JUDGE_MODELS,
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
