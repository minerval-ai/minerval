/**
 * Balance-guarded owl debits against real Postgres, raced. Every debit
 * (mandate contribution via addBudget, deep-decomposition hold, grant and
 * conversation-funding escrows, claim-assessment allocation, chargeOwls)
 * writes behind `SUM(amount_micro_usd) >= amount`. Under READ COMMITTED
 * each racing INSERT evaluates that guard against its own statement
 * snapshot, so without a per-user lock N parallel debits all read the same
 * pre-debit balance and all land, overdrawing it. withOwlBalanceLock
 * (src/services/owl-ledger-service.ts) serializes them on one per-user key.
 *
 * The race is forced, not hoped for: a test-only BEFORE INSERT trigger
 * parks every debit row of the raced user on a "gate" advisory lock the
 * test holds. A trigger fires after the INSERT's SELECT (and so its balance
 * guard) has run, so the gate holds each racer INSIDE the race window. The
 * test opens the gate only once every racer is parked on a lock — on the
 * gate (guard already evaluated) or, with the fix, on the owl-balance lock
 * the gated racer holds. Without the fix every racer's guard passes before
 * any commits; with it, at most one guard has run when the gate opens.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { rawQuery } from "../../src/db/client.js";
import {
  contributeToBudgetJob,
  createDeepDecompositionJob,
} from "../../src/services/budget-job-service.js";
import { chargeOwls } from "../../src/services/owl-ledger-service.js";
import { createGrant } from "../../src/services/grant-service.js";
import { fundConversationMandate } from "../../src/services/grant-conversation-service.js";
import { allocateToClaimAssessment } from "../../src/services/allocation-service.js";
import { TEST_DATABASE_URL } from "./urls.js";
import {
  seedUser,
  seedClaim,
  seedGrantWithJob,
  creditOwls,
  owlBalance,
  jobBudget,
  OWL,
} from "./helpers.js";

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await withAdmin(async (c) => {
    await c.query(`
      CREATE OR REPLACE FUNCTION dbtest_owl_debit_gate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.amount_micro_usd < 0 THEN
          PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('dbtest-owl-debit-gate:' || NEW.user_id::text, 0));
        END IF;
        RETURN NEW;
      END $$`);
    await c.query(
      `DROP TRIGGER IF EXISTS dbtest_owl_debit_gate ON owl_ledger`
    );
    await c.query(
      `CREATE TRIGGER dbtest_owl_debit_gate BEFORE INSERT ON owl_ledger
         FOR EACH ROW EXECUTE FUNCTION dbtest_owl_debit_gate()`
    );
  });
});

afterAll(async () => {
  await withAdmin(async (c) => {
    await c.query(`DROP TRIGGER IF EXISTS dbtest_owl_debit_gate ON owl_ledger`);
    await c.query(`DROP FUNCTION IF EXISTS dbtest_owl_debit_gate()`);
  });
});

/**
 * Start every call at once with `userId`'s debits gated shut, wait until
 * each call is parked on a lock (or already finished), then open the gate
 * and collect the results.
 */
async function race<T>(
  userId: string,
  calls: Array<() => Promise<T>>
): Promise<T[]> {
  return withAdmin(async (gate) => {
    await gate.query(
      `SELECT pg_advisory_lock(hashtextextended('dbtest-owl-debit-gate:' || $1::text, 0))`,
      [userId]
    );
    let settled = 0;
    const pending = calls.map((call) =>
      call().finally(() => {
        settled++;
      })
    );
    for (const p of pending) p.catch(() => {});
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await gate.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()`
      );
      if (rows[0]!.waiting + settled >= calls.length) break;
      if (Date.now() > deadline) {
        throw new Error(
          `race: only ${rows[0]!.waiting} of ${calls.length} racers parked`
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await gate.query(
      `SELECT pg_advisory_unlock(hashtextextended('dbtest-owl-debit-gate:' || $1::text, 0))`,
      [userId]
    );
    return Promise.all(pending);
  });
}

async function heldByUser(userId: string): Promise<number> {
  const [row] = await rawQuery<{ held: string }>(
    `SELECT COALESCE(-SUM(amount_micro_usd), 0) AS held FROM owl_ledger
      WHERE user_id = $1 AND reason = 'escrow_hold'`,
    [userId]
  );
  return Number(row!.held);
}

async function seedMandateJob(label: string): Promise<string> {
  const funder = await seedUser(label);
  const { jobId } = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: OWL,
  });
  return jobId;
}

async function seedProposedConversation(userId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO grant_conversations (user_id, status, messages, mandate)
     VALUES ($1, 'proposed', '[]'::jsonb, $2::jsonb) RETURNING id`,
    [
      userId,
      JSON.stringify({
        title: "DB-test raced mandate",
        objective: "Assess one claim.",
        plan: {
          strategy: "One pass.",
          items: [{ action: "assess", rationale: "the root" }],
        },
        expected_cost_owls: 1,
      }),
    ]
  );
  return row!.id;
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(sql, params);
  return Number(row!.n);
}

/** Every debit path other than the contribution, each spending ~10 owls. */
type OtherDebit = {
  name: string;
  setup: (userId: string) => Promise<() => Promise<boolean>>;
};

const OTHER_DEBITS: OtherDebit[] = [
  {
    name: "createDeepDecompositionJob",
    setup: async (userId) => {
      const claimId = await seedClaim("race-decomp");
      return async () =>
        (await createDeepDecompositionJob({ userId, claimId, budgetOwls: 10 }))
          .ok;
    },
  },
  {
    name: "chargeOwls",
    setup: async (userId) => async () =>
      (await chargeOwls({ userId, priceOwls: 10, op: "assessment" })).charged,
  },
  {
    name: "createGrant",
    setup: async (userId) => {
      const claimId = await seedClaim("race-grant");
      return async () =>
        (
          await createGrant({
            funderUserId: userId,
            name: "DB-test raced grant",
            policy: "deepen",
            budgetOwls: 10,
            scopeClaimId: claimId,
          })
        ).ok;
    },
  },
  {
    name: "fundConversationMandate",
    setup: async (userId) => {
      const conversationId = await seedProposedConversation(userId);
      return async () =>
        (await fundConversationMandate({ conversationId, userId, budgetOwls: 10 }))
          .ok;
    },
  },
  {
    name: "allocateToClaimAssessment",
    setup: async (userId) => {
      const claimId = await seedClaim("race-allocate");
      return async () =>
        (await allocateToClaimAssessment({ userId, claimId, owls: 10 })).ok;
    },
  },
];

/** The side rows a refused debit must not leave behind. */
async function assertNoOrphans(userId: string): Promise<void> {
  // A refused decomposition/grant deletes its unfunded job: every budget
  // job the user owns is funded by exactly its own escrow hold.
  const unfunded = await countRows(
    `SELECT count(*)::int AS n FROM budget_jobs j
      WHERE j.user_id = $1
        AND j.budget_micro_usd <> COALESCE((
              SELECT -SUM(l.amount_micro_usd) FROM owl_ledger l
               WHERE l.job_id = j.id AND l.reason = 'escrow_hold'), 0)`,
    [userId]
  );
  expect(unfunded).toBe(0);
  const stuck = await countRows(
    `SELECT count(*)::int AS n FROM grant_conversations
      WHERE user_id = $1 AND status = 'funding'`,
    [userId]
  );
  expect(stuck).toBe(0);
}

describe("contributeToBudgetJob — racing contributions from one user", () => {
  it("CONCURRENCY: N parallel full-balance contributions to one mandate escrow the balance once", async () => {
    const PARALLEL = 5;
    const jobId = await seedMandateJob("contrib-race-one");
    const contributor = await seedUser("contrib-race-one-user");
    await creditOwls(contributor, 10 * OWL);

    const results = await race(
      contributor,
      Array.from(
        { length: PARALLEL },
        () => () => contributeToBudgetJob({ jobId, userId: contributor, owls: 10 })
      )
    );

    const ok = results.filter((r) => r.ok);
    const refused = results.filter(
      (r) => !r.ok && r.code === "INSUFFICIENT_OWLS"
    );
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(PARALLEL - 1);
    expect(await owlBalance(contributor)).toBe(0);
    expect(await heldByUser(contributor)).toBe(10 * OWL);
    // The funder's 1 owl plus exactly one 10-owl contribution.
    expect(await jobBudget(jobId)).toBe(11 * OWL);
  });

  it("CONCURRENCY: parallel contributions across several mandates never overdraw", async () => {
    const PARALLEL = 5;
    const jobIds: string[] = [];
    for (let i = 0; i < PARALLEL; i++) {
      jobIds.push(await seedMandateJob(`contrib-race-many-${i}`));
    }
    const contributor = await seedUser("contrib-race-many-user");
    await creditOwls(contributor, 10 * OWL);

    // 5 × 3 owls against a 10-owl balance: exactly three fit.
    const results = await race(
      contributor,
      jobIds.map(
        (jobId) => () =>
          contributeToBudgetJob({ jobId, userId: contributor, owls: 3 })
      )
    );

    const ok = results.filter((r) => r.ok);
    const refused = results.filter(
      (r) => !r.ok && r.code === "INSUFFICIENT_OWLS"
    );
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(PARALLEL - 3);
    expect(await owlBalance(contributor)).toBe(OWL);
    expect(await heldByUser(contributor)).toBe(9 * OWL);
    let credited = 0;
    for (const jobId of jobIds) credited += (await jobBudget(jobId)) - OWL;
    expect(credited).toBe(9 * OWL);
  });

  it("a single contribution within the balance still lands, and one beyond it is refused", async () => {
    const jobId = await seedMandateJob("contrib-sequential");
    const contributor = await seedUser("contrib-sequential-user");
    await creditOwls(contributor, 10 * OWL);

    const first = await contributeToBudgetJob({
      jobId,
      userId: contributor,
      owls: 4,
    });
    expect(first.ok).toBe(true);
    const second = await contributeToBudgetJob({
      jobId,
      userId: contributor,
      owls: 7,
    });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.code).toBe("INSUFFICIENT_OWLS");
    expect(await owlBalance(contributor)).toBe(6 * OWL);
    expect(await jobBudget(jobId)).toBe(5 * OWL);
  });
});

describe("a contribution racing every other balance-guarded debit", () => {
  it.each(OTHER_DEBITS.map((d) => [d.name, d] as const))(
    "CONCURRENCY: contribution vs %s on a balance that covers one — exactly one lands, balance never below 0",
    async (_name, other) => {
      const jobId = await seedMandateJob(`cross-race-${other.name}`);
      const user = await seedUser(`cross-race-${other.name}-user`);
      await creditOwls(user, 10 * OWL);
      const otherCall = await other.setup(user);

      const [contributed, otherOk] = await race<boolean>(user, [
        async () =>
          (await contributeToBudgetJob({ jobId, userId: user, owls: 10 })).ok,
        otherCall,
      ]);

      expect([contributed, otherOk].filter(Boolean)).toHaveLength(1);
      const balance = await owlBalance(user);
      expect(balance).toBeGreaterThanOrEqual(0);
      if (contributed) {
        expect(balance).toBe(0);
        expect(await jobBudget(jobId)).toBe(11 * OWL);
      } else {
        expect(await jobBudget(jobId)).toBe(OWL);
      }
      await assertNoOrphans(user);
    }
  );

  it("CONCURRENCY: every debit path at once on a balance that covers one — exactly one lands", async () => {
    const jobId = await seedMandateJob("all-race");
    const user = await seedUser("all-race-user");
    await creditOwls(user, 10 * OWL);
    const others = await Promise.all(OTHER_DEBITS.map((d) => d.setup(user)));

    const results = await race<boolean>(user, [
      async () =>
        (await contributeToBudgetJob({ jobId, userId: user, owls: 10 })).ok,
      ...others,
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await owlBalance(user)).toBeGreaterThanOrEqual(0);
    await assertNoOrphans(user);
  });

  it("CONCURRENCY: parallel charges never overdraw (the former one-operation overshoot)", async () => {
    const user = await seedUser("charge-race-overshoot");
    await creditOwls(user, 10 * OWL);
    const results = await race(
      user,
      Array.from(
        { length: 4 },
        () => () => chargeOwls({ userId: user, priceOwls: 4, op: "assessment" })
      )
    );
    // 4 × 4 owls against 10: exactly two fit.
    expect(results.filter((r) => r.charged)).toHaveLength(2);
    expect(await owlBalance(user)).toBe(2 * OWL);
  });
});
