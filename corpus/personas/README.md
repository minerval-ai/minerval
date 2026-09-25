# Persona simulation — simulated users against the whole surface

`corpus:contributions` submits a fixed scenario of contributions. It says
nothing about what a *person* does when they arrive with a question, browse,
hit a dead end, and decide whether to contribute at all. This directory
holds the personas that do (#334 S8, from #82), and `corpus:personas` is the
driver: each persona is an LLM agent playing a manifest entry against the
graph a corpus run produced, with the read tools every agent has and three
actions a user has, through the same service path `POST /contributions`
and the intake route take. Phase 1 is twenty hand-picked personas; the
adversarial ones are a deliberate minority.

## The manifest

`manifest.json` lists the personas. Each has a `key`, a `name`, a `kind`
(`reader`, `contributor`, `programmatic`, `adversarial`), an `archetype`
(one line from #82's list), `goals`, a `style` (how the person writes and
what they notice — including their mistakes, which the agent is told not
to improve on), a `tier` (`fresh` = a new account at the default
reputation; `standard` and `trusted` start the run at 65 and 88 so the
review process treats them as it would an established account), a
`budget` of actions (`reads:6 contributions:2 proposals:1 findings:2` —
the tools refuse calls past it, so a run's cost is bounded by the
manifest), the `clusters` it cares about (`*` = any), and for some an
`opening` (what is on their mind as they arrive), `appeals: true` (a
rejection is appealed, in character, with one more model turn), or a
`pairWith` (the sockpuppet pair runs in manifest order; the second account
is told what the first submitted).

Kinds decide the tools: readers search, read, may propose a claim, and
file findings; programmatic clients only search, read and file findings;
contributors and the adversarial minority have all five. Adversarial
personas name a `tactic` (`sea-lion`, `spam`, `sockpuppet`,
`prompt-injection`) so the report can say how each was handled.

The prompt a persona is given is built from its entry by
`scripts/corpus/persona-prompts.ts` (`buildPersonaSystemPrompt`), pure and
exported so the evals page can show it verbatim: a plain statement that it
is a simulated user in an isolated evaluation deployment, the entry in
words, its budget, and how the tools are to be used. `--dry-run` prints it.

## Running it

```bash
npm run corpus:run -- blackholes --profile=production   # the graph to visit
npm run corpus:personas -- blackholes --dry-run          # the plan and the first prompt
npm run corpus:personas -- blackholes                    # every persona that cares about the cluster
npm run corpus:personas -- eggs --personas=first-timer,enthusiastic-novice,spammer
npm run corpus:personas -- lableak --limit=5 --no-appeals
```

Personas run on `PERSONA_MODEL` (default: the cheap OpenRouter flash pin
in `src/llm/models.ts` — a persona's judgment is not what is under test).
Each session runs under `withAgent("persona")`, so its full transcript —
system prompt, every tool call and result — lands in `agent_runs` /
`agent_steps` like any agent's, and the replay carries it. Then the local
queues drain (the Contribution Reviewer, intake for proposed claims,
escalations to the Dispute Arbitrator, Steward notifications); appeals
are written in character for the personas that appeal; a second drain
runs arbitration.

## The report

`runs/personas-<cluster>-<stamp>/report.md` + `report.json`, registered
in the eval-run registry as kind `personas`, with a replay when
`scripts/corpus/replay.ts` is present. Per persona: what it read, every
contribution and proposed claim verbatim with the review decision,
confidence, policy citations and reasoning verbatim, any bad-faith flag,
appeal and arbitration, what changed on the claim; the findings it filed;
its reputation before and after; its own LLM cost; and its closing
account in the first person. The adversarial minority gets its own table
— submitted, rejected, accepted, escalated, bad-faith flags, appeals
upheld, standing, reputation delta — and anything of theirs that landed
in the graph is called out, because that is what a defence is measured
against.

The findings come **triaged**: deduplicated by where+what similarity
(`triageFindings` in `personas-lib.ts`, a token-set Jaccard) and ranked by
severity × count, with every member listed under its representative.
**A human reads that list before any issue is opened.** A finding is one
simulated visitor's experience on one model, not a confirmed defect;
several personas hitting the same wall is the signal worth chasing, and a
persona that could not find something the corpus never contained is
noise. Phase 2 (hundreds of generated personas) and phase 3 (triage →
GitHub issues) are not built; the pipeline stops at the report on
purpose.

## What it cannot show

The web app is not exercised — personas act through the same services the
API and MCP surfaces call, so a rendering or navigation problem is
invisible here. Rate limits are the routes' and are not applied. A
persona sees no review decision during its session (a real user would,
later), so "I never heard back" is never a finding. And the personas are
one cheap model's reading of a paragraph of character: what they notice
is bounded by what that model notices.
