/**
 * Requests (constitution Part VIII) against real Postgres: the keeper fixed
 * from the targets, the filer labels (a mandate never named), work moving a
 * request into progress, closed states staying closed, the list filters, and
 * the /requests routes.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedGrantWithJob, seedUser, pgCode } from "./helpers.js";
import {
  fileRequest,
  getRequest,
  listRequests,
  recordWork,
  RequestError,
  setRequestState,
} from "../../src/services/request-service.js";
import { defineQuantity } from "../../src/services/quantity-service.js";
import { requestRoutes } from "../../src/routes/requests.js";

const BASE = {
  ask: "Recover regional mortality estimates for the 1918 pandemic outside the registered countries.",
  why: "The global estimate turns on how much of the world's mortality the registers missed.",
  satisfiedBy: "Estimates with stated methods for regions holding half the unregistered population.",
};

async function seedSource(): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title) VALUES ($1, 'DB-test source') RETURNING id`,
    [`https://example.org/${randomUUID()}`]
  );
  return row!.id;
}

describe("filing", () => {
  it("gives a request on one node to that node's Steward, any other to the Curator", async () => {
    const q = await seedClaim("quantity");
    await defineQuantity({
      claimId: q,
      definition: { measures: "Deaths", unit: { kind: "count" } },
      createdBy: "dbtest",
    });
    const one = await fileRequest({ ...BASE, claimIds: [q], filer: { kind: "admin", agent: "claim_steward" } });
    const view = await getRequest(one.id);
    expect(view).toMatchObject({
      keeper: { kind: "steward", label: "the quantity's Steward" },
      filed_by: { kind: "admin", label: "Claim Steward" },
      bears_on: [{ id: q, kind: "quantity" }],
      state: "open",
    });

    const two = await fileRequest({
      ...BASE,
      claimIds: [q, await seedClaim()],
      addressedTo: "Pathology archives",
      filer: { kind: "admin", agent: "question_steward" },
    });
    expect(await getRequest(two.id)).toMatchObject({
      keeper: { kind: "curator", label: "the Curator" },
      state: "addressed",
      addressed_to: "Pathology archives",
    });

    const src = await seedSource();
    const onSource = await fileRequest({ ...BASE, claimIds: [q], sourceIds: [src], filer: { kind: "admin", agent: "curator" } });
    expect(await getRequest(onSource.id)).toMatchObject({
      keeper: { kind: "curator" },
      bears_on_sources: [{ id: src, title: "DB-test source" }],
    });

    const unheld = await fileRequest({
      ...BASE,
      bearsOnText: "A regional table the graph does not hold yet",
      filer: { kind: "admin", agent: "curator" },
    });
    expect(await getRequest(unheld.id)).toMatchObject({ keeper: { kind: "curator" }, bears_on: [] });
  });

  it("names a contributor, never a mandate", async () => {
    const user = await seedUser("filer");
    const c = await fileRequest({ ...BASE, claimIds: [await seedClaim()], filer: { kind: "contributor", contributorId: user } });
    expect((await getRequest(c.id))!.filed_by).toEqual({ kind: "contributor", label: expect.stringMatching(/^dbtest filer/) });

    const funder = await seedUser("funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const m = await fileRequest({ ...BASE, claimIds: [await seedClaim()], filer: { kind: "mandate", grantId } });
    expect((await getRequest(m.id))!.filed_by).toEqual({ kind: "mandate", label: "a funded mandate" });
  });

  it("refuses a request with nothing to bear on, or on a node that is not live", async () => {
    await expect(fileRequest({ ...BASE, filer: { kind: "admin", agent: "curator" } })).rejects.toBeInstanceOf(RequestError);
    await expect(
      fileRequest({ ...BASE, claimIds: [randomUUID()], filer: { kind: "admin", agent: "curator" } })
    ).rejects.toThrow(/No active node/);
    // The database holds the keeper invariant too.
    const err = await rawQuery(
      `INSERT INTO requests (ask, why, satisfied_by, filer_kind, keeper_kind) VALUES ('a', 'b', 'c', 'admin', 'steward')`
    ).catch((e) => e);
    expect(pgCode(err)).toBe("23514");
  });
});

describe("work and state", () => {
  it("moves a request into progress with work, and keeps a closed request closed", async () => {
    const claim = await seedClaim();
    const { id } = await fileRequest({ ...BASE, claimIds: [claim], filer: { kind: "admin", agent: "claim_steward" } });
    await recordWork({ requestId: id, byLabel: "Researcher", summary: "Searching regional archives" });
    expect((await getRequest(id))!.state).toBe("in_progress");
    await recordWork({ requestId: id, byLabel: "Researcher", outcome: "negative", summary: "No estimates exist for these regions" });
    // An outcome does not close the request; that is the keeper's call.
    expect((await getRequest(id))!.state).toBe("in_progress");

    await expect(setRequestState({ requestId: id, state: "declined" })).rejects.toThrow(/says why/);
    await setRequestState({ requestId: id, state: "moot", note: "The question it served was withdrawn" });
    const closed = await getRequest(id);
    expect(closed).toMatchObject({ state: "moot", state_note: "The question it served was withdrawn" });
    expect(closed!.work.map((w) => w.outcome)).toEqual([null, "negative"]);
    await expect(setRequestState({ requestId: id, state: "open" })).rejects.toThrow(/already moot/);
    await expect(recordWork({ requestId: id, byLabel: "Researcher", summary: "late" })).rejects.toThrow(/moot/);
    const [row] = await rawQuery<{ closed_at: Date | null }>(`SELECT closed_at FROM requests WHERE id = $1`, [id]);
    expect(row!.closed_at).not.toBeNull();
  });

  it("discloses a mandate's funding of work as an arrangement, not a name", async () => {
    const funder = await seedUser("funder");
    const { jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const { id } = await fileRequest({ ...BASE, claimIds: [await seedClaim()], filer: { kind: "admin", agent: "claim_steward" } });
    await recordWork({ requestId: id, byLabel: "Researcher", outcome: "met", summary: "Found", fundedByJobId: jobId });
    expect((await getRequest(id))!.work[0]!.funded_by).toBe("a funded mandate");
  });
});

describe("listing and routes", () => {
  it("filters by node and by liveness, and serves both routes", async () => {
    const claim = await seedClaim();
    const live = await fileRequest({ ...BASE, claimIds: [claim], filer: { kind: "admin", agent: "claim_steward" } });
    const met = await fileRequest({ ...BASE, claimIds: [claim], filer: { kind: "admin", agent: "claim_steward" } });
    await setRequestState({ requestId: met.id, state: "met" });
    await fileRequest({ ...BASE, claimIds: [await seedClaim()], filer: { kind: "admin", agent: "claim_steward" } });

    const onClaim = await listRequests({ claimId: claim });
    expect(onClaim.total).toBe(2);
    expect(new Set(onClaim.items.map((r) => r.id))).toEqual(new Set([live.id, met.id]));
    const liveOnClaim = await listRequests({ claimId: claim, live: true });
    expect(liveOnClaim.items.map((r) => r.id)).toEqual([live.id]);

    const app = Fastify();
    await app.register(requestRoutes, { prefix: "/requests" });
    await app.ready();
    try {
      const list = await app.inject({ method: "GET", url: `/requests?claim_id=${claim}&state=live` });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ total: 1, requests: [{ id: live.id, ask: BASE.ask, keeper: { kind: "steward" } }] });
      const one = await app.inject({ method: "GET", url: `/requests/${met.id}` });
      expect(one.json()).toMatchObject({ id: met.id, state: "met", work: [] });
      expect((await app.inject({ method: "GET", url: `/requests/${randomUUID()}` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // Keyword search over requests.text_search: a match in the ask outranks
  // one only in the reasons, and search composes with the other filters.
  it("searches what a request asks and why, ranking the ask first", async () => {
    const word = `zr${randomUUID().slice(0, 8)}`;
    const claim = await seedClaim();
    const filer = { kind: "admin" as const, agent: "claim_steward" };
    const inWhy = await fileRequest({ ...BASE, why: `${BASE.why} See ${word}.`, claimIds: [claim], filer });
    const inAsk = await fileRequest({ ...BASE, ask: `Find the ${word} registers.`, claimIds: [claim], filer });
    const inSatisfied = await fileRequest({
      ...BASE, satisfiedBy: `A ${word} table.`, claimIds: [await seedClaim()], filer,
    });
    await setRequestState({ requestId: inSatisfied.id, state: "met" });
    await fileRequest({ ...BASE, claimIds: [claim], filer });

    const all = await listRequests({ q: word });
    expect(all.total).toBe(3);
    expect(all.items.map((r) => r.id)).toEqual([inAsk.id, inWhy.id, inSatisfied.id]);
    expect((await listRequests({ q: word, live: true })).items.map((r) => r.id)).toEqual([inAsk.id, inWhy.id]);
    expect((await listRequests({ q: word, claimId: claim })).total).toBe(2);
    expect((await listRequests({ q: `${word}nothing` })).total).toBe(0);

    const app = Fastify();
    await app.register(requestRoutes, { prefix: "/requests" });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: `/requests?q=${encodeURIComponent(word)}&state=live` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 2, requests: [{ id: inAsk.id }, { id: inWhy.id }] });
    } finally {
      await app.close();
    }
  });
});
