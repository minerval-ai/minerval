# Replays — recordings of the agents at work

A scorecard says how a graph came out. A replay shows how it was built: the
sources landing one by one, the Extractor listing claims, the Matcher
searching and deciding, each Steward's tool calls and the verdict it records,
the Curator's merges, and — for a two-arm episode — the same sources building
two graphs side by side. For a contribution or adversarial episode it shows
each submission, the Reviewer's decision and reasoning, the appeal, the
Arbitrator's ruling, and what the Steward did with the result.

Every driver that runs the real agents writes one at the end of its run
(`runs/<run>/replay.json`), built from the trace substrate (#334 L0:
`agent_runs`, `agent_steps`, `enqueue_events`, `llm_usage`) and the graph
tables. Nothing in a replay is authored by hand; where attribution is a
heuristic the record says so. Commit the ones worth showing here as a directory,
`corpus/replays/<name>/` holding `replay.json` (the index: arms, events with
a one-line gist and the size of each step, deltas, matching, final graph)
and `replay-events/<arm>/<seq>.json` (the full event: every step untrimmed,
including the "prompt" step with the system prompt, the initial messages
and the tool definitions the agent was given). Run
`npx tsx scripts/sync-frontend-content.ts`: the index lands in
`web/content/evals/replays/<name>.json`, the event files under
`web/public/evals/replays/<name>/events/`, and the public evals page plays
the recording at `/docs/evals/replays/<name>`, fetching an event's full
transcript when the reader opens it.

```bash
npm run corpus:replay -- db --since=<iso> --name=<name>      # from the corpus DB, one run window
npm run corpus:replay -- snap:<a> snap:<b> --name=<name>     # two arms, with the agreement matching
```

The schema is `scripts/corpus/replay-types.ts` (mirrored for the web in
`web/lib/replay.ts`), versioned. The player refuses a version it does not
know.

What a replay cannot show: anything the trace did not record. `TRACE_LEVEL`
must be `full` for the run (the default everywhere but vitest); a run traced
`off` yields events with no steps, and the player says so.
