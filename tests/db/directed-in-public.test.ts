/**
 * Directing the public graph is public (docs/allocation.md): a granting
 * conversation and the mandate it makes are public from the first message,
 * funded or not, and the runs that direct the mandate are public runs. The
 * conversations and mandates made before that rule were promised privacy
 * and keep it (migration 0182, src/llm/private-grantmaking.ts).
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { getPublicMandate } from "../../src/services/mandate-service.js";
import { getPublicConversation } from "../../src/services/platform-mandate-service.js";
import {
  grantmakingPromisedPrivate,
  keepGrantmakingPromise,
  PRIVATE_GRANTMAKING_REASON,
} from "../../src/llm/private-grantmaking.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { seedGrantWithJob, seedUser } from "./helpers.js";

async function conversation(userId: string, opts: { inPublic?: boolean; label?: string; grantId?: string } = {}) {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO grant_conversations (user_id, messages, status, grant_id, sensitivity_label${opts.inPublic === undefined ? "" : ", in_public"})
     VALUES ($1, $2::jsonb, $3, $4, $5${opts.inPublic === undefined ? "" : ", $6"}) RETURNING id`,
    [
      userId,
      JSON.stringify([
        { role: "user", content: "Cover the literature on sleep and memory.", at: new Date().toISOString() },
        { role: "assistant", content: "Here is what the graph holds.", at: new Date().toISOString() },
      ]),
      opts.grantId ? "funded" : "active",
      opts.grantId ?? null,
      opts.label ?? "public",
      ...(opts.inPublic === undefined ? [] : [opts.inPublic]),
    ]
  );
  return row!.id;
}

describe("a granting conversation", () => {
  it("is public from its first message by default, with its funder as a reader", async () => {
    const u = await seedUser("dip-convo");
    const id = await conversation(u);
    const convo = await getPublicConversation(id);
    expect(convo).toMatchObject({ id, funder: "a reader", status: "active", grant_id: null });
    expect(convo!.messages).toHaveLength(2);
    // Whose account it is is never served.
    expect(JSON.stringify(convo)).not.toContain(u);
  });

  it("names its funder only when they chose to be named on the mandate", async () => {
    const u = await seedUser("dip-named");
    await rawQuery(`UPDATE contributors SET display_name = 'Ada Funder' WHERE id = $1`, [u]);
    const { grantId } = await seedGrantWithJob({ funderId: u, budgetMicroUsd: 0 });
    const id = await conversation(u, { grantId });
    expect((await getPublicConversation(id))!.funder).toBe("a reader");
    await rawQuery(`UPDATE grants SET mandate = '{"funder_named": true}'::jsonb WHERE id = $1`, [grantId]);
    expect((await getPublicConversation(id))!.funder).toBe("Ada Funder");
  });

  it("held before the rule, is not served, and its runs keep the promise", async () => {
    const u = await seedUser("dip-legacy-convo");
    const id = await conversation(u, { inPublic: false });
    expect(await getPublicConversation(id)).toBeNull();
    expect(await grantmakingPromisedPrivate({ conversationId: id })).toBe(true);
  });

  it("at a label other than public, is not served here", async () => {
    const u = await seedUser("dip-label");
    await rawQuery(`INSERT INTO labels (name, description) VALUES ('dip-internal', 'dbtest') ON CONFLICT DO NOTHING`);
    const id = await conversation(u, { label: "dip-internal" });
    expect(await getPublicConversation(id)).toBeNull();
  });
});

describe("a mandate directed in public", () => {
  it("is readable by anyone while it is planned and while it waits for approval", async () => {
    const u = await seedUser("dip-planning");
    for (const status of ["planning", "pending_approval"]) {
      const { grantId } = await seedGrantWithJob({ funderId: u, budgetMicroUsd: 0, grantStatus: status });
      expect(await getPublicMandate(grantId), status).toMatchObject({ id: grantId, directed_in_public: true });
    }
  });

  it("shows its funder notes, working notes and conversation to anyone", async () => {
    const u = await seedUser("dip-notes");
    const { grantId } = await seedGrantWithJob({ funderId: u, budgetMicroUsd: 0 });
    await rawQuery(
      `UPDATE grants SET workspace = 'Map the trials first.',
              mandate = jsonb_build_object('funder_notes', jsonb_build_array(jsonb_build_object('at', now()::text, 'note', 'Shall I widen it?')))
        WHERE id = $1`,
      [grantId]
    );
    const convo = await conversation(u, { grantId });
    const m = await getPublicMandate(grantId);
    expect(m).toMatchObject({ workspace: "Map the trials first.", conversation_id: convo });
    expect(m!.funder_notes).toEqual([expect.objectContaining({ note: "Shall I widen it?" })]);
    expect(m!.is_manager).toBeUndefined();
  });

  it("made before the rule, is hidden until live and keeps its funder's notes to its funder", async () => {
    const u = await seedUser("dip-legacy");
    const { grantId } = await seedGrantWithJob({ funderId: u, budgetMicroUsd: 0, grantStatus: "planning" });
    await rawQuery(`UPDATE grants SET directed_in_public = false WHERE id = $1`, [grantId]);
    expect(await getPublicMandate(grantId)).toBeNull();
    expect(await getPublicMandate(grantId, u)).toMatchObject({ is_manager: true });

    await rawQuery(
      `UPDATE grants SET status = 'active', workspace = 'private notes',
              mandate = '{"funder_notes": [{"at": "2026-01-01", "note": "between us"}]}'::jsonb
        WHERE id = $1`,
      [grantId]
    );
    const m = await getPublicMandate(grantId);
    expect(m).not.toBeNull();
    expect(m!.funder_notes).toBeUndefined();
    expect(m!.workspace).toBeUndefined();
    expect(m!.directed_in_public).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("private notes");
  });

  it("marks a run that works for a mandate made before the rule, and leaves the others public", async () => {
    const u = await seedUser("dip-runs");
    const fresh = (await seedGrantWithJob({ funderId: u, budgetMicroUsd: 0 })).grantId;
    const legacy = (await seedGrantWithJob({ funderId: u, budgetMicroUsd: 0 })).grantId;
    await rawQuery(`UPDATE grants SET directed_in_public = false WHERE id = $1`, [legacy]);

    const marked = async (grantId: string) => {
      const trace = { privateReasons: new Set<string>(), tail: Promise.resolve(), ready: Promise.resolve(), runId: null } as never;
      await runWithUsageContext({ trace }, () => keepGrantmakingPromise({ grantId }));
      return [...(trace as { privateReasons: Set<string> }).privateReasons];
    };
    expect(await marked(fresh)).toEqual([]);
    expect(await marked(legacy)).toEqual([PRIVATE_GRANTMAKING_REASON]);
  });
});
