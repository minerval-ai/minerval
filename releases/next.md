---
security: false
settings:
  added:
    - key: releases.check
      note: "Whether the deployment reads the list of releases from the public graph: \"daily\", the starting value, or \"never\" where it must reach nothing outside."
    - key: releases.url
      note: "Where the list of releases is read from. The starting value is the public graph's API."
    - key: build.version
      note: "The version an image was built as (MINERVAL_VERSION). Set when the image is built, never by hand; an image knows its version without it."
    - key: build.commit
      note: "The commit an image was built from (MINERVAL_COMMIT). Set when the image is built. GIT_SHA, its older name, is still read."
  retired: []
  defaults_changed: []
operator_steps: []
---

## What is new

**Settings an administrator changes in the app.** The settings that are choices about how a deployment works (which model serves each role, what is switched on, what a run may spend, the outside services) no longer need a shell on the machine. An administrator changes them on the Settings page, over the API or over MCP; each change is checked before it is saved, logged with who made it and why, and most are in force within seconds. A setting whoever runs the machine has put in the environment or the config file is fixed there, as before, and the page says so. What stays on the machine is the database, the trust root and the facts about the machine itself. [docs/settings.md](../docs/settings.md) has the whole of it.

**Keys given in the app.** The model providers' keys, Elicit's, Pangram's, Stripe's and the GitHub App's can be given on the Settings page, where they are sealed under `CREDENTIAL_ENCRYPTION_KEY` and never shown again. The environment variable of the same name still fixes each where it is set.

**A deployment can be set up without a shell.** Once whoever runs the machine has started it, the first person to sign in becomes the first administrator by giving the one-time code the API prints in its log, and names the organization and chooses the models on Health's first day. `FIRST_ADMINISTRATOR` still works for a scripted install.

**Versions.** Every build of Minerval now says what it is: at `GET /setup/version`, in the web app's footer and in the sandbox's health answer. Health says which version the deployment runs, what it ran before, and what changed between the two. An upgrade checks out a tag, not `main`. [docs/releases.md](../docs/releases.md) has the whole of it.

**New checks.** `version` fails when the API, the web app and the sandbox were not built from one version. `unknown_settings` names environment variables that look like settings and are read by nothing, with the nearest name, and retired settings that are still set. `settings` says whether what was set in the app is in force. `models_chosen` fails in production while a load-bearing role's model is nobody's choice. `releases` says whether the deployment learns of new releases.

## What an upgrade asks

Nothing beyond the upgrade's own commands. Models set in `.env` stay fixed there; take one out of `.env` to choose it in the app instead.
