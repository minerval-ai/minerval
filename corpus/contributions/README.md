# Contribution scenarios — the other half of the organization

A corpus ingest exercises Extract → Match → Decompose → Assess and the
stewardship propagation those trigger. It never exercises **contributions,
conflict review, escalation, or arbitration**: those start with a
contribution submitted against an existing claim, which no ingest produces.
This directory holds the scenarios that do, and `corpus:contributions` is
the driver (#334 L1). It is the prerequisite for the adversarial suite (S4)
and the persona simulation (S8), both of which need contributions to flow.

## A scenario

One JSON file per cluster (`<name>.json`): a few **personas** (contributors
minted for the run, `corpus:<scenario>:<key>` external ids, so their standing
starts fresh and sandboxed like any new account) and a list of
**contributions**. Each contribution names its persona, its type
(`challenge`, `support`, `propose_edit`, `propose_merge`, `add_instance`,
`propose_argument`), the content and evidence, and its **target** as a search
query resolved against the graph at submit time — claim ids differ per run,
wording is stable. `appealIfRejected` carries the appeal reasoning to file if
the review rejects it, which is how the arbitration path gets exercised.

The `expect` notes orient a reader: what a reviewer honouring the policies
would plausibly do, and which outcomes are worth reading closely. They are
not an answer key and no gate reads them — review is judgment (§"Judgment
over Mechanism"), and a decision that differs from the note is a reason to
read the reasoning, not a failure.

## Running it

```bash
npm run corpus:run -- blackholes --profile=production   # the graph to contribute against
npm run corpus:contributions -- blackholes --dry-run     # resolve targets, print the plan
npm run corpus:contributions -- blackholes               # submit, drain, appeal, drain, report
```

The driver resolves every target, mints the personas, submits each
contribution through the same service path `POST /contributions` uses, and
drains the local queues to quiescence — the Contribution Reviewer runs, its
accepts notify the Steward, its escalations reach the Dispute Arbitrator,
bad-faith flags reach the audit queue. Then it files the appeals for
rejected contributions that carry `appealIfRejected` (the same path as
`POST /appeals`) and drains again. Everything is real: the agents, the
policies, the reputation ledger, the metering.

The report (`runs/contrib-<stamp>/report.md` + `report.json`, registered in
the eval-run registry as kind `contributions`) lists, per contribution, the
review decision with its reasoning, confidence and policy citations, any
bad-faith finding, the appeal and the arbitration outcome, and what changed
on the targeted claim (text, status); then a summary — decisions by type,
escalation and overturn rates, reputation deltas per persona, the run's
exact metered cost — and the `expect` notes beside the outcomes for the
reader. `--no-appeals` skips the appeal round; `--limit=N` runs the first N
contributions.

Rate limits are the route's, not the pipeline's, and are not applied: the
driver submits through the service layer with one persona per role, which
is what lets a single run exercise a dozen contributions. The rubric's
section G ("Stewardship & propagation") now has something to look at for
conflict, escalation and arbitration.
