/**
 * Stating a view and reading where views and assessments differ, through
 * the REST routes and the MCP tools generated from them, against real SQL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A key bound to a contributor identity. Set before any module reads config.
vi.hoisted(() => {
  process.env.API_KEYS = "svkey:mcp:stated-view-tester";
});

import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { executeReviewerTool } from "../../src/llm/tools/reviewer-tools.js";

let app: FastifyInstance;
let baseUrl: string;
let claim: string;
let quantity: string;

const headers = { "x-api-key": "svkey", "content-type": "application/json" };
const post = (id: string, payload: Record<string, unknown>, h: Record<string, string> = headers) =>
  app.inject({ method: "POST", url: `/claims/${id}/stated-views`, headers: h, payload });

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  claim = await seedClaim("sv-route");
  quantity = await seedClaim("sv-route-quantity");
  await rawQuery(`UPDATE claims SET kind = 'quantity' WHERE id = $1`, [quantity]);
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current) VALUES ($1, 'contradicted', 0.9, 'db test', true)`,
    [claim]
  );
});

afterAll(async () => {
  await app.close();
});

describe("POST /claims/:claim_id/stated-views", () => {
  it("needs credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/claims/${claim}/stated-views`,
      payload: { statement: "This is so.", stance: "affirms", no_stake: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an unknown node, a merged one, and a statement that does not fit the node's kind", async () => {
    const unknown = await post("00000000-0000-4000-8000-000000000000", { statement: "x", stance: "affirms", no_stake: true });
    expect(unknown.statusCode).toBe(404);

    const survivor = await seedClaim("sv-route-survivor");
    const merged = await seedClaim("sv-route-merged");
    await rawQuery(`UPDATE claims SET state = 'merged', merged_into = $2 WHERE id = $1`, [merged, survivor]);
    const gone = await post(merged, { statement: "x", stance: "affirms", no_stake: true });
    expect(gone.statusCode).toBe(409);
    // The alias plugin's refusal: a write to a merged node names the survivor.
    expect(gone.json()).toMatchObject({ code: "CLAIM_MERGED", merged_into: survivor });

    const noStake = await post(claim, { statement: "This is so.", stance: "affirms" });
    expect(noStake.statusCode).toBe(422);
    expect(noStake.json().error.code).toBe("STAKE");
    const wrongKind = await post(quantity, { statement: "It is so.", stance: "affirms", no_stake: true });
    expect(wrongKind.statusCode).toBe(422);
    expect(wrongKind.json().error.code).toBe("STANCE");
    const noFigure = await post(quantity, { statement: "About four.", stance: "states", no_stake: true });
    expect(noFigure.json().error.code).toBe("FIGURE");
  });

  it("files a statement under the caller's account and shows nothing until it is admitted", async () => {
    const res = await post(claim, {
      statement: "This is so.",
      stance: "affirms",
      reasons: "We measured it ourselves.",
      stake: "We sell the instrument.",
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.contribution).toMatchObject({ contribution_type: "state_view", review_status: "pending" });
    expect(body.message).toContain("never for whether the view is right");

    const before = await app.inject({ method: "GET", url: `/stated-views?claim_id=${claim}` });
    expect(before.json().summary.total).toBe(0);
    // The contribution's own record carries the view as filed.
    const record = await app.inject({ method: "GET", url: `/contributions/${body.contribution.id}` });
    expect(record.json().stated_view).toMatchObject({
      stance: "affirms",
      statement: "This is so.",
      reasons: "We measured it ourselves.",
      stake: "We sell the instrument.",
      instance_id: null,
    });

    await executeReviewerTool("record_review_decision", {
      contribution_id: body.contribution.id,
      decision: "accept",
      reasoning: "A view on this node, in good faith.",
      confidence: 0.9,
      policy_citations: ["§4"],
    });
    const after = await app.inject({ method: "GET", url: `/stated-views?claim_id=${claim}` });
    const list = after.json();
    expect(list.summary).toMatchObject({ total: 1, by_relation: { differs: 1 }, by_direction: { view_affirms_assessment_against: 1 } });
    expect(list.stated_views[0]).toMatchObject({
      statement: "This is so.",
      stake: "We sell the instrument.",
      speaker: { verified: false },
      challenge: { state: "waiting" },
    });
    expect(list.how_to_read).toContain("gives a statement no weight");
    // One speaker's statements, and one relation at a time.
    const speakerId = list.stated_views[0].speaker.id;
    const mine = await app.inject({ method: "GET", url: `/stated-views?speaker_id=${speakerId}&relation=agrees` });
    expect(mine.json()).toMatchObject({ total: 0, summary: { total: 1 } });
    // `earlier` is a reading of one node.
    expect((await app.inject({ method: "GET", url: `/stated-views?earlier=true` })).statusCode).toBe(422);
    const all = await app.inject({ method: "GET", url: `/stated-views?claim_id=${claim}&earlier=true` });
    expect(all.json().stated_views).toHaveLength(1);
  });

  it("is not a type POST /contributions takes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      headers,
      payload: { claim_id: claim, contribution_type: "state_view", content: "This is so." },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe("MCP", () => {
  let client: Client;
  const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

  beforeAll(async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { "x-api-key": "svkey" } },
    });
    client = new Client({ name: "stated-view-test", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("offers state_view and list_stated_views, and says what stating a view does and what bounds it", async () => {
    const { tools } = await client.listTools();
    const state = tools.find((t) => t.name === "state_view")!;
    const list = tools.find((t) => t.name === "list_stated_views")!;
    expect(state.description).toContain("It does not change the assessment.");
    expect(state.description).toContain("is not edited or withdrawn afterwards");
    expect(state.description).toMatch(/\d+ per hour, \d+ for accounts under a day old or below 50 reputation/);
    expect(state.annotations?.readOnlyHint).not.toBe(true);
    expect(list.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((state.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(
      expect.arrayContaining(["claim_id", "statement", "stance", "probability", "figure", "reasons", "stake", "no_stake"])
    );
  });

  it("states a view on a quantity and reads it back beside the estimate", async () => {
    await rawQuery(`INSERT INTO quantity_estimates (claim_id, estimate, work) VALUES ($1, $2, 'db test')`, [
      quantity,
      JSON.stringify({ form: "interval", low: 1, high: 2 }),
    ]);
    const filed = parse(
      await client.callTool({
        name: "state_view",
        arguments: {
          claim_id: quantity,
          statement: "Between five and six.",
          stance: "states",
          figure: { form: "interval", low: 5, high: 6 },
          no_stake: true,
        },
      })
    );
    expect(filed.contribution.review_status).toBe("pending");
    await executeReviewerTool("record_review_decision", {
      contribution_id: filed.contribution.id,
      decision: "accept",
      reasoning: "A view on this node, in good faith.",
      confidence: 0.9,
      policy_citations: ["§4"],
    });
    const status = parse(
      await client.callTool({ name: "get_contribution_status", arguments: { contribution_id: filed.contribution.id } })
    );
    expect(status.stated_view).toMatchObject({ stance: "states", figure: { form: "interval", low: 5, high: 6 }, stake: null });
    expect(status.stated_view.instance_id).toBeTruthy();
    const list = parse(await client.callTool({ name: "list_stated_views", arguments: { claim_id: quantity } }));
    expect(list.stated_views[0].comparison).toMatchObject({ relation: "differs", direction: "view_figure_higher" });
  });
});
