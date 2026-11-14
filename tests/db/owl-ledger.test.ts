/**
 * chargeOwls (src/services/owl-ledger-service.ts) against real Postgres:
 * the balance-guarded single-statement debit and the idempotency key that
 * makes a retried charge return the SAME entry instead of debiting again.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  chargeOwls,
  listOwlLedger,
  settleMeteredCharge,
} from "../../src/services/owl-ledger-service.js";
import { listOrders, orderCostsMicroUsd } from "../../src/services/order-service.js";
import { rawQuery } from "../../src/db/client.js";
import { chargeAgenticOp } from "../../src/server/plugins/quota.js";
import { seedUser, seedClaim, creditOwls, owlBalance, OWL } from "./helpers.js";

describe("chargeOwls", () => {
  it("same idempotency key twice → one debit, the same entry id back", async () => {
    const userId = await seedUser("charge-idem");
    await creditOwls(userId, 5 * OWL);
    const key = `dbtest:charge:${randomUUID()}`;

    const first = await chargeOwls({
      userId,
      priceOwls: 1,
      op: "assessment",
      idempotencyKey: key,
    });
    expect(first.charged).toBe(true);
    expect(first.entryId).not.toBeNull();

    const second = await chargeOwls({
      userId,
      priceOwls: 1,
      op: "assessment",
      idempotencyKey: key,
    });
    expect(second.charged).toBe(true);
    expect(second.entryId).toBe(first.entryId);

    // One debit on the ledger, balance down exactly one owl.
    expect(await owlBalance(userId)).toBe(4 * OWL);
    const rows = await rawQuery<{ id: string }>(
      `SELECT id FROM owl_ledger WHERE idempotency_key = $1`,
      [key]
    );
    expect(rows).toHaveLength(1);
  });

  it("CONCURRENCY: two parallel charges with one key debit once", async () => {
    const userId = await seedUser("charge-race");
    await creditOwls(userId, 5 * OWL);
    const key = `dbtest:charge-race:${randomUUID()}`;
    const charge = () =>
      chargeOwls({
        userId,
        priceOwls: 1,
        op: "assessment",
        idempotencyKey: key,
      });
    const [a, b] = await Promise.all([charge(), charge()]);
    expect(a.charged).toBe(true);
    expect(b.charged).toBe(true);
    expect(a.entryId).toBe(b.entryId);
    expect(await owlBalance(userId)).toBe(4 * OWL);
  });

  it("refuses to charge past the balance", async () => {
    const userId = await seedUser("charge-broke");
    await creditOwls(userId, Math.round(0.5 * OWL));
    const res = await chargeOwls({
      userId,
      priceOwls: 1,
      op: "assessment",
    });
    expect(res.charged).toBe(false);
    expect(res.entryId).toBeNull();
    expect(await owlBalance(userId)).toBe(Math.round(0.5 * OWL));
  });
});

// The account page reads a hold and the return from it as one piece of work
// (web/lib/owl-history.ts). The ledger says which charge a return settles,
// from the settlement's own idempotency key; nothing else is stored.
describe("chargeAgenticOp", () => {
  // In the second run with real models the organization's account on the public graph first acted by submitting
  // a published page, a route that charges without reading the balance first. The free grants land on the first
  // read of an account's balance, so the charge saw none and the page was refused "with a balance of 6".
  it("lands an account's free grants before charging it, so its first priced act is not refused", async () => {
    const userId = await seedUser("first-priced-act");
    const decision = await chargeAgenticOp({ userId, apiKeyId: null, method: "api_key" }, "source_ingest");
    expect(decision.allowed).toBe(true);
    expect(decision.entryId).toBeTruthy();
  });
});

describe("listOwlLedger: which charge a return settles", () => {
  it("names the charge for a settlement keyed by entry id and by order", async () => {
    const userId = await seedUser("ledger-pairs");
    const claimId = await seedClaim("ledger pairs");
    await creditOwls(userId, 10 * OWL);

    // A capped charge settled against its own entry id (the quota path).
    const direct = await chargeOwls({ userId, priceOwls: 1, op: "text_analysis" });
    await settleMeteredCharge({
      userId,
      capMicroUsd: OWL,
      meteredMicroUsd: 0.25 * OWL,
      settleKey: direct.entryId!,
      op: "text_analysis",
    });

    // An order, charged when its run began and settled by order id.
    const ordered = await chargeOwls({ userId, priceOwls: 2, op: "assessment", claimId });
    const orderId = randomUUID();
    await rawQuery(
      `INSERT INTO assessment_orders (id, user_id, claim_id, price_micro_usd, charge_entry_id, status)
       VALUES ($1, $2, $3, $4, $5, 'done')`,
      [orderId, userId, claimId, 2 * OWL, ordered.entryId]
    );
    await settleMeteredCharge({
      userId,
      capMicroUsd: 2 * OWL,
      meteredMicroUsd: 0.5 * OWL,
      settleKey: `order:${orderId}`,
      op: "assessment",
      claimId,
    });

    const ledger = await listOwlLedger(userId, 50);
    const returns = ledger.filter((e) => e.reason === "meter_settlement");
    expect(returns).toHaveLength(2);
    const settles = new Map(returns.map((e) => [e.op, e.settlesEntryId]));
    expect(settles.get("text_analysis")).toBe(direct.entryId);
    expect(settles.get("assessment")).toBe(ordered.entryId);
    // Nothing but a settlement names a charge.
    expect(ledger.filter((e) => e.reason !== "meter_settlement").every((e) => e.settlesEntryId === null)).toBe(true);

    // And the order's cost is its cap less what came back.
    const orders = await listOrders(userId);
    const costs = await orderCostsMicroUsd(orders);
    expect(costs.get(orderId)).toBe(0.5 * OWL);
  });

  it("gives an order no cost until it is done", async () => {
    const userId = await seedUser("ledger-open-order");
    const claimId = await seedClaim("open order");
    await rawQuery(
      `INSERT INTO assessment_orders (user_id, claim_id, price_micro_usd, status)
       VALUES ($1, $2, $3, 'pending')`,
      [userId, claimId, 2 * OWL]
    );
    const costs = await orderCostsMicroUsd(await listOrders(userId));
    expect(costs.size).toBe(0);
  });
});
