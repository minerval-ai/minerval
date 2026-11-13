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
  (OpenAI's).
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
   git. A setting in your shell's environment with the same name wins over
   `.env`, so run the commands below from a shell that does not carry, say,
   an `OPENAI_API_KEY` meant for something else.

   Two choices most deployments make here:

   - `OWLS=created`, if you pay your model providers yourself. Your
     administrators then create the owls that budget the agents' work. Left
     as it starts (`sold`), owls are bought through Stripe.
   - `PROVIDER_LABELS`, once you define labels. A provider is sent text at
     `public` only until this setting clears it for another label.

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

6. **Open the setup checklist.** It is the page at `/admin`. It reads the
   deployment and says what needs someone now: the deployment's own checks
   of its configuration (the preflight; [deployment.md](deployment.md),
   "Preflight"), then permissions, labels, the General mandate, owls and
   material. Read what the checks say fails: a wrong setting is named there
   with what to change. Once a label is defined, agent work does not start
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

8. **Carry on in the web app.** Grant permissions (`/admin/people`), clear
   your model providers for your labels (`PROVIDER_LABELS` in `.env`, then
   `docker compose up -d`), create owls and set up the General mandate,
   and add material. The checklist page says where
   each of these stands.

To stop: `docker compose down`. The database and the uploaded file sets are
kept in Docker volumes and are there at the next start. `docker compose
down -v` deletes them.

To take a new version: `git pull`, `docker compose build`, `docker compose
up -d`. The API applies new migrations and runs the enforcement step as it
starts.

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
- **No published images.** You build from the repository.
- **One machine, one API process.** The API and its workers are one
  container. Running more than one has not been tried.
- **No backups.** The database and the file sets are Docker volumes. Back
  them up yourself.
- **No model server.** The package runs no model. An endpoint of your own is
  yours to run and to name in `MODEL_ENDPOINTS`.
- **No mirror of the public graph unless you set it up.** With
  `MIRROR_FEED_URL` unset the deployment holds no copy of the public graph.
- **The Lean checker is not in the package.** Mathematics' machine checks
  need it (`lean-checker/`); without it those tools are absent.
- **No identity provider.** You bring one. There is no local accounts page.
- **Settings are changed by editing `.env` and starting again**, not in the
  web app.
