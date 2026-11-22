/**
 * Guests on /ask (docs/accounts.md, "Guests").
 *
 * A visitor with no account may talk to the Assistant, and through it read
 * the graph and propose to it, on owls the platform gives: GUEST_ASK_OWLS
 * each (5 by default). The web tier asks for a guest account the first time
 * such a visitor sends a message, and keeps the account in a signed cookie;
 * the API never sees the visitor's browser.
 *
 * What bounds it, and why each bound is what it is:
 *  - Each guest's balance is the gift, and the Assistant is charged against
 *    it as it runs, as any account is. No count is added on top.
 *  - The whole day's giving is a sum of owls, GUEST_ASK_DAILY_OWLS over a
 *    rolling 24 hours: the platform's money is what is at stake, so money is
 *    the measure.
 *  - GUEST_ASK_PER_ADDRESS_PER_DAY is a count of guest accounts one address
 *    makes in a UTC day. A visitor has no account or budget of their own, so
 *    nothing else tells one visitor from the next (the reason the anonymous
 *    rate limit is a count, src/server/plugins/anonymous-rate-limit.ts).
 * Each refusal says which bound it met and that making an account is the
 * way past it, and the page says all three before the first message.
 *
 * The address is never stored: the row keeps a hash of the address and the
 * UTC day, which matches only that day's guests, and making a pass clears
 * the hash on rows older than two days.
 *
 * A guest who then signs in keeps their conversations with the Assistant:
 * the web tier names the guest when it provisions the new account, and
 * carryGuestToAccount moves them. The guest's unspent owls are not moved;
 * the account gets the signup grant instead.
 */
import { createHash, randomUUID } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { membersOnly } from "../permissions.js";
import { owlsToMicroUsd, microUsdToOwls } from "./owl.js";
import { OWL_REASONS } from "./owl-ledger-service.js";
import { GUEST_EXTERNAL_ID_PREFIX, isGuestExternalId } from "./guest-account.js";

export { GUEST_EXTERNAL_ID_PREFIX, isGuestExternalId };

/** What a guest is shown about where they stand, and what a refusal says. */
export interface GuestTerms {
  /** The owls each guest is given. */
  owls: number;
  /** The most given to all guests together in a rolling 24 hours. */
  daily_owls: number;
  /** Guest accounts one address may make in a UTC day. */
  per_address_per_day: number;
  /** The owls a new account is given, which is the way past every bound. */
  signup_owls: number;
}

export function guestTerms(): GuestTerms {
  const config = loadConfig();
  return {
    owls: config.guestAskOwls,
    daily_owls: config.guestAskDailyOwls,
    per_address_per_day: config.guestAskPerAddressPerDay,
    signup_owls: config.signupGrantOwls,
  };
}

/** Whether this deployment offers guests at all. */
export function guestsOffered(): boolean {
  const config = loadConfig();
  return (
    !membersOnly() &&
    config.guestAskOwls > 0 &&
    config.guestAskDailyOwls > 0 &&
    config.guestAskPerAddressPerDay > 0
  );
}

export type GuestPassResult =
  | { ok: true; account: { id: string; externalId: string }; grantedOwls: number }
  | {
      ok: false;
      code: "GUESTS_OFF" | "GUEST_ADDRESS_LIMIT" | "GUEST_DAILY_LIMIT";
      message: string;
    };

function addressHash(address: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return createHash("sha256").update(`guest-address:${day}:${address.trim().toLowerCase()}`).digest("hex");
}

const MAKE_AN_ACCOUNT = (signupOwls: number) =>
  signupOwls > 0
    ? ` Make an account to go on: it is free, and comes with ${signupOwls} owls.`
    : " Make an account to go on.";

/**
 * Make a guest account for a visitor at `address`, given GUEST_ASK_OWLS,
 * unless a bound refuses it. Serialized on one advisory lock, so two
 * visitors at once cannot both take the day's last owls.
 */
export async function makeGuestPass(input: { address: string; now?: Date }): Promise<GuestPassResult> {
  const config = loadConfig();
  const terms = guestTerms();
  if (!guestsOffered()) {
    return {
      ok: false,
      code: "GUESTS_OFF",
      message: "This deployment does not offer the Assistant to visitors without an account." + MAKE_AN_ACCOUNT(terms.signup_owls),
    };
  }
  const now = input.now ?? new Date();
  const hash = addressHash(input.address, now);
  const grantMicro = owlsToMicroUsd(config.guestAskOwls);

  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('minerval:guest-passes'))`);

    const [fromAddress] = await tx.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM guest_passes
        WHERE address_hash = $1 AND created_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [hash, now.toISOString()]
    );
    if (Number(fromAddress?.n ?? 0) >= config.guestAskPerAddressPerDay) {
      return {
        ok: false as const,
        code: "GUEST_ADDRESS_LIMIT" as const,
        message:
          `A visitor without an account may start ${config.guestAskPerAddressPerDay === 1 ? "one guest session" : `${config.guestAskPerAddressPerDay} guest sessions`} ` +
          "a day from one address, and this address has." + MAKE_AN_ACCOUNT(terms.signup_owls),
      };
    }

    const [given] = await tx.query<{ total: string }>(
      `SELECT COALESCE(SUM(granted_micro_usd), 0)::bigint AS total FROM guest_passes
        WHERE created_at > $1::timestamptz - interval '24 hours'`,
      [now.toISOString()]
    );
    if (Number(given?.total ?? 0) + grantMicro > owlsToMicroUsd(config.guestAskDailyOwls)) {
      return {
        ok: false as const,
        code: "GUEST_DAILY_LIMIT" as const,
        message:
          `The owls Minerval gives visitors without an account (${config.guestAskDailyOwls} a day, among all of them) ` +
          "are spent for now." + MAKE_AN_ACCOUNT(terms.signup_owls),
      };
    }

    const externalId = `${GUEST_EXTERNAL_ID_PREFIX}${randomUUID()}`;
    const [account] = await tx.query<{ id: string }>(
      `INSERT INTO contributors (external_id, display_name) VALUES ($1, 'A guest') RETURNING id`,
      [externalId]
    );
    await tx.query(
      `INSERT INTO guest_passes (account_id, address_hash, granted_micro_usd, created_at)
       VALUES ($1, $2, $3, $4)`,
      [account!.id, hash, grantMicro, now.toISOString()]
    );
    await tx.query(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
       VALUES ($1, $2, $3, $4)`,
      [account!.id, grantMicro, OWL_REASONS.guestGrant, `guest:${account!.id}`]
    );
    // The address is wanted only for its own day's count.
    await tx.query(
      `UPDATE guest_passes SET address_hash = NULL
        WHERE address_hash IS NOT NULL AND created_at < $1::timestamptz - interval '2 days'`,
      [now.toISOString()]
    );
    return {
      ok: true as const,
      account: { id: account!.id, externalId },
      grantedOwls: microUsdToOwls(grantMicro),
    };
  });
}

/**
 * A guest's conversations with the Assistant, carried to the account they
 * signed in to. Only a guest account's, only into a person's, and once: the
 * pass records where they went. Returns how many were moved.
 */
export async function carryGuestToAccount(input: {
  guestExternalId: string;
  accountId: string;
}): Promise<number> {
  if (!isGuestExternalId(input.guestExternalId)) return 0;
  return withTransaction(async (tx) => {
    const [guest] = await tx.query<{ id: string; carried_to_id: string | null }>(
      `SELECT c.id, p.carried_to_id
         FROM contributors c JOIN guest_passes p ON p.account_id = c.id
        WHERE c.external_id = $1
        FOR UPDATE OF p`,
      [input.guestExternalId]
    );
    if (!guest || guest.carried_to_id || guest.id === input.accountId) return 0;
    const [target] = await tx.query<{ kind: string; external_id: string | null }>(
      `SELECT kind, external_id FROM contributors WHERE id = $1`,
      [input.accountId]
    );
    if (!target || target.kind !== "person" || isGuestExternalId(target.external_id)) return 0;
    const moved = await tx.query<{ id: string }>(
      `UPDATE assistant_conversations SET user_id = $2
        WHERE user_id = $1 AND acting_for IS NULL
        RETURNING id`,
      [guest.id, input.accountId]
    );
    // What waits on the guest in those conversations, and the pages the
    // Assistant made for them, go with them.
    await tx.query(`UPDATE assistant_held_actions SET user_id = $2 WHERE user_id = $1`, [guest.id, input.accountId]);
    await tx.query(`UPDATE assistant_pages SET user_id = $2 WHERE user_id = $1`, [guest.id, input.accountId]);
    await tx.query(`UPDATE guest_passes SET carried_to_id = $2 WHERE account_id = $1`, [guest.id, input.accountId]);
    return moved.length;
  });
}

/** Whether an account (by id) is a guest's, and what it was given. */
export async function guestStanding(
  accountId: string
): Promise<{ grantedOwls: number } | null> {
  const [row] = await rawQuery<{ granted: string }>(
    `SELECT granted_micro_usd::bigint AS granted FROM guest_passes WHERE account_id = $1`,
    [accountId]
  );
  return row ? { grantedOwls: microUsdToOwls(Number(row.granted)) } : null;
}
