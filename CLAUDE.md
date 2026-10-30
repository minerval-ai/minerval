# Working notes for Claude

Jackson often takes a few days to get to a PR review, so after opening a PR a check-in or two is plenty. Hourly re-checks over several days are not needed.

MCP keeps parity with the REST API: every route an account can call is also an MCP tool unless there is a written reason it shouldn't be. When you add or rename a route, decide its MCP side in `src/mcp/route-tools.ts` (usually one line in `ROUTE_TOOLS`; an exclusion needs its reason). `tests/unit/mcp/parity.test.ts` fails until you do. See docs/mcp.md, "Parity with the REST API".

The caller skills in `plugin/skills/` carry the graph's principles to outside agents and are served over MCP (#620). When you change the constitution, a skill in `skills/`, a role prompt, a tool's name, or how a tool or agent behaves, update them in the same change: run `npx tsx scripts/sync-frontend-content.ts` and read the skills that mention what you changed. See docs/mcp.md, "Keeping them current".

## Constraints on agents

Agents, like anyone, need to know their affordances and the constraints they work under.

- Every limit an agent works under is stated to it up front, with its running state as it goes (the way the turn counter and the spend line do), and with the reason for it. Never enforce a limit an agent has not been told.
- Prefer money to counts. Where a resource is metered, the run's budget bounds it (docs/allocation.md, "Agents work to a budget they can see"); do not add a per-run or per-day count on top.
- A new hard limit needs a reason money cannot serve (injected text near escrow, a loop that has stopped spending, a caller waiting on the result, human attention nothing prices), written in the comment beside it. Add one thoughtfully, not by reflex.
