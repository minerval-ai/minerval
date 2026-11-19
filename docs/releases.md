# Versions and release notes

A design, not yet built ("Phases", at the end). It gives every build of
Minerval a version, gives a private deployment a way to know what it runs,
whether a newer release is out and what changed since the version it last
ran, and gives Minerval one place to write and correct release notes. The
settings half of "what changed" (settings added, retired or given a new
default) is written with [settings.md](settings.md) in mind, and works
without it.

## What is wrong today

- **No build knows what it is.** `package.json` says `0.1.0` and has never
  moved. No commit or build id is put into the images, so the API, the web
  app and the sandbox cannot say which code they run, and a person cannot
  say which code they are reporting a fault against.
- **There are no releases.** The public graph deploys `main` on every merge
  (`.github/workflows/deploy.yml`). A private deployment upgrades with
  `git pull`, `docker compose build` and `docker compose up -d`
  ([self-hosting.md](self-hosting.md)), which takes whatever `main` is at
  that minute: a half-finished phase of a design, a migration that a fix
  lands on the next day.
- **Nothing says an upgrade is due.** A deployment never learns that a newer
  version exists, or that one fixed a fault it has.
- **Nothing says what an upgrade asks of the operator.** A new required
  setting is found when `docker compose up` stops with `Set X in .env`. A
  retired setting goes on sitting in `api.env`, read by nothing. A changed
  default is not noticed by anyone whose `api.env` still pins the old value.
- **Nothing records what an upgrade did.** The deployment does not record
  which version it ran before, so it cannot say "since you last upgraded".

What is right today and stays: the API applies migrations as it starts, and
the preflight's `database` check fails on a database migrated by newer code
and on a migration that is waiting ([deployment.md](deployment.md), "The
checks"). An upgrade is still one command an operator runs on the machine;
nothing here upgrades a deployment by itself.

## Versions

**One version for the whole product.** The API, the web app, the sandbox,
the plugin and the migrations are released together, from one commit, under
one number. A deployment runs one version, and a fault is reported against
it.

**Semantic versions, with the meaning written down for this product.**
`MAJOR.MINOR.PATCH`, starting at `0.2.0`:

| Part | Moves when |
| --- | --- |
| `PATCH` | Fixes only. No migration that changes what a row means, no setting added or retired, no default changed. A deployment takes it without reading anything. |
| `MINOR` | Anything else that a deployment takes without doing more than the release notes' operator steps say: new features, migrations, settings added, defaults changed, settings retired after a release that warned of it. |
| `MAJOR` | A release a deployment cannot reach from every earlier one: it names the oldest version it upgrades from (`upgrades_from`), and a deployment older than that goes through that version first. |

Until `1.0.0` a `MINOR` may also do what a `MAJOR` would, and says so in
`upgrades_from`.

**The version lives in `package.json`, and a release is a tag.** A release
is cut from `main` by a commit that sets the version and adds its notes
(below), tagged `v<version>`. `main` between releases runs as
`<next version>-dev.<commit>`: the public graph, which deploys `main`,
reports that, and is never mistaken for a release.

**Every image is stamped when it is built.** The Dockerfiles take the
version and the commit as build arguments (`MINERVAL_VERSION`,
`MINERVAL_COMMIT`), filled by `docker compose build` from the checkout, and
each part reports them:

- the API at `GET /setup/version`, open to anyone, with the version and the
  commit and nothing else. Saying which code a server runs is useful to a
  person reporting a fault and to a caller choosing what to call, and says
  nothing about the deployment's material;
- the web app in its footer, from the API's answer and its own;
- the sandbox in its health answer, which the preflight already reads.

**A new check: `version`.** It passes when the API, the web app and the
sandbox report one version, and fails, naming each part and its version,
when they do not: one image rebuilt and another not. It does not block
agent work.

**The deployment records what it has run.** A table, `versions_run`: each
version the API has started as, with when it first and last started. It is
written at start, one row per version, under system clearance, and carries
no label. It is how a deployment answers "what changed since I upgraded"
and how Health says "upgraded from 0.4.1 on 3 March".

**Upgrading takes a tag, not `main`.** [self-hosting.md](self-hosting.md)'s
upgrade becomes:

```
git fetch --tags
git checkout v0.5.0
docker compose build
docker compose up -d
```

Following `main` stays possible, and is what the public graph does; the
`version` part of Health says `-dev` and that the notes below cover
releases only.

## Release notes

**Written in the repository, reviewed like code.** Each release has one
file, `releases/<version>.md`, with a block of facts at the top and prose
below. The facts are what a deployment acts on; the prose is what a person
reads.

```
---
version: 0.5.0
date: 2026-12-02
security: false
upgrades_from: 0.3.0
settings:
  added:
    - key: models.redactor
      note: The Redactor's model. Left unset it runs on the Steward's.
  retired:
    - key: PUBLIC_GRAPH_API_KEY
      replaced_by: the connection to minerval.ai
      note: Read by nothing from this release. Delete it from .env.
  defaults_changed:
    - key: run_log.retention_days
      from: 0
      to: 90
      why: Logs of runs that wrote nothing were kept for ever.
operator_steps:
  - Rebuild all three images; the sandbox's changed.
---

## What is new
...
```

| Fact | |
| --- | --- |
| `version`, `date` | The release and the day it was cut. |
| `security` | Whether it fixes a fault that exposes material, credentials or the machine. Health says so first, and the prose says what was exposed and since when. |
| `upgrades_from` | The oldest version it can be reached from directly. |
| `settings.added`, `settings.retired`, `settings.defaults_changed` | Each by its key in the config file or its environment variable ([settings.md](settings.md), "One registry"), with what to do. |
| `operator_steps` | Anything beyond the four commands above that the operator must do on the machine. Usually empty. |

**Tests keep the facts true.** The point of facts over prose is that a
deployment can check them against itself, so they must be right:

- every key named is a setting in the registry, or (for `retired`) was one
  in the previous release;
- `releases/settings.json`, written by a script, holds each setting's key,
  environment variable and default as of the last release. A test fails
  when the code's registry differs from it and the next release's notes
  (`releases/next.md`, which a pull request that changes a setting adds to)
  do not list the difference. So a default cannot change, and a setting
  cannot be added or removed, without a line saying so. Cutting a release
  renames `next.md` and rewrites `settings.json`.

This is the same shape as the migrations folder and `web/content`: a file
generated by a script, and a test that fails when it is out of date. Two
open pull requests that each add to `next.md` conflict there; the
renumbering workflow is taught to merge its lists, as it does
`web/content` (docs/infrastructure.md, "Migration renumbering").

**Every image carries the notes.** `releases/` is copied into the API's
image, so a deployment knows the notes of every release up to its own
without asking anyone. That is what lets a deployment that reaches nothing
outside still say, after an upgrade, what changed since the version it last
ran ("What a deployment shows", below).

## What is current

**The public graph serves the list of releases.** Minerval's own
deployment holds the releases in a table, `releases`, one row per version
with its facts and its prose, filled from `releases/` when a release is
cut. Three routes, open to anyone, with no key:

| Route | Answer |
| --- | --- |
| `GET /releases` | Every release, newest first, with its facts and without its prose. |
| `GET /releases/latest` | The newest release that is not withdrawn. |
| `GET /releases/:version` | One release, with its prose. |

They are MCP tools (`list_releases`, `get_release`), as reads.

**A deployment asks without saying who it is or what it runs.** It reads
`GET /releases` unsigned, with no key and no version in the request, and
compares the list with its own version on its own side. The public graph
learns that some server read the list, which every reader of the site can
do, and nothing about the deployment. This is the rule the mirror keeps:
the public graph should keep no record of what a deployment looks at
([mirror.md](mirror.md)). A deployment connected to minerval.ai does not
sign this read either.

It asks once a day, and when an administrator opens Health. Where a
deployment must reach nothing outside, a setting (`releases.check`,
`"daily"` or `"never"`) stops it, and the preflight's `releases` check
says the deployment learns of releases only from the notes in its images.
A file of the list, downloaded from the site, can be uploaded instead.

**Releases are signed.** Each row is signed with Minerval's release key
(Ed25519, as the mirror feed's batches are), and the public key is in the
code. A deployment checks each release it is shown, so neither a mirror of
the list nor an uploaded file can invent a release, withdraw one or change
its facts.

**Corrections and withdrawal are new entries, not edits.** A release's
facts and prose can be corrected (`revision`, the next number, with what
changed and why); the list shows the latest revision and keeps the rest. A
release found to be bad is withdrawn: a signed entry naming the release, the
reason, and the version to move to. A deployment running a withdrawn
release is told first, before anything else on Health.

**Who manages them.** Cutting, correcting and withdrawing a release are
done by Minerval's release workflow, on a tag pushed to the repository,
which signs with the release key and posts to
`POST /operator/releases` with the operator key. The key and the route are
Minerval's, held outside every deployment surface, like the other operator
routes, and the route is not an MCP tool for that reason
(`src/mcp/route-tools.ts`). Writing and correcting a release's notes is a
pull request against `releases/`, so a correction has a review and a
history like any other change.

## What a deployment shows

Health (`/admin`) gains a part at the top, `version`, in the setup
checklist (`GET /setup/checklist`, `get_setup_checklist` on MCP):

- **What it runs**: the version and the commit, of each of the three parts,
  and when it was upgraded to it and from what (`versions_run`).
- **What changed since the version before**: from the notes in the image,
  every release between the version it last ran and the one it runs now.
  Each operator step, each setting retired that this deployment still sets
  (by name, and whether in `.env`, `api.env` or the config file), each
  default changed that this deployment pins to its old value, and each
  setting added that it must set. Each is shown until it is done: a retired
  setting until it is gone from the environment, a step until an
  administrator marks it done.
- **What is newer**: from the list, the releases after this one, the
  newest first, with the security ones marked, and what upgrading to the
  latest would ask of this deployment: the steps, and the settings it sets
  that the newer releases retire or whose defaults they change. Then the
  commands, with the tag filled in.
- **A withdrawn release**, when this is one, first.

Each item is marked as one for the deployment's operator, as items about the
machine already are, with the line on the machine to change.

The sidebar's dot on Health already says "something here needs someone";
a security release, a withdrawn release and an operator step not yet done
light it. A newer release that is not a security one does not: being one
release behind is a fact, not a fault.

## Phases

1. **Versions.** The version in `package.json` and the build arguments,
   `GET /setup/version`, the web app's footer, the sandbox's answer, the
   `version` check, `versions_run`, and the upgrade commands in
   [self-hosting.md](self-hosting.md) taking a tag. The first release,
   `0.2.0`, cut by hand.
2. **Notes in the repository.** `releases/`, `next.md`, `settings.json` and
   the script that writes it, the tests, the renumbering workflow taught to
   merge `next.md`, and Health's "what changed since the version before",
   from the image alone.
3. **The list on the public graph.** `releases`, the three routes and their
   tools, the release key, the release workflow and its operator route, the
   daily read and `releases.check`, withdrawal and correction, and Health's
   "what is newer".

Each phase does what CLAUDE.md asks of a new route: its MCP side in
`src/mcp/route-tools.ts`, its label in `src/server/request-labels.ts` (the
reads are open; the operator route names no label because it writes no
labelled row), and the caller skills where a tool is added.

## Questions for review

- **Is one version for every part right?** The browser extension is
  released on its own already (`.github/workflows/extension-release.yml`)
  and stays so: it talks to a deployment through the API, and its version is
  its own. Nothing else in the repository seems to want a version of its
  own.
- **Should `GET /setup/version` be open?** It tells a stranger which
  version a deployment runs, which helps someone looking for a deployment
  with a known fault. The alternative is to answer it to members only, and
  have the footer show it only when signed in.
- **Release cadence.** The design assumes releases are cut when there is
  something worth taking, perhaps every week or two, and patch releases
  when a fix cannot wait. Nothing here depends on the cadence.
