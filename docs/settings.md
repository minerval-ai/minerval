# Settings an administrator changes in the app

A design, not yet built ("Phases", at the end). It moves the settings that
are choices about how a deployment works out of the machine's environment
and into the deployment's database, where administrators change them in the
web app, over the API and over MCP, each change logged and most in force
within seconds. What stays on the machine is the short list of settings the
app cannot or must not change ("What stays on the machine").

## What is wrong today

`src/config.ts` reads 275 environment variables. The config file
([deployment.md](deployment.md)) names 64 of them; the rest are environment
variables only, set in `deploy/.env` or `deploy/api.env`. All of them are
read once, when the process starts (`loadConfig`, which keeps the first
answer for the life of the process), and 170 files read that answer.

So every setting, however ordinary, is changed the same way: someone with
a shell on the machine edits a file and restarts the deployment. That is
wrong in five ways:

- **The people who decide are not the people who can change it.** Which
  model the Steward runs on, whether mathematics is on, what a run may
  spend: these are the administrators' decisions, and they cannot make them.
  Health tells them what is wrong and that "the operator" puts it right
  ([deployment.md](deployment.md), "The setup checklist").
- **Nothing records a change.** A setting changed in `api.env` leaves no
  entry in the administrative log, no name and no reason. Every other
  administrative act is logged.
- **A bad value cannot be put right from where it is seen.** Health names
  the setting and the value to use, and the person reading it can do
  nothing with that.
- **Files on the machine go stale.** `api.env` is the operator's, ignored by
  git, never touched by an upgrade. A value pinned there outlives a change
  to its default, and a misspelt or retired name is read by nothing and
  says nothing ([releases.md](releases.md), "What is wrong today").
- **A deployment cannot be set up without a shell.** The models of six
  roles must be in `.env` before the API starts, beside the secrets, and
  the first administrator is named there too.

None of this was decided. Settings were read from the environment because
that is the convention, and read once because nothing yet needed more.

What is right today and stays: which model providers and outside services
each label may be sent to was moved in exactly this way, and works
([architecture.md](architecture.md), "Providers cleared by label";
`src/services/provider-clearance-service.ts`). It is a table, written by
holders of `clear_providers` on the labels page, each change logged, in
force in every process within `STORED_CLEARANCE_RECHECK_MS` (5 seconds);
and where `PROVIDER_LABELS` is set, the machine's setting fixes it, and the
page shows it fixed. This design does the same for the other settings.

## What stays on the machine

A setting stays on the machine, and the app never changes it, when it is
one of three kinds.

| Kind | Settings | Why |
| --- | --- | --- |
| **Needed before the database answers** | `[database]` and `DATABASE_URL`; `hosting.environment`, `hosting.host`, `hosting.port`; `READS` (fixed by the Compose file) | The settings table is in the database. |
| **The trust root** | `AUTH_SECRET`, `API_KEYS`/`WEB_API_KEY`, `SANDBOX_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY` and its previous keys, `MINERVAL_OPERATOR_KEY`, the database's passwords, `CLEARED_ROLE_PASSWORD` | Whoever could change these from the app would hold the machine: an administrator could seal credentials under a key of their choosing, or give themselves the operator key, which is the way back when every administrator is gone ([accounts.md](accounts.md), "The first administrator"). The split between who runs the machine and who runs the graph rests on these. |
| **Facts about the machine** | `sandbox.url`, `file_sets.store_dir`, `file_sets.directory_root`, `REGISTERED_DIR`, the queues (`SQS_*`, `AWS_REGION`), the SQL replica's address and roles, `LEAN_CHECKER_URL`; and the web app's sign-in client (`AUTH_OIDC_*`) | They say where things are on this machine and its network, not what the deployment should do. Changing one in the app would point it at something that is not there. Sign-in cannot be set from a page reached by signing in. |

That is a few dozen settings. Everything else is a choice, and is the
administrators'.

## What moves

The rest, in groups as the config file has them:

| Group | Examples | Applies |
| --- | --- | --- |
| `[models]`, `[model_providers]`, `[[pricing.model_prices]]` | The model each role runs on; OpenRouter's host sort; the price of a model the catalog does not price | live |
| `[[model_providers.endpoints]]` | A model endpoint of the organization's own: its address and prices | live |
| `[features]` | Mathematics, prizes, the browser extension | restart |
| `[outside_services]` | Elicit, Pangram, GitHub issues: on or off, address, price per call | live |
| `[run_log]` | Level, retention | live |
| `[pricing]` | `owls`, caps, grants, packs | live |
| `[private_runs]`, `[publishing]`, `[public_graph]`, `[usage_report]` | What private runs fetch, hosting, where acts go, the price, where reports go | live |
| `[hosting]`, the rest | The site's addresses, CORS origins, the log level, the anonymous rate limit | restart |
| The tuning that has no group today | Budgets and caps on runs, priors, the schedulers' intervals, the sweeps' thresholds, rate limits, timeouts and retries, the solver's and the researcher's switches, the mathematics mandates and prizes | mostly live |

The tuning settings move with the rest. That they are rarely changed is a
reason they need no prominent page, not a reason an administrator should
need a shell to change one. Where a tuning setting is a count that limits
an agent, moving it is a good time to ask whether a budget should replace it
(CLAUDE.md, "Constraints on agents"); that is a separate change, setting by
setting, and not part of this design.

**Some changes need guards.** These are rules on a setting, checked when it
is changed, and not reasons to keep it on the machine:

- `pricing.owls`, from `sold` to `created` or back, is refused while any
  account holds owls of the other kind; the refusal says how many and
  where.
- Switching a feature off is refused while it holds work that would be
  stranded (a running solver attempt, an open prize claim), naming it.
- `run_log.mode` stays on the machine where a label besides `public` is
  defined. A deployment that holds private material keeps its whole log
  ([run-log.md](run-log.md), "Record mode"), and loosening that is the operator's to
  decide, not an administrator's. Before the first label it moves with the
  rest.

## Keys issued by someone else

The model providers' keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, an endpoint's `key_env`), Elicit's and Pangram's,
Stripe's, the GitHub App's, and the old public-graph keys are secrets, but
not the trust root: someone outside issued them, and the deployment only
presents them. A credential given on a connection's page is already this
kind of secret, and is held sealed in the database under
`CREDENTIAL_ENCRYPTION_KEY`, written and never read back
([connections.md](connections.md), "A credential given here").

They move the same way. An administrator gives a key on the setting's page;
it is sealed as connection credentials are; the page shows that one is set,
its last four characters, who set it and when, and never the key. The
environment variable of the same name still fixes it where it is set.

So a deployment can be set up by someone with no shell on the machine, once
the operator has started it with the trust root and the facts about the
machine. That is the point of separating the two.

## One registry

`CONFIG_FILE_KEYS` in `src/config-file.ts` already has a row for each
setting in the file: its name there, its environment variable and the
config field it fills, with the values checked by the config schema itself
(`configFieldProblem`), so the schema is written once. It becomes the
registry of every setting, all 275, each row gaining three facts:

| Fact | |
| --- | --- |
| `where` | `machine` (stays on the machine), `app` (moves) or `app_secret` (moves, sealed). |
| `applies` | `live`, or `restart` for a setting read only where the process starts: a listening port, the set of workers started, a feature's routes. |
| `retired` | For a setting no longer read: the release it was retired in and what replaced it ([releases.md](releases.md)). |

A test fails on a setting `config.ts` reads that has no row, as the
parity tests do for routes, so a new setting is given a place when it is
added.

**A new check: `unknown_settings`.** The preflight lists every environment
variable the API was given that looks like a setting (by the registry's
prefixes) and is not in the registry, with the nearest name
(`STEWRD_MODEL`: did you mean `STEWARD_MODEL`?), and every retired one,
with what replaced it. It does not block.

## How a value is chosen

Four layers, in this order, the first that has a value winning:

1. **The environment.** What the operator put in `.env`, `api.env` or the
   process's environment.
2. **The config file.** What the operator wrote in `minerval.toml`.
3. **The database.** What an administrator set in the app.
4. **The code's default.**

The first two are the operator's, and either fixes the setting: the app
shows it, says it is fixed by whoever runs the machine, names the file or
variable it comes from, and does not offer to change it. That keeps the
operator in charge where they choose to be, keeps scripted installs working
unchanged, and is how `PROVIDER_LABELS` works today.

This changes one thing in [deployment.md](deployment.md): the setup page it
foresees writes the database, not the config file. `renderConfigFile` and
`writeConfigFile` stay, for an administrator to download the deployment's
settings as a file, to start another deployment the same way or to hand a
setting to the operator to fix.

## Changing a setting

**Who.** Holders of `administer`, from a signed-in session. Whether a
setting that decides where text goes should need `clear_providers` too is a
question for review; clearance already gates every call at a private label,
so choosing a model cannot send text anywhere a holder of `clear_providers`
has not allowed.

**Checked before it is saved.** A value is checked by the schema
(`configFieldProblem`), and then the whole configuration with the new value
in it is run through the preflight's checks that do not call out. A change
that would make a blocking check fail is refused with that check's
sentence; one that would make another check fail is saved, and the answer
carries the check's sentence. So the `owls` and `model_prices` checks,
which today say what is wrong after the fact, say it before.

**Logged.** Each change writes an entry to `administrative_events`
(`setting_changed`) in the same transaction: the setting, the value before
and after (for a secret, that one was set or removed), who, and a reason
the person may give. The settings table keeps no history of its own; the
log is it.

**Back to the default.** Removing a setting's row returns it to the code's
default, and is logged the same way. The page says what the default is, and
whether it changed in a release since the value was set
([releases.md](releases.md), "Release notes"), with "use the new default"
beside it.

**In force.** A `live` setting is in force in the process that changed it
at once, and in every other within a few seconds: each process keeps the
last copy it read and reads the table again when that copy is older than
the recheck interval, as provider clearance does. `loadConfig` becomes the
read of that copy, so the 170 files that read it read the current value
without changing. A `restart` setting is saved and marked as waiting; Health
says which wait, since when, and who changed them. A restart button, for
holders of `administer`, ends the API's process gracefully, which the
Compose file's `restart: unless-stopped` starts again; it is logged.

## Routes and tools

| Route | |
| --- | --- |
| `GET /settings` | Every setting in the registry: its value, which layer it comes from, its default, whether it applies live, whether a change waits for a restart, and for a secret only whether it is set. For holders of `administer`. |
| `PUT /settings/:key` | Set a value, with a reason. |
| `DELETE /settings/:key` | Return it to the default, with a reason. |
| `POST /setup/restart` | End the process, to be started again. |

On MCP the read is a tool, `list_settings`. The writes are tools too,
`set_setting` and `reset_setting`, classified in
`src/llm/tools/assistant-tools.ts` as held for the user: each can change
what the deployment spends and where text goes. A secret cannot be given
over MCP, so that no key passes through a model's context, and the tool
says to give it on the page. The restart is excluded from MCP: it ends
every run in flight, and is a person's act in their session.

Each write names no label in `src/server/request-labels.ts`
(`rule: "none"`, administration): a setting is the deployment's, not any
row's.

## The pages

`/admin/settings`, in groups as the table above has them, each setting with
its sentence from the registry, its value and where it comes from. The
settings that matter at setup (the models, the features, the owls, the
organization's name) are also asked for in order on Health's first-day view,
so that a new deployment is set up there; the same rows, not a second way to
set them.

The first-day view also takes the two steps that today need the machine:

- **Naming the organization.** The organization's own party is made under
  "This organization" when the first administrator signs in
  ([accounts.md](accounts.md), "The first administrator"), and given its
  name today only by adding a party marked as the organization while it
  still has that one. The first-day view asks for the name, and a party's
  name can be changed afterwards (`PATCH /parties/:id`, logged with the old
  name), which it cannot be today.
- **Becoming the first administrator.** In place of putting one's identity
  in `FIRST_ADMINISTRATOR` and starting again, the API, on its first start
  with no administrator, prints a one-time code in its log; the first person
  to sign in and give it is the first administrator. The code works once and
  for a day, and `FIRST_ADMINISTRATOR` still works, for installs that are
  scripted.

## Phases

1. **The registry.** Every setting given its row and its three facts, the
   test that fails on a setting without one, and the `unknown_settings`
   check. Nothing moves yet; the preflight starts naming stale files.
2. **The table and the read.** `deployment_settings`, the four layers,
   `loadConfig` reading the current copy, the routes and tools, the log
   entry, the checks before saving. The models and the outside services
   first, as they matter most at setup.
3. **The pages.** `/admin/settings`, Health's first-day view, the
   organization's name and `PATCH /parties/:id`, and the restart.
4. **Keys issued by someone else.** Sealed in the database, given on the
   page.
5. **The first administrator's code.**
6. **The rest of the tuning.** Every remaining `app` setting moved, and
   `deploy/env.example` cut to the settings that stay on the machine.

Each phase does what CLAUDE.md asks of a new route (its MCP side, its label,
the Assistant's classification, the page table in
`plugin/skills/using-minerval/SKILL.md`), and the caller skills where a
tool is added.

## Questions for review

- **Should the database win over the config file?** The order above lets
  an operator's file fix a setting, as the environment does. The
  alternative is that the file is a starting point the app may change,
  which suits an install that is set up once from a file and then run from
  the app, and makes "who fixed this" harder to say.
- **`administer` alone, or `clear_providers` for the models too?** Above.
- **Which tuning settings should become budgets instead of moving?** A
  list, setting by setting, is its own piece of work.
- **The trust root's edge.** `CORS_ORIGINS` moves above; it decides which
  other sites' pages may call the API from a browser, which is close to the
  trust root. It could stay on the machine instead.
