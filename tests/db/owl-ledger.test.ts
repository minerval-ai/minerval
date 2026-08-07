/**
 * chargeOwls (src/services/owl-ledger-service.ts) against real Postgres:
 * the balance-guarded single-statement debit and the idempotency key that
 * makes a retried charge return the SAME entry instead of debiting again.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { chargeOwls } from "../../src/services/owl-ledger-service.js";
import { rawQuery } from "../../src/db/client.js";
import { seedUser, creditOwls, owlBalance, OWL } from "./helpers.js";

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
