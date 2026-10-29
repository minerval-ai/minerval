/**
 * What kind of node a claim row is (constitution §2, §7a), checked under a
 * row lock by the kinds' writers (quantity-service, question-service).
 */
import type { TxQuery } from "../db/client.js";
import type { NodeKind } from "../schemas/kinds.js";

/**
 * A write refused because of what the node is or what it holds. The message
 * is written for the agent that tried it, so a tool can hand it back.
 */
export class KindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KindError";
  }
}

/** The node's kind, locked for the rest of the transaction; throws when it does not exist. */
export async function lockNodeKind(tx: TxQuery, claimId: string): Promise<NodeKind> {
  const [row] = await tx.query<{ kind: NodeKind; state: string }>(
    `SELECT kind, state FROM claims WHERE id = $1 FOR UPDATE`,
    [claimId]
  );
  if (!row) throw new KindError(`Node ${claimId} not found`);
  if (row.state !== "active") throw new KindError(`Node ${claimId} is ${row.state}, not active`);
  return row.kind;
}

/**
 * Change a claim into another kind. Allowed only while nothing has been
 * recorded that belongs to the old kind: a claim with a verdict is a
 * proposition, and a quantity or question on the same subject is a new node.
 */
export async function convertKind(tx: TxQuery, claimId: string, to: NodeKind): Promise<void> {
  const kind = await lockNodeKind(tx, claimId);
  if (kind === to) return;
  if (kind !== "claim") {
    throw new KindError(`Node ${claimId} is a ${kind}; only a claim can become a ${to}`);
  }
  const [held] = await tx.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM assessments WHERE claim_id = $1)::int
          + (SELECT count(*) FROM arguments WHERE claim_id = $1)::int AS n`,
    [claimId]
  );
  if ((held?.n ?? 0) > 0) {
    throw new KindError(
      `Claim ${claimId} already has assessments or arguments as a proposition; mint a new ${to} instead`
    );
  }
  await tx.query(`UPDATE claims SET kind = $2, updated_at = now() WHERE id = $1`, [claimId, to]);
}

export async function requireKind(tx: TxQuery, claimId: string, kind: NodeKind): Promise<void> {
  const actual = await lockNodeKind(tx, claimId);
  if (actual !== kind) throw new KindError(`Node ${claimId} is a ${actual}, not a ${kind}`);
}
