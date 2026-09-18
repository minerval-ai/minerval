# Replays — recordings of the agents at work

A scorecard says how a graph came out. A replay shows how it was built: the
sources landing one by one, the Extractor listing claims, the Matcher
searching and deciding, each Steward's tool calls and the verdict it records,
the Curator's merges, and — for a two-arm episode — the same sources building
two graphs side by side. For a contribution or adversarial episode it shows
each submission, the Reviewer's decision and reasoning, the appeal, the
Arbitrator's ruling, and what the Steward did with the result.

Every driver that runs the real agents writes one at the end of its run,
built from the trace substrate (#334 L0: `agent_runs`, `agent_steps`,
`enqueue_events`, `llm_usage`) and the graph tables. Nothing in a replay is
authored by hand; where attribution is a heuristic the record says so. A
recording is two layouts side by side:

```
runs/<run>/replay.json                     the index: arms, sources, every event with its
                                           deltas, causality, cost and step gists (verbatim
                                           content replaced by character sizes), the matching
                                           between arms, the final graph
runs/<run>/replay-events/<arm>/<seq>.json  the full event: every step verbatim — the prompt
                                           step (system prompt, initial messages, tool
                                           descriptors), thoughts, tool inputs and outputs
```

`events[i].detailPath` in the index names the event's file relative to
`replay-events/`. Nothing is trimmed by the exporter; `truncated` marks
only what the trace itself capped. Commit the recordings worth showing as
`corpus/replays/<name>/` (the same two layouts — `--commit-as=<name>` does
the copy), run `npx tsx scripts/sync-frontend-content.ts`, and the public
evals page plays them at `/docs/evals/replays/<name>`: the sync puts the
index in `web/content/evals/replays/<name>.json` and the event files under
`web/public/evals/replays/<name>/events/`, so the player fetches an
event's full transcript only when the reader opens it.

```bash
npm run corpus:replay -- db --since=<iso> --name=<name> [--cluster=<c>] [--commit-as=<name>]
npm run corpus:replay -- snap:<a> snap:<b> --since=<iso> --name=<name> [--agreement=<path>]
```

The first form reads one run window from the corpus DB (or `snap:<name>`,
or a `postgresql://` URL); the second reads each arm from its snapshot
(`--since-a` / `--since-b` when the windows differ) and links the claims
the agreement metric paired, from an `agreement.json` when given or computed
in-process from stored embeddings (no judge, no spend). `corpus:run`,
`corpus:property` and `corpus:swap` write theirs automatically; a replay
failure never fails the run.

The schema is `scripts/corpus/replay-types.ts` (mirrored for the web in
`web/lib/replay.ts`), versioned. The player refuses a version it does not
know.

What a replay cannot show: anything the trace did not record. `TRACE_LEVEL`
must be `full` for the run (the default everywhere but vitest); a run traced
`off` yields events with no steps, and the player says so.
