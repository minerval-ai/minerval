/**
 * The subscription router where a deployment holds material at more than
 * one label (src/services/subscription-router.ts). The router runs on the
 * engine's tick, which sees every label. What reaches a subscriber is held
 * to what the subscriber's own label reads: an event at a label it does not
 * read is not delivered and nothing is said of it, and a delivery is
 * written at the subscriber's label.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { closeDb, rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { runAtLabel } from "../../src/llm/usage-context.js";
import { recordEvent } from "../../src/services/event-service.js";
import { routeEvents } from "../../src/services/subscription-router.js";
import { seedClaim } from "./helpers.js";

const tag = randomUUID().slice(0, 8);
const A = `sub-a-${tag}`;
const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test of the subscription router's fixtures.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a test", fn);

let node: string;
const session: Record<string, string> = {};

async function sessionAt(label: string): Promise<string> {
  const [s] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO agent_sessions (id, role, node_id, status, awaiting, sensitivity_label)
       VALUES (gen_random_uuid(), 'steward', $1, 'running', '[]'::jsonb, $2) RETURNING id`,
      [node, label]
    )
  );
  await system(() =>
    rawQuery(
      `INSERT INTO subscriptions (subscriber_kind, subscriber_ref, filter, delivery, once, reason, created_by, sensitivity_label)
       VALUES ('session', $1, $2::jsonb, 'queue', false, 'to hear of this node', 'steward', $3)`,
      [s!.id, JSON.stringify({ node_ids: [node] }), label]
    )
  );
  return s!.id;
}

const replies = async (id: string) =>
  (
    await system(() => rawQuery<{ replies: Array<{ text: string }> }>(`SELECT replies FROM agent_sessions WHERE id = $1`, [id]))
  )[0]!.replies.map((r) => r.text);

beforeAll(async () => {
  node = await seedClaim(`A node two labels subscribe to ${tag}`);
  await system(() => rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Private, for the router test.')`, [A]));
  await ensureEnforcement();
  setNoContextSessionForTests(null);
  session.public = await sessionAt("public");
  session.a = await sessionAt(A);
  // Whatever earlier files left on the log is behind the cursor before the events below.
  await system(() => routeEvents());
});

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM subscriptions WHERE subscriber_ref = ANY($1)`, [Object.values(session)]);
    await rawQuery(`DELETE FROM agent_sessions WHERE id = ANY($1::uuid[])`, [Object.values(session)]);
    await rawQuery(`DELETE FROM events WHERE node_id = $1`, [node]);
  });
  await closeDb();
});

describe("the subscription router, with a second label", () => {
  it("delivers an event to the subscribers whose label reads it, at their label, and says nothing of it to the rest", async () => {
    const secret = `An assessment at ${A} moved, on partner material ${tag}`;
    await at(A, () => recordEvent({ kind: "assessed", nodeId: node, summary: secret }));
    await system(() => routeEvents());

    const toA = await replies(session.a!);
    expect(toA).toHaveLength(1);
    expect(toA[0]).toContain(secret);
    // The subscriber at public is told nothing: not the words, and not that something happened.
    expect(await replies(session.public!)).toEqual([]);

    const open = `A public assessment moved ${tag}`;
    await at("public", () => recordEvent({ kind: "assessed", nodeId: node, summary: open }));
    await system(() => routeEvents());
    expect((await replies(session.public!)).map((t) => t.includes(open))).toEqual([true]);
    // The label that reads public is told of the public event too.
    const both = await replies(session.a!);
    expect(both).toHaveLength(2);
    expect(both[1]).toContain(open);
  });
});
