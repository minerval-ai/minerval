/**
 * A merged id resolves to its survivor (#884), against real tables and the
 * real merge: the pointer the Curator's merge writes is the one every read
 * follows. Covers the three kinds (they share the table), a two-hop chain,
 * an opposed merge, a reversed merge, a corrupt (cyclic) pointer, the three
 * surfaces (the agents' view and walks, the REST routes, MCP), and the
 * writes, which are refused and name the survivor.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A key bound to a contributor identity, for the MCP client. Set before any
// module reads config.
vi.hoisted(() => {
  process.env.API_KEYS = "aliaskey:mcp:alias-tester";
});

import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedUser } from "./helpers.js";
import { mergeClaims, reverseReconciliation } from "../../src/services/reconciliation-service.js";
import {
  MAX_ALIAS_HOPS,
  mergedAliasRefusal,
  resolveClaimId,
} from "../../src/services/claim-alias-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { runGraphRead } from "../../src/services/graph-read-service.js";
import { getClaimCards } from "../../src/services/claim-card-service.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { createOrder } from "../../src/services/order-service.js";
import { createClaimMandate } from "../../src/services/claim-mandate-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { submitMandateContribution } from "../../src/services/contribution-service.js";
import { fileRequest, RequestError } from "../../src/services/request-service.js";
import { executeCuratorTool } from "../../src/llm/tools/curator-tools.js";
import { executeNotifySteward } from "../../src/llm/tools/notify-steward.js";
import { insertRelationshipEdge } from "../../src/services/relationship-service.js";

const NOWHERE = "00000000-0000-4000-8000-00000000dead";

async function merge(loserId: string, survivorId: string, stanceRelation: "same" | "opposed" = "same") {
  return mergeClaims({ survivorId, loserId, stanceRelation, reasoning: "dbtest: one proposition" });
}

async function seedKind(kind: "quantity" | "question", label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(`UPDATE claims SET kind = $2 WHERE id = $1`, [id, kind]);
  return id;
}

async function seedAssessment(claimId: string, status: string): Promise<void> {
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current)
     VALUES ($1, $2, 0.8, 'dbtest', true)`,
    [claimId, status]
  );
}

async function textOf(id: string): Promise<string> {
  const [row] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [id]);
  return row!.text;
}

describe("resolveClaimId", () => {
  it("leaves a node's own id alone, and answers null for an id no node has", async () => {
    const id = await seedClaim("own");
    expect(await resolveClaimId(id)).toEqual({ id, resolvedFrom: null });
    expect(await resolveClaimId(NOWHERE)).toBeNull();
  });

  it("resolves an absorbed id to its survivor, with the alias's wording, relation and date", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    const aliasText = await textOf(alias);
    await merge(alias, survivor);

    const resolution = await resolveClaimId(alias);
    expect(resolution!.id).toBe(survivor);
    expect(resolution!.resolvedFrom).toMatchObject({
      id: alias,
      canonical_form: aliasText,
      stance_relation: "same",
    });
    const mergedAt = Date.parse(resolution!.resolvedFrom!.merged_at!);
    expect(Math.abs(Date.now() - mergedAt)).toBeLessThan(60_000);
    // The survivor's own id is still its own.
    expect(await resolveClaimId(survivor)).toEqual({ id: survivor, resolvedFrom: null });
  });

  it("says when the absorbed node was the survivor's negation", async () => {
    const survivor = await seedClaim("holds");
    const negation = await seedClaim("does not hold");
    await merge(negation, survivor, "opposed");
    expect((await resolveClaimId(negation))!.resolvedFrom!.stance_relation).toBe("opposed");
  });

  it("follows a two-hop chain to its end and composes the relation along it", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const c = await seedClaim("c");
    await merge(a, b, "opposed");
    await merge(b, c, "same");
    // a was b's negation, and b is c: a is c's negation.
    const fromA = await resolveClaimId(a);
    expect(fromA!.id).toBe(c);
    expect(fromA!.resolvedFrom).toMatchObject({ id: a, stance_relation: "opposed" });
    expect((await resolveClaimId(b))!.resolvedFrom).toMatchObject({ id: b, stance_relation: "same" });

    // Two opposed merges in a row put the first id back on the survivor's side.
    const x = await seedClaim("x");
    const y = await seedClaim("y");
    const z = await seedClaim("z");
    await merge(x, y, "opposed");
    await merge(y, z, "opposed");
    const fromX = await resolveClaimId(x);
    expect(fromX!.id).toBe(z);
    expect(fromX!.resolvedFrom!.stance_relation).toBe("same");
  });

  it("covers quantities and questions, which share the table", async () => {
    for (const kind of ["quantity", "question"] as const) {
      const survivor = await seedKind(kind, `${kind} survivor`);
      const alias = await seedKind(kind, `${kind} alias`);
      await merge(alias, survivor);
      const resolution = await resolveClaimId(alias);
      expect(resolution!.id).toBe(survivor);
      const view = await getClaimView(alias);
      expect((view!.claim as { id: string; kind: string })).toMatchObject({ id: survivor, kind });
      expect(view!.resolved_from).toMatchObject({ id: alias, stance_relation: "same" });
    }
  });

  it("stops resolving once the merge is reversed, and reads the live merge after a re-merge", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    const { eventId } = await merge(alias, survivor, "opposed");
    expect(await reverseReconciliation(eventId!, { reasoning: "two claims after all" })).toEqual({ reversed: true });
    expect(await resolveClaimId(alias)).toEqual({ id: alias, resolvedFrom: null });

    await merge(alias, survivor, "same");
    expect((await resolveClaimId(alias))!.resolvedFrom!.stance_relation).toBe("same");
  });

  it("does not loop on a corrupt pointer: a cycle is served as the row it names", async () => {
    const a = await seedClaim("cycle a");
    const b = await seedClaim("cycle b");
    await rawQuery(`UPDATE claims SET merged_into = $2, state = 'merged' WHERE id = $1`, [a, b]);
    await rawQuery(`UPDATE claims SET merged_into = $2, state = 'merged' WHERE id = $1`, [b, a]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveClaimId(a)).toEqual({ id: a, resolvedFrom: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(MAX_ALIAS_HOPS).toBeGreaterThan(2);
    // Undo, so no later whole-table read meets the cycle.
    await rawQuery(`UPDATE claims SET merged_into = NULL, state = 'deprecated' WHERE id = ANY($1::uuid[])`, [[a, b]]);
  });

  it("reports the relation as unknown when the merge left no record", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    // A pointer with no reconciliation event behind it.
    await rawQuery(`UPDATE claims SET merged_into = $2, state = 'merged', updated_at = now() WHERE id = $1`, [alias, survivor]);
    const resolution = await resolveClaimId(alias);
    expect(resolution!.id).toBe(survivor);
    expect(resolution!.resolvedFrom!.stance_relation).toBeNull();
    expect(resolution!.resolvedFrom!.merged_at).not.toBeNull();
  });
});

describe("reads of a merged id (agents' tools)", () => {
  it("get_claim returns the survivor's view, saying which id was asked", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    await seedAssessment(survivor, "well_supported");
    await seedAssessment(alias, "doubtful");
    await merge(alias, survivor, "opposed");

    const view = (await getClaimView(alias))!;
    // The notice comes before the verdict it qualifies.
    expect(Object.keys(view)[0]).toBe("resolved_from");
    expect(view.resolved_from).toMatchObject({ id: alias, stance_relation: "opposed" });
    expect(view.claim).toMatchObject({ id: survivor, state: "active" });
    expect((view.claim as { page_url: string }).page_url.endsWith(`/claims/${survivor}`)).toBe(true);
    // The survivor's verdict, not the absorbed row's stale one.
    expect(view.assessment).toMatchObject({ status: "well_supported" });

    // The survivor read by its own id carries no notice.
    const own = (await getClaimView(survivor))!;
    expect("resolved_from" in own).toBe(false);

    // The same through an agent's tool loop.
    const viaTool = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: alias }))!);
    expect(viaTool.claim.id).toBe(survivor);
    expect(viaTool.resolved_from.id).toBe(alias);
  });

  it("an id no node has is said plainly, with the code a dispatcher reads", async () => {
    const out = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: NOWHERE }))!);
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.error).toContain(`No node has the id "${NOWHERE}"`);
    const walk = JSON.parse((await executeGraphReadTool("get_decomposition", { claim_id: NOWHERE }))!);
    expect(walk.code).toBe("CLAIM_NOT_FOUND");
  });

  it("get_decomposition and get_dependents walk from the survivor", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    const child = await seedClaim("child");
    const parent = await seedClaim("parent");
    await insertRelationshipEdge({
      parentId: alias, childId: child, relationType: "requires", reasoning: "r", confidence: 1, createdBy: "dbtest",
    });
    await insertRelationshipEdge({
      parentId: parent, childId: alias, relationType: "requires", reasoning: "r", confidence: 1, createdBy: "dbtest",
    });
    await merge(alias, survivor);

    const down = await runGraphRead("get_decomposition", { claim_id: alias });
    expect(down).toMatchObject({ ok: true });
    const downPayload = (down as { payload: Record<string, any> }).payload;
    expect(downPayload.claim_id).toBe(survivor);
    expect(downPayload.resolved_from).toMatchObject({ id: alias });
    expect(JSON.stringify(downPayload.tree)).toContain(child);

    const up = await runGraphRead("get_dependents", { claim_id: alias });
    const upPayload = (up as { payload: Record<string, any> }).payload;
    expect(upPayload.claim_id).toBe(survivor);
    expect(upPayload.resolved_from).toMatchObject({ id: alias });
    expect(JSON.stringify(upPayload.dependents)).toContain(parent);

    expect(await runGraphRead("get_decomposition", { claim_id: NOWHERE })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("cards answer under the id asked with the survivor's card", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    await seedAssessment(survivor, "supported");
    await merge(alias, survivor, "opposed");

    const cards = await getClaimCards([alias, survivor, NOWHERE]);
    expect(cards.has(NOWHERE)).toBe(false);
    expect(cards.get(survivor)).toMatchObject({ id: survivor, resolved_from: null, assessment_status: "supported" });
    expect(cards.get(alias)).toMatchObject({
      id: survivor,
      state: "active",
      assessment_status: "supported",
      resolved_from: { id: alias, stance_relation: "opposed" },
    });
    // An alias asked for alone still finds its survivor.
    expect((await getClaimCards([alias])).get(alias)).toMatchObject({ id: survivor });
  });
});

describe("REST and MCP", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let survivor: string;
  let alias: string;
  let aliasText: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address === "string" || !address) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    survivor = await seedClaim("rest survivor");
    alias = await seedClaim("rest alias");
    aliasText = await textOf(alias);
    await seedAssessment(survivor, "well_supported");
    await seedAssessment(alias, "doubtful");
    await merge(alias, survivor, "opposed");
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: "GET", url });

  it("GET /claims/:id answers an alias with the survivor and resolved_from", async () => {
    const res = await get(`/claims/${alias}?information_depth=cursory`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-minerval-resolved-from"]).toBe(alias);
    const body = res.json();
    expect(body.claim.id).toBe(survivor);
    expect(body.assessment.status).toBe("well_supported");
    expect(body.resolved_from).toMatchObject({
      id: alias,
      canonical_form: aliasText,
      stance_relation: "opposed",
    });
    expect(Number.isNaN(Date.parse(body.resolved_from.merged_at))).toBe(false);

    const own = await get(`/claims/${survivor}?information_depth=cursory`);
    expect(own.headers["x-minerval-resolved-from"]).toBeUndefined();
    expect(own.json().resolved_from).toBeUndefined();

    // An uppercase alias id is the same id.
    expect((await get(`/claims/${alias.toUpperCase()}?information_depth=cursory`)).json().claim.id).toBe(survivor);
    expect((await get(`/claims/${NOWHERE}`)).statusCode).toBe(404);
  });

  it("keeps resolved_from whatever `fields` trims the response to", async () => {
    const body = (await get(`/claims/${alias}?information_depth=cursory&fields=assessment.status`)).json();
    expect(body).toEqual({
      resolved_from: expect.objectContaining({ id: alias, stance_relation: "opposed" }),
      assessment: { status: "well_supported" },
    });
  });

  it("every read route under the id resolves the same way", async () => {
    const card = (await get(`/claims/${alias}/card`)).json();
    expect(card).toMatchObject({ id: survivor, assessment_status: "well_supported", resolved_from: { id: alias } });
    expect((await get(`/claims/${survivor}/card`)).json().resolved_from).toBeNull();

    const cards = (await get(`/claims/cards?ids=${alias},${survivor},${NOWHERE}`)).json();
    expect(cards.not_found).toEqual([NOWHERE]);
    expect(cards.cards.map((c: { id: string }) => c.id)).toEqual([survivor, survivor]);
    expect(cards.cards[0].resolved_from).toMatchObject({ id: alias, stance_relation: "opposed" });
    expect(cards.cards[1].resolved_from).toBeNull();

    // The survivor's history, not the absorbed row's own stale verdict.
    const history = (await get(`/claims/${alias}/assessments`)).json();
    expect(history.resolved_from).toMatchObject({ id: alias });
    expect(history.assessments.map((a: { status: string }) => a.status)).toEqual(["well_supported"]);

    for (const path of ["dependents", "record", "assessments/trajectory", "events", "provenance", "citation"]) {
      const res = await get(`/claims/${alias}/${path}`);
      expect(res.statusCode, path).toBe(200);
      expect(res.json().resolved_from, path).toMatchObject({ id: alias, stance_relation: "opposed" });
      expect(res.headers["x-minerval-resolved-from"], path).toBe(alias);
    }

    // A text export cannot carry the field; the header does, and the text is the survivor's.
    const bibtex = await get(`/claims/${alias}/citation?format=bibtex`);
    expect(bibtex.statusCode).toBe(200);
    expect(bibtex.headers["x-minerval-resolved-from"]).toBe(alias);
    expect(bibtex.body).toContain(survivor);
    expect(bibtex.body).not.toContain(alias);
  });

  it("the formal statement routes answer with the row the id names", async () => {
    const res = await get(`/claims/${alias}/formalizations`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-minerval-resolved-from"]).toBeUndefined();
    expect(res.json().claim_id).toBe(alias);
  });

  it("refuses a write addressed to an alias with 409 and the survivor", async () => {
    for (const [method, url, payload] of [
      ["POST", `/claims/${alias}/order`, undefined],
      ["POST", `/claims/${alias}/contribute`, { owls: 1 }],
      ["POST", `/claims/${alias}/decompose`, { budget_owls: 10 }],
    ] as const) {
      const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(409);
      const body = res.json();
      expect(body.code, url).toBe("CLAIM_MERGED");
      expect(body.merged_into, url).toBe(survivor);
      expect(body.error, url).toContain(`was merged into ${survivor}`);
      expect(body.error, url).toContain("states the opposite");
    }
    // A write to the survivor is not refused by this check (it needs a signed-in user).
    expect((await app.inject({ method: "POST", url: `/claims/${survivor}/order` })).statusCode).toBe(401);
  });

  describe("MCP", () => {
    let client: Client;
    const parse = (result: { content?: unknown }) =>
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

    beforeAll(async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { "x-api-key": "aliaskey" } },
      });
      client = new Client({ name: "alias-test", version: "0.0.0" });
      await client.connect(transport);
    });

    afterAll(async () => {
      await client.close();
    });

    it("get_claim, the walks and the route tools resolve an alias alike", async () => {
      const view = parse(await client.callTool({ name: "get_claim", arguments: { claim_id: alias } }));
      expect(view.claim.id).toBe(survivor);
      expect(view.resolved_from).toMatchObject({
        id: alias,
        canonical_form: aliasText,
        stance_relation: "opposed",
      });

      const down = parse(await client.callTool({ name: "get_decomposition", arguments: { claim_id: alias } }));
      expect(down.claim_id).toBe(survivor);
      expect(down.resolved_from.id).toBe(alias);

      const up = parse(await client.callTool({ name: "get_dependents", arguments: { claim_id: alias } }));
      expect(up.claim_id).toBe(survivor);
      expect(up.resolved_from.id).toBe(alias);

      // Tools generated from the REST routes dispatch to them, so they agree.
      const card = parse(await client.callTool({ name: "get_claim_card", arguments: { claim_id: alias } }));
      expect(card).toMatchObject({ id: survivor, resolved_from: { id: alias, stance_relation: "opposed" } });
      const history = parse(
        await client.callTool({ name: "get_assessment_history", arguments: { claim_id: alias } })
      );
      expect(history.resolved_from.id).toBe(alias);
    });

    it("says what resolved_from means where a caller reads the tool", async () => {
      const { tools } = await client.listTools();
      const getClaim = tools.find((t) => t.name === "get_claim")!;
      expect(getClaim.description).toContain("resolved_from");
      expect(getClaim.description).toContain("OPPOSITE");
      expect(tools.find((t) => t.name === "get_decomposition")!.description).toContain("resolved_from");
    });

    it("refuses a write to an alias and names the survivor", async () => {
      const contribution = await client.callTool({
        name: "submit_contribution",
        arguments: {
          claim_id: alias,
          contribution_type: "challenge",
          content: "The evidence cited for this does not bear the weight placed on it, for these reasons.",
        },
      });
      expect(contribution.isError).toBe(true);
      const error = parse(contribution).error;
      expect(error.code).toBe("CLAIM_MERGED");
      expect(error.message).toContain(`was merged into ${survivor}`);
      const [landed] = await rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM contributions WHERE claim_id = $1`,
        [alias]
      );
      expect(landed!.n).toBe(0);

      const order = await client.callTool({ name: "order_assessment", arguments: { claim_id: alias } });
      expect(order.isError).toBe(true);
      expect(parse(order).error).toMatchObject({ code: "CLAIM_MERGED", status: 409 });
    });
  });
});

describe("writes addressed to a merged id", () => {
  it("names the survivor, and says so when the merge was with a negation", async () => {
    const survivor = await seedClaim("survivor");
    const same = await seedClaim("same");
    const negation = await seedClaim("negation");
    await merge(same, survivor);
    await merge(negation, survivor, "opposed");

    const plain = await mergedAliasRefusal(same);
    expect(plain).toMatchObject({ survivorId: survivor, stanceRelation: "same" });
    expect(plain!.message).toBe(`Node ${same} was merged into ${survivor}; address that node. Nothing was written.`);

    const opposed = await mergedAliasRefusal(negation);
    expect(opposed!.stanceRelation).toBe("opposed");
    expect(opposed!.message).toContain(`${survivor} states the opposite of what ${negation} stated`);

    expect(await mergedAliasRefusal(survivor)).toBeNull();
    expect(await mergedAliasRefusal(NOWHERE)).toBeNull();
    expect(await mergedAliasRefusal("not-an-id")).toBeNull();
    expect(await mergedAliasRefusal(undefined)).toBeNull();
  });

  it("services refuse orders, funding, commissions, contributions and requests", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    await merge(alias, survivor);
    const userId = await seedUser("alias-writer");
    const named = `was merged into ${survivor}`;

    const order = await createOrder({ userId, claimId: alias });
    expect(order).toMatchObject({ ok: false, code: "CLAIM_NOT_ACTIVE" });
    expect((order as { message: string }).message).toContain(named);

    const mandate = await createClaimMandate({ userId, claimId: alias, budgetOwls: 10 });
    expect(mandate).toMatchObject({ ok: false, code: "CLAIM_NOT_FOUND" });
    expect((mandate as { message: string }).message).toContain(named);

    const commission = await commissionNodePass({
      payer: { kind: "user", userId } as never,
      claimId: alias,
      budgetMicroUsd: 1_000_000,
      brief: "look again",
      commissionedBy: "person",
    });
    expect(commission).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((commission as { message: string }).message).toContain(named);

    const contribution = await submitMandateContribution({
      researchRunId: NOWHERE,
      input: {
        claim_id: alias,
        contribution_type: "challenge",
        content: "What I found, and what it rests on, at enough length to be a contribution.",
      },
    });
    expect(contribution.success).toBe(false);
    expect(contribution.message).toContain(named);

    await expect(
      fileRequest({
        ask: "Find the original measurement",
        why: "The claim rests on it",
        satisfiedBy: "A primary source",
        claimIds: [alias],
        filer: { kind: "agent", agent: "curator" },
      } as never)
    ).rejects.toThrow(named);
    await expect(
      fileRequest({
        ask: "Find the original measurement",
        why: "The claim rests on it",
        satisfiedBy: "A primary source",
        claimIds: [NOWHERE],
        filer: { kind: "agent", agent: "curator" },
      } as never)
    ).rejects.toThrow(RequestError);

    // Nothing landed on the absorbed row.
    const [orders] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM assessment_orders WHERE claim_id = $1`, [alias]);
    expect(orders!.n).toBe(0);
  });

  it("the Curator cannot merge into, link to, or hang an edge on an absorbed node", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    const other = await seedClaim("other");
    await merge(alias, survivor);
    const named = `was merged into ${survivor}`;

    const intoAlias = JSON.parse(
      await executeCuratorTool("merge_claims", {
        survivor_id: alias, loser_id: other, stance_relation: "same", reasoning: "dup",
      })
    );
    expect(intoAlias.success).toBe(false);
    expect(intoAlias.message).toContain(named);
    const [otherRow] = await rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id = $1`, [other]);
    expect(otherRow!.state).toBe("active");

    const edge = JSON.parse(
      await executeCuratorTool("add_relationship_edge", {
        parent_id: other, child_id: alias, relation: "requires", reasoning: "r",
      })
    );
    expect(edge.success).toBe(false);
    expect(edge.message).toContain(named);

    const link = JSON.parse(
      await executeCuratorTool("link_claims", {
        claim_id: other, other_claim_id: alias, kind: "see_also", reasoning: "r",
      })
    );
    expect(link.success).toBe(false);
    expect(link.message).toContain(named);

    const [edges] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM claim_relationships WHERE child_claim_id = $1 OR parent_claim_id = $1`,
      [alias]
    );
    expect(edges!.n).toBe(0);

    // A merge between two live nodes still goes through, and chains resolve.
    const chained = JSON.parse(
      await executeCuratorTool("merge_claims", {
        survivor_id: other, loser_id: survivor, stance_relation: "same", reasoning: "dup",
      })
    );
    expect(chained.success).toBe(true);
    expect((await resolveClaimId(alias))!.id).toBe(other);
  });

  it("a notice to an absorbed node's Steward is refused, naming the survivor", async () => {
    const survivor = await seedClaim("survivor");
    const alias = await seedClaim("alias");
    await merge(alias, survivor);
    const out = JSON.parse(
      await executeNotifySteward({ role: "curator" }, { target_ids: [alias], message: "The wording needs a look." })
    );
    expect(JSON.stringify(out)).toContain(`was merged into ${survivor}`);
    const [queued] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1`,
      [alias]
    );
    expect(queued!.n).toBe(0);
  });
});
