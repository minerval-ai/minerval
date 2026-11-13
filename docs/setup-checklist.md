# The setup checklist

Once a deployment has administrators, they are who sets it up, and they work
in the web app. `GET /setup/checklist` (`src/routes/setup-checklist.ts`,
`src/services/setup-checklist-service.ts`; `get_setup_checklist` on MCP) is
one read of what a members-only deployment can see about its own setup, for
holders of the permission to administer:

| Part | What it says |
|---|---|
| `preflight` | The deployment's own checks of its configuration: each check with pass, fail or not applicable and a sentence saying why, and whether agent work may start. It is the preflight's report, and `null` in a build that has no preflight (below). |
| `permissions` | How many accounts and groups hold each permission now, by label and by party where the permission is granted at one. |
| `labels` | Every label besides `public`, with the model providers and outside services cleared for it (`PROVIDER_LABELS`) and the roles whose model's provider is not cleared, whose runs at that label are refused. |
| `undefined_labels_in_provider_setting` | Labels `PROVIDER_LABELS` names that are not defined. While there is one, every call to a provider is refused. |
| `standing_mandates` | The General and Governance mandates, each with its budget once set up ([accounts.md](accounts.md), "The standing mandates, set up in the app"). Where the deployment holds material at more than one label, `by_label` has each label the administrator reads with the mandate set up there or none. |
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

**The deployment's own checks.** The preflight, and the config file it
reads, are a separate change that this line of work does not carry
(`src/services/deployment-checks.ts`). Until the two meet, `preflight` is
`null`, and the page says that the build does not check its own
configuration and marks nothing as passed. When they meet, the same part
carries the preflight's report, and the roles the checklist lists for a
label come from the config file's own list of roles, to which the
Redactor's (`REDACTOR_MODEL`) has to be added.

The page that shows it is `/admin` in a members-only build of the web app
([accounts.md](accounts.md), "The web app"). It is the same page on a
deployment's first day and on every day after: what needs someone now, then
every item as it stands, each with what to do next, who can do it, and where.

The checklist only reads. What it finds wrong in a setting is put right by
whoever runs the deployment.
