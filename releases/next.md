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
    - key: accounts.members_label
      note: "The name of the label for the organization's own material that every member reads (MEMBERS_LABEL). Leave it unset unless the deployment had already defined a label named members."
    - key: accounts.published_label
      note: "The name of the label for what the organization released outside (PUBLISHED_LABEL). Leave it unset unless the deployment had already defined a label named published."
    - key: limits.event_webhooks_per_account
      note: "How many webhook subscriptions to events an account may hold at once (EVENT_WEBHOOK_MAX_PER_ACCOUNT). Starts at 20."
    - key: hosting.webhook_allowed_hosts
      note: "Hosts a webhook may deliver to although their addresses are not public (EVENT_WEBHOOK_ALLOWED_HOSTS): a receiver on the deployment's own network. Set on the machine. Empty, the starting value, reaches public addresses only."
    - key: model_providers.allowed
      note: "The model providers the deployment may call at all (MODEL_PROVIDERS_ALLOWED). Empty, the starting value, allows every one."
    - key: model_providers.bedrock_region
      note: "The region for Claude on Amazon Bedrock (BEDROCK_REGION). Needed only where a role's model is a bedrock: one."
    - key: model_providers.vertex_region
      note: "The region for Claude on Google Vertex (VERTEX_REGION). Needed only where a role's model is a vertex: one."
    - key: model_providers.vertex_project_id
      note: "The Google Cloud project for Claude on Vertex (VERTEX_PROJECT_ID)."
    - key: model_providers.bedrock_api_key
      note: "A Bedrock API key (AWS_BEARER_TOKEN_BEDROCK), used in place of the machine's AWS credentials. A secret: given on Settings or in the environment."
  retired:
    - key: models.extractor_fallback
      replaced_by: "nothing: a model's refusal is no longer retried on another model, and the Extractor's refusal is shown as one"
      note: "EXTRACTOR_FALLBACK_MODEL is read by nothing. Delete it from .env or api.env; a config file that still holds models.extractor_fallback is read, with a warning."
  defaults_changed: []
operator_steps: []
---

## What is new

**Settings an administrator changes in the app.** The settings that are choices about how a deployment works (which model serves each role, what is switched on, what a run may spend, the outside services) no longer need a shell on the machine. An administrator changes them on the Settings page, over the API or over MCP; each change is checked before it is saved, logged with who made it and why, and most are in force within seconds. A setting whoever runs the machine has put in the environment or the config file is fixed there, as before, and the page says so. What stays on the machine is the database, the trust root and the facts about the machine itself. [docs/settings.md](../docs/settings.md) has the whole of it.

**Keys given in the app.** The model providers' keys, Elicit's, Pangram's, Stripe's and the GitHub App's can be given on the Settings page, where they are sealed under `CREDENTIAL_ENCRYPTION_KEY` and never shown again. The environment variable of the same name still fixes each where it is set.

**A deployment can be set up without a shell.** Once whoever runs the machine has started it, the first person to sign in becomes the first administrator by giving the one-time code the API prints in its log, and names the organization and chooses the models on Health's first day. `FIRST_ADMINISTRATOR` still works for a scripted install.

**Versions.** Every build of Minerval now says what it is: at `GET /setup/version`, in the web app's footer and in the sandbox's health answer. Health says which version the deployment runs, what it ran before, and what changed between the two. An upgrade checks out a tag, not `main`. [docs/releases.md](../docs/releases.md) has the whole of it.

**New checks.** `version` fails when the API, the web app and the sandbox were not built from one version. `unknown_settings` names environment variables that look like settings and are read by nothing, with the nearest name, and retired settings that are still set. `settings` says whether what was set in the app is in force. `models_chosen` fails in production while a load-bearing role's model is nobody's choice. `releases` says whether the deployment learns of new releases.

**An accepted contribution gets its pass.** A challenge or other contribution the Contribution Reviewer admitted used to wait in its node's inbox until something else paid for a pass, which could be never. Now a contribution that asks for a fresh pass can pay for it when it is made (`assess`, by default whenever the contributor's balance covers the assessment cap, refunded on rejection), and the node is reassessed at once when it is accepted. A free one's pass is put to the General mandate's officers on acceptance, as a consistency flag is. [docs/accounts.md](../docs/accounts.md), "Contributing to a node", has the whole of it. A contributor with owls is now charged up to the assessment cap by default on these contributions; the claim page's form and the API say so, and `assess: false` turns it off.

## What an upgrade asks

Nothing beyond the upgrade's own commands. Models set in `.env` stay fixed there; take one out of `.env` to choose it in the app instead.
