# Deploying Minerval: the config file and the preflight

This page is for whoever installs Minerval on their own machines. It covers
two things: the one file that holds a deployment's settings, and the check
that says whether a deployment is ready to run. Packaging (the container
image and a compose file for the whole system) is separate work and is not
described here; public Minerval's own hosting is in
[infrastructure.md](infrastructure.md).

There are no named profiles. Setup never asks what kind of organization a
deployment is for, and nothing arrives shaped for one. A deployment starts
from public Minerval's own settings and changes the ones it needs to, one at
a time. A private deployment is the same code and the same agents as the
public graph.

## The config file

A deployment's settings live in one file. It is
[TOML](https://toml.io): groups in square brackets, `name = value` lines
under each, and `#` for comments.

```toml
[features]
off = ["extension"]

[run_log]
mode = "record"
retention_days = 30

[outside_services.elicit]
use = false
```

Two settings are structured, and are written as TOML's own structures: the
model endpoints a deployment runs itself are one `[[model_providers.endpoints]]`
group each, and the labels each provider is cleared for are the lines of
`[provider_labels]`. Both are described under their groups below.

[`deploy/minerval.example.toml`](../deploy/minerval.example.toml) is public
Minerval's own settings, written out, with a comment on each group. Copy it
and change what you need.

**Where it is.** Name the file in the environment variable
`MINERVAL_CONFIG`. If that is not set and there is a `minerval.toml` in the
directory the server starts in, that file is read. If neither is there,
there is no config file, and everything works as it did before the file
existed: settings come from environment variables and their defaults.

**What it overrides, and what overrides it.** A setting in the file replaces
that setting's default. An environment variable for the same setting
overrides the file, including one set to nothing, and a `.env` file beside
the server counts as the environment. So an
operator can still change one setting for one process without editing the
file, and the settings that must not be in a file have somewhere to go. The
preflight says which settings the environment is overriding.

**Secrets are never in the file.** Keys, tokens and passwords are set as
environment variables, and a file that holds one is refused, with the name
of the variable to use. The secrets are:

| Environment variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | The model providers' keys. The OpenAI key also makes the embeddings. |
| `DB_PASSWORD`, or `DATABASE_URL` whole | The database password. A connection string carries one, so it is a secret too. |
| `SQL_AGENT_DB_PASSWORD`, `SQL_CALLER_DB_PASSWORD`, `SQL_AGENT_DATABASE_URL`, `SQL_CALLER_DATABASE_URL` | The two read-only database roles that SQL queries run as. |
| `API_KEYS` | The service keys the web app and first-party tools present. |
| `MINERVAL_OPERATOR_KEY` | The operator's key ([accounts.md](accounts.md), "The operator key"). |
| `ELICIT_API_KEY`, `PANGRAM_API_KEY` | The two paid research services. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments. |
| `GITHUB_APP_PRIVATE_KEY`, `GITHUB_TOKEN` | The credential for filing reports as GitHub issues. |
| `PUBLISH_SIGNING_KEY` | The Ed25519 private key, in PEM form, that signs packages of pages shown outside ([published-pages.md](published-pages.md)). |
| `PUBLIC_GRAPH_API_KEY` | The organization's own account key on the public graph, for everything the deployment sends or does there ([outward-acts.md](outward-acts.md)). |
| `USAGE_REPORT_API_KEY` | The key usage reports are sent to the public graph with ([usage-report.md](usage-report.md)). |
| `SANDBOX_TOKEN` | The secret the API and the sandbox service share ([file-sets.md](file-sets.md)). |
| `CONNECTION_...` | Each connection's credential, in a variable the connection names ([connections.md](connections.md)). There may be any number, so a file is refused for any name that begins this way. |

**A file that cannot be used stops the server**, and says everything that is
wrong with it at once: a group or setting it does not have (with the nearest
name that exists), a value of the wrong kind (text where a number belongs),
a value the setting does not accept, a secret. For example:

```
The config file /etc/minerval/minerval.toml cannot be used, for 2 reasons:
  - run_log.modes is not a setting. Did you mean run_log.mode? [run_log] holds: mode, level, retention_days.
  - hosting.port must be a number (for example 30), but the file has the text "3000".
```

### The settings

Every setting below has an environment variable of its own, given in the
last column. The file's name for it is the group and the name joined by a
dot (`run_log.mode`).

#### `[features]`

| Name | What it sets | Environment variable |
|---|---|---|
| `off` | A list of the optional parts of the product to switch off: `"extension"`, `"mathematics"`, `"prizes"`. Everything not named is on ([architecture.md](architecture.md), "Features"). | `FEATURES_OFF` |

#### `[models]`

Which model serves each role. An id starting `claude-` is served by
Anthropic, one starting `gpt-` by OpenAI, and a `vendor/model` id by
OpenRouter; the provider's key must be in the environment. An id of the form
`endpoint:<name>/<model>` is served by a model endpoint the deployment
declares under `[[model_providers.endpoints]]`, below.

| Name | The role | Environment variable |
|---|---|---|
| `steward` | The Steward's standard pass: assessing and decomposing claims. | `STEWARD_MODEL` |
| `steward_strong` | The Steward's strong pass and paid orders. `""` runs every pass on `steward`. | `STEWARD_STRONG_MODEL` |
| `curator` | The Curator: merges, splits and structure. | `CURATOR_MODEL` |
| `extractor` | The Extractor: the claims a document makes, in canonical wording. | `EXTRACTOR_MODEL` |
| `extractor_fallback` | Where extraction retries when `extractor` refuses a document. | `EXTRACTOR_FALLBACK_MODEL` |
| `matcher` | The Matcher: whether a statement is a claim the graph already holds. | `MATCHER_MODEL` |
| `tagger` | The tagger: what a claim is about. | `TAGGER_MODEL` |
| `contribution_reviewer` | The Contribution Reviewer. | `GOVERNANCE_MODEL` |
| `audit` | The Audit Agent. | `AUDIT_MODEL` |
| `arbitration` | The Dispute Arbitrator. | `ARBITRATION_MODEL` |
| `grantmaker` | The Grantmaker, in conversation and in its review passes. | `GRANTMAKER_MODEL` |
| `program_officer` | Program officers: routine decisions on a mandate's inbox. | `PROGRAM_OFFICER_MODEL` |
| `lookout` | Lookouts: standing watches a mandate funds. | `LOOKOUT_MODEL` |
| `correspondent` | Correspondents: updates written for an audience. | `CORRESPONDENT_MODEL` |
| `consistency`, `consistency_strong` | The Consistency Checker's standard and strong sweeps. | `CONSISTENCY_MODEL`, `CONSISTENCY_STRONG_MODEL` |
| `assistant`, `assistant_standard`, `assistant_title` | The Assistant, its cheaper choice, and the small model that names a conversation. | `ASSISTANT_MODEL`, `ASSISTANT_STANDARD_MODEL`, `ASSISTANT_TITLE_MODEL` |
| `extension` | The browser extension's agent. | `EXTENSION_MODEL` |
| `researcher_strong`, `researcher_standard`, `researcher_cheap` | The researcher's three tiers. | `RESEARCHER_STRONG_MODEL`, `RESEARCHER_STANDARD_MODEL`, `RESEARCHER_CHEAP_MODEL` |
| `solver` | The solver's proof attempts. | `SOLVER_MODEL` |
| `judge` | The judge that grades evaluation runs. | `JUDGE_MODEL` |
| `redactor` | The Redactor, where a page is shown to readers who do not read its label. `""` runs it on `steward`. | `REDACTOR_MODEL` |

#### `[model_providers]`

| Name | What it sets | Environment variable |
|---|---|---|
| `openrouter_provider_sort` | How OpenRouter picks among a model's hosts: `"price"`, `"throughput"` or `"latency"`. Left out, OpenRouter decides. | `OPENROUTER_PROVIDER_SORT` |

The providers' keys are secrets (above).

#### `[[model_providers.endpoints]]`

A deployment can serve open-weight models from a server it runs itself
(vLLM, llama.cpp's server, TGI, Ollama), beside or instead of the hosted
providers ([architecture.md](architecture.md), "Providers"). Each server is one group, headed `[[model_providers.endpoints]]`
with double brackets, and the groups together are the setting `endpoints`,
whose environment variable is `MODEL_ENDPOINTS` (the same list as JSON).

```toml
[[model_providers.endpoints]]
name = "local"
base_url = "http://vllm.internal:8000/v1"
key_env = "LOCAL_LLM_KEY"
input_usd_per_mtok = 0.5
output_usd_per_mtok = 1.5
```

| Name | What it sets | In `MODEL_ENDPOINTS` |
|---|---|---|
| `name` | What model ids and `[provider_labels]` call the endpoint: a role's model is `"endpoint:local/<model>"`, and its clearance is the line `"endpoint:local"`. Lower-case letters, digits, `-` and `_`. | `name` |
| `base_url` | Where its OpenAI-compatible API is served, up to and including the version segment. | `baseUrl` |
| `key_env` | The name of the environment variable that holds the endpoint's key, never the key, so the file holds no secret. Left out for an endpoint that takes no key. | `keyEnv` |
| `input_usd_per_mtok`, `output_usd_per_mtok` | What a call costs, in US dollars per million tokens. Both are required: budgets and owls are counted in this cost, and only the deployment knows what its own hardware costs. A deployment that counts its endpoint as free writes `0`. | `inputUsdPerMtok`, `outputUsdPerMtok` |

#### `[provider_labels]`

Which labels each model provider and each outside service may be sent text
at ([architecture.md](architecture.md), "Providers cleared by label"). One
line for each provider: its name, and the list of labels it is cleared for.
The environment variable is `PROVIDER_LABELS` (the same lines as one JSON
object).

```toml
[provider_labels]
anthropic = ["public", "internal"]
"endpoint:local" = ["public", "internal", "restricted"]
embeddings = ["public", "internal"]
```

The names are `anthropic`, `openai` and `openrouter`; `"endpoint:<name>"`
for each declared endpoint, in quotes because of the colon; and the outside
services `embeddings`, `web_search`, `web_pages`, `elicit` and `pangram`.

A provider with no line is cleared for `public` and for nothing else, so a
deployment with only the `public` label needs no `[provider_labels]` at all,
and a deployment that defines another label sends nothing at that label
anywhere until a line here says who may receive it. A provider with a line
is cleared for exactly the labels on it, so `[]` clears it for none,
`public` included. Labels are named, never created, here: a name that is not
a defined label refuses every call until it is defined or corrected, and the
preflight check `provider_labels` says which name.

Two mistakes in these settings stop the server at start with a message that
uses the environment variables' names, because they can only be found once
both settings are read: a line in `[provider_labels]` for a name that is not
a provider here, and a role's model on an endpoint that is not declared.

#### `[outside_services.elicit]`, `[outside_services.pangram]`, `[outside_services.payments]`

Three paid services, each with a `use` setting that says whether the
deployment uses it at all. `use = false` switches the service off even when
its key is in the environment. `use = true` says the deployment means to use
it, and the preflight fails if its key is missing. Left out, the service is
on when its key is set, which is how it worked before the file existed.

| Name | What it sets | Environment variable |
|---|---|---|
| `elicit.use` | Whether Elicit (paid scholarly search for the Steward) is used. | `ELICIT_ENABLED` |
| `elicit.url`, `elicit.usd_per_call` | Its address, and what one search costs, which is what the tool tells the agent and what is metered. | `ELICIT_MCP_URL`, `ELICIT_USD_PER_CALL` |
| `pangram.use` | Whether Pangram (detection of machine-written text, and of a text's original source) is used. | `PANGRAM_ENABLED` |
| `pangram.url`, `pangram.plagiarism_url`, `pangram.model` | Its two addresses and its model. | `PANGRAM_API_URL`, `PANGRAM_PLAGIARISM_API_URL`, `PANGRAM_MODEL` |
| `pangram.ai_usd_per_word`, `pangram.plagiarism_usd_per_word`, `pangram.max_words` | What it charges per word, and the most words one call sends. | `PANGRAM_AI_USD_PER_WORD`, `PANGRAM_PLAGIARISM_USD_PER_WORD`, `PANGRAM_MAX_WORDS` |
| `payments.use` | Whether owls are sold through Stripe. | `PAYMENTS_ENABLED` |

#### `[outside_services.github_issues]`

| Name | What it sets | Environment variable |
|---|---|---|
| `repo` | The repository (`"owner/name"`) the agents' problem reports are filed in as issues. `""` files nothing. A deployment that holds private material must leave it empty: a report quotes what the agent was working on. | `GITHUB_ISSUES_REPO` |
| `label` | The label filed issues carry. | `GITHUB_ISSUES_LABEL` |
| `include_external_reports` | Whether reports raised by outside callers over MCP are filed too. | `GITHUB_ISSUES_INCLUDE_EXTERNAL` |
| `api_base_url` | GitHub's API address. | `GITHUB_API_BASE_URL` |
| `app_id`, `app_installation_id` | The GitHub App's two ids, as text in quotes. Its private key is a secret. | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` |

#### `[run_log]`

| Name | What it sets | Environment variable |
|---|---|---|
| `mode` | `"best_effort"`: a step that cannot be written is noted and the run carries on. `"record"`: a run does not finish until its log is sealed, and nothing is deleted ([run-log.md](run-log.md)). A deployment that holds private material uses `"record"`. | `RUN_LOG_MODE` |
| `level` | `"full"` or `"off"`. Record mode logs every run whatever this says. | `TRACE_LEVEL` |
| `retention_days` | How many days the log of a run that wrote nothing to the graph is kept. `0` keeps everything. | `TRACE_RETENTION_DAYS` |

#### `[hosting]`

| Name | What it sets | Environment variable |
|---|---|---|
| `environment` | `"development"`, `"staging"` or `"production"`. In production the server applies the database migrations when it starts, refuses to start unless the load-bearing roles have a model named, refuses requests without a key where development lets them through, and connects to the database over TLS verified against the Amazon RDS certificates shipped with the code. That last point means a database that is not on Amazon RDS cannot be used in production mode yet. | `ENVIRONMENT` |
| `web_base_url` | Where the web app is reached. Used in links to claim pages and in sign-in for MCP clients. | `PUBLIC_WEB_BASE_URL` |
| `api_base_url` | Where this API is reached from outside. | `PUBLIC_API_BASE_URL` |
| `citation_url_base` | Where a claim's permanent citation address starts. `""` uses `web_base_url`. | `CITATION_URL_BASE` |
| `cors_origins` | A list of other sites whose pages may call the API from a browser. | `CORS_ORIGINS` |
| `host`, `port` | The address and port the API listens on. | `HOST`, `PORT` |
| `log_level` | `"fatal"`, `"error"`, `"warn"`, `"info"`, `"debug"` or `"trace"`. | `LOG_LEVEL` |
| `anonymous_rate_limit_per_minute` | Requests a minute one address may make without a key. | `ANONYMOUS_RATE_LIMIT_PER_MINUTE` |

#### `[database]`

| Name | What it sets | Environment variable |
|---|---|---|
| `host`, `port`, `name`, `user` | Where the database is and who connects. Used when `DATABASE_URL` is not set. The database must have the pgvector extension. | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME` |
| `tls` | `"off"`: connections to the database are not encrypted, which is right only where it is on a network of the deployment's own that nothing else can reach (the packaged Compose file sets this). Left out, production verifies the server's certificate and other environments use no TLS. | `DATABASE_TLS` |
| `ca_file` | The path of the certificate authority a database that is not on RDS is verified against, in any environment. Not beside `tls`: the server does not start with both. | `DATABASE_CA_FILE` |

#### `[pricing]`

| Name | What it sets | Environment variable |
|---|---|---|
| `owl_price_micro_usd` | What one owl costs to buy, in millionths of a dollar. | `OWL_PRICE_MICRO_USD` |
| `owl_cost_micro_usd` | What one owl of spending covers, in millionths of a dollar of metered cost. | `OWL_COST_MICRO_USD` |
| `owl_packs` | What is sold, as a list of `"owls:cents:name"`. An empty list sells nothing. | `OWL_PACKS` |
| `signup_grant_owls`, `monthly_grant_owls` | Owls given to a new account, and each month. | `SIGNUP_GRANT_OWLS`, `MONTHLY_GRANT_OWLS` |
| `cap_claim_proposal_owls`, `cap_assessment_owls`, `cap_source_ingest_owls`, `cap_extension_analysis_owls`, `cap_text_analysis_owls` | The most each paid operation can cost its buyer. | `CAP_CLAIM_PROPOSAL_OWLS`, `CAP_ASSESSMENT_OWLS`, `CAP_SOURCE_INGEST_OWLS`, `CAP_EXTENSION_ANALYSIS_OWLS`, `CAP_TEXT_ANALYSIS_OWLS` |
| `owls` | `"sold"`, the starting value, or `"created"`: the deployment's administrators create the owls that budget its agents' work, each act logged, and nothing is sold ([accounts.md](accounts.md), "Owls a deployment creates for itself"). `"created"` needs a members-only deployment, no Stripe key and no free grants. | `OWLS` |

#### `[[pricing.model_prices]]`

A price the deployment states for a model, for one the rate table does not
know or in place of the table's ([accounts.md](accounts.md), "Owls a
deployment creates for itself"). Each model is one group, and the groups
together are the setting whose environment variable is `MODEL_PRICES` (the
same list as JSON). Where owls are created, a run on a model with no price
is refused.

```toml
[[pricing.model_prices]]
model = "gpt-oss-120b"
input_usd_per_mtok = 0.5
output_usd_per_mtok = 1.5
```

| Name | What it sets | In `MODEL_PRICES` |
|---|---|---|
| `model` | A model id, or the start of one; the longest match wins. | `model` |
| `input_usd_per_mtok`, `output_usd_per_mtok` | What a call costs, in US dollars per million tokens. Both are required; `0` for a model the deployment counts as free. | `inputUsdPerMtok`, `outputUsdPerMtok` |
| `cache_read_multiplier`, `cache_write_multiplier` | Optional: what a cached read and a cache write cost, as a multiple of the input price. | `cacheReadMultiplier`, `cacheWriteMultiplier` |

#### `[publishing]`

| Name | What it sets | Environment variable |
|---|---|---|
| `hosting` | Where the deployment runs: `"own_machines"`, `"minerval"` or `"third_party"`. It is stated in every package of a page shown outside, and no package is built until it is set ([published-pages.md](published-pages.md)). | `DEPLOYMENT_HOSTING` |

The signing key is a secret (above).

#### `[public_graph]`

| Name | What it sets | Environment variable |
|---|---|---|
| `api_url` | The public graph's API, for sending packages and for acting there in the organization's name. Left out, packages are carried as files and nothing is done there from here. | `PUBLIC_GRAPH_API_URL` |
| `acts_by` | The permission whose holders may act on the public graph in the organization's name: `"direct"`, the starting value, `"fund"` or `"administer"` ([outward-acts.md](outward-acts.md)). | `PUBLIC_ACTS_BY` |
| `price` | How a members-only deployment pays toward the public graph it reads: `"metered"`, the starting value, on the owl usage it reports, or `"flat"`, a flat price for the feed with nothing reported ([usage-report.md](usage-report.md)). | `PUBLIC_GRAPH_PRICE` |

#### `[usage_report]`

| Name | What it sets | Environment variable |
|---|---|---|
| `url` | The address a metered deployment's usage reports are sent to. | `USAGE_REPORT_URL` |
| `dir` | A directory the reports are written to as files instead, to be handed over. One of the two, never both; with neither, reports are prepared and kept. | `USAGE_REPORT_DIR` |
| `from` | The first day reported, as `"YYYY-MM-DD"`. Left out, it is the first day anything was metered. | `USAGE_REPORT_FROM` |

#### `[file_sets]`

| Name | What it sets | Environment variable |
|---|---|---|
| `store_dir` | Where uploaded sets of files are kept. Left out, sets cannot be uploaded ([file-sets.md](file-sets.md)). | `FILE_SET_STORE_DIR` |
| `directory_root` | The directory that directories already on the deployment's disk are registered from. It carries no label: the administrator who registers a directory under it says which label its files get. | `FILE_SET_DIRECTORY_ROOT` |

#### `[sandbox]`

| Name | What it sets | Environment variable |
|---|---|---|
| `url` | The address of the sandbox service agents run commands over file sets in. Left out, sets can be added and not explored. | `SANDBOX_URL` |
| `hour_cost_micro_usd` | What an hour of sandbox time is charged to a run, in millionths of a dollar. `0` charges nothing, and each run is told so. | `SANDBOX_HOUR_COST_MICRO_USD` |

### What is not in the file

The file covers what a deployment has to decide. The rest of the settings
stay environment variables, each described where it is defined in
`src/config.ts`, and `.env.example` lists the common ones:

- **Secrets**, above.
- **Tuning of the agents and the allocation**: budgets and caps on runs,
  priors, intervals of the schedulers and sweeps, rate limits other than the
  anonymous one, the solver's and the researcher's switches, and the sizing
  of the mathematics mandates and prizes. A deployment rarely changes these,
  and each is described at length beside its definition.
- **Amazon queue addresses** (`SQS_*`) and `AWS_REGION`. With none set, the
  queues run inside the server process.
- **The read-only SQL replica** (`SQL_DB_HOST` and the two roles). Without
  it the SQL tools say they are not configured.
- **The Lean checker's address** (`LEAN_CHECKER_URL`), which matters only
  with the mathematics feature on.
- **The model providers' timeouts and retries** (`LLM_REQUEST_TIMEOUT_MS`,
  `LLM_LONG_RUN_TIMEOUT_MS`, `LLM_MAX_RETRIES`) and the breaker on
  unattributed model calls (`LLM_*_LIMIT`).

Four things an installer might look for have no setting at all today:

- **Open-web search** has no off switch. Agents that search do so through
  Anthropic's API when their model is one Anthropic searches for, and
  through OpenRouter otherwise.
- **Page reading** has no off switch and needs no key. Agents and the
  source workers fetch public pages, and ask Crossref and the Wayback
  Machine about them, directly from the server.
- **Embeddings** cannot be switched off or pointed elsewhere. They are made
  by OpenAI and need `OPENAI_API_KEY`.
- **Email**: the API sends none. The web app's contact form sends through
  Amazon SES when the web app is given `CONTACT_TO_EMAIL` and
  `CONTACT_FROM_EMAIL`, and does nothing without them.

So a deployment that must reach nothing outside its own network cannot be
configured yet. The preflight says so for each of these, below.

### The web app

The web app is a separate process and does not read the config file. It
reads its own environment variables (`web/.env.example`): `MINERVAL_API_URL`
(where the API is), `MINERVAL_API_KEY` (a service key from the API's
`API_KEYS`, a secret), `SITE_URL` (its own address, the same value as
`hosting.web_base_url`), `AUTH_SECRET` and the sign-in providers' ids and
secrets. It needs nothing from the config file at build time: it learns
which features a deployment has from the API when it runs
(`GET /setup/features`).

### Writing the file from code

A setup page will write this same file. The code it will call is in
`src/config-file.ts`: `renderConfigFile` and `writeConfigFile` take settings
keyed by their dotted names, check them exactly as a file being read is
checked, and write the file whole, with the line on each group above it.
They refuse a secret, so the page cannot put one in the file. What is
written reads back as the same settings.

## Preflight

The preflight is a list of named checks. Each answers **pass**, **fail** or
**not applicable**, with one sentence. It can be read three ways:

- `npm run preflight` on the machine. It prints each check and exits with a
  non-zero status when any check failed, so it can stand in front of a start
  command. `npm run preflight -- --json` prints the same report as data.
- `GET /setup/preflight` on the API, with the operator key in the
  `x-operator-key` header. The answer names missing keys, the issue
  repository and the state of the database, so it is for whoever runs the
  deployment and nobody else. With no `MINERVAL_OPERATOR_KEY` set the route
  is closed. It is not an MCP tool.
- The server's own start. A deployment that holds private material does not
  start agent work while a blocking check fails (below).

### Holding private material

Some checks only matter, and some only block, when a deployment holds
private material. For now that has one definition: **the deployment has
defined a label other than `public`** (a row in the `labels` table;
`src/labels.ts`). Reads are not yet held to labels, so there is nothing
finer to ask: a deployment that defines its second label has said it means
to hold something that is not for everyone, and from then on it is held to
the blocking checks.

On a deployment with only the `public` label, which is public Minerval,
every check is information. Nothing is refused, and the server starts as it
always has. The three clearance checks (`model_clearance`,
`embeddings_clearance`, `outside_service_clearance`) do not apply there and
say so: every provider is cleared for `public` unless `[provider_labels]`
says otherwise, and there is no other label.

The clearance checks do not treat an outside service that is not cleared as
a fault. Which outside party may be sent private text is the deployment's
choice, and leaving one uncleared sends nothing out. So `embeddings_clearance`
and `outside_service_clearance` pass and state what each label goes without.
Only a role whose own model cannot serve a label fails, because agent work
at that label does not run at all.

### The checks

| Check | What it looks at | Blocks agent work |
|---|---|---|
| `config_file` | Which file the settings were read from, and which of its settings the environment overrides. | no |
| `database` | The database can be reached, has the pgvector extension, and has applied every migration the code has. It also fails when the database was migrated by newer code, and when a migration is waiting that the migrator would pass over. | yes |
| `run_log` | A test run is written to the run log, sealed, checked against its seal and removed. Where private material is held, the log must also be in record mode. | yes |
| `models` | Every role's model resolves to a provider whose key is set. A model on one of the deployment's own endpoints needs the endpoint declared, and the variable its `key_env` names set if it has one. Roles of a feature that is off are left out. No provider is called. | no |
| `provider_labels` | Every label `[provider_labels]` names is a defined label. A name that is not refuses every model call and every call to an outside service, at every label, so nothing is lost by holding agent work back until it is put right. | yes |
| `model_clearance` | For each label besides `public`, the provider of every role's model is cleared for it. It fails naming the label, the provider and the roles whose runs there would be refused. It does not block: there is one gate for the whole deployment, so closing it would also stop the work at the labels that are served, and a refused run sends nothing. | no |
| `embeddings` | `OPENAI_API_KEY` is set. | no |
| `embeddings_clearance` | For each label besides `public`, whether embeddings are cleared for it. Where they are not, it passes and says what that label goes without: rows written there have no vector, and a search there matches on keywords. | no |
| `web_search` | Every role that searches the web has what its search needs: models Anthropic does not search for go through OpenRouter and need its key. | no |
| `page_reading` | Nothing to configure; it says that page reading has no off switch. | no |
| `elicit`, `pangram` | The service is off, or on with its key. Switched on with no key fails. | no |
| `outside_service_clearance` | For each label besides `public`, which of open-web search through OpenRouter, page reading, Elicit and Pangram are cleared for it, which are not, and which are not in use at all. It passes either way and says what runs at the label go without, and that roles on models Anthropic searches for still search the web under Anthropic's clearance. | no |
| `payments` | Payments are off, or on with both Stripe keys. One key without the other, or a secret key that is not a Stripe key, fails. | no |
| `github_issues` | No repository is named, or one is named and a credential is set. A repository with no credential, or with half of the GitHub App's settings, fails. | no |
| `reports_stay_inside` | Where private material is held, no issue repository is configured. | yes |
| `features` | Which features are off. Where private material is held and the run log is best-effort, it fails if the browser extension is on: a best-effort log leaves out its page analysis and chat. In record mode they are logged, and it passes. | no |
| `work_outside_the_run_log` | Where private material is held and the run log is best-effort, it fails: a best-effort log leaves out the MCP tools `match_claim`, `extract_claims` and `assess_text`, and the naming of an Assistant conversation, and they have no switch. In record mode they are logged runs, and it passes. | no |
| `database_tls` | How the connection to the database is secured. `tls = "off"` passes and says when that is right. A `ca_file` must be readable and hold a certificate. In production, a database that is not on RDS with neither set, and which cannot be reached, fails naming the two settings. | no |
| `database_owner` | Where a label besides `public` is defined, the role in `DATABASE_URL` is not a superuser: row-level security does not bind one. | no |
| `owls` | The settings about owls agree (`OWLS=created` needs a members-only deployment, no Stripe key and no free grants). A members-only deployment that sells owls with payments off fails: no account could get one. | no |
| `model_prices` | Where owls are created, every model a role is set to has a price, from the rate table or `[[pricing.model_prices]]`. It fails naming each setting and model, because a run on a model with no price is refused there. | yes |
| `usage_report` | On the metered price: the report's destination is an address with its key or a directory that can be written, not both. With neither it passes and says reports are kept. Not applicable on the flat price or on a deployment anyone may read. | no |
| `standing_mandates` | In a members-only deployment, a General mandate is set up, and at every label that holds material of the deployment's own. It names the labels that have none. | no |
| `own_organization` | In a members-only deployment, a party is marked as the organization itself. Without one a request to show a page is refused. | no |
| `publishing` | Where a page is shown outside or hosting is set: `PUBLISH_SIGNING_KEY` is an Ed25519 private key and `publishing.hosting` is set. Not applicable where nothing is shown outside. The key is never printed. | no |
| `public_graph` | `public_graph.api_url` is an https address and `PUBLIC_GRAPH_API_KEY` is set with it. With a signing key and no address it passes and says packages are carried as files. The public graph is not called. | no |
| `public_acts` | Which permission's holders may act on the public graph in the organization's name, and how many grants of it are live. With none it passes and says nobody can act there. | no |
| `connections` | For the connections that are on, how many name a credential variable that is not set, by label. It calls no server: whether each answers is on the connections page. | no |
| `file_sets` | `file_sets.store_dir` exists and can be written, and `file_sets.directory_root` exists and can be read, where each is set. It says the registered root carries no label. | no |
| `sandbox` | With `sandbox.url` set: `SANDBOX_TOKEN` is set and the service answers, with its version and image. File sets with no sandbox pass, saying they cannot be explored. | no |
| `sandbox_confinement` | The sandbox's own probe, check by check: a command is held to its run's file sets, the sets cannot be written, and an attempt to connect out fails. Not applicable with no sandbox or one that does not answer. | yes |

Some of these are about rows at every label: showings, mandates, connections
and file sets. The preflight is read by whoever holds the operator key and,
through the setup checklist, by administrators, and neither reads every
label. So those facts are read as the tables' owner and reported as counts
and the names of labels, never a row's text
(`src/preflight-deployment.ts`). The sandbox is the one thing a check asks:
it is the deployment's own service, and whether a command in it is confined
is a fact about the running container and not about any setting.

The run log's test uses the writer every agent run uses. It opens a run
under the agent name `preflight`, writes two steps, seals it, recomputes its
chain with the verifier behind `GET /runs/:run_id/verify`, and deletes it.
It calls no model, runs whatever the log's level, and the run is not public
while it exists. If the process dies between the write and the delete, a
sealed two-step run named `preflight` is left behind.

### What a failed blocking check does

Agent work means everything the server does in the background: the queue
workers, the runner that carries out Steward passes, orders, funded jobs and
ledger actions, and the schedulers and sweeps around them. All of it starts
in one place (`src/workers/agent-work-gate.ts`), behind the gate:

- A deployment that holds only public material is asked one question (is
  `public` the only label?) and its work starts. No check runs.
- A deployment that holds private material starts no agent work until
  `database`, `run_log`, `provider_labels`, `reports_stay_inside`,
  `model_prices` and `sandbox_confinement` all pass. The server logs
  one line naming each failed check with its sentence. The API still starts
  and serves, so `GET /setup/preflight` can be read.
- The gate is looked at again every minute. Work that was refused starts
  once the checks pass. A deployment whose work is running and which then
  defines its second label has its work stopped if a blocking check fails,
  each worker finishing the unit it has in hand.
- If the labels cannot be read at all (the database is down at start), work
  is not started until they can be: an unread label is never taken to mean
  public.

The solver worker (`npm run worker:solver`), which is its own process, asks
the same gate when it starts and exits with a non-zero status if it is
refused.

Two things are outside the gate. Work a request asks for and waits on (a
conversation with the Assistant or the Grantmaker, a browser extension
analysis, an MCP caller's on-demand analysis) runs in the API, which is not
gated. And the scripts that run the pipeline by hand (the corpus harness)
do not ask it.

The checks that fail without blocking are still failures: `npm run
preflight` exits non-zero on them. They do not stop work because the
deployment can run without them being right (a missing key fails the calls
that need it, loudly, and a run whose model's provider is not cleared for
its label is refused before anything is sent), or because, like
`features` and `work_outside_the_run_log`, what they check runs in the API,
which the gate does not hold.

## The setup checklist

Once a deployment has administrators, they are who sets it up, and they work
in the web app. `GET /setup/checklist` (`src/routes/setup-checklist.ts`,
`src/services/setup-checklist-service.ts`; `get_setup_checklist` on MCP) is
one read of what a members-only deployment can see about its own setup, for
holders of the permission to administer:

| Part | What it says |
|---|---|
| `preflight` | The preflight's report, above: each check with pass, fail or not applicable and a sentence saying why, and whether agent work may start. |
| `permissions` | How many accounts and groups hold each permission now, by label and by party where the permission is granted at one. |
| `labels` | Every label besides `public`, with the model providers and outside services cleared for it (`PROVIDER_LABELS`) and the roles whose model's provider is not cleared, whose runs at that label are refused. |
| `undefined_labels_in_provider_setting` | Labels `PROVIDER_LABELS` names that are not defined. While there is one, every call to a provider is refused. |
| `standing_mandates` | The General mandate, with its budget once set up ([accounts.md](accounts.md), "The standing mandates, set up in the app"). Where the deployment holds material at more than one label, `by_label` has each label the administrator reads with the mandate set up there or none. |
| `owls` | Whether the deployment creates its own owls, how many were created and spent, and the configured models with no price. |
| `usage_report` | Whether usage is reported, where to, and how many reports wait to be sent ([usage-report.md](usage-report.md)). |
| `connections` | The connections at labels the administrator reads: how many there are, and which need a look (not answering, a credential not set, a tool withdrawn), from what was last recorded ([connections.md](connections.md)). `not_shown` counts the connections at labels the administrator does not read. |
| `material` | The sources recorded in the whole deployment, by the party each belongs to, the submitted sources waiting for review, and the nodes the graph holds. |

It holds no list of steps and decides nothing: every part is a fact, and
nothing is marked done because a person said so. Most parts are read through
the service that serves the same thing to its own route, so the checklist
and those routes cannot disagree.

**What an administrator is shown is held to what they read.** Administering
does not by that alone let a person read at a label
([architecture.md](architecture.md), "Labels and clearance"), so the
connections and the standing mandates in the checklist are the ones at
labels the administrator reads, and the checklist says how many connections
it leaves out. Two things are counted past that, under system clearance,
because the question is about the whole deployment and the answer is a
number: how much material is in at all, by the party it belongs to, and how
many connections there are. No row's label is returned.

**The deployment's own checks.** The `preflight` part is the same report
`GET /setup/preflight` gives the operator, asked for in one place
(`src/services/deployment-checks.ts`), so the two cannot disagree. What it
says of rows at a label is a count and the label's name ("The checks",
above), so it shows an administrator nothing they do not read. The roles
the checklist lists for a label are the rows of the config file's
`[models]` group, the Redactor's among them.

The page that shows it is `/admin` in a members-only build of the web app
([accounts.md](accounts.md), "The web app"). It is the same page on a
deployment's first day and on every day after: what needs someone now, then
every item as it stands, each with what to do next, who can do it, and where.

The checklist only reads. What it finds wrong in a setting is put right by
whoever runs the deployment.
