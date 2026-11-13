/**
 * The public graph as a second process, for tests/db/published-pages.test.ts.
 *
 * A private deployment is a client of the public graph's ordinary API, so
 * the test's own process is the deployment and this is the public graph: the
 * real app on its own database (PUBLIC_GRAPH_DATABASE_URL), listening on a
 * port it prints. No model runs here. The two steps of the path that an
 * agent takes (the Contribution Reviewer's decision on a submission, and
 * the node's Steward taking a source off its page) are driven through the
 * agents' own tools on a second port, as the showing tests drive the
 * Redactor's and Audit's.
 */
import { createServer } from "node:http";

process.env.DATABASE_URL = process.env.PUBLIC_GRAPH_DATABASE_URL;
process.env.ENVIRONMENT = "development";
process.env.READS = "open";
process.env.LOG_LEVEL = "error";
delete process.env.API_KEYS;

const { buildApp } = await import("../../../src/server/app.js");
const { executeReviewerTool } = await import("../../../src/llm/tools/reviewer-tools.js");
const { executeStewardTool } = await import("../../../src/llm/tools/steward-tools.js");
const { withAgent } = await import("../../../src/llm/usage-context.js");
const { publishedPageAsText } = await import("../../../src/published-page/shape.js");

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const apiPort = (app.server.address() as { port: number }).port;

const agents = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    void (async () => {
      try {
        const { agent, tool, input } = JSON.parse(body) as { agent: string; tool: string; input: Record<string, unknown> };
        const out =
          agent === "reviewer"
            ? await withAgent("contribution_reviewer", () => executeReviewerTool(tool, input))
            : agent === "steward"
              ? await withAgent("steward", () => executeStewardTool(tool, input, {} as never))
              : agent === "text"
                ? JSON.stringify({ text: publishedPageAsText(input as never) })
                : JSON.stringify({ success: false, error: "no such agent" });
        res.writeHead(200, { "content-type": "application/json" }).end(out);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
});
agents.listen(0, "127.0.0.1", () => {
  console.log(`PUBLIC_GRAPH_READY ${apiPort} ${(agents.address() as { port: number }).port}`);
});

process.on("SIGTERM", () => {
  void app.close().finally(() => process.exit(0));
});
