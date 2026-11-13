/**
 * Close the unread messages sitting on nodes that are no longer active (#962).
 *
 * No Steward works a merged, deprecated or archived node, so a message in its
 * inbox is never read, and it reads to anyone looking (get_claim's
 * `waiting_messages`, the `messages` view) as work waiting. Nothing delivers
 * to such a node now (inbox-service.ts, queue-service.ts); this closes what
 * arrived before that. On the public graph in November 2026 every one of them
 * came in with migration 0090, which carried the old `steward_context` queue
 * slot of every pending claim into the inbox, retired claims included, so
 * they are dated 2026-11-09 though most were written in August.
 *
 * A message is closed by marking it read, with an `outcome_note` saying it was
 * not weighed and why; its outcome stays null (it was not answered), its row
 * and text are kept, and the changes stream keeps its arrival. With
 * `--forward`, a message whose node has an active successor (a merged node's
 * survivor, or a successor its retirement record names) is also sent there,
 * unpaid and marked as forwarded, as a new message would be; a first-pass
 * request (`structure_and_assess`) is never forwarded. Forwarding spends
 * nothing: the successor waits as pending until someone commissions its pass.
 *
 * Safe by default: prints what it WOULD close, by state and trigger, and
 * exits. Pass `--confirm` to write.
 *
 *   npx tsx scripts/close-retired-inboxes.ts                       # dry run
 *   npx tsx scripts/close-retired-inboxes.ts --confirm             # close
 *   npx tsx scripts/close-retired-inboxes.ts --forward --confirm   # close, and forward where a successor is live
 */
import "../src/load-env.js";
import { pathToFileURL } from "url";
import { rawQuery, closeDb } from "../src/db/client.js";
import { activeSuccessors } from "../src/services/claim-lifecycle-service.js";
import { enqueueSteward, type StewardMessage } from "../src/services/queue-service.js";
import type { MessageSenderKind } from "../src/services/inbox-service.js";

export interface CloseOptions {
  confirm: boolean;
  forward: boolean;
}

export function parseCloseArgs(argv: string[]): CloseOptions {
  const opts: CloseOptions = { confirm: false, forward: false };
  for (const arg of argv) {
    if (arg === "--confirm") opts.confirm = true;
    else if (arg === "--forward") opts.forward = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

interface UnreadRow {
  id: string;
  node_id: string;
  state: string;
  trigger: string;
  sender_kind: string;
  sender_node_id: string | null;
  sender_ref: string | null;
  body: string;
}

export interface CloseResult {
  unread: UnreadRow[];
  /** Message id to the successors it would go (or went) to. */
  forwards: Map<string, string[]>;
  closed: number;
}

export async function closeRetiredInboxes(opts: CloseOptions): Promise<CloseResult> {
  const unread = await rawQuery<UnreadRow>(
    `SELECT m.id, m.node_id, c.state, m.trigger, m.sender_kind, m.sender_node_id, m.sender_ref, m.body
       FROM node_messages m JOIN claims c ON c.id = m.node_id
      WHERE m.read_at IS NULL AND c.state <> 'active'
      ORDER BY m.created_at, m.id`
  );
  const forwards = new Map<string, string[]>();
  if (opts.forward) {
    const successorsByNode = new Map<string, string[]>();
    for (const m of unread) {
      if (m.trigger === "structure_and_assess" || m.trigger === "message_reply") continue;
      if (!successorsByNode.has(m.node_id)) successorsByNode.set(m.node_id, await activeSuccessors(m.node_id));
      const to = successorsByNode.get(m.node_id)!;
      if (to.length > 0) forwards.set(m.id, to);
    }
  }
  if (!opts.confirm || unread.length === 0) return { unread, forwards, closed: 0 };

  for (const m of unread) {
    if (!forwards.has(m.id)) continue;
    for (const successorId of forwards.get(m.id)!) {
      await enqueueSteward({
        claimId: successorId,
        trigger: m.trigger as StewardMessage["trigger"],
        context:
          `[Addressed to ${m.node_id}, which is no longer active; this node carries on ` +
          `what it stated, so the message is forwarded here. Weigh it for this node.] ` +
          m.body,
        sender: { kind: m.sender_kind as MessageSenderKind, nodeId: m.sender_node_id, ref: m.sender_ref },
        forwardedFrom: m.node_id,
      });
    }
  }
  // Guarded on the read and the state again: a message read, or a node
  // restored, since the read above is left alone.
  const rows = await rawQuery<{ id: string }>(
    `UPDATE node_messages m
        SET read_at = now(),
            outcome_note = concat('Not weighed: the node is ', c.state,
                                  ', so no Steward works it (#962).',
                                  CASE WHEN m.id = ANY($2::uuid[]) THEN ' Forwarded to its successor.' ELSE '' END)
       FROM claims c
      WHERE c.id = m.node_id AND m.id = ANY($1::uuid[]) AND m.read_at IS NULL AND c.state <> 'active'
      RETURNING m.id`,
    [unread.map((m) => m.id), [...forwards.keys()]]
  );
  return { unread, forwards, closed: rows.length };
}

async function main(): Promise<void> {
  const opts = parseCloseArgs(process.argv.slice(2));
  const res = await closeRetiredInboxes(opts);
  console.log(`Unread messages on nodes that are not active: ${res.unread.length}`);
  const tally = new Map<string, number>();
  for (const m of res.unread) {
    const k = `${m.state} / ${m.trigger}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...tally].sort()) console.log(`  ${k}: ${n}`);
  console.log(`  on ${new Set(res.unread.map((m) => m.node_id)).size} nodes`);
  if (opts.forward) console.log(`  with an active successor to forward to: ${res.forwards.size}`);
  if (!opts.confirm) {
    if (res.unread.length > 0) console.log(`\nDry run — re-run with --confirm to close them${opts.forward ? " and forward" : ""}.`);
  } else {
    console.log(`\nClosed ${res.closed}${opts.forward ? `; forwarded ${res.forwards.size}` : ""}.`);
  }
  await closeDb();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
