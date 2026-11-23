# Versions and release notes

Every build of Minerval has a version. A deployment knows which version it
runs, what it ran before and what changed between the two, and whether a
newer release is out. Minerval writes and corrects release notes in one
place. This page says how each of those works.

The settings half of "what changed" (settings added, retired or given a new
default) rests on the registry of settings in [settings.md](settings.md).
An upgrade is still commands whoever runs the machine types; nothing here
upgrades a deployment by itself.

## Versions

**One version for the whole product.** The API, the web app, the sandbox,
the plugin and the migrations are released together, from one commit, under
one number. A deployment runs one version, and a fault is reported against
it. The browser extension is released on its own
(`.github/workflows/extension-release.yml`) and keeps its own version.

**Semantic versions, with the meaning written down for this product.**
`MAJOR.MINOR.PATCH`:

| Part | Moves when |
| --- | --- |
| `PATCH` | Fixes only. No migration that changes what a row means, no setting added or retired, no default changed. A deployment takes it without reading anything. |
| `MINOR` | Anything else that a deployment takes without doing more than the release notes' operator steps say: new features, migrations, settings added, defaults changed, settings retired after a release that warned of it. |
| `MAJOR` | A release a deployment cannot reach from every earlier one: it names the oldest version it upgrades from (`upgrades_from`), and a deployment older than that goes through that version first. |

Until `1.0.0` a `MINOR` may also do what a `MAJOR` would, and says so in
`upgrades_from`.

**The version lives in `package.json`, and a release is a tag.** A release
is cut from `main` by a commit that sets the version and adds its notes,
tagged `v<version>`. Between releases `main` carries the next version with
`-dev`, and a build of it runs as `<next version>-dev.<commit>`: the public
graph, which deploys `main`, reports that, and is never mistaken for a
release.

**Every part knows its version from a file in its own build.**
`npm run version:set -- <version>` writes it in all of them at once:
`package.json` and `web/package.json` with their locks,
`sandbox/MINERVAL_VERSION` and the plugin's manifest. So
`docker compose build` on a checked-out tag needs nothing passed to it.
`tests/unit/version.test.ts` fails when the parts disagree. The commit is
the one thing only a build can know: the Dockerfiles take it as the build
argument `MINERVAL_COMMIT`, which the deploy fills from the commit it
builds and a self-hosted build may fill
(`MINERVAL_COMMIT=$(git rev-parse HEAD) docker compose build`).
`MINERVAL_VERSION`, where a build passes it, says the same as the file and
wins. `GIT_SHA`, the commit's older name, is still read.

Each part reports what it is:

- the API at `GET /setup/version`, open to anyone on every deployment, with
  the version and the commit and nothing else (`get_version` on MCP).
  Saying which code a server runs is useful to a person reporting a fault
  and to a caller choosing what to call, and says nothing about the
  deployment's material. `GET /health` carries the version too;
- the web app at the foot of every page, from the API's answer, and its own
  beside it where the two differ;
- the sandbox in its health answer (`minerval_version`, `minerval_commit`),
  beside the version of its own behaviour that kept analyses record.

**The `version` check.** It passes when the API, the web app and the
sandbox report one version, and fails, naming each part and its version,
when they do not: one image was rebuilt and another was not. The web app
names its version in a header on its own requests to the API, so until it
has called, the check says its version is not known yet. It does not block
agent work.

**The deployment records what it has run.** The table `versions_run` has a
row for each version the API has started as, with when it first and last
did. It is written at start and carries no label. It is how Health says
"upgraded from 0.4.1 on 3 March", and which releases lie between the
version a deployment ran before and the one it runs now. Rebuilds of `main`
of one release-to-be count as one version.

**Upgrading takes a tag, not `main`** ([self-hosting.md](self-hosting.md)):

```
git fetch --tags
git checkout v0.5.0
docker compose build
docker compose up -d
```

Following `main` stays possible, and is what the public graph does; Health
then says the deployment runs a build of `main`, and that the notes cover
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
| `upgrades_from` | The oldest version it can be reached from directly. Left out where any earlier one will do. |
| `settings.added`, `settings.retired`, `settings.defaults_changed` | Each by its name in the config file or its environment variable, with what to do. |
| `operator_steps` | Anything beyond the four commands above that the operator must do on the machine. Usually empty. |

**The next release's notes are `releases/next.md`.** It has the same facts
without a version or a day. A pull request that adds a setting, retires one
or changes a default adds its line there, and writes what a person should
know under its prose. Two open pull requests that each add to it do not
conflict: `.gitattributes` gives the file git's union merge, which keeps
both sides' lines.

**Tests keep the facts true.** The point of facts over prose is that a
deployment can check them against itself, so they must be right
(`tests/unit/release-notes.test.ts`, and `npm run release:check`):

- every release's notes read, and every key a line names is a setting the
  registry has, or for a retired one, a setting the last release had;
- `releases/settings.json` holds each setting's name, environment variable
  and default as of the last release. The test fails when the registry
  differs from it and `next.md` does not list the difference, or lists a
  default's figures wrongly. So a default cannot change, and a setting
  cannot be added or removed, without a line saying so.

**Cutting a release.** `npm run release:cut -- <version>` turns `next.md`
into `releases/<version>.md` with its version and day, starts a new
`next.md`, rewrites `settings.json` from the registry and writes the version
in every part. It commits nothing: it prints the commit, the tag and the
push that make the release, and the command that puts `main` on the next
`-dev` version afterwards.

**Every image carries the notes.** `releases/` is copied into the API's
image, so a deployment knows the notes of every release up to its own
without asking anyone. That is what lets a deployment that reaches nothing
outside still say, after an upgrade, what changed since the version it last
ran.

## What is current

**The public graph serves the list of releases.** Minerval's own deployment
holds the list in a table, `product_release_entries`. The name says product
because the gate already has releases of pages (`/releases`,
[releasing-a-page.md](releasing-a-page.md)); these are releases of the
software, and their routes sit under `/setup`, beside `/setup/version`.
Three routes, open to anyone on the public graph, with no key:

| Route | MCP tool | Answer |
| --- | --- | --- |
| `GET /setup/releases` | `list_product_releases` | Every release, newest first, with its facts and without its prose, and the signed entries that say so. |
| `GET /setup/releases/latest` | `get_latest_product_release` | The newest release that is not withdrawn. |
| `GET /setup/releases/:version` | `get_product_release` | One release, with its prose. |

A members-only deployment serves its own copy of the list to its members by
the same routes.

**A deployment asks without saying who it is or what it runs.** It reads
`GET /setup/releases` unsigned, with no key and no version in the request,
and compares the list with its own version on its own side. The public
graph learns that some server read the list, which every reader of the site
can do, and nothing about the deployment. This is the rule the mirror
keeps: the public graph should keep no record of what a deployment looks at
([mirror.md](mirror.md)). A deployment connected to minerval.ai does not
sign this read either.

It asks shortly after the API starts, once a day after that, and when an
administrator opens Health, though not more often than every ten minutes.
Where a deployment must reach nothing outside, the setting `releases.check`
(`"daily"`, the starting value, or `"never"`) stops it, and the preflight's
`releases` check says the deployment learns of releases only from the notes
in its images. A file of the list, saved from the public graph's
`GET /setup/releases`, can be uploaded on Health instead
(`POST /setup/releases/upload`). `releases.url` says where the list is read
from; it starts as the public graph's API.

**Releases are signed.** Each entry is signed with Minerval's release key
(Ed25519 over the hash of the entry's canonical JSON, as the mirror feed's
batches are), and the public half is in the code (`src/release-key.ts`). A
deployment checks each entry it is shown, when it takes it and again each
time it reads its copy, so neither a mirror of the list nor an uploaded file
can invent a release, withdraw one or change its facts. A release's prose
is kept beside its facts and not inside them, so the list can be read
without it; the entry carries the prose's hash, which fixes it.

The code carries no release key until Minerval makes one
(`npm run release:sign -- keygen`) and writes its public half in
`src/release-key.ts`. Until then no entry verifies: the public graph's list
takes none, and a deployment's `releases` check says that it knows of
releases from the notes in its own images.

**Corrections and withdrawal are new entries, not edits.** A release's
facts and prose can be corrected: the next `revision`, with what changed and
why. The list shows the latest revision and keeps the rest. A release found
to be bad is withdrawn: a signed entry naming the release, the reason, and
the version to move to. An entry already on the list is never changed.

**Who manages them.** Cutting a release is a tag pushed to the repository:
the release workflow (`.github/workflows/release.yml`) checks the tag is
the version the code states, signs the release with the release key and
posts it to `POST /operator/releases` with the operator key. A correction
and a withdrawal are signed by hand (`npm run release:sign -- correct`,
`... withdraw`) and posted the same way, since each takes words only a
person has. The key and the route are Minerval's, held outside every
deployment surface like the other operator routes, and the route is not an
MCP tool for that reason. The operator key says who may add to the list;
the signature says an entry is Minerval's, and the route refuses one the
release key did not sign whoever holds the operator key. Writing and
correcting a release's notes is a pull request against `releases/`, so a
correction has a review and a history like any other change.

## What a deployment shows

Health (`/admin`) has a part at the top, `version`, in the setup checklist
(`GET /setup/checklist`, `get_setup_checklist` on MCP):

- **What it runs**: the version and the commit, the web app's and the
  sandbox's versions, and when it was upgraded to it and from what
  (`versions_run`).
- **What changed since the version before**: from the notes in the image,
  every release between the version it last ran and the one it runs now.
  Each operator step, each setting retired that this deployment still sets
  (by name, and whether in the environment or the config file), each
  default changed that this deployment pins to its old value, and each
  setting added. A retired setting is listed until it is gone from the
  environment, and a step until an administrator marks it done
  (`POST /setup/releases/steps`, logged).
- **What is newer**: from the list, the releases after this one, the newest
  first, with the security ones marked, and what upgrading to each would
  ask of this deployment: the steps, and the settings it sets that the
  newer releases retire or whose defaults they change. Then the commands,
  with the tag filled in. Where the latest release cannot be reached from
  the version the deployment runs, the commands name the release to go
  through first.
- **A withdrawn release**, when this is one, first.

Each item is marked as one for the deployment's operator, as items about the
machine already are.

The sidebar's dot on Health says "something here needs someone". A security
release the deployment does not run, a withdrawn release it does run and an
operator step not yet marked done light it. A newer release that is not a
security one does not: being one release behind is a fact, not a fault.

**The `releases` check** fails where the release the deployment runs was
withdrawn, where a security release is out that it does not run, and where
it is set to read the list and could not. It does not block agent work: an
upgrade is the operator's to make.

When a setting an upgrade retired is still in the environment, the
`unknown_settings` check names it too, with what replaced it
([settings.md](settings.md), "The registry").
