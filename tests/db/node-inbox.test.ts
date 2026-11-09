/**
 * A node's inbox against real Postgres: messages kept whole, labelled in the
 * brief, answered, replies delivered to the sender's node, and marked read
 * only once a pass has seen them.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import {
  INBOX_FULL_TEXT_CHARS,
  answerMessages,
  markMessagesRead,
  openInbox,
  postMessage,
  waitingMessages,
} from "../../src/services/inbox-service.js";
import { seedClaim } from "./helpers.js";

async function unread(nodeId: string): Promise<number> {
  const [r] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1 AND read_at IS NULL`,
    [nodeId]
  );
  return r!.n;
}

describe("node inbox", () => {
  it("keeps every message whole, however many arrive, and marks the claim pending", async () => {
    const node = await seedClaim("inbox target");
    const long = "x".repeat(20_000);
    await enqueueSteward({ claimId: node, trigger: "staleness_check", context: long });
    await enqueueSteward({ claimId: node, trigger: "curator_change", context: "merged Y into you", sender: { kind: "curator" } });
    const [c] = await rawQuery<{ steward_state: string; steward_trigger: string }>(
      `SELECT steward_state, steward_trigger FROM claims WHERE id = $1`,
      [node]
    );
    expect(c!.steward_state).toBe("pending");
    expect(c!.steward_trigger).toBe("staleness_check");
    const rows = await rawQuery<{ body: string }>(
      `SELECT body FROM node_messages WHERE node_id = $1 ORDER BY created_at`,
      [node]
    );
    expect(rows.map((r) => r.body.length)).toEqual([20_000, "merged Y into you".length]);
  });

  it("labels messages oldest first and names a Steward sender by how its node is joined", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'db test')`,
      [parent, child]
    );
    await postMessage({ nodeId: child, trigger: "dependent_note", body: "your count is stale", sender: { kind: "steward", nodeId: parent } });
    await postMessage({ nodeId: child, trigger: "staleness_check", body: "due a fresh look" });
    const inbox = await openInbox(child);
    expect([...inbox.labels.keys()]).toEqual(["m1", "m2"]);
    expect(inbox.brief).toContain("[m1] dependent_note");
    expect(inbox.brief).toContain(`the Steward of ${parent}`);
    expect(inbox.brief).toContain("a node that depends on yours");
    expect(inbox.brief).toContain("your count is stale");
    expect(inbox.brief.indexOf("[m1]")).toBeLessThan(inbox.brief.indexOf("[m2]"));
  });

  it("lists the oldest without text when the inbox outgrows one brief, keeping the newest whole", async () => {
    const node = await seedClaim("flooded");
    const chunk = INBOX_FULL_TEXT_CHARS / 2 + 10;
    await postMessage({ nodeId: node, trigger: "steward_note", body: "OLDEST " + "a".repeat(chunk) });
    await postMessage({ nodeId: node, trigger: "steward_note", body: "MIDDLE " + "b".repeat(chunk) });
    await postMessage({ nodeId: node, trigger: "steward_note", body: "NEWEST" });
    const inbox = await openInbox(node);
    expect(inbox.ids).toHaveLength(3);
    expect(inbox.brief).toContain("read_message reads one");
    expect(inbox.brief).not.toContain("OLDEST");
    expect(inbox.brief).toContain("MIDDLE");
    expect(inbox.brief).toContain("NEWEST");
  });

  it("records answers and delivers a reply to the sending Steward's node, without opening work there", async () => {
    const sender = await seedClaim("sender");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [sender]);
    const receiver = await seedClaim("receiver");
    await postMessage({ nodeId: receiver, trigger: "steward_note", body: "the 2023 census revised it", sender: { kind: "steward", nodeId: sender } });
    const inbox = await openInbox(receiver);
    const out = JSON.parse(
      await answerMessages(receiver, inbox.labels, [
        { message: "m1", outcome: "changed", note: "Re-estimated from the 2023 figures." },
        { message: "m7", outcome: "changed" },
      ])
    );
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/1 reached their senders/);
    expect(out.refused).toEqual([{ message: "m7", reason: "Not a message in your brief." }]);
    const [reply] = await rawQuery<{ trigger: string; body: string; reply_to: string }>(
      `SELECT trigger, body, reply_to FROM node_messages WHERE node_id = $1`,
      [sender]
    );
    expect(reply!.trigger).toBe("message_reply");
    expect(reply!.body).toContain("changed its assessment");
    expect(reply!.body).toContain("Re-estimated");
    const [s] = await rawQuery<{ steward_state: string | null }>(`SELECT steward_state FROM claims WHERE id = $1`, [sender]);
    expect(s!.steward_state).toBe("done");
  });

  it("marks read only what the pass was shown; a message arriving mid-pass waits", async () => {
    const node = await seedClaim("mid-pass");
    await postMessage({ nodeId: node, trigger: "steward_note", body: "first" });
    const inbox = await openInbox(node);
    await postMessage({ nodeId: node, trigger: "steward_note", body: "arrived during the pass" });
    await markMessagesRead(inbox.ids);
    expect(await unread(node)).toBe(1);
    const waiting = await waitingMessages(node);
    expect(waiting.map((w) => w.summary)).toEqual(["arrived during the pass"]);
  });
});
