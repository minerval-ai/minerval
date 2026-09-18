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
heuristic the record says so. Commit the ones worth showing here as
`corpus/replays/<name>.json`, run `npx tsx scripts/sync-frontend-content.ts`,
and the public evals page plays them at `/docs/evals/replays/<name>`.

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
