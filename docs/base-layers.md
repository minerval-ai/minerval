# The bottom of a private graph: the public graph, what the organization published, and its members

A design, for review. Nothing in it is built yet. It splits the one label
a members-only deployment has at the bottom, `public`, into the three
things it holds today: the public graph's own rows, which the mirror
brings in; what the organization has released outside; and the
organization's own material that every member reads. Each becomes a
label of its own. The labels a deployment defines above them do not
change.

It started from the labels page. There the bottom row says `public`
for material no one outside reads. Its provider clearance says
"Everything", which cannot be changed and is not always true.

## What is wrong today

On a members-only deployment (`reads = "members"`) one label, `public`,
holds three kinds of row. Most code tells them apart by `origin` or by
the table, not by the label:

| What | Where it comes from | Told apart today by |
| --- | --- | --- |
| The public graph's own rows | The mirror's applier (`mirror-apply-service.ts`), at system clearance | `origin = 'mirror'` |
| What the organization released outside | The gate to outside and the outbound work: `received_releases`, `release_acts`, `received_pages`, `received_parts`, `received_nodes`, `outbound_proposals`, `outbound_packages`, `outbound_sends`, `inbound_contributions`, `outward_acts`, the outside boundary's `gates`, `redaction_policies` and `label_faces` | The table, and `to_label IS NULL` with `to_outside` |
| The organization's own material that every member reads | Every run, request and key with no other label: `currentLabel()` falls back to `public` (`usage-context.ts`), as do `withAgent`, the trace and a key's `work_label` | Nothing: it is whatever is at `public` and not the other two |

That costs five things.

1. **The name says the wrong thing.** Members see `public` on material
   nobody outside reads. The page puts other words beside it
   (`MEMBERS_PUBLIC_DESCRIPTION` in `label-service.ts`), but every chip,
   filter and version still says `public`. That is also the public
   graph's word, in the same app's Public graph section.
2. **One provider switch covers all three.** Clearance is per label, so
   the organization cannot keep its own member-wide material away from a
   provider without keeping the public graph's text away too. The stored
   choice cannot narrow `public` at all (`ck_provider_clearances_not_public`,
   `clearanceProblem`). The page therefore prints "Everything" for that row
   whatever is in force. Under `PROVIDER_LABELS` that is not always true.
3. **A release to every member and a release outside arrive at the same
   label.** `to_label = 'public'` (an internal release to all members,
   `routes/releases.ts`) and `to_outside` both write their destination
   rows at `public` (`destinationLabel` in `redaction-policy.ts`,
   `destinationOfGate`, `gate-service.ts`). Only the flag tells "every
   member reads it" from "the world reads it".
4. **Some code reads `public` as "may leave the deployment".**
   - Only reports at `public` are filed to GitHub (`report-service.ts`,
     `staysInside` in `github-issue-service.ts`). On a members-only
     deployment that sets `GITHUB_ISSUES_REPO`, that is the members'
     layer.
   - A run at `public` is told "every reader may read it" (`label-note.ts`).
   - The display order and the bare ledger keys (`keyAtLabel`,
     `groupAtLabel`) treat `public` as the bottom, which is right for
     the public graph and an accident for the members.
5. **The mirror is a layer apart from the label machinery.** The
   database places mirrored rows below the deployment's own by
   `origin` (`minerval_layer_depth`, `0163_layer_identity.sql`). There
   are also rules of their own for "work at `public` on a mirrored node":
   - the retired local judgment (`mirror-apply-service.ts`);
   - the refused adoption of a mirrored request at `public`
     (`request-adoption-service.ts`, `outward-acts-service.ts`);
   - the 409 `PUBLIC_GRAPH_NODE` when a member orders work on a mirrored
     node without naming a label.

   Each exists because the members' layer and the public graph share a
   label.

What is right today and stays:

- The public graph has one label, `public`, which everyone reads.
- Text that passed the gate to outside is the organization's: on the
  public graph it is a publisher's contribution, weighed by that graph's
  Steward like any other ([published-pages.md](published-pages.md)).
- The labels above are the deployment's to define and are not ranked
  ([architecture.md](architecture.md), "Labels and clearance").

## The shape

A members-only deployment has three labels at the bottom, and its own
above them:

| Label | What is at it | Who reads it | What reads it | Who writes it | Providers |
| --- | --- | --- | --- | --- | --- |
| `public` | The public graph's own rows, as the mirror brings them. On a deployment that does not mirror it is empty. | Anyone | Every label, always | The mirror's applier, and nothing else | Every provider, always: it is the public graph's text |
| `published` | What the organization released outside: what passed the gate to outside, the packages and proposals built from it, what was sent and what came back about it. | Anyone once sent; every member here | Every label, always | The gate to outside and the outbound work, nothing else | The administrators' choice. Each provider set up starts cleared. |
| `members` | The organization's own material that every member reads: the work of any run, request or key that names no other label | Every member | `members`, and each label that names it | Work at `members` | The administrators' choice, on the labels page |
| Each label the deployment defines | As today | Those granted it | As today | As today | As today |

`members` reads `published` and `public`. `published` reads `public`.
`public` reads nothing. Every clearance includes `public` and
`published`, as every clearance includes `public` today: the rows at
both may be read by anyone. A label above reads `members` by a pair in
`label_reads`, as it reads any other label. The pair can be absent, for
a label that should not see the members' material.

**`published` is a third thing, not the public graph.** It is public in
that the world may read it. The organization made it with its own
owls, models and material. The public graph's agents treat it as an outside
party's contribution, and the deployment keeps it apart from what the
public graph says itself. A published page on a mirrored node sits
beside the mirrored node's own judgment and does not replace it. A page
the public graph has admitted comes back with the mirror at `public`, as
the public graph's row, beside the record at `published` of what was
sent. Each graph keeps its own identity, as between any two layers
([mirror.md](mirror.md), "Identity is per graph").

**Nothing runs at `public` on a members-only deployment.** The mirror's
applier is system work, and the package builder moves to `published`. So
"the judgment of a mirrored node at its own label is the public graph's"
stops being a rule and becomes a fact. No run can work at that label.
The rules and refusals in point 5 above go away, and a member who
orders work on a mirrored node without naming a label gets it at
`members`.

**The public graph does not change.** It has one label, `public`. It
defines neither `published` nor `members`, and its base label is
`public`. A deployment with `reads = "open"` keeps `public` as its base
too, since its visitors read it. This design is for members-only
deployments.

## The base label

The code needs a name for "the bottom layer of this deployment's own
work", which is `public` today only because those were the same thing.
It becomes `baseLabel()`: `members` on a members-only deployment that
has been split, `public` everywhere else. These uses of `PUBLIC_LABEL`
move to it:

- The fallbacks for work with no label named:
  - `currentLabel()` and the label `withAgent` gives a run
    (`usage-context.ts`);
  - the trace's label (`trace-service.ts`);
  - a key's `work_label` and its column default (`routes/api-keys.ts`,
    `0131`);
  - the clearance fallbacks in `coverage-service.ts`,
    `judgment-version-service.ts` and `label-service.ts`.
- What every member reads: the start of `labelsReadableFrom` and of
  `rawSourceLabels` (`permission-service.ts`), and `PUBLIC_STANDING`
  for a signed-in member with no grant (`permissions.ts`). An account
  with no grant reads `members`, as it reads `public` today.
- The bare key at the bottom label (`keyAtLabel`, `groupAtLabel`). The
  keys already written stay valid because the base keeps the bare form.
- Display order, `everyLabel`, the audit and monitor sweeps, and the
  preflight's "material" count.
- The words: `whoReads`, `read_by_everyone`, and the run brief's sentence
  for a run at the bottom label (`label-note.ts`).

In SQL, `minerval_write_label()` and `minerval_default_label()` fall back
to the base label in place of the literal `'public'`, and
`minerval_clearance()` and `minerval_labels_readable_from` seed
`published` beside `public`. The base label is
data, not configuration, because migrations and triggers cannot read
config. `labels` gains `layer`, one of `public_graph`, `published` or
`base`, or null for a label the deployment defines. A unique index
allows one row of each. `minerval_base_label()` reads it, and the
application reads the same row.

Work with nothing in context still reads `public` alone (`PUBLIC_ONLY`
in `db/clearance.ts`, `minerval_clearance()`). That becomes stricter in
fact: a path that relied on it to see the members' material now sees
only the public graph. Each such path is one of the fallbacks listed
above, or a bug.

## The destination outside

The gate to outside gets a destination label of its own. `destinationLabel`,
`destinationOfGate`, `gate-service.ts`, `release-service.ts` and the
`0166` backfill return `published` where `to_outside` is set, in place
of `public`. The outbound and inbound work runs at `published`:
`atPublic` becomes `atPublished` in `outbound-service.ts` and
`inbound-service.ts`. So do the outward acts, `keep-current.ts` and the
OUTBOUND and OUTWARD rules in `request-labels.ts`. The published
mandate's subscriptions are read at `published` (`mandate-service.ts`).

An internal release to every member names `members`
(`to_label = 'members'`). A release with `to_label = 'public'` is
refused with the reason: nothing here writes at the public graph's
label. To go outside, say `outside`.

GitHub filing reads reports at `published`. A report reaches that label
by the gate's `report` kind, which already exists for the boundary to
outside. A members-only deployment's reports then leave only through
the gate. The public graph, whose base is `public`, files as it does
today.

## Providers

- `public` stays cleared for every provider, and the stored choice still
  cannot narrow it. Now that is true by construction, since only the
  public graph's own text is there and no run works there on a
  members-only deployment. The page draws the row as what is in force.
  Under `PROVIDER_LABELS` that is the setting's lines for `public`, not a
  fixed word, and on a members-only deployment the row says no run works
  at this label.
- `published` and `members` are choosable on the labels page like any
  other label. Nothing private is at `published`, but which models and
  services the organization's own work uses is still the organization's
  choice.
- At the split, the stored choice for both is seeded with what is in
  force for `public` at that moment, so nothing changes until an
  administrator unticks a box. Where `PROVIDER_LABELS` is set, nothing is
  seeded, since the setting fixes the clearance. Until the setting names
  `members` and `published`, the preflight's `provider_labels` check
  fails and says which lines to add. This is the one change an operator
  has to make by hand. `deploy/env.example` and
  [deployment.md](deployment.md) show the new lines.

## The split

The split runs once, at start, on a members-only deployment whose
`labels` has no `base` row. It runs before the workers, on the owner's
connection, in one transaction, and is logged in `administrative_events`.
It cannot be a plain migration, because a migration does not know
whether the deployment is members-only. The migration adds the column,
the functions and the index, and the start step does the rest:

1. **Labels.** It defines `members` (layer `base`) and `published`
   (layer `published`), and marks `public` as `public_graph`. It stops
   with a message naming the label if the deployment already defined
   one called `members` or `published`. Labels are never renamed, so the
   operator says, in a setting the step reads, which names to use
   instead.
2. **Rows.** In each of the 144 labelled tables, rows at `public` with
   `origin = 'local'` are stamped again:
   - `published` for the destination-side tables of the gate to
     outside listed under "What is wrong today", where the row belongs
     to a release or a boundary with `to_outside`;
   - `members` for every other row, including those tables' rows for an
     internal release with `to_label = 'public'`, whose `to_label`
     becomes `members`.

   Rows with `origin = 'mirror'` stay at `public`. Today a row's label
   never changes, with no exception
   ([architecture.md](architecture.md), "Labels and clearance"). This
   step is the one exception, once, on the owner's connection, with
   `minerval_own_label_guard` and the judgment guard set aside for the
   transaction. The keys that hold the label move with their rows. No
   pair can collide, because before the split no row was at `members`
   or `published`.
3. **Reads.** It adds `(L, members)` to `label_reads` for every label `L`
   besides the three, so each label reads what it reads today. On the
   page, today's "Only itself" for `sensitive` becomes "members",
   written down where it was implicit.
4. **Grants and keys.**
   - Read grants at `public` become read grants at `members`, and so do
     raw-source grants.
   - Keys and tokens with `work_label = 'public'` get `members`.
   - The first administrator's grants gain `members`.
5. **Providers**, as above.
6. **Work in flight.** A queue message enqueued before the split that
   names `public` for local work is read as `members`. The step records
   when it ran, and the consumers that check a message's label compare
   against that time (`claim-pipeline.ts` and the others that call
   `labelIsDefined`).

The split turns enforcement on for a members-only deployment that had
only `public` until then, since a second label now exists. That is
deliberate: a members-only deployment holds material that is not for
everyone, and the database should hold it to that.

## Pages and words

- **Labels** (`/admin/labels`). Four rows on a deployment like the one in
  the screenshot:
  - `public`, described as the public graph's rows, as of the mirror's
    last batch;
  - `published`, described as what this organization sent outside;
  - `members`;
  - `sensitive`, which reads `members`.

  Provider clearance gets rows for `published` and `members` with
  ticks, and the public row as it actually stands.
- **Chips and versions.** Every place that hard-codes `"public"` in `web/`
  (`InsideVersions.tsx`, `OnThePublicGraph.tsx`, `lib/inside-node.ts`,
  `lib/inside-versions.ts`, the budget, people and releases pages, the
  inbox and the work sections) names the layer: "Public graph",
  "Published", "Members".
- **The Public graph section** (Overview, Requests, Replies, Outbox)
  reads `public` and `published`, and gains nothing new.
- **The run brief** (`label-note.ts`). The passage about what is the
  public graph's says "what is labeled `public`" and is then simply true.
  A run at `members` is told that `published` is what the organization
  has said outside, and that it is not the public graph's own judgment.
- **The caller skills and MCP tool descriptions** that say `public` for
  the deployment's own bottom label get `members`, through
  `scripts/sync-frontend-content.ts`.

## Phases

Each phase leaves things working.

1. **Name the layers, move nothing.** Add `labels.layer`,
   `baseLabel()`, `minerval_base_label()` and the destination label for
   outside. Until the split, each returns `public`. Every use of
   `PUBLIC_LABEL` and of the literal moves to the name that says which
   layer it means, and there is a test that fails on a new bare use
   outside a listed file (as `tests/unit/db/judgment-in-force.test.ts`
   does for `is_current`). No behaviour changes.
2. **The split.** The start step, the seeding, the preflight check on
   `PROVIDER_LABELS`, and the refusal of `to_label = 'public'`. Tests:
   - a deployment with rows of all three kinds at `public`, split and
     read back;
   - `tests/db/request-labels.test.ts` for the outbound and outward
     routes at `published`;
   - `tests/db/private-on-mirror.test.ts` with the run at `members`.
3. **Pages and words.** The labels page, the chips, the run brief, the
   caller skills, and [architecture.md](architecture.md),
   [mirror.md](mirror.md), [the-gate.md](the-gate.md),
   [published-pages.md](published-pages.md) and
   [deployment.md](deployment.md).
4. **What the split makes dead.** The retired local judgment at
   `public`, the refused adoption at `public`, `PUBLIC_GRAPH_NODE`, and
   `MEMBERS_PUBLIC_DESCRIPTION`.

## Decisions for review

- **Is a release waiting to be sent already `published`?** Proposed: yes.
  It is at `published` once it passes the gate, whether or not it has
  been sent. Passing the gate is the decision that the world may read
  it. Sending only carries it there, and a person may carry it as a
  file.
- **Is `published` in every clearance?** Proposed: yes, as `public` is.
  The alternative is to make each label name it, which would let a
  label not see what its own organization has said outside. That is
  hard to justify.
- **Does a new label read `members`?** Today every label reads the
  members' layer without saying so, because it is `public`. Proposed:
  the Add label drawer lists `members` first under "Also reads", ticked,
  and the administrator can untick it. That is a default, so it is
  flagged. The alternative is no tick, and a label that reads nothing
  below until someone chooses.
- **The names.** `members` and `published` are proposed. The table
  allows any plain word, so a deployment could pick its own at the
  split. Proposed: fixed names, so that docs, skills and agents' briefs
  can say them.
- **An open deployment with labels** (`reads = "open"`) is out of scope.
  Its base stays `public` because its visitors read it.
