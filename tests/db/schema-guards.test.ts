/**
 * The migration-installed backstops, exercised against real Postgres:
 * CHECK constraints on money columns, and the partial unique indexes that
 * make racing writers converge instead of double-spending. These are the
 * guards the mocked unit suite is structurally unable to see.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { createOrder } from "../../src/services/order-service.js";
import {
  seedUser,
  seedClaim,
  seedGrantWithJob,
  seedAllocation,
  seedAction,
  pgCode,
  OWL,
} from "./helpers.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

describe("migration sanity", () => {
  it("applied the full chain: pgvector present, last migration recorded", async () => {
    const [ext] = await rawQuery<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`
    );
    expect(ext?.extname).toBe("vector");
    const [count] = await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM drizzle.__drizzle_migrations`
    );
    // 0000..0039 — at least the full current chain applied.
    expect(Number(count!.n)).toBeGreaterThanOrEqual(40);
  });

  it("installed the money constraints and partial unique indexes", async () => {
    const constraints = await rawQuery<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN
         ('ck_action_allocations_one_funder', 'ck_action_allocations_amount',
          'ck_action_allocations_spent', 'ck_regrants_amount',
          'ck_regrants_refunded')`
    );
    expect(constraints.map((c) => c.conname).sort()).toEqual([
      "ck_action_allocations_amount",
      "ck_action_allocations_one_funder",
      "ck_action_allocations_spent",
      "ck_regrants_amount",
      "ck_regrants_refunded",
    ]);
    const indexes = await rawQuery<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN
         ('uq_action_allocations_live_placement', 'uq_orders_open_per_claim')`
    );
    expect(indexes.map((i) => i.indexname).sort()).toEqual([
      "uq_action_allocations_live_placement",
      "uq_orders_open_per_claim",
    ]);
  });
});

describe("action_allocations CHECK constraints", () => {
  it("rejects spent > amount", async () => {
    const userId = await seedUser("ck-spent");
    await expect(
      seedAllocation({
        group: `dbtest:ck-spent:${userId}`,
        userId,
        amountMicroUsd: 100,
        spentMicroUsd: 101,
      })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("rejects an UPDATE that pushes spent past amount", async () => {
    const userId = await seedUser("ck-spent-upd");
    const id = await seedAllocation({
      group: `dbtest:ck-spent-upd:${userId}`,
      userId,
      amountMicroUsd: 100,
      spentMicroUsd: 90,
    });
    await expect(
      rawQuery(
        `UPDATE action_allocations
            SET spent_micro_usd = spent_micro_usd + 20 WHERE id = $1`,
        [id]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("rejects a zero-funder row (neither grant nor user)", async () => {
    await expect(
      seedAllocation({
        group: "dbtest:ck-zero-funder",
        amountMicroUsd: 100,
      })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("rejects a double-funder row (both grant and user)", async () => {
    const userId = await seedUser("ck-double");
    const { grantId } = await seedGrantWithJob({
      funderId: userId,
      budgetMicroUsd: OWL,
    });
    await expect(
      seedAllocation({
        group: `dbtest:ck-double:${grantId}`,
        userId,
        grantId,
        amountMicroUsd: 100,
      })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("rejects non-positive amounts", async () => {
    const userId = await seedUser("ck-amount");
    for (const amount of [0, -100]) {
      await expect(
        seedAllocation({
          group: `dbtest:ck-amount:${userId}`,
          userId,
          amountMicroUsd: amount,
        })
      ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
    }
  });
});

describe("regrants CHECK constraints", () => {
  async function twoGrants() {
    const funder = await seedUser("ck-regrant");
    const a = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: OWL });
    const b = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: OWL });
    return { a: a.grantId, b: b.grantId };
  }

  it("rejects refunded > amount", async () => {
    const { a, b } = await twoGrants();
    await expect(
      rawQuery(
        `INSERT INTO regrants
           (from_grant_id, to_grant_id, amount_micro_usd, refunded_micro_usd)
         VALUES ($1, $2, 100, 101)`,
        [a, b]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("rejects an UPDATE stamping refunded past amount", async () => {
    const { a, b } = await twoGrants();
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd)
       VALUES ($1, $2, 100) RETURNING id`,
      [a, b]
    );
    await expect(
      rawQuery(
        `UPDATE regrants SET refunded_micro_usd = 101 WHERE id = $1`,
        [row!.id]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("rejects non-positive amounts", async () => {
    const { a, b } = await twoGrants();
    await expect(
      rawQuery(
        `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd)
         VALUES ($1, $2, 0)`,
        [a, b]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });
});

describe("uq_orders_open_per_claim (one open order per user per claim)", () => {
  it("createOrder: a second open order for the same (user, claim) joins the first", async () => {
    const userId = await seedUser("orders");
    const claimId = await seedClaim("orders");
    const first = await createOrder({ userId, claimId });
    expect(first.ok).toBe(true);
    const second = await createOrder({ userId, claimId });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("ORDER_ALREADY_OPEN");
      expect(second.existingOrderId).toBe(first.ok ? first.order.id : "");
    }
    const rows = await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM assessment_orders
        WHERE user_id = $1 AND claim_id = $2`,
      [userId, claimId]
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("a raw racing insert of a second open order violates the index", async () => {
    const userId = await seedUser("orders-raw");
    const claimId = await seedClaim("orders-raw");
    const insert = () =>
      rawQuery(
        `INSERT INTO assessment_orders (user_id, claim_id, price_micro_usd)
         VALUES ($1, $2, 1000000)`,
        [userId, claimId]
      );
    await insert();
    await expect(insert()).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === UNIQUE_VIOLATION
    );
  });

  it("a closed order does not block a new one", async () => {
    const userId = await seedUser("orders-closed");
    const claimId = await seedClaim("orders-closed");
    const first = await createOrder({ userId, claimId });
    expect(first.ok).toBe(true);
    await rawQuery(
      `UPDATE assessment_orders SET status = 'cancelled' WHERE id = $1`,
      [first.ok ? first.order.id : ""]
    );
    const again = await createOrder({ userId, claimId });
    expect(again.ok).toBe(true);
  });
});

describe("uq_action_allocations_live_placement (one live placement per grant × group × pin)", () => {
  async function grantAndGroup(label: string) {
    const funder = await seedUser(label);
    const { grantId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 10 * OWL,
    });
    return { grantId, group: `dbtest:${label}:${grantId}` };
  }

  it("a duplicate live placement is rejected raw and a no-op under ON CONFLICT", async () => {
    const { grantId, group } = await grantAndGroup("placement-dup");
    await seedAllocation({ group, grantId, amountMicroUsd: 100_000 });
    // Raw duplicate: unique violation.
    await expect(
      seedAllocation({ group, grantId, amountMicroUsd: 50_000 })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
    // The allocator's ON CONFLICT DO NOTHING path: silent no-op, no row.
    const inserted = await rawQuery<{ id: string }>(
      `INSERT INTO action_allocations
         (exclusion_group, grant_id, amount_micro_usd)
       VALUES ($1, $2, 50000)
       ON CONFLICT DO NOTHING RETURNING id`,
      [group, grantId]
    );
    expect(inserted.length).toBe(0);
    const rows = await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM action_allocations
        WHERE grant_id = $1 AND exclusion_group = $2`,
      [grantId, group]
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("an unpinned and a pinned placement on the same group coexist", async () => {
    const { grantId, group } = await grantAndGroup("placement-pin");
    const actionId = await seedAction({ group, costMicroUsd: 100_000 });
    await seedAllocation({ group, grantId, amountMicroUsd: 100_000 });
    await expect(
      seedAllocation({ group, grantId, actionId, amountMicroUsd: 50_000 })
    ).resolves.toBeTruthy();
  });

  it("a released old placement does not block a new one", async () => {
    const { grantId, group } = await grantAndGroup("placement-released");
    await seedAllocation({
      group,
      grantId,
      amountMicroUsd: 100_000,
      released: true,
    });
    await expect(
      seedAllocation({ group, grantId, amountMicroUsd: 100_000 })
    ).resolves.toBeTruthy();
  });

  it("a fully-spent old placement does not block a new one", async () => {
    const { grantId, group } = await grantAndGroup("placement-spent");
    await seedAllocation({
      group,
      grantId,
      amountMicroUsd: 100_000,
      spentMicroUsd: 100_000,
    });
    await expect(
      seedAllocation({ group, grantId, amountMicroUsd: 100_000 })
    ).resolves.toBeTruthy();
  });

  it("does not constrain user-funded (direct) allocations", async () => {
    const userId = await seedUser("placement-user");
    const group = `dbtest:placement-user:${userId}`;
    await seedAllocation({ group, userId, amountMicroUsd: 100_000 });
    await expect(
      seedAllocation({ group, userId, amountMicroUsd: 100_000 })
    ).resolves.toBeTruthy();
  });
});
