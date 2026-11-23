/**
 * The registry: every setting this deployment has, one row each
 * (docs/settings.md).
 *
 * A row says what the setting is called (its name in the config file and in
 * the app), the environment variable it stands for, the field of the config
 * schema that variable fills, and three facts about it:
 *
 *   where    Who may change it. "machine": whoever runs the machine, in its
 *            environment or its config file, and nobody from the app. "app":
 *            the administrators too, in the app. "app_secret": a key someone
 *            outside issued; the administrators give it in the app, where it
 *            is sealed and never read back.
 *   applies  "live": a change is in force within seconds, in every process.
 *            "restart": the value is read where the process starts (a
 *            listening port, which workers run, which routes are mounted),
 *            so a change waits for the next start.
 *   retired  For a setting nothing reads any more: the release it was
 *            retired in and what replaced it.
 *
 * A setting stays on the machine when it is one of three kinds: it is needed
 * before the database answers (the settings table is in the database), it is
 * part of the trust root (whoever could change it from the app would hold
 * the machine), or it is a fact about the machine (where a thing is, not
 * what the deployment should do).
 *
 * tests/unit/settings-registry.test.ts fails on an environment variable
 * src/config.ts reads that has no row here, so a new setting is given its
 * place when it is added.
 *
 * `applies` is stated carefully: "live" is a promise that every reader of
 * the setting reads it again, and a row is "restart" wherever one reader
 * keeps the value it first read (a scheduler's interval, a plugin's
 * options). A "restart" setting that is in fact read again is only late.
 *
 * This module imports nothing, so src/config-file.ts and src/config.ts can
 * both load it first.
 */

/**
 * What a value is in the file. The environment holds only text, so each kind
 * has one way of being written there: a number in digits, a boolean as
 * "true" or "false", a list as its items joined by commas. The two
 * structured kinds are written there as JSON: "groups" is a list of groups
 * that each hold the same few settings (a JSON list of objects), and "lists"
 * is one group whose names the deployment chooses, each with a list of text
 * (a JSON object of lists).
 */
export type SettingKind = "text" | "number" | "boolean" | "list" | "groups" | "lists";

export type SettingWhere = "machine" | "app" | "app_secret";
export type SettingApplies = "live" | "restart";

export interface Setting {
  /** The setting's name in the file and the app: its group, a dot, its name in the group. */
  key: string;
  /** The environment variable the setting stands for. */
  env: string;
  kind: SettingKind;
  /**
   * The field of the config schema (src/config.ts) the variable fills.
   * Absent on a secret the config file never carries and the app never
   * shows, and on a retired setting.
   */
  field?: string;
  /** A secret: refused in a file, never written to one, never shown. */
  secret?: true;
  /**
   * For "groups": the settings each group holds, in the order they are
   * written, from the name in the file to the name in the variable's JSON.
   */
  members?: Readonly<Record<string, string>>;
  where: SettingWhere;
  applies: SettingApplies;
  /** One sentence on what the setting decides, shown beside it in the app. */
  about: string;
  /**
   * Tuning: a setting a deployment rarely decides. It has no line in the
   * example file and no place on the first page of settings; it is changed
   * the same way as any other.
   */
  tuning?: true;
  /** Nothing reads it any more. */
  retired?: { in: string; replacedBy: string };
}

type Extra = Partial<Pick<Setting, "members" | "tuning">>;

/** A setting the administrators change in the app, in force within seconds. */
const live = (key: string, env: string, kind: SettingKind, field: string, about: string, extra: Extra = {}): Setting => ({
  key, env, kind, field, where: "app", applies: "live", about, ...extra,
});
/** A setting the administrators change in the app, in force at the next start. */
const atStart = (key: string, env: string, kind: SettingKind, field: string, about: string, extra: Extra = {}): Setting => ({
  key, env, kind, field, where: "app", applies: "restart", about, ...extra,
});
/** A setting only whoever runs the machine changes. */
const machine = (key: string, env: string, kind: SettingKind, field: string, about: string, extra: Extra = {}): Setting => ({
  key, env, kind, field, where: "machine", applies: "restart", about, ...extra,
});
/** A secret of the machine's: the trust root, or a password to something on it. */
const machineSecret = (key: string, env: string, about: string): Setting => ({
  key, env, kind: "text", secret: true, where: "machine", applies: "restart", about,
});
/** A key someone outside issued, given in the app and sealed. */
const issuedKey = (key: string, env: string, about: string): Setting => ({
  key, env, kind: "text", secret: true, where: "app_secret", applies: "live", about,
});
const model = (name: string, env: string, field: string, about: string): Setting =>
  live(`models.${name}`, env, "text", field, about);
const retired = (key: string, env: string, about: string, replacedBy: string): Setting => ({
  key, env, kind: "text", secret: true, where: "machine", applies: "restart", about,
  retired: { in: "0.2.0", replacedBy },
});

const T: Extra = { tuning: true };

/**
 * Every setting, in the order a written file lists them. The first groups
 * are the ones a deployment decides when it is set up; the tuning follows.
 */
export const SETTINGS: readonly Setting[] = [
  atStart("features.off", "FEATURES_OFF", "list", "featuresOff",
    "The optional parts of the product this deployment switches off. A part's routes and workers are set up as the process starts."),

  // Which model serves which role. The roles are the config schema's.
  model("steward", "STEWARD_MODEL", "stewardModel", "The Steward: assesses and decomposes nodes, the graph's main work."),
  model("steward_strong", "STEWARD_STRONG_MODEL", "stewardStrongModel",
    "The Steward's strong pass, and the model its money decisions run on. Empty, there is no strong pass."),
  model("curator", "CURATOR_MODEL", "curatorModel", "The Curator: merges, splits and structure."),
  model("extractor", "EXTRACTOR_MODEL", "extractorModel", "The Extractor: reads a document and states its claims in the graph's words."),
  model("extractor_fallback", "EXTRACTOR_FALLBACK_MODEL", "extractorFallbackModel",
    "Where extraction is tried again when the Extractor's model refuses a document."),
  model("matcher", "MATCHER_MODEL", "matcherModel", "The Matcher: decides whether a claim is already in the graph."),
  model("tagger", "TAGGER_MODEL", "taggerModel", "The tagger: says what each node is about."),
  model("contribution_reviewer", "GOVERNANCE_MODEL", "governanceModel", "The Contribution Reviewer."),
  model("audit", "AUDIT_MODEL", "auditModel", "The Audit Agent."),
  model("arbitration", "ARBITRATION_MODEL", "arbitrationModel", "Arbitration of an appeal: few runs, each one final."),
  model("grantmaker", "GRANTMAKER_MODEL", "grantmakerModel", "The Grantmaker: designs mandates and decides what they fund."),
  model("program_officer", "PROGRAM_OFFICER_MODEL", "programOfficerModel", "Program officers: routine decisions under a mandate's written policy."),
  model("lookout", "LOOKOUT_MODEL", "lookoutModel", "Lookouts: a mandate's standing watches."),
  model("correspondent", "CORRESPONDENT_MODEL", "correspondentModel", "Correspondents: write updates on the graph for an audience."),
  model("consistency", "CONSISTENCY_MODEL", "consistencyModel", "The Consistency Checker's standard sweep."),
  model("consistency_strong", "CONSISTENCY_STRONG_MODEL", "consistencyStrongModel", "The Consistency Checker's strong sweep."),
  model("assistant", "ASSISTANT_MODEL", "assistantModel", "The Assistant, on its strongest tier."),
  model("assistant_standard", "ASSISTANT_STANDARD_MODEL", "assistantStandardModel", "The Assistant's cheaper tier, which a person may choose for a conversation."),
  model("assistant_title", "ASSISTANT_TITLE_MODEL", "assistantTitleModel", "Names a conversation with the Assistant from its first message."),
  model("assistant_markup", "ASSISTANT_MARKUP_MODEL", "assistantMarkupModel", "The Assistant's verdicts on a page's wording, which the browser extension draws."),
  model("researcher_strong", "RESEARCHER_STRONG_MODEL", "researcherStrongModel", "The researcher's strong tier."),
  model("researcher_standard", "RESEARCHER_STANDARD_MODEL", "researcherStandardModel", "The researcher's standard tier."),
  model("researcher_cheap", "RESEARCHER_CHEAP_MODEL", "researcherCheapModel", "The researcher's cheap tier."),
  model("solver", "SOLVER_MODEL", "solverModel", "The solver: proof attempts, where mathematics is on."),
  model("judge", "JUDGE_MODEL", "judgeModel", "The judge that scores agents' output in evaluation runs."),
  // Empty for the Steward's model: the Redactor then runs on that.
  model("redactor", "REDACTOR_MODEL", "redactorModel", "The Redactor. Empty, it runs on the Steward's model."),

  live("model_providers.openrouter_provider_sort", "OPENROUTER_PROVIDER_SORT", "text", "openrouterProviderSort",
    "How OpenRouter picks among a model's hosts: by price, throughput or latency."),
  issuedKey("model_providers.anthropic_api_key", "ANTHROPIC_API_KEY", "Anthropic's key."),
  issuedKey("model_providers.openai_api_key", "OPENAI_API_KEY", "OpenAI's key, for its models and for embeddings."),
  issuedKey("model_providers.openrouter_api_key", "OPENROUTER_API_KEY", "OpenRouter's key."),
  // The deployment's own model endpoints (src/llm/providers/endpoint-config.ts).
  // Written last in its group: a [[...]] heading ends the plain settings above it.
  live("model_providers.endpoints", "MODEL_ENDPOINTS", "groups", "modelEndpoints",
    "Model servers this deployment runs itself: each one's address and what a call costs.", {
      members: {
        name: "name",
        base_url: "baseUrl",
        key_env: "keyEnv",
        input_usd_per_mtok: "inputUsdPerMtok",
        output_usd_per_mtok: "outputUsdPerMtok",
      },
    }),

  live("outside_services.elicit.use", "ELICIT_ENABLED", "boolean", "elicitEnabled", "Whether the Steward may search with Elicit."),
  live("outside_services.elicit.url", "ELICIT_MCP_URL", "text", "elicitMcpUrl", "Elicit's address."),
  live("outside_services.elicit.usd_per_call", "ELICIT_USD_PER_CALL", "number", "elicitUsdPerCall", "What one Elicit search costs, in US dollars."),
  issuedKey("outside_services.elicit.api_key", "ELICIT_API_KEY", "Elicit's key."),

  live("outside_services.pangram.use", "PANGRAM_ENABLED", "boolean", "pangramEnabled", "Whether agents may check text with Pangram."),
  live("outside_services.pangram.url", "PANGRAM_API_URL", "text", "pangramApiUrl", "Pangram's address for detecting machine-written text."),
  live("outside_services.pangram.plagiarism_url", "PANGRAM_PLAGIARISM_API_URL", "text", "pangramPlagiarismApiUrl", "Pangram's address for finding a text's original source."),
  live("outside_services.pangram.model", "PANGRAM_MODEL", "text", "pangramModel", "Which of Pangram's models reads the text."),
  live("outside_services.pangram.ai_usd_per_word", "PANGRAM_AI_USD_PER_WORD", "number", "pangramAiUsdPerWord", "What detection costs per word, in US dollars."),
  live("outside_services.pangram.plagiarism_usd_per_word", "PANGRAM_PLAGIARISM_USD_PER_WORD", "number", "pangramPlagiarismUsdPerWord", "What a source search costs per word, in US dollars."),
  live("outside_services.pangram.max_words", "PANGRAM_MAX_WORDS", "number", "pangramMaxWords", "The most words one call sends."),
  issuedKey("outside_services.pangram.api_key", "PANGRAM_API_KEY", "Pangram's key."),

  // The billing routes are mounted as the process starts.
  atStart("outside_services.payments.use", "PAYMENTS_ENABLED", "boolean", "paymentsEnabled", "Whether owls are sold through Stripe."),
  issuedKey("outside_services.payments.stripe_secret_key", "STRIPE_SECRET_KEY", "Stripe's secret key."),
  issuedKey("outside_services.payments.stripe_webhook_secret", "STRIPE_WEBHOOK_SECRET", "The secret Stripe signs its webhook deliveries with."),

  live("outside_services.github_issues.repo", "GITHUB_ISSUES_REPO", "text", "githubIssuesRepo", "The repository the agents' problem reports are filed in, as owner/repo. Empty files nothing."),
  live("outside_services.github_issues.label", "GITHUB_ISSUES_LABEL", "text", "githubIssuesLabel", "The label put on each issue filed."),
  live("outside_services.github_issues.include_external_reports", "GITHUB_ISSUES_INCLUDE_EXTERNAL", "boolean", "githubIssuesIncludeExternal",
    "Whether reports raised by outside callers over MCP are filed too."),
  live("outside_services.github_issues.api_base_url", "GITHUB_API_BASE_URL", "text", "githubApiBaseUrl", "GitHub's API address."),
  live("outside_services.github_issues.app_id", "GITHUB_APP_ID", "text", "githubAppId", "The GitHub App's id."),
  live("outside_services.github_issues.app_installation_id", "GITHUB_APP_INSTALLATION_ID", "text", "githubAppInstallationId", "The GitHub App's installation on the repository."),
  issuedKey("outside_services.github_issues.token", "GITHUB_TOKEN", "A GitHub token, where no App is used."),
  issuedKey("outside_services.github_issues.app_private_key", "GITHUB_APP_PRIVATE_KEY", "The GitHub App's private key."),

  // Which labels each model provider and outside service may be sent text at
  // (src/provider-labels.ts). A group of its own: it speaks of both. It is
  // the machine's where it is set at all: left unset, the administrators
  // choose on the labels page (services/provider-clearance-service.ts),
  // which is this design's first instance and keeps its own table.
  machine("provider_labels", "PROVIDER_LABELS", "lists", "providerLabels",
    "Fixes which labels each provider may be sent text at. Left unset, holders of clear_providers choose on the labels page."),

  // Before the first private label this is the administrators'; with one
  // defined it is the machine's (services/settings-service.ts, guards).
  atStart("run_log.mode", "RUN_LOG_MODE", "text", "runLogMode",
    "How much a run depends on its log: best_effort, or record, where a run whose log cannot be written whole fails."),
  live("run_log.level", "TRACE_LEVEL", "text", "traceLevel", "Whether runs are logged at all: full or off."),
  atStart("run_log.retention_days", "TRACE_RETENTION_DAYS", "number", "traceRetentionDays",
    "How many days the logs of runs that wrote nothing are kept. 0 keeps everything."),

  machine("hosting.environment", "ENVIRONMENT", "text", "env", "Whether this is development, staging or production."),
  atStart("hosting.web_base_url", "PUBLIC_WEB_BASE_URL", "text", "publicWebBaseUrl", "The address people reach the site at."),
  atStart("hosting.api_base_url", "PUBLIC_API_BASE_URL", "text", "publicApiBaseUrl", "The address callers reach the API at."),
  live("hosting.citation_url_base", "CITATION_URL_BASE", "text", "citationUrlBase", "The base of the permanent address a citation carries. Empty, it is the node's page."),
  atStart("hosting.cors_origins", "CORS_ORIGINS", "list", "corsOrigins", "The other sites whose pages may call the API from a browser."),
  machine("hosting.host", "HOST", "text", "host", "The address the API listens on."),
  machine("hosting.port", "PORT", "number", "port", "The port the API listens on."),
  atStart("hosting.log_level", "LOG_LEVEL", "text", "logLevel", "How much the API writes to its own log."),
  atStart("hosting.anonymous_rate_limit_per_minute", "ANONYMOUS_RATE_LIMIT_PER_MINUTE", "number", "anonymousRateLimitPerMinute",
    "Requests a minute one address may make without credentials."),
  machineSecret("hosting.api_keys", "API_KEYS", "The service keys the API accepts, the web app's among them."),
  machineSecret("hosting.operator_key", "MINERVAL_OPERATOR_KEY", "The operator key: the way back in when every administrator is gone."),

  machine("database.host", "DB_HOST", "text", "dbHost", "The database's host."),
  machine("database.port", "DB_PORT", "number", "dbPort", "The database's port."),
  machine("database.name", "DB_NAME", "text", "dbName", "The database's name."),
  machine("database.user", "DB_USERNAME", "text", "dbUser", "The role the API connects as."),
  // How the connection is secured where the database is not on RDS: "off"
  // for one on a network of the deployment's own, or the authority its
  // certificate is checked against. One of the two, never both.
  machine("database.tls", "DATABASE_TLS", "text", "databaseTls", "\"off\" where the database is reached over the deployment's own network."),
  machine("database.ca_file", "DATABASE_CA_FILE", "text", "databaseCaFile", "The authority the database's certificate is checked against."),
  machine("database.sql_host", "SQL_DB_HOST", "text", "sqlDbHost", "The replica read-only SQL runs on.", T),
  machine("database.sql_port", "SQL_DB_PORT", "number", "sqlDbPort", "The replica's port.", T),
  machine("database.sql_agent_user", "SQL_AGENT_DB_USERNAME", "text", "sqlAgentDbUser", "The role agents' read-only SQL connects as.", T),
  machine("database.sql_caller_user", "SQL_CALLER_DB_USERNAME", "text", "sqlCallerDbUser", "The role callers' read-only SQL connects as.", T),
  machineSecret("database.password", "DB_PASSWORD", "The database's password."),
  // A connection string carries its password.
  machineSecret("database.url", "DATABASE_URL", "The database's connection string."),
  machineSecret("database.sql_agent_url", "SQL_AGENT_DATABASE_URL", "The connection string of agents' read-only SQL."),
  machineSecret("database.sql_caller_url", "SQL_CALLER_DATABASE_URL", "The connection string of callers' read-only SQL."),
  machineSecret("database.sql_agent_password", "SQL_AGENT_DB_PASSWORD", "The password of agents' read-only SQL role."),
  machineSecret("database.sql_caller_password", "SQL_CALLER_DB_PASSWORD", "The password of callers' read-only SQL role."),
  machineSecret("database.cleared_role_password", "CLEARED_ROLE_PASSWORD", "The password of the role every connection held to a clearance logs in as."),

  live("pricing.owl_price_micro_usd", "OWL_PRICE_MICRO_USD", "number", "owlPriceMicroUsd", "What one owl costs to buy, in millionths of a US dollar."),
  live("pricing.owl_cost_micro_usd", "OWL_COST_MICRO_USD", "number", "owlCostMicroUsd", "What one owl of spend covers, in millionths of a US dollar of metered cost."),
  live("pricing.owl_packs", "OWL_PACKS", "list", "owlPacks", "The packs owls are sold in, each as owls:cents:name."),
  live("pricing.signup_grant_owls", "SIGNUP_GRANT_OWLS", "number", "signupGrantOwls", "Owls a new account is given once."),
  live("pricing.monthly_grant_owls", "MONTHLY_GRANT_OWLS", "number", "monthlyGrantOwls", "Owls every account is given each month."),
  live("pricing.guest_ask_owls", "GUEST_ASK_OWLS", "number", "guestAskOwls", "Owls a visitor with no account may spend talking to the Assistant."),
  live("pricing.guest_ask_daily_owls", "GUEST_ASK_DAILY_OWLS", "number", "guestAskDailyOwls", "Owls given to all guests together over a day."),
  live("pricing.guest_ask_per_address_per_day", "GUEST_ASK_PER_ADDRESS_PER_DAY", "number", "guestAskPerAddressPerDay", "Guest conversations one address may start a day."),
  live("pricing.cap_claim_proposal_owls", "CAP_CLAIM_PROPOSAL_OWLS", "number", "capClaimProposalOwls", "The most a proposed node costs its proposer."),
  live("pricing.cap_assessment_owls", "CAP_ASSESSMENT_OWLS", "number", "capAssessmentOwls", "The most an ordered assessment costs its buyer."),
  live("pricing.cap_source_ingest_owls", "CAP_SOURCE_INGEST_OWLS", "number", "capSourceIngestOwls", "The most reading a submitted source costs."),
  live("pricing.cap_extension_analysis_owls", "CAP_EXTENSION_ANALYSIS_OWLS", "number", "capExtensionAnalysisOwls", "The most the analysis of one page costs, and that run's budget."),
  live("pricing.cap_text_analysis_owls", "CAP_TEXT_ANALYSIS_OWLS", "number", "capTextAnalysisOwls", "The most the analysis of a pasted text costs."),
  // Whether owls are sold or the deployment's administrators create them.
  // The billing routes or the creating ones are mounted as the process starts.
  atStart("pricing.owls", "OWLS", "text", "owls", "Whether owls are sold, or created by this deployment's administrators."),
  // How often the public price lists are read (services/model-price-service.ts).
  atStart("pricing.model_price_refresh_hours", "MODEL_PRICE_REFRESH_HOURS", "number", "modelPriceRefreshHours",
    "How many hours apart the public lists of model prices are read. 0 never reads them."),
  // Prices the deployment states for models (src/llm/model-prices.ts).
  // Written last in its group: a [[...]] heading ends the plain settings above it.
  live("pricing.model_prices", "MODEL_PRICES", "groups", "modelPrices",
    "Prices this deployment states for models, for one the catalog does not price or in place of the catalog's.", {
      members: {
        model: "model",
        input_usd_per_mtok: "inputUsdPerMtok",
        output_usd_per_mtok: "outputUsdPerMtok",
        cache_read_multiplier: "cacheReadMultiplier",
        cache_write_multiplier: "cacheWriteMultiplier",
      },
    }),

  // Which addresses the tools of a run that reads a private label take.
  live("private_runs.fetches", "PRIVATE_RUN_FETCHES", "text", "privateRunFetches",
    "Whether a run that reads a private label may fetch any address, or only one the deployment was given."),

  // Releasing pages outside (docs/published-pages.md). The signing key is a
  // secret, and the deployment's own: it is what a reader outside trusts.
  live("publishing.hosting", "DEPLOYMENT_HOSTING", "text", "deploymentHosting", "Where this deployment runs, stated on every page it releases outside."),
  machineSecret("publishing.signing_key", "PUBLISH_SIGNING_KEY", "The key pages released outside are signed with."),

  // The public graph, as this deployment reaches it and pays toward it
  // (docs/outward-acts.md, docs/usage-report.md).
  atStart("public_graph.api_url", "PUBLIC_GRAPH_API_URL", "text", "publicGraphApiUrl", "The public graph's API address."),
  live("public_graph.acts_by", "PUBLIC_ACTS_BY", "text", "publicActsBy", "Which permission's holders may act on the public graph in the organization's name."),
  atStart("public_graph.price", "PUBLIC_GRAPH_PRICE", "text", "publicGraphPrice", "How this deployment pays toward the public graph: metered or flat."),
  machineSecret("public_graph.hosting_token", "MINERVAL_HOSTING_TOKEN", "The token Minerval's provisioning gives a deployment Minerval runs."),
  machineSecret("oidc.signing_key", "OIDC_SIGNING_KEY", "The key minerval.ai signs sign-in tokens with for organizations."),

  atStart("usage_report.url", "USAGE_REPORT_URL", "text", "usageReportUrl", "Another address usage reports are sent to, in place of the connection's."),
  // A directory on this machine.
  machine("usage_report.dir", "USAGE_REPORT_DIR", "text", "usageReportDir", "A directory usage reports are written to as files, where the network does not join."),
  live("usage_report.from", "USAGE_REPORT_FROM", "text", "usageReportFrom", "The first day reported, as YYYY-MM-DD. Empty, the first day anything was metered."),

  // Sets of files and the sandbox agents explore them in (docs/file-sets.md).
  machine("file_sets.store_dir", "FILE_SET_STORE_DIR", "text", "fileSetStoreDir", "The directory uploaded sets of files are kept in."),
  machine("file_sets.directory_root", "FILE_SET_DIRECTORY_ROOT", "text", "fileSetDirectoryRoot", "The directory that directories are registered from."),
  machine("sandbox.url", "SANDBOX_URL", "text", "sandboxUrl", "The sandbox's address on this machine's network."),
  live("sandbox.hour_cost_micro_usd", "SANDBOX_HOUR_COST_MICRO_USD", "number", "sandboxHourCostMicroUsd",
    "What an hour of a command's time in the sandbox is charged to its run, in millionths of a US dollar."),
  machineSecret("sandbox.token", "SANDBOX_TOKEN", "The token the API and the sandbox share."),

  // The key a credential given on a connection's page is sealed with, and
  // the keys that sealed credentials before it (services/connection-credential.ts).
  // Not CONNECTION_..., which a connection may name as its credential.
  machineSecret("connections.credential_key", "CREDENTIAL_ENCRYPTION_KEY", "The key credentials and keys given in the app are sealed with."),
  machineSecret("connections.previous_credential_keys", "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS", "The keys that sealed credentials before the current one."),

  // ---- Releases (docs/releases.md) ----
  atStart("releases.check", "RELEASES_CHECK", "text", "releasesCheck",
    "Whether this deployment reads the list of releases from the public graph: daily or never."),
  atStart("releases.url", "RELEASES_URL", "text", "releasesUrl", "The address the list of releases is read from."),

  // ---- Who is served. Needed before anyone can sign in. ----
  machine("accounts.reads", "READS", "text", "reads", "Whether anyone may read (open) or only signed-in members (members).", T),
  machine("accounts.first_administrator", "FIRST_ADMINISTRATOR", "text", "firstAdministrator",
    "The sign-in identity made the first administrator, for an install that is scripted.", T),
  // The web app ends a session at the same age and reads the same variable
  // from its own environment (web/auth.ts), which the app cannot change.
  machine("accounts.sign_in_valid_hours", "SIGN_IN_VALID_HOURS", "number", "signInValidHours",
    "How many hours a sign-in vouches for the groups it carried. The web app reads the same variable.", T),

  // ---- Budgets: what a run of each kind works to ----
  live("budgets.paid_assessment_owls", "PAID_ASSESSMENT_BUDGET_OWLS", "number", "paidAssessmentBudgetOwls", "The budget a paid assessment's Steward pass works to.", T),
  live("budgets.curate_run_owls", "CURATE_RUN_BUDGET_OWLS", "number", "curateRunBudgetOwls", "The budget a Curator run works to.", T),
  live("budgets.audit_run_owls", "AUDIT_RUN_BUDGET_OWLS", "number", "auditRunBudgetOwls", "The budget an Audit run works to.", T),
  live("budgets.officer_run_owls", "OFFICER_RUN_BUDGET_OWLS", "number", "officerRunBudgetOwls", "The budget of a program officer's run over a mandate's inbox.", T),
  live("budgets.default_officer_limit_owls", "DEFAULT_OFFICER_LIMIT_OWLS", "number", "defaultOfficerLimitOwls", "The most a program officer commits in one decision, unless the mandate's policy says otherwise.", T),
  live("budgets.default_review_pass_owls", "DEFAULT_REVIEW_PASS_BUDGET_OWLS", "number", "defaultReviewPassBudgetOwls", "The budget of a mandate's review pass when its policy names none.", T),
  live("budgets.review_pass_floor_owls", "REVIEW_PASS_FLOOR_OWLS", "number", "reviewPassFloorOwls", "The least a review pass is started with.", T),
  live("budgets.matcher_usd", "MATCHER_BUDGET_USD", "number", "matcherBudgetUsd", "What one Matcher decision may spend, in US dollars.", T),
  live("budgets.contribution_review_estimate_usd", "CONTRIBUTION_REVIEW_ESTIMATE_USD", "number", "contributionReviewEstimateUsd", "What a contribution's review is expected to cost, until there are reviews to average.", T),
  live("budgets.contribution_review_usd", "CONTRIBUTION_REVIEW_BUDGET_USD", "number", "contributionReviewBudgetUsd", "What one contribution review may spend, in US dollars.", T),
  live("budgets.arbitration_usd", "ARBITRATION_BUDGET_USD", "number", "arbitrationBudgetUsd", "What one arbitration may spend, in US dollars.", T),
  live("budgets.cap_lookout_run_owls", "CAP_LOOKOUT_RUN_OWLS", "number", "capLookoutRunOwls", "The most one lookout run costs.", T),
  live("budgets.cap_correspondent_run_owls", "CAP_CORRESPONDENT_RUN_OWLS", "number", "capCorrespondentRunOwls", "The most one Correspondent run costs.", T),
  live("budgets.cap_consistency_sweep_owls", "CAP_CONSISTENCY_SWEEP_OWLS", "number", "capConsistencySweepOwls", "The most one standard consistency sweep costs.", T),
  live("budgets.cap_consistency_sweep_strong_owls", "CAP_CONSISTENCY_SWEEP_STRONG_OWLS", "number", "capConsistencySweepStrongOwls", "The most one strong consistency sweep costs.", T),
  live("budgets.background_daily_owls", "BACKGROUND_DAILY_BUDGET_OWLS", "number", "backgroundDailyBudgetOwls", "The background lane's spend a day. 0 is uncapped.", T),
  live("budgets.contribution_award_owl_per_point", "CONTRIBUTION_AWARD_OWL_PER_POINT", "number", "contributionAwardOwlPerPoint", "Owls an accepted contribution earns per point. 0 awards none.", T),

  // ---- Allocation: what the ledger prices and paces with ----
  live("allocation.est_steward_run_cost_owls", "EST_STEWARD_RUN_COST_OWLS", "number", "estStewardRunCostOwls", "What a Steward pass is expected to cost, until recent runs say.", T),
  live("allocation.est_steward_run_cost_strong_owls", "EST_STEWARD_RUN_COST_STRONG_OWLS", "number", "estStewardRunCostStrongOwls", "What a strong Steward pass is expected to cost, until recent runs say.", T),
  live("allocation.cost_estimate_window_days", "COST_ESTIMATE_WINDOW_DAYS", "number", "costEstimateWindowDays", "How many days of runs a cost estimate is taken from.", T),
  live("allocation.cost_estimate_min_runs", "COST_ESTIMATE_MIN_RUNS", "number", "costEstimateMinRuns", "How many recent runs an estimate needs before it replaces the prior.", T),
  live("allocation.cost_estimate_percentile", "COST_ESTIMATE_PERCENTILE", "number", "costEstimatePercentile", "Which point of recent runs' costs the estimate takes, from 0 to 1.", T),
  live("allocation.background_fallback_lane", "BACKGROUND_FALLBACK_LANE_ENABLED", "boolean", "backgroundFallbackLaneEnabled", "Whether Steward runs go ahead with no General mandate behind them.", T),
  live("allocation.mandate_review", "MANDATE_REVIEW_ENABLED", "boolean", "mandateReviewEnabled", "Whether mandates' own review passes are funded.", T),
  live("allocation.mandate_review_move_fraction_per_pass", "MANDATE_REVIEW_MOVE_FRACTION_PER_PASS", "number", "mandateReviewMoveFractionPerPass", "The share of a mandate's escrow one review pass may move.", T),
  live("allocation.mandate_review_move_fraction_per_day", "MANDATE_REVIEW_MOVE_FRACTION_PER_DAY", "number", "mandateReviewMoveFractionPerDay", "The share of a mandate's escrow its review passes may move in a day.", T),
  live("allocation.lookout_runs", "LOOKOUT_RUNS_ENABLED", "boolean", "lookoutRunsEnabled", "Whether lookout runs are funded.", T),
  live("allocation.correspondent_runs", "CORRESPONDENT_RUNS_ENABLED", "boolean", "correspondentRunsEnabled", "Whether Correspondent runs are funded.", T),
  live("allocation.consistency_sweeps", "CONSISTENCY_SWEEPS_ENABLED", "boolean", "consistencySweepsEnabled", "Whether the General mandate funds consistency sweeps.", T),
  live("allocation.consistency_min_tag_claims", "CONSISTENCY_MIN_TAG_CLAIMS", "number", "consistencyMinTagClaims", "How many nodes a tag needs to be swept on its own.", T),
  live("allocation.officer_sittings", "OFFICER_SITTINGS_ENABLED", "boolean", "officerSittingsEnabled", "Whether program officers sit for inboxes no run is waiting on.", T),
  atStart("allocation.sweep_interval_hours", "ALLOCATION_SWEEP_INTERVAL_HOURS", "number", "allocationSweepIntervalHours", "How many hours apart priorities are refreshed and stale assessments looked for. 0 never does.", T),
  live("allocation.staleness_base_days", "STALENESS_BASE_DAYS", "number", "stalenessBaseDays", "How old an assessment is before it is due to be looked at again.", T),
  live("allocation.grant_maintain_cadence_days", "GRANT_MAINTAIN_CADENCE_DAYS", "number", "grantMaintainCadenceDays", "How old an assessment in a mandate's scope is before a funded refresh is due.", T),
  live("allocation.steward_max_iterations", "STEWARD_MAX_ITERATIONS", "number", "stewardMaxIterations", "A backstop on the turns of one Steward run.", T),
  live("allocation.steward_max_runs", "STEWARD_MAX_RUNS", "number", "stewardMaxRuns", "Steward runs one process makes before it stops. 0 is no limit.", T),
  live("allocation.curator_max_runs", "CURATOR_MAX_RUNS", "number", "curatorMaxRuns", "Curator runs one process makes on the unfunded lane. 0 is no limit.", T),
  atStart("allocation.steward_concurrency", "STEWARD_CONCURRENCY", "number", "stewardConcurrency", "How many runs one process works at once.", T),
  live("allocation.steward_enqueue_min_importance", "STEWARD_ENQUEUE_MIN_IMPORTANCE", "number", "stewardEnqueueMinImportance", "The importance below which a new subclaim is not assessed on its own.", T),
  live("allocation.proposed_claim_importance_prior", "PROPOSED_CLAIM_IMPORTANCE_PRIOR", "number", "proposedClaimImportancePrior", "The importance a proposed node starts at.", T),

  // ---- Sessions: an agent waiting on an answer ----
  live("sessions.wait_hours", "SESSION_WAIT_HOURS", "number", "sessionWaitHours", "How long a paused run waits for what it asked for.", T),
  live("sessions.max_transcript_chars", "SESSION_MAX_TRANSCRIPT_CHARS", "number", "sessionMaxTranscriptChars", "The longest transcript a paused run is resumed from.", T),
  live("sessions.wait_for_answers_seconds", "SESSION_WAIT_FOR_ANSWERS_SECONDS", "number", "sessionWaitForAnswersSeconds", "How long a run with nothing else to do holds on for an answer.", T),
  live("sessions.officer_batch_ms", "OFFICER_BATCH_MS", "number", "officerBatchMs", "How long an officer waits so petitions that arrive together are decided together.", T),

  // ---- Limits no price covers ----
  live("limits.agentic_rate_limit_per_hour", "AGENTIC_RATE_LIMIT_PER_HOUR", "number", "agenticRateLimitPerHour", "Agentic requests an hour for a service key acting for no user. 0 is no limit.", T),
  live("limits.contribution_rate_limit_per_hour", "CONTRIBUTION_RATE_LIMIT_PER_HOUR", "number", "contributionRateLimitPerHour", "Free contributions an hour for one contributor. 0 is no limit.", T),
  live("limits.new_contributor_rate_limit_per_hour", "NEW_CONTRIBUTOR_RATE_LIMIT_PER_HOUR", "number", "newContributorRateLimitPerHour", "The same, for a new or low-reputation contributor.", T),
  live("limits.grant_conversation_rate_limit_per_hour", "GRANT_CONVERSATION_RATE_LIMIT_PER_HOUR", "number", "grantConversationRateLimitPerHour", "Turns an hour of a granting conversation for one person. 0 is no limit.", T),
  live("limits.report_rate_limit_per_hour", "REPORT_RATE_LIMIT_PER_HOUR", "number", "reportRateLimitPerHour", "Problem reports an hour from one outside caller. 0 is no limit.", T),
  live("limits.llm_hourly_call_limit", "LLM_HOURLY_CALL_LIMIT", "number", "llmHourlyCallLimit", "Model calls an hour for one process. 0 is no limit.", T),
  live("limits.llm_daily_call_limit", "LLM_DAILY_CALL_LIMIT", "number", "llmDailyCallLimit", "Model calls a day for one process. 0 is no limit.", T),
  live("limits.llm_hourly_token_limit", "LLM_HOURLY_TOKEN_LIMIT", "number", "llmHourlyTokenLimit", "Model tokens an hour for one process. 0 is no limit.", T),
  live("limits.llm_daily_token_limit", "LLM_DAILY_TOKEN_LIMIT", "number", "llmDailyTokenLimit", "Model tokens a day for one process. 0 is no limit.", T),
  live("limits.extension_max_claims", "EXTENSION_MAX_CLAIMS", "number", "extensionMaxClaims", "The most claims taken from one page the browser extension analyses.", T),
  live("limits.published_page_max_bytes", "PUBLISHED_PAGE_MAX_BYTES", "number", "publishedPageMaxBytes", "The largest released page a graph admits, in bytes.", T),
  live("limits.file_set_upload_max_bytes", "FILE_SET_UPLOAD_MAX_BYTES", "number", "fileSetUploadMaxBytes", "The most bytes one uploaded set of files may hold.", T),
  atStart("limits.public_read_max_age_seconds", "PUBLIC_READ_MAX_AGE_SECONDS", "number", "publicReadMaxAgeSeconds", "How long a browser may reuse an anonymous read.", T),
  atStart("limits.public_read_stale_while_revalidate_seconds", "PUBLIC_READ_STALE_WHILE_REVALIDATE_SECONDS", "number", "publicReadStaleWhileRevalidateSeconds", "How long a stale anonymous read may be served while a fresh one is fetched.", T),
  live("limits.llm_request_timeout_ms", "LLM_REQUEST_TIMEOUT_MS", "number", "llmRequestTimeoutMs", "How long one model call may take, in milliseconds.", T),
  live("limits.llm_long_run_timeout_ms", "LLM_LONG_RUN_TIMEOUT_MS", "number", "llmLongRunTimeoutMs", "How long one call of a long-run model may take, in milliseconds.", T),
  live("limits.llm_max_retries", "LLM_MAX_RETRIES", "number", "llmMaxRetries", "How many times a failed model call is tried again.", T),

  // ---- Read-only SQL ----
  live("sql.agent_timeout_seconds", "SQL_AGENT_TIMEOUT_SECONDS", "number", "sqlAgentTimeoutSeconds", "How long an agent's query may run.", T),
  live("sql.caller_timeout_seconds", "SQL_CALLER_TIMEOUT_SECONDS", "number", "sqlCallerTimeoutSeconds", "How long a caller's query may run.", T),
  live("sql.max_plan_cost", "SQL_MAX_PLAN_COST", "number", "sqlMaxPlanCost", "The planner's estimate above which a query is refused before it runs.", T),
  live("sql.free_allowance_seconds", "SQL_FREE_ALLOWANCE_SECONDS", "number", "sqlFreeAllowanceSeconds", "A caller's free database time a day, in seconds.", T),
  live("sql.paid_allowance_seconds", "SQL_PAID_ALLOWANCE_SECONDS", "number", "sqlPaidAllowanceSeconds", "A caller's paid database time a day, in seconds.", T),
  live("sql.owls_per_second", "SQL_OWLS_PER_SECOND", "number", "sqlOwlsPerSecond", "What a second of database time costs past the free allowance.", T),

  // ---- Processing ----
  live("processing.pipeline_epoch", "PIPELINE_EPOCH", "text", "pipelineEpoch", "The cohort every new node is stamped with.", T),
  live("processing.prompt_cache_ttl", "PROMPT_CACHE_TTL", "text", "promptCacheTtl", "How long cached prompts live at the provider: 5m or 1h.", T),
  live("processing.matching_top_k", "MATCHING_TOP_K", "number", "matchingTopK", "How many near nodes a match search returns.", T),
  live("processing.extraction_max_tokens", "EXTRACTION_MAX_TOKENS", "number", "extractionMaxTokens", "The output allowance of one turn of the Extractor.", T),
  atStart("processing.tagging_interval_seconds", "TAGGING_INTERVAL_SECONDS", "number", "taggingIntervalSeconds", "How often untagged nodes are tagged. 0 switches tagging off.", T),
  live("processing.tagging_batch_size", "TAGGING_BATCH_SIZE", "number", "taggingBatchSize", "How many nodes one tagging pass takes.", T),
  live("processing.contributions", "ENABLE_CONTRIBUTIONS", "boolean", "enableContributions", "Whether contributions are taken.", T),
  atStart("processing.url_extraction_concurrency", "URL_EXTRACTION_CONCURRENCY", "number", "urlExtractionConcurrency", "How many pages one process reads at once.", T),
  atStart("processing.url_extraction_stall_minutes", "URL_EXTRACTION_STALL_MINUTES", "number", "urlExtractionStallMinutes", "How long a page's reading may go without progress before it is given up.", T),
  atStart("processing.queue_stall_minutes", "QUEUE_STALL_MINUTES", "number", "queueStallMinutes", "How long any queued work may go without progress before it is given up.", T),
  atStart("processing.queue_depth_sample_interval_hours", "QUEUE_DEPTH_SAMPLE_INTERVAL_HOURS", "number", "queueDepthSampleIntervalHours", "How many hours apart the queues' depth is recorded. 0 never records it.", T),
  live("processing.enqueue_events", "ENQUEUE_EVENTS", "text", "enqueueEvents", "Whether each enqueue is recorded: on or off.", T),
  live("processing.trace_always_agents", "TRACE_ALWAYS_AGENTS", "list", "traceAlwaysAgents", "Agents whose runs are logged whatever the log's level.", T),
  live("processing.label_posture", "LABEL_POSTURE", "text", "labelPosture", "Settings a label changes for its own runs, as JSON from a label's name to them.", T),
  atStart("processing.usage_report_interval_seconds", "USAGE_REPORT_INTERVAL_SECONDS", "number", "usageReportIntervalSeconds", "How often closed days are looked for to report.", T),

  // ---- Sweeps and schedulers ----
  atStart("sweeps.audit_interval_hours", "AUDIT_SWEEP_INTERVAL_HOURS", "number", "auditSweepIntervalHours", "How many hours apart the Audit Agent's periodic sweep runs. 0 never runs it.", T),
  live("sweeps.audit_stale_suspension_days", "AUDIT_STALE_SUSPENSION_DAYS", "number", "auditStaleSuspensionDays", "How long a suspension stands before it is reviewed again.", T),
  atStart("sweeps.monitor_interval_hours", "MONITOR_SWEEP_INTERVAL_HOURS", "number", "monitorSweepIntervalHours", "How many hours apart the monitors' hits go to the Audit Agent. 0 never sends them.", T),
  live("sweeps.monitor_reflag_days", "MONITOR_REFLAG_DAYS", "number", "monitorReflagDays", "How long before a node a monitor flagged may be flagged again.", T),
  live("sweeps.monitor_max_flags", "MONITOR_SWEEP_MAX_FLAGS", "number", "monitorSweepMaxFlags", "The most nodes one monitor sweep hands to the Audit Agent.", T),
  live("sweeps.monitor_settled_confidence", "MONITOR_SETTLED_CONFIDENCE", "number", "monitorSettledConfidence", "The confidence at which a monitor counts a verdict as settled.", T),
  live("sweeps.monitor_material_credence_delta", "MONITOR_MATERIAL_CREDENCE_DELTA", "number", "monitorMaterialCredenceDelta", "How far credence must move for a monitor to call it material.", T),
  live("sweeps.monitor_recent_challenge_days", "MONITOR_RECENT_CHALLENGE_DAYS", "number", "monitorRecentChallengeDays", "How recent an accepted challenge is for a monitor to count it as live.", T),
  live("sweeps.monitor_monotonicity_tolerance", "MONITOR_MONOTONICITY_TOLERANCE", "number", "monitorMonotonicityTolerance", "The move against new evidence a monitor puts down to noise.", T),
  live("sweeps.monitor_monotonicity_horizon_days", "MONITOR_MONOTONICITY_HORIZON_DAYS", "number", "monitorMonotonicityHorizonDays", "How long after a contribution a monitor looks for the reassessment.", T),
  atStart("sweeps.report_triage_interval_hours", "REPORT_TRIAGE_INTERVAL_HOURS", "number", "reportTriageIntervalHours", "How many hours apart problem reports are triaged. 0 never triages.", T),
  live("sweeps.report_match_similarity", "REPORT_MATCH_SIMILARITY", "number", "reportMatchSimilarity", "How alike two problem reports are before one is shown as related to the other.", T),
  atStart("sweeps.report_embedding_backfill_per_tick", "REPORT_EMBEDDING_BACKFILL_PER_TICK", "number", "reportEmbeddingBackfillPerTick", "Reports given an embedding in one pass. 0 switches the pass off.", T),
  atStart("sweeps.report_embedding_backfill_interval_seconds", "REPORT_EMBEDDING_BACKFILL_INTERVAL_SECONDS", "number", "reportEmbeddingBackfillIntervalSeconds", "How often that pass runs.", T),
  atStart("sweeps.source_backfill_per_tick", "SOURCE_BACKFILL_PER_TICK", "number", "sourceBackfillPerTick", "Sources whose facts are filled in one pass. 0 switches the pass off.", T),
  atStart("sweeps.source_backfill_interval_seconds", "SOURCE_BACKFILL_INTERVAL_SECONDS", "number", "sourceBackfillIntervalSeconds", "How often that pass runs.", T),
  atStart("sweeps.github_issues_backfill_per_tick", "GITHUB_ISSUES_BACKFILL_PER_TICK", "number", "githubIssuesBackfillPerTick", "Reports filed as issues in one pass. 0 switches the pass off.", T),
  atStart("sweeps.github_issues_sync_interval_seconds", "GITHUB_ISSUES_SYNC_INTERVAL_SECONDS", "number", "githubIssuesSyncIntervalSeconds", "How often that pass runs.", T),
  atStart("sweeps.lookout_retraction_poll_hours", "LOOKOUT_RETRACTION_POLL_HOURS", "number", "lookoutRetractionPollHours", "How many hours apart retractions are looked for. 0 never looks.", T),
  live("sweeps.lookout_feed_poll_max_feeds", "LOOKOUT_FEED_POLL_MAX_FEEDS", "number", "lookoutFeedPollMaxFeeds", "How many feeds one pass polls. 0 polls none.", T),

  // ---- The researcher ----
  live("researcher.enabled", "RESEARCHER_ENABLED", "boolean", "researcherEnabled", "Whether new research runs may be launched.", T),
  live("researcher.daily_cap_owls", "RESEARCHER_DAILY_CAP_OWLS", "number", "researcherDailyCapOwls", "The most researcher runs that no funder pays for spend in a day.", T),
  live("researcher.request_max_wall_minutes", "RESEARCHER_REQUEST_MAX_WALL_MINUTES", "number", "researcherRequestMaxWallMinutes", "A backstop on how long one research run may go on.", T),

  // ---- Mathematics (docs/mathematics.md) ----
  machine("mathematics.lean_checker_url", "LEAN_CHECKER_URL", "text", "leanCheckerUrl", "The Lean checker's address on this machine's network.", T),
  machineSecret("mathematics.lean_checker_token", "LEAN_CHECKER_TOKEN", "The token the API and the Lean checker share."),
  live("mathematics.lean_cpu_hour_cost_micro_usd", "LEAN_CPU_HOUR_COST_MICRO_USD", "number", "leanCpuHourCostMicroUsd", "What an hour of the checker's processor is charged at, in millionths of a US dollar.", T),
  live("mathematics.lean_check_overhead_micro_usd", "LEAN_CHECK_OVERHEAD_MICRO_USD", "number", "leanCheckOverheadMicroUsd", "What every check is charged besides its time, in millionths of a US dollar.", T),
  live("mathematics.formalization_review_period_days", "FORMALIZATION_REVIEW_PERIOD_DAYS", "number", "formalizationReviewPeriodDays", "How long a published statement is public before a bounty may bind to it.", T),
  live("mathematics.formalization_review_award_owls", "FORMALIZATION_REVIEW_AWARD_OWLS", "number", "formalizationReviewAwardOwls", "What a challenge to a statement upheld in that time earns.", T),
  // The solver is a process of its own, which reads this as it starts.
  atStart("mathematics.solver_enabled", "SOLVER_ENABLED", "boolean", "solverEnabled", "Whether the solver takes proof attempts.", T),
  live("mathematics.solver_daily_cap_owls", "SOLVER_DAILY_CAP_OWLS", "number", "solverDailyCapOwls", "The most the solver spends in a day.", T),
  live("mathematics.solver_calibration_daily_cap_owls", "SOLVER_CALIBRATION_DAILY_CAP_OWLS", "number", "solverCalibrationDailyCapOwls", "The most the solver's calibration runs spend in a day.", T),
  live("mathematics.attempt_overage_fraction", "ATTEMPT_OVERAGE_FRACTION", "number", "attemptOverageFraction", "How far past its estimate a proof attempt may spend, as a share of the estimate.", T),
  live("mathematics.max_bounty_per_claim_owls", "MAX_BOUNTY_PER_CLAIM_OWLS", "number", "maxBountyPerClaimOwls", "The largest bounty on one statement.", T),
  live("mathematics.min_bounty_per_claim_owls", "MIN_BOUNTY_PER_CLAIM_OWLS", "number", "minBountyPerClaimOwls", "The smallest bounty on one statement.", T),
  live("mathematics.bounty_escrow_fraction_per_pass", "BOUNTY_ESCROW_FRACTION_PER_PASS", "number", "bountyEscrowFractionPerPass", "The share of a mandate's escrow one review pass may commit to bounties.", T),
  live("mathematics.bounty_escrow_fraction_per_day", "BOUNTY_ESCROW_FRACTION_PER_DAY", "number", "bountyEscrowFractionPerDay", "The share of a mandate's escrow committed to bounties in a day.", T),
  live("mathematics.bounty_autonomy_threshold_owls", "BOUNTY_AUTONOMY_THRESHOLD_OWLS", "number", "bountyAutonomyThresholdOwls", "The bounty at or above which a person must confirm the posting.", T),
  live("mathematics.bounty_notice_days", "BOUNTY_NOTICE_DAYS", "number", "bountyNoticeDays", "The public notice a bounty's withdrawal is given.", T),
  live("mathematics.bounty_default_expiry_days", "BOUNTY_DEFAULT_EXPIRY_DAYS", "number", "bountyDefaultExpiryDays", "How long a bounty stands unless it is renewed.", T),
  live("mathematics.prize_human_signoff_owls", "PRIZE_HUMAN_SIGNOFF_OWLS", "number", "prizeHumanSignoffOwls", "The bounty at or above which a prize needs a person's sign-off.", T),
  live("mathematics.prize_human_signoff_importance", "PRIZE_HUMAN_SIGNOFF_IMPORTANCE", "number", "prizeHumanSignoffImportance", "The importance at or above which a prize needs a person's sign-off.", T),
  live("mathematics.prize_challenge_window_days_small", "PRIZE_CHALLENGE_WINDOW_DAYS_SMALL", "number", "prizeChallengeWindowDaysSmall", "The days between a small prize's acceptance and its payment. Never under 14.", T),
  live("mathematics.prize_challenge_window_days_large", "PRIZE_CHALLENGE_WINDOW_DAYS_LARGE", "number", "prizeChallengeWindowDaysLarge", "The same, for a large prize.", T),
  live("mathematics.prize_window_tier_owls", "PRIZE_WINDOW_TIER_OWLS", "number", "prizeWindowTierOwls", "The bounty at or above which a prize is a large one.", T),
  live("mathematics.prize_payee_steps_days", "PRIZE_PAYEE_STEPS_DAYS", "number", "prizePayeeStepsDays", "How long a winner has to complete their steps before the prize is forfeit.", T),
  live("mathematics.prize_review_reserve_fraction", "PRIZE_REVIEW_RESERVE_FRACTION", "number", "prizeReviewReserveFraction", "The share of a bounty held back to pay for reviewing claims on it.", T),
  live("mathematics.prize_defect_award_fraction", "PRIZE_DEFECT_AWARD_FRACTION", "number", "prizeDefectAwardFraction", "The share of a bounty a claimant earns for exposing a defect in the statement.", T),
  live("mathematics.prize_defect_award_cap_owls", "PRIZE_DEFECT_AWARD_CAP_OWLS", "number", "prizeDefectAwardCapOwls", "The most such an award pays.", T),
  live("mathematics.prize_owl_tranche_owls", "PRIZE_OWL_TRANCHE_OWLS", "number", "prizeOwlTrancheOwls", "The most owls of a prize granted in one day.", T),
  live("mathematics.prize_check_max_concurrent", "PRIZE_CHECK_MAX_CONCURRENT", "number", "prizeCheckMaxConcurrent", "How many prize claims are checked at once.", T),
  live("mathematics.prize_checks_per_day", "PRIZE_CHECKS_PER_DAY", "number", "prizeChecksPerDay", "How many prize claims are checked in a day.", T),
  live("mathematics.prize_check_reclaim_minutes", "PRIZE_CHECK_RECLAIM_MINUTES", "number", "prizeCheckReclaimMinutes", "How long before a check whose worker died is taken up again.", T),
  live("mathematics.prize_check_max_attempts", "PRIZE_CHECK_MAX_ATTEMPTS", "number", "prizeCheckMaxAttempts", "How many times a check that failed on the checker's side is tried.", T),
  live("mathematics.prize_claims_per_statement_per_30_days", "PRIZE_CLAIMS_PER_STATEMENT_PER_30_DAYS", "number", "prizeClaimsPerStatementPer30Days", "Prize claims one statement takes in 30 days.", T),
  live("mathematics.prize_claims_per_day_platform", "PRIZE_CLAIMS_PER_DAY_PLATFORM", "number", "prizeClaimsPerDayPlatform", "Prize claims taken in a day across the deployment.", T),
  live("mathematics.mandate_escrow_owls", "MATH_MANDATE_ESCROW_OWLS", "number", "mathMandateEscrowOwls", "The Mathematics mandate's escrow when it is seeded.", T),
  live("mathematics.mandate_daily_owls", "MATH_MANDATE_DAILY_OWLS", "number", "mathMandateDailyOwls", "The Mathematics mandate's pace a day when it is seeded.", T),
  live("mathematics.prizes_escrow_owls", "MATH_PRIZES_ESCROW_OWLS", "number", "mathPrizesEscrowOwls", "The prizes mandate's escrow when it is seeded.", T),

  // ---- The mirror feed (docs/mirror.md). Its workers start with the process. ----
  atStart("mirror.publish", "MIRROR_PUBLISH", "boolean", "mirrorPublish", "Whether this deployment publishes a signed feed of its public rows.", T),
  // Which process cuts the feed is how the machine is arranged.
  machine("mirror.publisher_worker", "MIRROR_PUBLISHER_WORKER", "boolean", "mirrorPublisherWorker", "Whether the feed is cut in a process of its own.", T),
  atStart("mirror.publish_interval_seconds", "MIRROR_PUBLISH_INTERVAL_SECONDS", "number", "mirrorPublishIntervalSeconds", "How often the feed is cut.", T),
  atStart("mirror.batch_max_bytes", "MIRROR_BATCH_MAX_BYTES", "number", "mirrorBatchMaxBytes", "The most bytes of rows one batch of the feed holds.", T),
  atStart("mirror.feed_url", "MIRROR_FEED_URL", "text", "mirrorFeedUrl", "The publisher's address this deployment's mirror is fed from.", T),
  machine("mirror.feed_dir", "MIRROR_FEED_DIR", "text", "mirrorFeedDir", "A directory of batch files the mirror is fed from, where the network does not reach.", T),
  atStart("mirror.feed_public_keys", "MIRROR_FEED_PUBLIC_KEYS", "list", "mirrorFeedPublicKeys", "The keys a batch of the feed must be signed with to be applied.", T),
  atStart("mirror.feed_next_public_keys", "MIRROR_FEED_NEXT_PUBLIC_KEYS", "list", "mirrorFeedNextPublicKeys", "The keys this deployment's feed will sign with next.", T),
  atStart("mirror.apply_interval_seconds", "MIRROR_APPLY_INTERVAL_SECONDS", "number", "mirrorApplyIntervalSeconds", "How often the mirror is brought up to its feed.", T),
  machineSecret("mirror.signing_key", "MIRROR_SIGNING_KEY", "The key this deployment's feed is signed with."),

  // ---- Where the queues are, and what was built ----
  machine("queues.url_extraction", "SQS_URL_EXTRACTION_QUEUE", "text", "sqsUrlExtractionQueue", "The queue of pages to read.", T),
  machine("queues.claim_pipeline", "SQS_CLAIM_PIPELINE_QUEUE", "text", "sqsClaimPipelineQueue", "The queue of claims to place.", T),
  machine("queues.contribution", "SQS_CONTRIBUTION_QUEUE", "text", "sqsContributionQueue", "The queue of contributions to review.", T),
  machine("queues.arbitration", "SQS_ARBITRATION_QUEUE", "text", "sqsArbitrationQueue", "The queue of appeals to arbitrate.", T),
  machine("queues.steward", "SQS_STEWARD_QUEUE", "text", "sqsStewardQueue", "The Steward's queue.", T),
  machine("queues.aws_region", "AWS_REGION", "text", "awsRegion", "The region the queues are in.", T),
  machine("build.commit", "MINERVAL_COMMIT", "text", "gitSha", "The commit the running code was built from. Set when the image is built.", T),
  machine("build.version", "MINERVAL_VERSION", "text", "version", "The version the running code was built as. Set when the image is built.", T),

  // ---- Retired: read by nothing, named so that a file that still sets one is told ----
  retired("retired.public_graph_api_key", "PUBLIC_GRAPH_API_KEY", "The key a deployment reached the public graph with.", "the connection to minerval.ai, made on the Overview"),
  retired("retired.mirror_feed_api_key", "MIRROR_FEED_API_KEY", "The key a deployment read the mirror feed with.", "the connection to minerval.ai, made on the Overview"),
  retired("retired.usage_report_api_key", "USAGE_REPORT_API_KEY", "The key a deployment sent usage reports with.", "the connection to minerval.ai, made on the Overview"),
];

/**
 * Environment variables a deployment may set that are not settings of the
 * API: another part reads each. The `unknown_settings` check does not name
 * them as mistakes.
 */
export const OTHER_VARIABLES: Readonly<Record<string, string>> = {
  MINERVAL_CONFIG: "names the config file",
  AUTH_SECRET: "the web app's session secret",
  WEB_API_KEY: "the web app's key to the API",
  AUTH_TRUST_HOST: "the web app's",
  NEXT_PUBLIC_API_URL: "the web app's",
  API_URL: "the web app's",
  PUBLIC_API_URL: "the web app's",
  GIT_SHA: "the older name of MINERVAL_COMMIT, still read",
  PGOPTIONS: "the database client's",
  LLM_LOG_CACHE: "a developer's switch on the providers' cache logging",
};

/** Prefixes of variables other parts read, any number of them: the web app's sign-in client, a connection's credential. */
export const OTHER_VARIABLE_PREFIXES: readonly string[] = ["AUTH_", "NEXT_PUBLIC_", "CONNECTION_", "POSTGRES_", "NEXTAUTH_"];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const BY_ENV = new Map(SETTINGS.map((s) => [s.env, s]));

export const settingByKey = (key: string): Setting | undefined => BY_KEY.get(key);
export const settingByEnv = (env: string): Setting | undefined => BY_ENV.get(env);

/** A setting by its name in the file or by its environment variable, as a person may give either. */
export function findSetting(name: string): Setting | undefined {
  return BY_KEY.get(name) ?? BY_ENV.get(name) ?? BY_ENV.get(name.toUpperCase());
}

/** The group a setting is in; "" for a setting that is a group of its own at the top of the file. */
export function settingGroup(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot < 0 ? "" : key.slice(0, dot);
}

/** How many single-character edits turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/**
 * The first words of the settings' variables that mark a variable as one of
 * this product's (STEWARD_, OWL_, MIRROR_ ...). Words other software names
 * its own variables with are left out, so that the machine's AWS or GitHub
 * variables are never read as misspelt settings.
 */
const SHARED_PREFIXES = new Set(["AWS", "GITHUB", "DATABASE", "DB", "HOST", "PORT", "ENVIRONMENT", "GIT", "PUBLIC", "API", "OPENAI", "ANTHROPIC", "OPENROUTER", "STRIPE", "LOG", "SQL", "ENABLE", "MAX", "MIN", "READS", "FIRST", "SIGN", "FILE"]);
export const SETTING_PREFIXES: readonly string[] = [
  ...new Set(
    SETTINGS.map((s) => s.env.split("_")[0]!)
      .filter((word) => !SHARED_PREFIXES.has(word))
      .map((word) => `${word}_`)
  ),
];

export interface UnknownVariable {
  env: string;
  /** The setting it is nearest to, when one is near. */
  nearest: string | null;
}

export interface RetiredVariable {
  env: string;
  retiredIn: string;
  replacedBy: string;
}

/**
 * The variables in an environment that look like settings and are none, and
 * the ones that were settings and are read by nothing now.
 */
export function strayVariables(env: Readonly<Record<string, string | undefined>>): {
  unknown: UnknownVariable[];
  retired: RetiredVariable[];
} {
  const unknown: UnknownVariable[] = [];
  const retiredSet: RetiredVariable[] = [];
  for (const name of Object.keys(env).sort()) {
    if ((env[name] ?? "").trim() === "") continue;
    const row = BY_ENV.get(name);
    if (row?.retired) {
      retiredSet.push({ env: name, retiredIn: row.retired.in, replacedBy: row.retired.replacedBy });
      continue;
    }
    if (row || name in OTHER_VARIABLES || OTHER_VARIABLE_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    const near = SETTINGS.filter((s) => !s.retired)
      .map((s) => ({ env: s.env, distance: editDistance(name, s.env) }))
      // A short name is near too many things: HOME is two edits from HOST.
      .filter((c) => c.distance <= (name.length >= 8 ? 2 : name.length >= 5 ? 1 : 0))
      .sort((a, b) => a.distance - b.distance)[0];
    if (near || SETTING_PREFIXES.some((p) => name.startsWith(p))) unknown.push({ env: name, nearest: near?.env ?? null });
  }
  return { unknown, retired: retiredSet };
}
