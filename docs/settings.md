# Settings an administrator changes in the app

The settings that are choices about how a deployment works are kept in the
deployment's database, where its administrators change them in the web app,
over the API and over MCP. Each change is checked before it is saved, logged
with who made it and why, and for most settings in force within seconds.
What stays on the machine is the short list of settings the app cannot or
must not change.

This page says which is which, how a value is chosen, what happens when a
setting is changed, and lists every setting. The config file and the
preflight are in [deployment.md](deployment.md). Versions, and what an
upgrade does to settings, are in [releases.md](releases.md).

It applies to a members-only deployment (`READS=members`), which is the kind
that has administrators. The public graph's settings are its machine's.

## What stays on the machine

A setting stays on the machine, and the app never changes it, when it is one
of three kinds.

| Kind | Settings | Why |
| --- | --- | --- |
| **Needed before the database answers** | `[database]` and `DATABASE_URL`; `hosting.environment`, `hosting.host`, `hosting.port`; `READS`; `FIRST_ADMINISTRATOR`; `SIGN_IN_VALID_HOURS`, which the web app reads too | The settings table is in the database. |
| **The trust root** | `API_KEYS`, `SANDBOX_TOKEN`, `LEAN_CHECKER_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY` and its previous keys, `MINERVAL_OPERATOR_KEY`, the database's passwords, `CLEARED_ROLE_PASSWORD`, and the deployment's own signing keys (`PUBLISH_SIGNING_KEY`, `MIRROR_SIGNING_KEY`, `OIDC_SIGNING_KEY`, `MINERVAL_HOSTING_TOKEN`) | Whoever could change these from the app would hold the machine: an administrator could seal keys under a key of their choosing, or give themselves the operator key, which is the way back when every administrator is gone ([accounts.md](accounts.md), "The first administrator"). The split between who runs the machine and who runs the graph rests on these. |
| **Facts about the machine** | `sandbox.url`, `file_sets.store_dir`, `file_sets.directory_root`, the queues (`SQS_*`, `AWS_REGION`), the SQL replica's address and roles, `LEAN_CHECKER_URL`, the directories reports and feeds are read from and written to (`usage_report.dir`, `mirror.feed_dir`), which process cuts the mirror feed, and what an image was built from | They say where things are on this machine and its network, not what the deployment should do. |

The web app's own settings (`AUTH_SECRET`, the sign-in client's
`AUTH_OIDC_*`, `WEB_API_KEY`) are the machine's too: sign-in cannot be set
from a page reached by signing in.

Two settings are the machine's only some of the time:

- **`provider_labels`** fixes which labels each provider may be sent text
  at, where it is set at all. Left unset, holders of `clear_providers`
  choose on the labels page ([architecture.md](architecture.md), "Providers
  cleared by label"). That choice has its own table and its own page, and
  is where this design started.
- **`run_log.mode`** is the administrators' until a label besides `public`
  is defined, which for a members-only deployment is its first start: its
  own material is at `members` and `published` from then on
  ([architecture.md](architecture.md)). From then on it is the machine's: a deployment that holds
  private material keeps its whole log ([run-log.md](run-log.md), "Record
  mode"), and loosening that is for whoever runs the machine to decide. The
  packaged deployment sets it to `record` in its Compose file, which fixes
  it from the start.

Everything else is a choice, and is the administrators'.

## Keys issued by someone else

The model providers' keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`), the key of a model endpoint the deployment runs
itself, Elicit's and Pangram's, Stripe's two, and the GitHub App's key and
token are secrets, but not the trust root: someone outside issued them, and
the deployment only presents them.

An administrator gives one on the settings page. It is sealed under
`CREDENTIAL_ENCRYPTION_KEY`, the way a connection's credential is
([connections.md](connections.md), "A credential given here"), and never
read back: the page says that one is set, its last four characters, who set
it and when. The environment variable of the same name still fixes it where
it is set.

A key is given only from a signed-in session. Over MCP, or with an API key,
the route refuses it and says to give it on the page, so that no key passes
through a model's context.

A model endpoint names the environment variable that holds its key
(`key_env`). Its key is given under that name: the setting
`endpoint_keys.<the variable>`, which the page lists beside the endpoint
once the endpoint is declared.

Where `CREDENTIAL_ENCRYPTION_KEY` is not set, no key can be given in the
app, and the refusal says so. When that key is replaced,
`npm run reseal:connection-credentials` moves the settings' keys onto the
new one with the connections' credentials. A key sealed under a sealing key
the deployment no longer has is shown as set and not in force, and is given
again.

So a deployment can be set up by someone with no shell on the machine, once
whoever runs it has started it with the trust root and the facts about the
machine.

## How a value is chosen

Four layers, in this order, the first that has a value winning:

1. **The environment.** What whoever runs the machine put in `.env`,
   `api.env` or the process's environment.
2. **The config file.** What they wrote in `minerval.toml`
   ([deployment.md](deployment.md)).
3. **The database.** What an administrator set in the app.
4. **The code's default.**

The first two are the machine's, and either fixes the setting: the app
shows it, says it is fixed by whoever runs the machine, names the variable
or the file it comes from, and does not offer to change it. That keeps the
operator in charge where they choose to be and keeps scripted installs
working unchanged.

A variable that is present and empty in the environment fixes nothing: a
Compose file passes one for every variable it names. The app may set such a
setting. A setting the config file writes as empty is fixed as empty.

A setting that stays on the machine is never read from the database,
whatever the table holds.

## Changing a setting

**Who.** Holders of `administer`: on the settings page, over the API, or
through the MCP tools `set_setting` and `reset_setting`. The Assistant holds
both tools for its user's press, every time, whatever the user has allowed:
a setting decides which model reads the deployment's material and what a run
may spend, for everyone in it.

**Checked before it is saved.** A value is checked by the config schema, as
a config file's is. Then the whole configuration with the new value in it is
built, which refuses settings that cannot hold together (owls created beside
a Stripe key, say). Then the preflight's checks are evaluated over that
configuration, without calling anything outside. A change that would make a
blocking check fail is refused with that check's sentence. One that would
make another check fail is saved, and the answer carries the sentence. So
the checks that used to say what was wrong after the fact say it before.

**Rules that turn on what the deployment holds.** Checked with the rest:

- `pricing.owls`, from `sold` to `created` or back, is refused while any
  account holds owls. The refusal says how many accounts and how many owls.
- Switching a feature off in `features.off` is refused while it holds work
  that would be stranded: a proof attempt that is running, for mathematics;
  an open prize claim, for prizes or mathematics.
- `run_log.mode` is refused once a label besides `public` is defined, as
  above.

**Logged.** Each change writes an entry to the administrators' log
(`setting_changed`) in the same transaction: the setting, its value before
and after as the environment would hold it, who, and the reason they gave.
For a key the entry says only that one was set, and whether one was set
before. The settings table keeps no history of its own; the log is the
history. The Activity log filters by it (`type=settings`).

**Back to the default.** Removing a setting's row returns it to the code's
default, and is logged the same way (`setting_reset`).

**In force.** Each setting applies in one of two ways, which the list says:

- **Live.** In force at once in the process that changed it, and in every
  other within a few seconds: each process keeps the last copy of the table
  it read and reads it again every five seconds, as the provider clearance
  does. Every reader of the configuration then reads the current value. A
  provider's client, which holds the key and the timeout it was made with,
  is made again when the configuration changes.
- **Restart.** A setting read only where a process starts: a feature's
  routes, a scheduler's interval, the CORS origins, the log level. It is
  saved and waits. The process keeps the value it started with, the list
  shows the saved value as waiting, and the preflight's `settings` check
  says which wait. The settings page offers to start the API again
  (`POST /setup/restart`), which ends the API's process the way the machine
  would; the Compose file's `restart: unless-stopped` starts it again. Every
  run in flight hands its work back and is taken up again. It is logged
  (`restart_requested`).

A setting marked live is one every reader reads again. One marked restart
may in fact be read again by some reader; it is marked for the reader that
does not.

**When the stored settings cannot be used.** After an upgrade a saved value
may no longer be acceptable: a model id the new code does not resolve, say.
The deployment does not fail to start. It runs on the machine's settings and
the defaults, the preflight's `settings` check fails with what is wrong, and
the settings page says the same above the list. Putting the setting right,
or returning it to its default, puts the rest back in force.

## Routes and tools

| Route | MCP tool | |
| --- | --- | --- |
| `GET /settings` | `list_settings` | Every setting in the registry: its value, which layer it comes from, its default, whether it applies live, a saved value that waits for a restart, and for a key only whether one is set. For holders of `administer`. |
| `GET /settings/file` | `export_settings_file` | What is set in the app, as a config file: to start another deployment the same way, or to hand a setting to whoever runs the machine to fix there. Never a key. |
| `PUT /settings/:key` | `set_setting` | Set a value, with a reason. `:key` is the setting's name (`models.steward`) or its environment variable. |
| `DELETE /settings/:key` | `reset_setting` | Return it to the default, with a reason. |
| `POST /setup/restart` | none | End the API's process, to be started again. From a signed-in session. It ends every run in flight, and is a person's act. |

Each write names no label in `src/server/request-labels.ts`: a setting is
the deployment's, not any row's. The table, `deployment_settings`, is the
database owner's alone where a deployment has more than one label: no
connection held to a clearance and no SQL view reads it.

## The pages

**Settings** (`/admin/settings`) lists every setting in groups, each with
its sentence from the registry, its value, and where the value comes from:
the default, an administrator, or the machine. The groups a deployment
decides come first. The tuning, which a deployment rarely decides, is folded
away below them and is changed the same way. A setting the machine has fixed
opens to say where it is set. The page also gives what is set in the app as
a config file, and offers the restart when a change waits on one.

**Health's first day** (`/admin`) asks, in order, for what a new deployment
decides first: the organization's name, the model of each load-bearing role,
the features, and where owls come from. Each is the same setting the
settings page shows, opened in the same form. The section goes once the
organization is named and every load-bearing role has a model somebody
chose.

The first day also takes the two steps that used to need the machine:

- **Naming the organization.** The organization's own party is made as
  "This organization" when the first administrator is made. The first day
  asks for its name, and any party's name can be changed afterwards
  (`PATCH /parties/:id`), logged with the name it had.
- **Becoming the first administrator.** A deployment that has never had an
  administrator prints a one-time code in the API's log each time it starts.
  The first person to sign in and give it is the first administrator
  ([accounts.md](accounts.md), "The first administrator").

## The registry

`src/settings-registry.ts` has one row for every setting: its name, its
environment variable, the field of the config schema it fills, a sentence on
what it decides, and three facts.

| Fact | |
| --- | --- |
| `where` | `machine` (stays on the machine), `app` (the administrators') or `app_secret` (the administrators', sealed). |
| `applies` | `live`, or `restart` for a setting read only where the process starts. |
| `retired` | For a setting no longer read: the release it was retired in and what replaced it. |

`tests/unit/settings-registry.test.ts` fails on an environment variable
`src/config.ts` reads that has no row, so a new setting is given its place
when it is added. A new setting, a retired one and a changed default also
each need a line in `releases/next.md` ([releases.md](releases.md), "Tests
keep the facts true").

The registry is also what a config file may hold: every setting that is not
a secret can be written in `minerval.toml` under the same name.

**The `unknown_settings` check.** The preflight lists every environment
variable the API was given that looks like a setting and is not one, with
the nearest name (`STEWRD_MODEL`: did you mean `STEWARD_MODEL`?), and every
retired one, with what replaced it. A variable looks like a setting when it
is within two letters of one or begins the way the settings' variables do
(`STEWARD_`, `OWL_`, `MIRROR_`); the machine's own variables (`AWS_`,
`GITHUB_`) and the other parts' (`AUTH_`, `CONNECTION_`) are left alone. It
does not block.

**The `models_chosen` check.** The code's default models are the cheap tier,
kept cheap for tests. On the public graph a production start without a
chosen model for each load-bearing role stops, as it always has. A
members-only deployment starts, so that its administrators can choose in the
app; this check fails in production while any of those roles is nobody's
choice, and where private material is held it holds agent work until each
is.

## Every setting

The table below is made from the registry (`npx tsx
scripts/settings-docs.ts`). "Changed by" says who may change a setting: the
machine alone, or the administrators too, in which case the machine may
still fix it. A machine setting always applies at a restart.

<!-- settings-table:start (made by scripts/settings-docs.ts; do not edit by hand) -->

#### `features`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `features.off` | `FEATURES_OFF` | administrators | restart | empty | The optional parts of the product this deployment switches off. A part's routes and workers are set up as the process starts. |

#### `models`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `models.steward` | `STEWARD_MODEL` | administrators | live | `claude-sonnet-5-5` | The Steward: assesses and decomposes nodes, the graph's main work. |
| `models.steward_strong` | `STEWARD_STRONG_MODEL` | administrators | live | empty | The Steward's strong pass, and the model its money decisions run on. Empty, there is no strong pass. |
| `models.curator` | `CURATOR_MODEL` | administrators | live | `claude-sonnet-5-5` | The Curator: merges, splits and structure. |
| `models.extractor` | `EXTRACTOR_MODEL` | administrators | live | `claude-sonnet-5-5` | The Extractor: reads a document and states its claims in the graph's words. |
| `models.matcher` | `MATCHER_MODEL` | administrators | live | `openai/gpt-6-luna` | The Matcher: decides whether a claim is already in the graph. |
| `models.tagger` | `TAGGER_MODEL` | administrators | live | `openai/gpt-6-luna` | The tagger: says what each node is about. |
| `models.contribution_reviewer` | `GOVERNANCE_MODEL` | administrators | live | `claude-sonnet-5-5` | The Contribution Reviewer. |
| `models.audit` | `AUDIT_MODEL` | administrators | live | `claude-sonnet-5-5` | The Audit Agent. |
| `models.arbitration` | `ARBITRATION_MODEL` | administrators | live | `claude-sonnet-5-5` | Arbitration of an appeal: few runs, each one final. |
| `models.grantmaker` | `GRANTMAKER_MODEL` | administrators | live | `claude-fable-5-2` | The Grantmaker: designs mandates and decides what they fund. |
| `models.program_officer` | `PROGRAM_OFFICER_MODEL` | administrators | live | `openai/gpt-6-luna` | Program officers: routine decisions under a mandate's written policy. |
| `models.lookout` | `LOOKOUT_MODEL` | administrators | live | `openai/gpt-6-luna` | Lookouts: a mandate's standing watches. |
| `models.correspondent` | `CORRESPONDENT_MODEL` | administrators | live | `claude-sonnet-5-5` | Correspondents: write updates on the graph for an audience. |
| `models.consistency` | `CONSISTENCY_MODEL` | administrators | live | `openai/gpt-6-luna` | The Consistency Checker's standard sweep. |
| `models.consistency_strong` | `CONSISTENCY_STRONG_MODEL` | administrators | live | `claude-sonnet-5-5` | The Consistency Checker's strong sweep. |
| `models.assistant` | `ASSISTANT_MODEL` | administrators | live | `claude-fable-5-2` | The Assistant, on its strongest tier. |
| `models.assistant_standard` | `ASSISTANT_STANDARD_MODEL` | administrators | live | `claude-opus-5-5` | The Assistant's cheaper tier, which a person may choose for a conversation. |
| `models.assistant_title` | `ASSISTANT_TITLE_MODEL` | administrators | live | `claude-haiku-5-5` | Names a conversation with the Assistant from its first message. |
| `models.assistant_markup` | `ASSISTANT_MARKUP_MODEL` | administrators | live | `claude-sonnet-5-5` | The Assistant's verdicts on a page's wording, which the browser extension draws. |
| `models.researcher_strong` | `RESEARCHER_STRONG_MODEL` | administrators | live | `claude-fable-5-2` | The researcher's strong tier. |
| `models.researcher_standard` | `RESEARCHER_STANDARD_MODEL` | administrators | live | `claude-sonnet-5-5` | The researcher's standard tier. |
| `models.researcher_cheap` | `RESEARCHER_CHEAP_MODEL` | administrators | live | `openai/gpt-6-luna` | The researcher's cheap tier. |
| `models.solver` | `SOLVER_MODEL` | administrators | live | `claude-fable-5-2` | The solver: proof attempts, where mathematics is on. |
| `models.judge` | `JUDGE_MODEL` | administrators | live | `claude-sonnet-5-5` | The judge that scores agents' output in evaluation runs. |
| `models.redactor` | `REDACTOR_MODEL` | administrators | live | empty | The Redactor. Empty, it runs on the Steward's model. |

#### `model_providers`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `model_providers.openrouter_provider_sort` | `OPENROUTER_PROVIDER_SORT` | administrators | live | none | How OpenRouter picks among a model's hosts: by price, throughput or latency. |
| `model_providers.anthropic_api_key` | `ANTHROPIC_API_KEY` | administrators (sealed) | live |  | Anthropic's key. |
| `model_providers.openai_api_key` | `OPENAI_API_KEY` | administrators (sealed) | live |  | OpenAI's key, for its models and for embeddings. |
| `model_providers.openrouter_api_key` | `OPENROUTER_API_KEY` | administrators (sealed) | live |  | OpenRouter's key. |
| `model_providers.endpoints` | `MODEL_ENDPOINTS` | administrators | live | empty | Model servers this deployment runs itself: each one's address and what a call costs. |

#### `outside_services.elicit`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `outside_services.elicit.use` | `ELICIT_ENABLED` | administrators | live | none | Whether the Steward may search with Elicit. |
| `outside_services.elicit.url` | `ELICIT_MCP_URL` | administrators | live | `https://elicit.com/api/mcp` | Elicit's address. |
| `outside_services.elicit.usd_per_call` | `ELICIT_USD_PER_CALL` | administrators | live | `2` | What one Elicit search costs, in US dollars. |
| `outside_services.elicit.api_key` | `ELICIT_API_KEY` | administrators (sealed) | live |  | Elicit's key. |

#### `outside_services.pangram`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `outside_services.pangram.use` | `PANGRAM_ENABLED` | administrators | live | none | Whether agents may check text with Pangram. |
| `outside_services.pangram.url` | `PANGRAM_API_URL` | administrators | live | `https://text.external-api.pangram.com` | Pangram's address for detecting machine-written text. |
| `outside_services.pangram.plagiarism_url` | `PANGRAM_PLAGIARISM_API_URL` | administrators | live | `https://plagiarism.api.pangram.com` | Pangram's address for finding a text's original source. |
| `outside_services.pangram.model` | `PANGRAM_MODEL` | administrators | live | `pangram-4` | Which of Pangram's models reads the text. |
| `outside_services.pangram.ai_usd_per_word` | `PANGRAM_AI_USD_PER_WORD` | administrators | live | `0.0005` | What detection costs per word, in US dollars. |
| `outside_services.pangram.plagiarism_usd_per_word` | `PANGRAM_PLAGIARISM_USD_PER_WORD` | administrators | live | `0.0005` | What a source search costs per word, in US dollars. |
| `outside_services.pangram.max_words` | `PANGRAM_MAX_WORDS` | administrators | live | `1500` | The most words one call sends. |
| `outside_services.pangram.api_key` | `PANGRAM_API_KEY` | administrators (sealed) | live |  | Pangram's key. |

#### `outside_services.payments`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `outside_services.payments.use` | `PAYMENTS_ENABLED` | administrators | restart | none | Whether owls are sold through Stripe. |
| `outside_services.payments.stripe_secret_key` | `STRIPE_SECRET_KEY` | administrators (sealed) | live |  | Stripe's secret key. |
| `outside_services.payments.stripe_webhook_secret` | `STRIPE_WEBHOOK_SECRET` | administrators (sealed) | live |  | The secret Stripe signs its webhook deliveries with. |

#### `outside_services.github_issues`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `outside_services.github_issues.repo` | `GITHUB_ISSUES_REPO` | administrators | live | empty | The repository the agents' problem reports are filed in, as owner/repo. Empty files nothing. |
| `outside_services.github_issues.label` | `GITHUB_ISSUES_LABEL` | administrators | live | `agent-generated` | The label put on each issue filed. |
| `outside_services.github_issues.include_external_reports` | `GITHUB_ISSUES_INCLUDE_EXTERNAL` | administrators | live | `false` | Whether reports raised by outside callers over MCP are filed too. |
| `outside_services.github_issues.api_base_url` | `GITHUB_API_BASE_URL` | administrators | live | `https://api.github.com` | GitHub's API address. |
| `outside_services.github_issues.app_id` | `GITHUB_APP_ID` | administrators | live | empty | The GitHub App's id. |
| `outside_services.github_issues.app_installation_id` | `GITHUB_APP_INSTALLATION_ID` | administrators | live | empty | The GitHub App's installation on the repository. |
| `outside_services.github_issues.token` | `GITHUB_TOKEN` | administrators (sealed) | live |  | A GitHub token, where no App is used. |
| `outside_services.github_issues.app_private_key` | `GITHUB_APP_PRIVATE_KEY` | administrators (sealed) | live |  | The GitHub App's private key. |

#### `provider_labels`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `provider_labels` | `PROVIDER_LABELS` | the machine | restart | empty | Fixes which labels each provider may be sent text at. Left unset, holders of clear_providers choose on the labels page. |

#### `run_log`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `run_log.mode` | `RUN_LOG_MODE` | administrators | restart | `best_effort` | How much a run depends on its log: best_effort, or record, where a run whose log cannot be written whole fails. |
| `run_log.level` | `TRACE_LEVEL` | administrators | live | none | Whether runs are logged at all: full or off. |
| `run_log.retention_days` | `TRACE_RETENTION_DAYS` | administrators | restart | `30` | How many days the logs of runs that wrote nothing are kept. 0 keeps everything. |

#### `hosting`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `hosting.environment` | `ENVIRONMENT` | the machine | restart | `development` | Whether this is development, staging or production. |
| `hosting.web_base_url` | `PUBLIC_WEB_BASE_URL` | administrators | restart | `https://minerval.ai` | The address people reach the site at. |
| `hosting.api_base_url` | `PUBLIC_API_BASE_URL` | administrators | restart | `http://localhost:3000` | The address callers reach the API at. |
| `hosting.citation_url_base` | `CITATION_URL_BASE` | administrators | live | empty | The base of the permanent address a citation carries. Empty, it is the node's page. |
| `hosting.cors_origins` | `CORS_ORIGINS` | administrators | restart | empty | The other sites whose pages may call the API from a browser. |
| `hosting.host` | `HOST` | the machine | restart | `0.0.0.0` | The address the API listens on. |
| `hosting.port` | `PORT` | the machine | restart | `3000` | The port the API listens on. |
| `hosting.log_level` | `LOG_LEVEL` | administrators | restart | `info` | How much the API writes to its own log. |
| `hosting.anonymous_rate_limit_per_minute` | `ANONYMOUS_RATE_LIMIT_PER_MINUTE` | administrators | restart | `300` | Requests a minute one address may make without credentials. |
| `hosting.api_keys` | `API_KEYS` | the machine | restart |  | The service keys the API accepts, the web app's among them. |
| `hosting.operator_key` | `MINERVAL_OPERATOR_KEY` | the machine | restart |  | The operator key: the way back in when every administrator is gone. |

#### `database`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `database.host` | `DB_HOST` | the machine | restart | none | The database's host. |
| `database.port` | `DB_PORT` | the machine | restart | none | The database's port. |
| `database.name` | `DB_NAME` | the machine | restart | none | The database's name. |
| `database.user` | `DB_USERNAME` | the machine | restart | none | The role the API connects as. |
| `database.tls` | `DATABASE_TLS` | the machine | restart | none | "off" where the database is reached over the deployment's own network. |
| `database.ca_file` | `DATABASE_CA_FILE` | the machine | restart | none | The authority the database's certificate is checked against. |
| `database.sql_host` | `SQL_DB_HOST` | the machine | restart | none | The replica read-only SQL runs on. |
| `database.sql_port` | `SQL_DB_PORT` | the machine | restart | none | The replica's port. |
| `database.sql_agent_user` | `SQL_AGENT_DB_USERNAME` | the machine | restart | none | The role agents' read-only SQL connects as. |
| `database.sql_caller_user` | `SQL_CALLER_DB_USERNAME` | the machine | restart | none | The role callers' read-only SQL connects as. |
| `database.password` | `DB_PASSWORD` | the machine | restart |  | The database's password. |
| `database.url` | `DATABASE_URL` | the machine | restart |  | The database's connection string. |
| `database.sql_agent_url` | `SQL_AGENT_DATABASE_URL` | the machine | restart |  | The connection string of agents' read-only SQL. |
| `database.sql_caller_url` | `SQL_CALLER_DATABASE_URL` | the machine | restart |  | The connection string of callers' read-only SQL. |
| `database.sql_agent_password` | `SQL_AGENT_DB_PASSWORD` | the machine | restart |  | The password of agents' read-only SQL role. |
| `database.sql_caller_password` | `SQL_CALLER_DB_PASSWORD` | the machine | restart |  | The password of callers' read-only SQL role. |
| `database.cleared_role_password` | `CLEARED_ROLE_PASSWORD` | the machine | restart |  | The password of the role every connection held to a clearance logs in as. |

#### `pricing`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `pricing.owl_price_micro_usd` | `OWL_PRICE_MICRO_USD` | administrators | live | `4000000` | What one owl costs to buy, in millionths of a US dollar. |
| `pricing.owl_cost_micro_usd` | `OWL_COST_MICRO_USD` | administrators | live | `1000000` | What one owl of spend covers, in millionths of a US dollar of metered cost. |
| `pricing.owl_packs` | `OWL_PACKS` | administrators | live | `5:2000:Clutch,25:9000:Perch,100:30000:Wisdom,500:100000:P...` | The packs owls are sold in, each as owls:cents:name. |
| `pricing.signup_grant_owls` | `SIGNUP_GRANT_OWLS` | administrators | live | `10` | Owls a new account is given once. |
| `pricing.monthly_grant_owls` | `MONTHLY_GRANT_OWLS` | administrators | live | `1` | Owls every account is given each month. |
| `pricing.guest_ask_owls` | `GUEST_ASK_OWLS` | administrators | live | `5` | Owls a visitor with no account may spend talking to the Assistant. |
| `pricing.guest_ask_daily_owls` | `GUEST_ASK_DAILY_OWLS` | administrators | live | `100` | Owls given to all guests together over a day. |
| `pricing.guest_ask_per_address_per_day` | `GUEST_ASK_PER_ADDRESS_PER_DAY` | administrators | live | `1` | Guest conversations one address may start a day. |
| `pricing.cap_claim_proposal_owls` | `CAP_CLAIM_PROPOSAL_OWLS` | administrators | live | `2` | The most a proposed node costs its proposer. |
| `pricing.cap_assessment_owls` | `CAP_ASSESSMENT_OWLS` | administrators | live | `2` | The most an ordered assessment costs its buyer. |
| `pricing.cap_source_ingest_owls` | `CAP_SOURCE_INGEST_OWLS` | administrators | live | `10` | The most reading a submitted source costs. |
| `pricing.cap_extension_analysis_owls` | `CAP_EXTENSION_ANALYSIS_OWLS` | administrators | live | `1` | The most the analysis of one page costs, and that run's budget. |
| `pricing.cap_text_analysis_owls` | `CAP_TEXT_ANALYSIS_OWLS` | administrators | live | `0.1` | The most the analysis of a pasted text costs. |
| `pricing.owls` | `OWLS` | administrators | restart | `sold` | Whether owls are sold, or created by this deployment's administrators. |
| `pricing.model_price_refresh_hours` | `MODEL_PRICE_REFRESH_HOURS` | administrators | restart | `6` | How many hours apart the public lists of model prices are read. 0 never reads them. |
| `pricing.model_prices` | `MODEL_PRICES` | administrators | live | empty | Prices this deployment states for models, for one the catalog does not price or in place of the catalog's. |

#### `private_runs`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `private_runs.fetches` | `PRIVATE_RUN_FETCHES` | administrators | live | `any` | Whether a run that reads a private label may fetch any address, or only one the deployment was given. |

#### `publishing`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `publishing.hosting` | `DEPLOYMENT_HOSTING` | administrators | live | empty | Where this deployment runs, stated on every page it releases outside. |
| `publishing.signing_key` | `PUBLISH_SIGNING_KEY` | the machine | restart |  | The key pages released outside are signed with. |

#### `public_graph`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `public_graph.api_url` | `PUBLIC_GRAPH_API_URL` | administrators | restart | empty | The public graph's API address. |
| `public_graph.acts_by` | `PUBLIC_ACTS_BY` | administrators | live | `direct` | Which permission's holders may act on the public graph in the organization's name. |
| `public_graph.price` | `PUBLIC_GRAPH_PRICE` | administrators | restart | `metered` | How this deployment pays toward the public graph: metered or flat. |
| `public_graph.hosting_token` | `MINERVAL_HOSTING_TOKEN` | the machine | restart |  | The token Minerval's provisioning gives a deployment Minerval runs. |

#### `oidc`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `oidc.signing_key` | `OIDC_SIGNING_KEY` | the machine | restart |  | The key minerval.ai signs sign-in tokens with for organizations. |

#### `usage_report`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `usage_report.url` | `USAGE_REPORT_URL` | administrators | restart | empty | Another address usage reports are sent to, in place of the connection's. |
| `usage_report.dir` | `USAGE_REPORT_DIR` | the machine | restart | empty | A directory usage reports are written to as files, where the network does not join. |
| `usage_report.from` | `USAGE_REPORT_FROM` | administrators | live | empty | The first day reported, as YYYY-MM-DD. Empty, the first day anything was metered. |

#### `file_sets`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `file_sets.store_dir` | `FILE_SET_STORE_DIR` | the machine | restart | empty | The directory uploaded sets of files are kept in. |
| `file_sets.directory_root` | `FILE_SET_DIRECTORY_ROOT` | the machine | restart | empty | The directory that directories are registered from. |

#### `sandbox`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `sandbox.url` | `SANDBOX_URL` | the machine | restart | empty | The sandbox's address on this machine's network. |
| `sandbox.hour_cost_micro_usd` | `SANDBOX_HOUR_COST_MICRO_USD` | administrators | live | `50000` | What an hour of a command's time in the sandbox is charged to its run, in millionths of a US dollar. |
| `sandbox.token` | `SANDBOX_TOKEN` | the machine | restart |  | The token the API and the sandbox share. |

#### `connections`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `connections.credential_key` | `CREDENTIAL_ENCRYPTION_KEY` | the machine | restart |  | The key credentials and keys given in the app are sealed with. |
| `connections.previous_credential_keys` | `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` | the machine | restart |  | The keys that sealed credentials before the current one. |

#### `releases`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `releases.check` | `RELEASES_CHECK` | administrators | restart | `daily` | Whether this deployment reads the list of releases from the public graph: daily or never. |
| `releases.url` | `RELEASES_URL` | administrators | restart | `https://api.minerval.ai` | The address the list of releases is read from. |

#### `accounts`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `accounts.reads` | `READS` | the machine | restart | `open` | Whether anyone may read (open) or only signed-in members (members). |
| `accounts.first_administrator` | `FIRST_ADMINISTRATOR` | the machine | restart | empty | The sign-in identity made the first administrator, for an install that is scripted. |
| `accounts.members_label` | `MEMBERS_LABEL` | the machine | restart | empty | The name of the label for the organization's own material that every member reads. Left empty, it is members. |
| `accounts.published_label` | `PUBLISHED_LABEL` | the machine | restart | empty | The name of the label for what the organization released outside. Left empty, it is published. |
| `accounts.sign_in_valid_hours` | `SIGN_IN_VALID_HOURS` | the machine | restart | `12` | How many hours a sign-in vouches for the groups it carried. The web app reads the same variable. |

#### `budgets`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `budgets.paid_assessment_owls` | `PAID_ASSESSMENT_BUDGET_OWLS` | administrators | live | `5` | The budget a paid assessment's Steward pass works to. |
| `budgets.curate_run_owls` | `CURATE_RUN_BUDGET_OWLS` | administrators | live | `5` | The budget a Curator run works to. |
| `budgets.audit_run_owls` | `AUDIT_RUN_BUDGET_OWLS` | administrators | live | `5` | The budget an Audit run works to. |
| `budgets.officer_run_owls` | `OFFICER_RUN_BUDGET_OWLS` | administrators | live | `1` | The budget of a program officer's run over a mandate's inbox. |
| `budgets.default_officer_limit_owls` | `DEFAULT_OFFICER_LIMIT_OWLS` | administrators | live | `5` | The most a program officer commits in one decision, unless the mandate's policy says otherwise. |
| `budgets.default_review_pass_owls` | `DEFAULT_REVIEW_PASS_BUDGET_OWLS` | administrators | live | `5` | The budget of a mandate's review pass when its policy names none. |
| `budgets.review_pass_floor_owls` | `REVIEW_PASS_FLOOR_OWLS` | administrators | live | `1` | The least a review pass is started with. |
| `budgets.matcher_usd` | `MATCHER_BUDGET_USD` | administrators | live | `0.1` | What one Matcher decision may spend, in US dollars. |
| `budgets.contribution_review_estimate_usd` | `CONTRIBUTION_REVIEW_ESTIMATE_USD` | administrators | live | `0.25` | What a contribution's review is expected to cost, until there are reviews to average. |
| `budgets.contribution_review_usd` | `CONTRIBUTION_REVIEW_BUDGET_USD` | administrators | live | `1` | What one contribution review may spend, in US dollars. |
| `budgets.arbitration_usd` | `ARBITRATION_BUDGET_USD` | administrators | live | `3` | What one arbitration may spend, in US dollars. |
| `budgets.cap_lookout_run_owls` | `CAP_LOOKOUT_RUN_OWLS` | administrators | live | `0.05` | The most one lookout run costs. |
| `budgets.cap_correspondent_run_owls` | `CAP_CORRESPONDENT_RUN_OWLS` | administrators | live | `0.25` | The most one Correspondent run costs. |
| `budgets.cap_consistency_sweep_owls` | `CAP_CONSISTENCY_SWEEP_OWLS` | administrators | live | `2` | The most one standard consistency sweep costs. |
| `budgets.cap_consistency_sweep_strong_owls` | `CAP_CONSISTENCY_SWEEP_STRONG_OWLS` | administrators | live | `10` | The most one strong consistency sweep costs. |
| `budgets.background_daily_owls` | `BACKGROUND_DAILY_BUDGET_OWLS` | administrators | live | `50` | The background lane's spend a day. 0 is uncapped. |
| `budgets.contribution_award_owl_per_point` | `CONTRIBUTION_AWARD_OWL_PER_POINT` | administrators | live | `0` | Owls an accepted contribution earns per point. 0 awards none. |

#### `allocation`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `allocation.est_steward_run_cost_owls` | `EST_STEWARD_RUN_COST_OWLS` | administrators | live | `1.4` | What a Steward pass is expected to cost, until recent runs say. |
| `allocation.est_steward_run_cost_strong_owls` | `EST_STEWARD_RUN_COST_STRONG_OWLS` | administrators | live | `3.3` | What a strong Steward pass is expected to cost, until recent runs say. |
| `allocation.cost_estimate_window_days` | `COST_ESTIMATE_WINDOW_DAYS` | administrators | live | `14` | How many days of runs a cost estimate is taken from. |
| `allocation.cost_estimate_min_runs` | `COST_ESTIMATE_MIN_RUNS` | administrators | live | `5` | How many recent runs an estimate needs before it replaces the prior. |
| `allocation.cost_estimate_percentile` | `COST_ESTIMATE_PERCENTILE` | administrators | live | `0.8` | Which point of recent runs' costs the estimate takes, from 0 to 1. |
| `allocation.background_fallback_lane` | `BACKGROUND_FALLBACK_LANE_ENABLED` | administrators | live | `false` | Whether Steward runs go ahead with no General mandate behind them. |
| `allocation.mandate_review` | `MANDATE_REVIEW_ENABLED` | administrators | live | `true` | Whether mandates' own review passes are funded. |
| `allocation.mandate_review_move_fraction_per_pass` | `MANDATE_REVIEW_MOVE_FRACTION_PER_PASS` | administrators | live | `0.25` | The share of a mandate's escrow one review pass may move. |
| `allocation.mandate_review_move_fraction_per_day` | `MANDATE_REVIEW_MOVE_FRACTION_PER_DAY` | administrators | live | `0.5` | The share of a mandate's escrow its review passes may move in a day. |
| `allocation.lookout_runs` | `LOOKOUT_RUNS_ENABLED` | administrators | live | `true` | Whether lookout runs are funded. |
| `allocation.correspondent_runs` | `CORRESPONDENT_RUNS_ENABLED` | administrators | live | `true` | Whether Correspondent runs are funded. |
| `allocation.consistency_sweeps` | `CONSISTENCY_SWEEPS_ENABLED` | administrators | live | `false` | Whether the General mandate funds consistency sweeps. |
| `allocation.consistency_min_tag_claims` | `CONSISTENCY_MIN_TAG_CLAIMS` | administrators | live | `10` | How many nodes a tag needs to be swept on its own. |
| `allocation.officer_sittings` | `OFFICER_SITTINGS_ENABLED` | administrators | live | `false` | Whether program officers sit for inboxes no run is waiting on. |
| `allocation.sweep_interval_hours` | `ALLOCATION_SWEEP_INTERVAL_HOURS` | administrators | restart | `6` | How many hours apart priorities are refreshed and stale assessments looked for. 0 never does. |
| `allocation.staleness_base_days` | `STALENESS_BASE_DAYS` | administrators | live | `60` | How old an assessment is before it is due to be looked at again. |
| `allocation.grant_maintain_cadence_days` | `GRANT_MAINTAIN_CADENCE_DAYS` | administrators | live | `30` | How old an assessment in a mandate's scope is before a funded refresh is due. |
| `allocation.steward_max_iterations` | `STEWARD_MAX_ITERATIONS` | administrators | live | `200` | A backstop on the turns of one Steward run. |
| `allocation.steward_max_runs` | `STEWARD_MAX_RUNS` | administrators | live | `0` | Steward runs one process makes before it stops. 0 is no limit. |
| `allocation.curator_max_runs` | `CURATOR_MAX_RUNS` | administrators | live | `0` | Curator runs one process makes on the unfunded lane. 0 is no limit. |
| `allocation.steward_concurrency` | `STEWARD_CONCURRENCY` | administrators | restart | `8` | How many runs one process works at once. |
| `allocation.steward_enqueue_min_importance` | `STEWARD_ENQUEUE_MIN_IMPORTANCE` | administrators | live | `0.25` | The importance below which a new subclaim is not assessed on its own. |
| `allocation.proposed_claim_importance_prior` | `PROPOSED_CLAIM_IMPORTANCE_PRIOR` | administrators | live | `0.3` | The importance a proposed node starts at. |

#### `sessions`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `sessions.wait_hours` | `SESSION_WAIT_HOURS` | administrators | live | `24` | How long a paused run waits for what it asked for. |
| `sessions.max_transcript_chars` | `SESSION_MAX_TRANSCRIPT_CHARS` | administrators | live | `400000` | The longest transcript a paused run is resumed from. |
| `sessions.wait_for_answers_seconds` | `SESSION_WAIT_FOR_ANSWERS_SECONDS` | administrators | live | `60` | How long a run with nothing else to do holds on for an answer. |
| `sessions.officer_batch_ms` | `OFFICER_BATCH_MS` | administrators | live | `2000` | How long an officer waits so petitions that arrive together are decided together. |

#### `limits`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `limits.agentic_rate_limit_per_hour` | `AGENTIC_RATE_LIMIT_PER_HOUR` | administrators | live | `30` | Agentic requests an hour for a service key acting for no user. 0 is no limit. |
| `limits.contribution_rate_limit_per_hour` | `CONTRIBUTION_RATE_LIMIT_PER_HOUR` | administrators | live | `10` | Free contributions an hour for one contributor. 0 is no limit. |
| `limits.new_contributor_rate_limit_per_hour` | `NEW_CONTRIBUTOR_RATE_LIMIT_PER_HOUR` | administrators | live | `3` | The same, for a new or low-reputation contributor. |
| `limits.grant_conversation_rate_limit_per_hour` | `GRANT_CONVERSATION_RATE_LIMIT_PER_HOUR` | administrators | live | `30` | Turns an hour of a granting conversation for one person. 0 is no limit. |
| `limits.report_rate_limit_per_hour` | `REPORT_RATE_LIMIT_PER_HOUR` | administrators | live | `5` | Problem reports an hour from one outside caller. 0 is no limit. |
| `limits.llm_hourly_call_limit` | `LLM_HOURLY_CALL_LIMIT` | administrators | live | `0` | Model calls an hour for one process. 0 is no limit. |
| `limits.llm_daily_call_limit` | `LLM_DAILY_CALL_LIMIT` | administrators | live | `0` | Model calls a day for one process. 0 is no limit. |
| `limits.llm_hourly_token_limit` | `LLM_HOURLY_TOKEN_LIMIT` | administrators | live | `0` | Model tokens an hour for one process. 0 is no limit. |
| `limits.llm_daily_token_limit` | `LLM_DAILY_TOKEN_LIMIT` | administrators | live | `0` | Model tokens a day for one process. 0 is no limit. |
| `limits.extension_max_claims` | `EXTENSION_MAX_CLAIMS` | administrators | live | `25` | The most claims taken from one page the browser extension analyses. |
| `limits.published_page_max_bytes` | `PUBLISHED_PAGE_MAX_BYTES` | administrators | live | `4000000` | The largest released page a graph admits, in bytes. |
| `limits.file_set_upload_max_bytes` | `FILE_SET_UPLOAD_MAX_BYTES` | administrators | live | `10737418240` | The most bytes one uploaded set of files may hold. |
| `limits.public_read_max_age_seconds` | `PUBLIC_READ_MAX_AGE_SECONDS` | administrators | restart | `60` | How long a browser may reuse an anonymous read. |
| `limits.public_read_stale_while_revalidate_seconds` | `PUBLIC_READ_STALE_WHILE_REVALIDATE_SECONDS` | administrators | restart | `300` | How long a stale anonymous read may be served while a fresh one is fetched. |
| `limits.llm_request_timeout_ms` | `LLM_REQUEST_TIMEOUT_MS` | administrators | live | `180000` | How long one model call may take, in milliseconds. |
| `limits.llm_long_run_timeout_ms` | `LLM_LONG_RUN_TIMEOUT_MS` | administrators | live | `3600000` | How long one call of a long-run model may take, in milliseconds. |
| `limits.llm_max_retries` | `LLM_MAX_RETRIES` | administrators | live | `4` | How many times a failed model call is tried again. |

#### `sql`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `sql.agent_timeout_seconds` | `SQL_AGENT_TIMEOUT_SECONDS` | administrators | live | `20` | How long an agent's query may run. |
| `sql.caller_timeout_seconds` | `SQL_CALLER_TIMEOUT_SECONDS` | administrators | live | `5` | How long a caller's query may run. |
| `sql.max_plan_cost` | `SQL_MAX_PLAN_COST` | administrators | live | `500000` | The planner's estimate above which a query is refused before it runs. |
| `sql.free_allowance_seconds` | `SQL_FREE_ALLOWANCE_SECONDS` | administrators | live | `60` | A caller's free database time a day, in seconds. |
| `sql.paid_allowance_seconds` | `SQL_PAID_ALLOWANCE_SECONDS` | administrators | live | `600` | A caller's paid database time a day, in seconds. |
| `sql.owls_per_second` | `SQL_OWLS_PER_SECOND` | administrators | live | `0.01` | What a second of database time costs past the free allowance. |

#### `processing`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `processing.pipeline_epoch` | `PIPELINE_EPOCH` | administrators | live | `2026-10-assessment-as-thinking` | The cohort every new node is stamped with. |
| `processing.prompt_cache_ttl` | `PROMPT_CACHE_TTL` | administrators | live | `5m` | How long cached prompts live at the provider: 5m or 1h. |
| `processing.matching_top_k` | `MATCHING_TOP_K` | administrators | live | `20` | How many near nodes a match search returns. |
| `processing.extraction_max_tokens` | `EXTRACTION_MAX_TOKENS` | administrators | live | `16384` | The output allowance of one turn of the Extractor. |
| `processing.tagging_interval_seconds` | `TAGGING_INTERVAL_SECONDS` | administrators | restart | `30` | How often untagged nodes are tagged. 0 switches tagging off. |
| `processing.tagging_batch_size` | `TAGGING_BATCH_SIZE` | administrators | live | `5` | How many nodes one tagging pass takes. |
| `processing.contributions` | `ENABLE_CONTRIBUTIONS` | administrators | live | `false` | Whether contributions are taken. |
| `processing.url_extraction_concurrency` | `URL_EXTRACTION_CONCURRENCY` | administrators | restart | `3` | How many pages one process reads at once. |
| `processing.url_extraction_stall_minutes` | `URL_EXTRACTION_STALL_MINUTES` | administrators | restart | `15` | How long a page's reading may go without progress before it is given up. |
| `processing.queue_stall_minutes` | `QUEUE_STALL_MINUTES` | administrators | restart | `30` | How long any queued work may go without progress before it is given up. |
| `processing.queue_depth_sample_interval_hours` | `QUEUE_DEPTH_SAMPLE_INTERVAL_HOURS` | administrators | restart | `6` | How many hours apart the queues' depth is recorded. 0 never records it. |
| `processing.enqueue_events` | `ENQUEUE_EVENTS` | administrators | live | none | Whether each enqueue is recorded: on or off. |
| `processing.trace_always_agents` | `TRACE_ALWAYS_AGENTS` | administrators | live | `math_solver` | Agents whose runs are logged whatever the log's level. |
| `processing.label_posture` | `LABEL_POSTURE` | administrators | live | empty | Settings a label changes for its own runs, as JSON from a label's name to them. |
| `processing.usage_report_interval_seconds` | `USAGE_REPORT_INTERVAL_SECONDS` | administrators | restart | `3600` | How often closed days are looked for to report. |

#### `sweeps`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `sweeps.audit_interval_hours` | `AUDIT_SWEEP_INTERVAL_HOURS` | administrators | restart | `24` | How many hours apart the Audit Agent's periodic sweep runs. 0 never runs it. |
| `sweeps.audit_stale_suspension_days` | `AUDIT_STALE_SUSPENSION_DAYS` | administrators | live | `14` | How long a suspension stands before it is reviewed again. |
| `sweeps.monitor_interval_hours` | `MONITOR_SWEEP_INTERVAL_HOURS` | administrators | restart | `0` | How many hours apart the monitors' hits go to the Audit Agent. 0 never sends them. |
| `sweeps.monitor_reflag_days` | `MONITOR_REFLAG_DAYS` | administrators | live | `14` | How long before a node a monitor flagged may be flagged again. |
| `sweeps.monitor_max_flags` | `MONITOR_SWEEP_MAX_FLAGS` | administrators | live | `5` | The most nodes one monitor sweep hands to the Audit Agent. |
| `sweeps.monitor_settled_confidence` | `MONITOR_SETTLED_CONFIDENCE` | administrators | live | `0.8` | The confidence at which a monitor counts a verdict as settled. |
| `sweeps.monitor_material_credence_delta` | `MONITOR_MATERIAL_CREDENCE_DELTA` | administrators | live | `0.1` | How far credence must move for a monitor to call it material. |
| `sweeps.monitor_recent_challenge_days` | `MONITOR_RECENT_CHALLENGE_DAYS` | administrators | live | `30` | How recent an accepted challenge is for a monitor to count it as live. |
| `sweeps.monitor_monotonicity_tolerance` | `MONITOR_MONOTONICITY_TOLERANCE` | administrators | live | `0.05` | The move against new evidence a monitor puts down to noise. |
| `sweeps.monitor_monotonicity_horizon_days` | `MONITOR_MONOTONICITY_HORIZON_DAYS` | administrators | live | `30` | How long after a contribution a monitor looks for the reassessment. |
| `sweeps.report_triage_interval_hours` | `REPORT_TRIAGE_INTERVAL_HOURS` | administrators | restart | `24` | How many hours apart problem reports are triaged. 0 never triages. |
| `sweeps.report_match_similarity` | `REPORT_MATCH_SIMILARITY` | administrators | live | `0.8` | How alike two problem reports are before one is shown as related to the other. |
| `sweeps.report_embedding_backfill_per_tick` | `REPORT_EMBEDDING_BACKFILL_PER_TICK` | administrators | restart | `20` | Reports given an embedding in one pass. 0 switches the pass off. |
| `sweeps.report_embedding_backfill_interval_seconds` | `REPORT_EMBEDDING_BACKFILL_INTERVAL_SECONDS` | administrators | restart | `300` | How often that pass runs. |
| `sweeps.source_backfill_per_tick` | `SOURCE_BACKFILL_PER_TICK` | administrators | restart | `20` | Sources whose facts are filled in one pass. 0 switches the pass off. |
| `sweeps.source_backfill_interval_seconds` | `SOURCE_BACKFILL_INTERVAL_SECONDS` | administrators | restart | `120` | How often that pass runs. |
| `sweeps.github_issues_backfill_per_tick` | `GITHUB_ISSUES_BACKFILL_PER_TICK` | administrators | restart | `20` | Reports filed as issues in one pass. 0 switches the pass off. |
| `sweeps.github_issues_sync_interval_seconds` | `GITHUB_ISSUES_SYNC_INTERVAL_SECONDS` | administrators | restart | `300` | How often that pass runs. |
| `sweeps.lookout_retraction_poll_hours` | `LOOKOUT_RETRACTION_POLL_HOURS` | administrators | restart | `24` | How many hours apart retractions are looked for. 0 never looks. |
| `sweeps.lookout_feed_poll_max_feeds` | `LOOKOUT_FEED_POLL_MAX_FEEDS` | administrators | live | `100` | How many feeds one pass polls. 0 polls none. |

#### `researcher`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `researcher.enabled` | `RESEARCHER_ENABLED` | administrators | live | `false` | Whether new research runs may be launched. |
| `researcher.daily_cap_owls` | `RESEARCHER_DAILY_CAP_OWLS` | administrators | live | `50` | The most researcher runs that no funder pays for spend in a day. |
| `researcher.request_max_wall_minutes` | `RESEARCHER_REQUEST_MAX_WALL_MINUTES` | administrators | live | `240` | A backstop on how long one research run may go on. |

#### `mathematics`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `mathematics.lean_checker_url` | `LEAN_CHECKER_URL` | the machine | restart | empty | The Lean checker's address on this machine's network. |
| `mathematics.lean_checker_token` | `LEAN_CHECKER_TOKEN` | the machine | restart |  | The token the API and the Lean checker share. |
| `mathematics.lean_cpu_hour_cost_micro_usd` | `LEAN_CPU_HOUR_COST_MICRO_USD` | administrators | live | `200000` | What an hour of the checker's processor is charged at, in millionths of a US dollar. |
| `mathematics.lean_check_overhead_micro_usd` | `LEAN_CHECK_OVERHEAD_MICRO_USD` | administrators | live | `20000` | What every check is charged besides its time, in millionths of a US dollar. |
| `mathematics.formalization_review_period_days` | `FORMALIZATION_REVIEW_PERIOD_DAYS` | administrators | live | `14` | How long a published statement is public before a bounty may bind to it. |
| `mathematics.formalization_review_award_owls` | `FORMALIZATION_REVIEW_AWARD_OWLS` | administrators | live | `100` | What a challenge to a statement upheld in that time earns. |
| `mathematics.solver_enabled` | `SOLVER_ENABLED` | administrators | restart | `false` | Whether the solver takes proof attempts. |
| `mathematics.solver_daily_cap_owls` | `SOLVER_DAILY_CAP_OWLS` | administrators | live | `400` | The most the solver spends in a day. |
| `mathematics.solver_calibration_daily_cap_owls` | `SOLVER_CALIBRATION_DAILY_CAP_OWLS` | administrators | live | `100` | The most the solver's calibration runs spend in a day. |
| `mathematics.attempt_overage_fraction` | `ATTEMPT_OVERAGE_FRACTION` | administrators | live | `0.25` | How far past its estimate a proof attempt may spend, as a share of the estimate. |
| `mathematics.max_bounty_per_claim_owls` | `MAX_BOUNTY_PER_CLAIM_OWLS` | administrators | live | `5000` | The largest bounty on one statement. |
| `mathematics.min_bounty_per_claim_owls` | `MIN_BOUNTY_PER_CLAIM_OWLS` | administrators | live | `250` | The smallest bounty on one statement. |
| `mathematics.bounty_escrow_fraction_per_pass` | `BOUNTY_ESCROW_FRACTION_PER_PASS` | administrators | live | `0.4` | The share of a mandate's escrow one review pass may commit to bounties. |
| `mathematics.bounty_escrow_fraction_per_day` | `BOUNTY_ESCROW_FRACTION_PER_DAY` | administrators | live | `0.5` | The share of a mandate's escrow committed to bounties in a day. |
| `mathematics.bounty_autonomy_threshold_owls` | `BOUNTY_AUTONOMY_THRESHOLD_OWLS` | administrators | live | `1000` | The bounty at or above which a person must confirm the posting. |
| `mathematics.bounty_notice_days` | `BOUNTY_NOTICE_DAYS` | administrators | live | `30` | The public notice a bounty's withdrawal is given. |
| `mathematics.bounty_default_expiry_days` | `BOUNTY_DEFAULT_EXPIRY_DAYS` | administrators | live | `365` | How long a bounty stands unless it is renewed. |
| `mathematics.prize_human_signoff_owls` | `PRIZE_HUMAN_SIGNOFF_OWLS` | administrators | live | `1000` | The bounty at or above which a prize needs a person's sign-off. |
| `mathematics.prize_human_signoff_importance` | `PRIZE_HUMAN_SIGNOFF_IMPORTANCE` | administrators | live | `0.6` | The importance at or above which a prize needs a person's sign-off. |
| `mathematics.prize_challenge_window_days_small` | `PRIZE_CHALLENGE_WINDOW_DAYS_SMALL` | administrators | live | `14` | The days between a small prize's acceptance and its payment. Never under 14. |
| `mathematics.prize_challenge_window_days_large` | `PRIZE_CHALLENGE_WINDOW_DAYS_LARGE` | administrators | live | `30` | The same, for a large prize. |
| `mathematics.prize_window_tier_owls` | `PRIZE_WINDOW_TIER_OWLS` | administrators | live | `1000` | The bounty at or above which a prize is a large one. |
| `mathematics.prize_payee_steps_days` | `PRIZE_PAYEE_STEPS_DAYS` | administrators | live | `90` | How long a winner has to complete their steps before the prize is forfeit. |
| `mathematics.prize_review_reserve_fraction` | `PRIZE_REVIEW_RESERVE_FRACTION` | administrators | live | `0.1` | The share of a bounty held back to pay for reviewing claims on it. |
| `mathematics.prize_defect_award_fraction` | `PRIZE_DEFECT_AWARD_FRACTION` | administrators | live | `0.1` | The share of a bounty a claimant earns for exposing a defect in the statement. |
| `mathematics.prize_defect_award_cap_owls` | `PRIZE_DEFECT_AWARD_CAP_OWLS` | administrators | live | `500` | The most such an award pays. |
| `mathematics.prize_owl_tranche_owls` | `PRIZE_OWL_TRANCHE_OWLS` | administrators | live | `2000` | The most owls of a prize granted in one day. |
| `mathematics.prize_check_max_concurrent` | `PRIZE_CHECK_MAX_CONCURRENT` | administrators | live | `2` | How many prize claims are checked at once. |
| `mathematics.prize_checks_per_day` | `PRIZE_CHECKS_PER_DAY` | administrators | live | `50` | How many prize claims are checked in a day. |
| `mathematics.prize_check_reclaim_minutes` | `PRIZE_CHECK_RECLAIM_MINUTES` | administrators | live | `30` | How long before a check whose worker died is taken up again. |
| `mathematics.prize_check_max_attempts` | `PRIZE_CHECK_MAX_ATTEMPTS` | administrators | live | `3` | How many times a check that failed on the checker's side is tried. |
| `mathematics.prize_claims_per_statement_per_30_days` | `PRIZE_CLAIMS_PER_STATEMENT_PER_30_DAYS` | administrators | live | `3` | Prize claims one statement takes in 30 days. |
| `mathematics.prize_claims_per_day_platform` | `PRIZE_CLAIMS_PER_DAY_PLATFORM` | administrators | live | `5` | Prize claims taken in a day across the deployment. |
| `mathematics.mandate_escrow_owls` | `MATH_MANDATE_ESCROW_OWLS` | administrators | live | `2500` | The Mathematics mandate's escrow when it is seeded. |
| `mathematics.mandate_daily_owls` | `MATH_MANDATE_DAILY_OWLS` | administrators | live | `200` | The Mathematics mandate's pace a day when it is seeded. |
| `mathematics.prizes_escrow_owls` | `MATH_PRIZES_ESCROW_OWLS` | administrators | live | `2500` | The prizes mandate's escrow when it is seeded. |

#### `mirror`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `mirror.publish` | `MIRROR_PUBLISH` | administrators | restart | `false` | Whether this deployment publishes a signed feed of its public rows. |
| `mirror.publisher_worker` | `MIRROR_PUBLISHER_WORKER` | the machine | restart | `false` | Whether the feed is cut in a process of its own. |
| `mirror.publish_interval_seconds` | `MIRROR_PUBLISH_INTERVAL_SECONDS` | administrators | restart | `900` | How often the feed is cut. |
| `mirror.batch_max_bytes` | `MIRROR_BATCH_MAX_BYTES` | administrators | restart | `8000000` | The most bytes of rows one batch of the feed holds. |
| `mirror.feed_url` | `MIRROR_FEED_URL` | administrators | restart | empty | The publisher's address this deployment's mirror is fed from. |
| `mirror.feed_dir` | `MIRROR_FEED_DIR` | the machine | restart | empty | A directory of batch files the mirror is fed from, where the network does not reach. |
| `mirror.feed_public_keys` | `MIRROR_FEED_PUBLIC_KEYS` | administrators | restart | empty | The keys a batch of the feed must be signed with to be applied. |
| `mirror.feed_next_public_keys` | `MIRROR_FEED_NEXT_PUBLIC_KEYS` | administrators | restart | empty | The keys this deployment's feed will sign with next. |
| `mirror.apply_interval_seconds` | `MIRROR_APPLY_INTERVAL_SECONDS` | administrators | restart | `300` | How often the mirror is brought up to its feed. |
| `mirror.signing_key` | `MIRROR_SIGNING_KEY` | the machine | restart |  | The key this deployment's feed is signed with. |

#### `queues`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `queues.url_extraction` | `SQS_URL_EXTRACTION_QUEUE` | the machine | restart | empty | The queue of pages to read. |
| `queues.claim_pipeline` | `SQS_CLAIM_PIPELINE_QUEUE` | the machine | restart | empty | The queue of claims to place. |
| `queues.contribution` | `SQS_CONTRIBUTION_QUEUE` | the machine | restart | empty | The queue of contributions to review. |
| `queues.arbitration` | `SQS_ARBITRATION_QUEUE` | the machine | restart | empty | The queue of appeals to arbitrate. |
| `queues.steward` | `SQS_STEWARD_QUEUE` | the machine | restart | empty | The Steward's queue. |
| `queues.aws_region` | `AWS_REGION` | the machine | restart | `us-east-1` | The region the queues are in. |

#### `build`

| Setting | Environment variable | Changed by | Applies | Default | What it decides |
|---|---|---|---|---|---|
| `build.commit` | `MINERVAL_COMMIT` | the machine | restart | none | The commit the running code was built from. Set when the image is built. |
| `build.version` | `MINERVAL_VERSION` | the machine | restart | empty | The version the running code was built as. Set when the image is built. |

#### Retired

| Environment variable | Retired in | In its place |
|---|---|---|
| `EXTRACTOR_FALLBACK_MODEL` | 0.2.0 | a model's refusal is no longer retried on another model (#1044); the Extractor's refusal is shown as one |
| `PUBLIC_GRAPH_API_KEY` | 0.2.0 | the connection to minerval.ai, made on the Overview |
| `MIRROR_FEED_API_KEY` | 0.2.0 | the connection to minerval.ai, made on the Overview |
| `USAGE_REPORT_API_KEY` | 0.2.0 | the connection to minerval.ai, made on the Overview |

<!-- settings-table:end -->
