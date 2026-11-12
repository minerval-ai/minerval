# The run log

Every agent run leaves a log: one `agent_runs` row, and one `agent_steps`
row for the setup the model was given, each model turn, and each batch of
tool results. This page describes what makes that log checkable, and the
mode in which a run depends on it (#552).

## The chain and the seal

Each step carries two hashes:

```
genesis   = sha256("minerval-run-log/1\n" + run id)
step hash = sha256(prev_hash + "\n" + seq + "\n" + kind + "\n" + canonical content)
```

The first step's `prev_hash` is the genesis; each later step's is the hash
of the step before it. Starting from the run's id keeps a step from being
moved to another run. Canonical content is the step's content as stored,
written as JSON with object keys sorted (by UTF-16 code unit), no
whitespace, and scalars as `JSON.stringify` writes them: what survives a
round trip through a `jsonb` column.

Steps are written one at a time, in order. When the run closes and every
step was written, the run is **sealed**: `agent_runs.log_hash` is the last
step's hash (the genesis, for a run with no steps) and `sealed_at` is when.
A run that lost a step closes unsealed, and the steps after the lost one
still chain from it, so the gap shows instead of being closed over. So:

- **Sealed** means the log is whole: every step the run took is there.
- **Unsealed** means the run is still open, it lost a step, or it ran
  before steps were chained.

The code is in `src/services/run-log.ts` (the arithmetic, no database) and
`src/services/trace-service.ts` (the writer).

## What the first step says about the run

A run's first step is a prompt step (a run that starts more than one tool
loop or single call has one for each), and its content carries a `setup`
object: the commit the code was built from, the hash of the prompt set
(`promptSet`), the model and its settings, the parts the setup was made of
(the constitution, the role prompt, each tool) by hash, the `label` the
run wrote at, the `provider` that served it, and the features that were
switched off for it (`featuresOff`).

A label says who may read a row (`src/labels.ts`). Every judgment and source
a run writes, every row of the graph's own content (a node, an edge, an
argument, a tag, a formal statement), and everything it records from or
about a source (an instance, a reading, a provenance edge, an examination's
findings), is stamped with the run's label (the
`sensitivity_label` column), and so is its `agent_runs` row. Recording the label in the setup puts it under the chain: the label a
sealed run worked at cannot be changed afterwards without the log no longer
reaching its seal. The public graph has one label, `public`, so every run
there records `"label": "public"`; a run logged before labels existed has
no `label` in its setup and was public.

A run takes its label from the work that started it. The row that work
waited in (a job, a ledger action, an order, a contribution, a paused
session) was stamped with the label of the run or request that created it,
and the worker that picks the row up opens the run at that label. So the
label in a run's setup is the label of whatever asked for the run, through
however many hand-overs, and never something the agent chose. A run that
starts from a claim itself, with no such row (the Tagger's, or a pass the
scheduler's sweep opens for a pending claim), works at the claim's label.
Work that starts from a source the same way (the source backfill) is done
at the source's label; it opens no run. Two kinds of row are not the run's
at all: a document's segments and the notices against it are derived from
the document, the same whoever asks, and carry the document's label even
when a run's fetch produced them.

`provider` is what served the run's model: `anthropic`, `openai`,
`openrouter`, or `endpoint:<name>` for an endpoint the deployment runs
itself, as the model id resolved (docs/architecture.md, "Providers"). A run
is served only by a provider cleared for the label it works at
(docs/architecture.md, "Providers cleared by label"), and the label and the
provider together are what a later reader needs to check that this held for
a given run. The field is always recorded; a setup with no `provider` is
from before the field existed.

`featuresOff` names the features the deployment had switched off when the
run was set up (docs/architecture.md, "Features"): `["mathematics",
"prizes"]` where mathematics is off, since prizes go with it. A run with
any off was told so at the head of its first task message, and the same
prompt step records that message as it was sent. The prompts and the prompt
set's hash do not depend on the list, so two runs with the same `promptSet`
and different `featuresOff` read the same role text and were offered
different tools. The list is always recorded: `[]` means nothing was off,
which is every run on the public graph, and a setup with no `featuresOff`
is from before the field existed and says nothing either way.

## Checking a log

`GET /runs/:run_id/verify` (`verify_run_log` on MCP) recomputes the chain
from the stored steps and answers whether they still chain to the seal, and
where they first do not: a step missing, a step that does not follow from
the one before it, a step whose content is not what its hash was taken
over, or a chain that does not end at the sealed hash.

That is the server checking its own rows. To check without trusting it,
read the steps (`GET /runs/:run_id/steps/:seq` serves each step's content,
`prev_hash` and `hash`) and recompute with the two lines above.

## What the chain does and does not show

It shows that a sealed log is whole and has not been altered since it was
sealed, against the sealed hash: a step changed, dropped, reordered or added
afterwards no longer reaches it.

It does not show that the sealed hash is the original. Whoever can rewrite
every row can rewrite the seal as well. That takes the hash being held
somewhere its author cannot change, which is what a published page's
record is for: it names the log's hash at the time of publication.

It also does not show that the logged run was the only run. A deployment
on its owner's own machines can run an assessment off the log. Only where
the run happens can close that.

## Record mode

By default the log is best-effort: a step that cannot be written is logged
to the console and the run carries on, closing unsealed. `RUN_LOG_MODE=record`
turns the dependence round:

- every run is traced, whatever `TRACE_LEVEL` says;
- no model is called outside a run (below);
- nothing in a step is cut to a size cap;
- the run does not return until its log is sealed, and a run whose log
  could not be written whole fails with `RunLogError`;
- the retention sweep deletes nothing.

What a run wrote to the graph before its log failed stays written; a reader
tells it by the run being unsealed. Making readers treat a judgment whose
run is unsealed as unfinished is later work.

One thing record mode does not change yet: work that returns without a
promise, which has nothing to hold its result behind. Every agent's entry
point is async, so today this is no agent's work.

A deployment's preflight (docs/deployment.md) holds it to this. It tests the
log by writing a run, sealing it, checking its chain and removing it. Where
the deployment holds private material, agent work does not start unless
that test passes and the log is in record mode. The work below runs in the
API rather than as agent work the gate holds, so the preflight also fails,
without stopping anything, while that work would go unlogged: where private
material is held and the log is best-effort.

The public graph runs best-effort until record mode has run somewhere in
earnest.

## Work the best-effort log leaves out, and record mode does not

While the log is best-effort, four kinds of model work are kept off it on
purpose (#356). Each handles a reader's own content, which the public
service's terms say is never stored:

- the MCP tools `match_claim`, `extract_claims` and `assess_text`, which
  analyze a passage the caller hands over;
- the browser extension's page analysis, which reads whatever page the
  reader has open;
- the extension's page chat;
- the naming of an Assistant conversation from its first message. The
  message itself is kept, in the conversation and in the log of the
  Assistant's reply; what keeps the naming off the log is that deleting a
  conversation deletes the runs its messages name, and no message names
  this one.

The code marks each with `untraced()` (`src/llm/usage-context.ts`), and
the extension's own agent is never traced whoever calls it. Metering is
unaffected: the calls are counted and charged like any others.

That is an exemption of the best-effort log, and record mode has none. A
deployment that keeps its log as a record holds material whose handling
has to be on that log, and a member's passage or page there is such
material. So in record mode each of these is a logged run like any other:
the run row, the prompt step with its `setup`, a step for each turn, and
the seal the run waits on. If a log cannot be written whole, the tool or
the analysis fails with `RunLogError`, and the cap charged for an MCP tool
call is refunded, as it is for any failure. One call makes one run for
each agent it invokes: `match_claim` makes two (the domain prior, which
runs as the `extractor` agent, and the Matcher), `extract_claims` one
Extractor run, and `assess_text` one Extractor run and a Matcher run for
each claim it judges. The runs of one MCP call share its `request_id`.
Naming a conversation is one run of the `assistant` agent, whose role part
is the prompt set's `assistant-title`; if its log cannot be written the
name is dropped and the conversation keeps its opening words as its title.

These runs start private, so their transcripts are served only with the
service key, like any private run's: the naming run because every run of
the `assistant` agent is private, the others with the reason
`input:readers-own-content` in `private_reasons`. A report an agent raises
from such work still leaves its body out, in either mode: a report travels
further than the log does.

Of these, only the page chat's agent speaks to the reader, who may ask it
what is kept. Its role prompt is the same text in every deployment and
says only what holds in all of them (nothing from the page or the
questions is added to the graph). Which of the two holds where it runs is
said at the head of each conversation's first message
(`getChatKeptNote` in `src/llm/prompts/extension-agent.ts`): that nothing
is stored, or that the run is on the deployment's log.

What a caller gets back and what they are charged are the same in both
modes. The charge is the metered cost of the model calls, which logging
does not change. What record mode adds is the log's own writes: for each
run one `agent_runs` row, one `agent_steps` row for the prompt and one for
each model turn and each batch of tool results, and one update when the
run closes. The prompt step holds the whole system prompt and the tool
descriptors, uncut.

## No model call outside a run

A run is logged because `withAgent` opened it. Code that reached a model
without passing through `withAgent` would leave no run, no steps and no
seal, in any mode. Two things keep that from happening.

In record mode the door to a provider refuses: `getAdapter`
(`src/llm/providers/index.ts`), which every function of the LLM client
goes through, and the web search that is a completion of its own, throw
`UnloggedModelCallError` when no run is open (`src/llm/logged-run.ts`). The
call is not made. While the log is best-effort nothing is refused.

`tests/unit/llm/logged-runs.test.ts` is the static half. It fails when a
file calls the LLM client without opening a run in the same file, imports
a provider adapter around the client, constructs a provider's SDK client,
or calls `untraced()`, unless the file is on the test's list for that with
its reason.

Embedding calls are not agent work and are outside both: text goes in and
a vector comes back, with no prompt, reasoning or output to log.
