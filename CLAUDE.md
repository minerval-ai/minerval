# Working notes for Claude

Jackson often takes a few days to get to a PR review, so after opening a PR a check-in or two is plenty. Hourly re-checks over several days are not needed.

MCP keeps parity with the REST API: every route an account can call is also an MCP tool unless there is a written reason it shouldn't be. When you add or rename a route, decide its MCP side in `src/mcp/route-tools.ts` (usually one line in `ROUTE_TOOLS`; an exclusion needs its reason). `tests/unit/mcp/parity.test.ts` fails until you do. See docs/mcp.md, "Parity with the REST API".
