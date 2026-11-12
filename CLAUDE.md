# Working notes for Claude

Jackson often takes a few days to get to a PR review, so after opening a PR a check-in or two is plenty. Hourly re-checks over several days are not needed.

MCP keeps parity with the REST API: every route an account can call is also an MCP tool unless there is a written reason it shouldn't be. When you add or rename a route, decide its MCP side in `src/mcp/route-tools.ts` (usually one line in `ROUTE_TOOLS`; an exclusion needs its reason). `tests/unit/mcp/parity.test.ts` fails until you do. See docs/mcp.md, "Parity with the REST API".

The Assistant (`/ask`, docs/accounts.md) uses the MCP tool list as its own. A new tool that is not a read must be classified in `src/llm/tools/assistant-tools.ts` as held for the user or as running without asking, with its reason; `tests/unit/llm/assistant-tools.test.ts` fails until it is. When you add, move or remove a page under `web/app`, update the table in `plugin/skills/using-minerval/SKILL.md` (`tests/unit/plugin/using-minerval.test.ts`).

The caller skills in `plugin/skills/` carry the graph's principles to outside agents and are served over MCP (#620). When you change the constitution, a skill in `skills/`, a role prompt, a tool's name, or how a tool or agent behaves, update them in the same change: run `npx tsx scripts/sync-frontend-content.ts` and read the skills that mention what you changed. See docs/mcp.md, "Keeping them current".

A request that writes works at one label, where a deployment holds material at more than one. When you add a route that is not a read, decide where its label comes from in `src/server/request-labels.ts`: the row the request is about, or the label the person names when it starts something new, never a default. `tests/unit/server/request-labels.test.ts` fails until you do, and `tests/db/request-labels.test.ts` wants a request for it against a private row. A new place that returns a source's stored text to a person holds the permission to open raw sources (`src/raw-sources.ts`, `tests/unit/db/raw-source-text.test.ts`).

Two open PRs that each add a migration take the same number, so the second to merge always conflicts in `src/db/migrations`. Do not resolve that by hand: merge `origin/main`, leave the conflicts in the migrations folder as they are, and run `npm run db:renumber`. It renumbers this branch's migrations after main's and rebuilds the journal and snapshots. The journal's timestamps matter more than they look: production skips, without an error, a migration whose `when` is earlier than one it has already run (`scripts/migrations-lib.ts`). `tests/unit/scripts/migrations.test.ts` fails on a folder that is out of order.

Read a node's current judgment through the four `*_in_force` views (`src/db/schema.ts`), not by filtering on `is_current` by hand: a file under `src` that mentions `is_current` must be listed with its reason in `tests/unit/db/judgment-in-force.test.ts`, which fails until it is.

## Constraints on agents

Agents, like anyone, need to know their affordances and the constraints they work under.

- Every limit an agent works under is stated to it up front, with its running state as it goes (the way the turn counter and the spend line do), and with the reason for it. Never enforce a limit an agent has not been told.
- Prefer money to counts. Where a resource is metered, the run's budget bounds it (docs/allocation.md, "Agents work to a budget they can see"); do not add a per-run or per-day count on top.
- A new hard limit needs a reason money cannot serve (injected text near escrow, a loop that has stopped spending, a caller waiting on the result, human attention nothing prices), written in the comment beside it. Add one thoughtfully, not by reflex.
