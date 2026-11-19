# Running a private Minerval on your own machine

This page is for whoever installs it. It says what the package in `deploy/`
stands up, the steps in order, and what the package does not do yet. It
says only what works today.

## What you get

One Docker Compose file, `deploy/compose.yml`, that runs four containers on
one machine:

| Container | What it is |
| --- | --- |
| `postgres` | Postgres 16 with pgvector. It holds everything: the graph, the ledger, the run log. |
| `api` | The API and, in the same process, the workers that run the agents' work. It applies the database migrations each time it starts. |
| `web` | The web app, built so that nothing is shown to anyone who has not signed in. |
| `sandbox` | Where agents run commands over file sets. It has no route to any network but the API's. |

The deployment is members-only: every page and every API route needs a
signed-in person or a key. People sign in through your own identity
provider (OpenID Connect). What a signed-in person may do follows from the
permissions your administrators grant in the web app.

Nothing is set up for any particular kind of organization. The deployment
starts with public Minerval's own settings and you change the ones you need.

## What you need first

- A Linux machine with Docker Engine and the Compose plugin (`docker compose
  version` answers). The package was tried with Docker Engine 29 and
  Compose 5.
- **A kernel with Landlock, for the sandbox**: Linux 5.13 or later with
  `landlock` among the active security modules, which current distributions
  have. The sandbox uses it to hold each command to the file sets its own
  run may read. Without it the sandbox still starts, says why in its health
  answer, and runs no command: file sets can be added and nothing can
  explore them, while everything else works. On Linux before 6.7 a command
  is kept off the network by the container's network alone, and before 6.12
  a command can signal another run's commands (it can end them, and cannot
  read anything of theirs). `sandbox/README.md` has the detail.
- About 4 GB of disk for the images (as built here: the sandbox 1.6 GB, the
  web app 1.1 GB, the API 0.7 GB, Postgres 0.65 GB), about as much again
  while they are being built, and room for the database and your files.
- An identity provider that speaks OpenID Connect, and a client registered
  with it for this deployment. The callback address to register is
  `<your site address>/api/auth/callback/oidc`.
- A key for at least one model provider, or a model endpoint of your own
  that speaks the OpenAI Chat Completions API, and a decision about which
  model each role runs on. Matching and search need an embeddings key
  (OpenAI's). Six roles start on OpenRouter (the program officers, the
  Matcher, the tagger, the lookouts, the Consistency Checker and the
  Researcher's cheap tier); `deploy/env.example`, section 5, names their
  settings. Open-web search needs an OpenRouter key whatever model a role
  runs on, unless that model is a current Claude model (Fable, Mythos,
  Opus 4.6 and later, Sonnet 4.6 and later, Haiku 5.5), which searches
  inside Anthropic's API: every other model, OpenAI's and an endpoint of your own
  included, searches through OpenRouter, and at a label other than
  `public` that needs `web_search` cleared for the label. So a deployment
  without OpenRouter puts every role that searches on one of those Claude
  models.
- The address people will open the site at. The package does not terminate
  TLS: put your own reverse proxy in front of the web app's port.

## The steps

1. **Get the code.** Clone the repository onto the machine. The images are
   built from it; none is published to a registry.

2. **Write the settings file.**

   ```
   cd deploy
   cp env.example .env
   ```

   Open `.env`. Every setting has a comment saying what it is. The lines
   that are not commented out have no starting value and must be filled in:
   the site's address, three passwords and keys of the deployment's own
   (`openssl rand -hex 32` makes one), your identity provider's three
   values, and the model for each of six roles (and the solver's, unless
   you switch mathematics off with `FEATURES_OFF`). Leave the rest commented
   out unless you want to change them.

   `.env` is the one place this deployment's secrets live. It is ignored by
   git and is in no Docker volume, so keep a copy off the machine ("No
   backups", below, says which values cannot be made again). A setting in
   your shell's environment with the same name wins over `.env`, so run
   the commands below from a shell that does not carry, say, an
   `OPENAI_API_KEY` meant for something else.

   One choice most deployments make here:

   - `OWLS=created`, if you pay your model providers yourself. Your
     administrators then create the owls that budget the agents' work. Left
     as it starts (`sold`), owls are bought through Stripe.

   Which model providers and outside services may be sent the text of each
   label you define is chosen in the web app, where the label is defined
   (step 8), and needs nothing here. Leave `PROVIDER_LABELS` unset unless
   you want that decided only by whoever runs the machine: set, it fixes
   the clearance for every label, and the labels page then only shows it.

   The package starts `RUN_LOG_MODE` at `record`, where every run's log is
   kept whole. Leave it: once a label is defined, a deployment on
   `best_effort` starts no agent work.

   To work beside the public graph and publish to it, fill in section 8 of
   `env.example` as well ("The public graph", below). It can wait until
   the deployment runs.

3. **Build the images.**

   ```
   docker compose build
   ```

   This builds three images from the repository (the API, the web app and
   the sandbox) and takes several minutes. It downloads packages from npm,
   PyPI, Debian and Alpine.

4. **Start it.**

   ```
   docker compose up -d
   docker compose logs -f api
   ```

   The first start creates the database: the `postgres` container makes the
   role the API connects as (`minerval_owner`, which owns the tables and is
   not a superuser) and two extensions. The API then applies every
   migration, which makes the role that reads are held through
   (`minerval_cleared`), and runs the enforcement step. In the log you
   should see `Running database migrations...`, `Migrations complete.` and
   then `Server listening`. On a new deployment the enforcement step has
   nothing to hold yet and prints nothing: the database starts holding
   reads to a clearance when you define your first label (step 7).

   To check later without watching the log, either of these will do:

   ```
   docker compose ps
   docker compose logs api | grep -E "Migrations complete|Server listening"
   ```

   The first shows `api` as `healthy` once it answers its health check
   (every 30 seconds, from the image; `web` starts only after that). The
   second finds the two lines however long ago they were printed. The
   health checks themselves are not logged unless they fail.

   If `docker compose` stops with `Set X in .env`, that setting is empty.
   If the API's log ends in an error that names `SOLVER_MODEL`, mathematics
   is on and the solver's model is missing or is not one the API accepts
   (`env.example` says which it does). With mathematics in `FEATURES_OFF`
   the setting is not read.

5. **Sign in and become the first administrator.** Open the site. You are
   asked to sign in, and sent to your identity provider. If you did not set
   `FIRST_ADMINISTRATOR`, the page you land on shows your sign-in identity
   (`oidc:` and your subject at the provider). Put it in `.env` as
   `FIRST_ADMINISTRATOR`, run `docker compose up -d` again, and sign in
   again. The first sign-in by that identity, while the deployment has never
   had an administrator, is granted every permission. It works once.

6. **Open Health.** It is the page at `/admin`, under Admin in the sidebar.
   It reads the deployment and says what needs someone now: the deployment's own checks
   of its configuration (the preflight; [deployment.md](deployment.md),
   "Preflight"), then permissions, labels, the General mandate, owls and
   material, each item marked as one the deployment's operator or an
   administrator puts right. Read what the checks say fails: a wrong setting
   is named there with what to change. Once a label is defined, agent work does not start
   until the checks that block it pass, and the API's log says which.

7. **Define your labels.** On `/admin/labels`, define a label and say which
   labels it reads. Defining the first one takes about ten seconds: the
   database turns enforcement on first, so that no row can carry the label
   before every read is held to a clearance. To confirm it afterwards:

   ```
   docker compose exec api npx tsx scripts/enforcement-step.ts
   ```

   answers `[labels] reads and writes are held to a clearance; the step made
   0 change(s)`. From then on the API does not start unless every labelled
   table is under its policies and its own reading connection is the role
   the policies bind, and its log says at each start
   `[labels] reads and writes are held to a clearance in the database`.

8. **Carry on in the web app.** Grant permissions (`/admin/people`),
   define your labels and tick the model providers and outside services
   each may be sent to (`/admin/labels`; nothing is ticked until you tick
   it, and a change is in force within seconds, with no restart), add the
   parties (`/admin/parties`), create owls and set up the General mandate
   (`/admin/budget`), and add material (`/sources`). Health says where each
   of these stands.

To stop: `docker compose down`. The database and the uploaded file sets are
kept in Docker volumes and are there at the next start. `docker compose
down -v` deletes them.

To take a new version: `git pull`, `docker compose build`, `docker compose
up -d`. The API applies new migrations and runs the enforcement step as it
starts.

## The public graph

A deployment can keep a read-only copy of the public graph, so its own
judgments sit beside the public ones, and can publish to it and act there in
the organization's name ([mirror.md](mirror.md),
[outward-acts.md](outward-acts.md)). Both go through the deployment's
connection to minerval.ai, which belongs to an organization there, not to a
person ([organizations.md](organizations.md), "Connecting"):

1. Someone makes the organization on minerval.ai, signed in as themselves
   (Account, Organizations). They are its first admin.
2. Set `DEPLOYMENT_HOSTING` (`own_machines`, for this package). An
   organization admin is shown it when they approve the deployment.
3. An administrator of the deployment presses "Connect to minerval.ai" on the
   public graph's Overview (`/admin/outside`) and chooses which grants to ask
   for. The deployment makes a key of its own, kept in its database and never
   in `.env`, and shows a short code and a link.
4. An admin of the organization opens the link, checks the code and key id,
   and approves it with the grants they choose. The deployment learns it the
   next time the Overview is opened. No restart.

From then on every request to minerval.ai is signed with that key and carries
no bearer secret. The organization's admins see the deployment, its grants
and the writes it signed on the organization's Deployments tab.

| Setting | For Minerval's public graph |
| --- | --- |
| `DEPLOYMENT_HOSTING` | `own_machines`, for this package |
| `MIRROR_FEED_URL` | `https://api.claimgraph.io`, to follow the mirror (with the `read_feed` grant) |
| `MIRROR_FEED_PUBLIC_KEYS` | the `public_key` that `https://api.claimgraph.io/mirror/feed/key` answers |
| `PUBLISH_SIGNING_KEY` | `npx tsx scripts/published-page.ts keygen` makes one; keep a copy |

`PUBLIC_GRAPH_API_KEY`, `MIRROR_FEED_API_KEY` and `USAGE_REPORT_API_KEY`, the
account keys an earlier version needed, still work for a deployment that is
not connected, and are not used by one that is. They go in a later version.
`PUBLIC_GRAPH_API_URL` and `USAGE_REPORT_URL`, where set, override the
connection's address.

Then an administrator presses "Register key" on the public graph's Overview
(`/admin/outside`): the deployment signs the registration for the
organization's account and sends it there through that account
([published-pages.md](published-pages.md), "Who a publisher is"). Until the public graph's feed answers at that address, nothing can be
mirrored ([infrastructure.md](infrastructure.md), "The mirror feed").

What to decide once it runs (labels, people, what to show and say outside)
is a guide of its own: `/docs/running-a-private-graph` on the site.

## The settings, and where each lives

- `deploy/.env`: the settings in `deploy/env.example`. The Compose file
  hands each to the container that reads it and to no other. The database
  superuser's password goes to the database container alone.
- `deploy/api.env` (optional): any other setting the API reads, such as a
  budget, an interval, Stripe's keys, or a connection's credential
  (`CONNECTION_...`). `.env.example` at the repository's root lists them.
- Fixed by the Compose file: that the deployment is members-only, where the
  database and the sandbox are, where uploaded file sets are kept, and that
  connections to the packaged database are not encrypted, because it is on
  a network of the deployment's own that nothing else joins
  (`DATABASE_TLS=off`).

To use a Postgres elsewhere (a managed one, say), remove the `postgres`
service, set `DB_HOST` and the other `DB_` settings on the API to it, and
replace `DATABASE_TLS=off` with `DATABASE_CA_FILE`, the path in the
container of the certificate authority the server's certificate is checked
against. That database needs what `deploy/postgres/10-owner.sh` makes: an
owner role that may create roles and is not a superuser, and the `vector`
and `pg_trgm` extensions. This arrangement has not been tried.

## The sandbox

The Compose file gives the sandbox what its README asks for: one network,
marked internal, shared with the API alone; the file sets mounted read-only;
a scratch directory in memory; a read-only root filesystem, no capabilities
and a memory limit. The setup checklist shows whether it holds: the
preflight runs the sandbox's own probe (`sandbox_confinement`), and where a
label is defined agent work waits until it passes. To run the probe
yourself from the machine:

```
docker compose exec sandbox python3 -c "import os,urllib.request as u; print(u.urlopen(u.Request('http://127.0.0.1:8080/probe', method='POST', headers={'Authorization':'Bearer '+os.environ['SANDBOX_TOKEN']})).read().decode())"
```

Each check comes back with what was tried. `commands_are_confined` fails
on a kernel without Landlock.

To let agents explore data too large to upload, set `REGISTERED_DIR` to a
directory on the machine. It is mounted read-only into the API and the
sandbox, and an administrator registers directories under it as file sets.

## What this package does not do yet

- **Its settings are not in a config file.** The API reads one where it is
  named (`MINERVAL_CONFIG`; [deployment.md](deployment.md)), and every
  setting in `env.example` that is not a secret has a place in it. The
  Compose file does not mount one yet: it hands the settings in `.env` to
  each container as environment variables, which is the layer a config file
  sits under.
- **No TLS.** The web app and the API listen on plain HTTP, on this machine
  only unless `BIND_ADDRESS` says otherwise. Put a reverse proxy in front.
  For Claude.ai, Cowork and other hosted MCP clients, the proxy also puts
  the API at a public HTTPS address, and `API_URL` in `.env` names it: the
  API tells clients to register and sign in there, and members connect at
  it followed by `/mcp`. The web app's address does not serve for this
  ([mcp.md](mcp.md), "Connecting from Claude.ai / Cowork").
- **No published images.** You build from the repository.
- **One machine, one API process.** The API and its workers are one
  container. Running more than one has not been tried.
- **No backups.** The database and the file sets are Docker volumes, and
  the settings are two files on the machine, `deploy/.env` and
  `deploy/api.env` (where you made one), in neither volume. Back up all
  four yourself, and keep the two files somewhere off the machine, such as
  a password manager or a secrets store: they hold the deployment's
  secrets, and a restored database is started with the settings it was
  run with. What each secret costs when it is lost:
  - **Made again, with a restart:** `AUTH_SECRET` (everyone is signed
    out), `WEB_API_KEY`, `SANDBOX_TOKEN`, `CLEARED_ROLE_PASSWORD` (the API
    gives the role the new password when it starts and its login is
    refused) and `MINERVAL_OPERATOR_KEY` (give the new one to whatever
    calls the operator routes).
  - **Issued again by whoever issued them:** the model providers' keys,
    `AUTH_OIDC_SECRET`, the public graph's API keys, and in `api.env`
    Stripe's keys and each connection's credential.
  - **`CREDENTIAL_ENCRYPTION_KEY`** opens the credentials given on
    connections' pages, which the database holds sealed under it. Made
    again with a restart, every such credential is then given again on its
    connection's page: the database's backup alone never opens them
    ([connections.md](connections.md), "A credential given here").
  - **`DB_OWNER_PASSWORD`** must be the password `minerval_owner` has in
    the restored database. Without it, give the role a new one inside the
    database: `docker compose exec postgres psql -U postgres`, then
    `ALTER ROLE minerval_owner PASSWORD '<new>';`, and put the new one in
    `.env`. `POSTGRES_PASSWORD` is read only when the data volume is first
    created; a restored volume keeps the superuser's old password, and
    the step above does not need it.
  - **`PUBLISH_SIGNING_KEY` cannot be made again.** A new key can be
    registered on the public graph, which retires the old registration,
    but every page already released outside is a chain of packages signed
    with the old key. The new key cannot continue it: each page's record
    starts again.

  The rest of `.env` is choices (the models, which labels each provider is
  cleared for) that can be written again, and are easier kept.
- **No model server.** The package runs no model. An endpoint of your own is
  yours to run and to name in `MODEL_ENDPOINTS`.
- **No mirror of the public graph unless you set it up.** With
  `MIRROR_FEED_URL` unset the deployment holds no copy of the public graph.
- **The Lean checker is not in the package.** Mathematics' machine checks
  need it (`lean-checker/`); without it those tools are absent.
- **No identity provider.** You bring one. There is no local accounts page.
- **Settings are changed by editing `.env` and starting again**, not in the
  web app.
