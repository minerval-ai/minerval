/**
 * The one-time code that makes the first administrator (docs/accounts.md,
 * "The first administrator").
 *
 * A members-only deployment that has never had an administrator needs one
 * person to hold every permission and hand them out. Whoever runs the
 * machine can name that person in FIRST_ADMINISTRATOR, which means knowing
 * their sign-in identity before they have signed in, putting it in a file
 * and starting the deployment again. This is the other way, and needs
 * neither: on a start with no administrator the API prints a code in its
 * log, and the first person to sign in and give the code is the first
 * administrator. Reading the API's log is something only whoever runs the
 * machine can do, so the code says what FIRST_ADMINISTRATOR says: that the
 * machine's operator chose this person.
 *
 * A code works once and for a day. Only its hash is kept
 * (first_administrator_codes, the owner's alone), so a start cannot print a
 * code again: each start with no administrator prints a new one, and every
 * code not yet used or expired works, since several API tasks may start
 * together and each prints its own.
 *
 * FIRST_ADMINISTRATOR still works, for an install that is scripted.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { loadConfig } from "../config.js";
import { membersOnly } from "../permissions.js";
import { establishAsFirstAdministrator } from "./permission-service.js";

/** How long a code works. */
export const FIRST_ADMINISTRATOR_CODE_HOURS = 24;

/**
 * How many wrong codes are taken before every code is void and the API must
 * be started again to print a new one. A count, because nothing prices a
 * guess: a code is a credential for the whole deployment, and anyone who
 * can sign in can try one. A code has 60 bits, so this is far from needed
 * to keep it from being found; it is here so that trying is noticed.
 */
export const FIRST_ADMINISTRATOR_CODE_ATTEMPTS = 20;

const CODES_REASON =
  "The first administrator's code is the owner's alone: its hash is read and written on the owner's connection, and the grants it leads to say what an account may read.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(CODES_REASON, fn);

/** Letters and digits that are not mistaken for each other when read from a log and typed. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

/** A code as it is compared: its letters and digits, in capitals, whatever was typed between them. */
function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const hashOf = (code: string): string => createHash("sha256").update(`minerval first administrator:${normalize(code)}`).digest("hex");

let wrongAttempts = 0;

/** Whether this deployment has ever had an administrator. */
async function everHadAnAdministrator(): Promise<boolean> {
  const rows = await rawQuery(`SELECT 1 FROM permission_grants WHERE permission = 'administer' LIMIT 1`);
  return rows.length > 0;
}

/**
 * On a start with no administrator, make a code, keep its hash and return
 * the code to be printed. Null where there is nothing to do: the public
 * graph, or a deployment that has had an administrator.
 */
export async function issueFirstAdministratorCode(): Promise<{ code: string; expiresAt: Date } | null> {
  if (!membersOnly(loadConfig())) return null;
  return asOwner(async () => {
    if (await everHadAnAdministrator()) return null;
    const code = newCode();
    const [row] = await rawQuery<{ expires_at: Date }>(
      `INSERT INTO first_administrator_codes (code_hash, expires_at)
       VALUES ($1, now() + make_interval(hours => $2))
       RETURNING expires_at`,
      [hashOf(code), FIRST_ADMINISTRATOR_CODE_HOURS]
    );
    // Codes long expired say nothing; they are not kept.
    await rawQuery(`DELETE FROM first_administrator_codes WHERE used_at IS NULL AND expires_at < now() - interval '7 days'`);
    return { code, expiresAt: row!.expires_at };
  });
}

/** What the API prints at a start with no administrator. */
export function firstAdministratorCodeLines(issued: { code: string; expiresAt: Date }): string[] {
  return [
    "This deployment has no administrator yet.",
    `The first person to sign in to its web app and give this code becomes the first administrator: ${issued.code}`,
    `The code works once, until ${issued.expiresAt.toISOString()}. Starting the API again prints a new one.`,
  ];
}

/** Whether a signed-in person can become the first administrator by giving a code now. */
export async function awaitingFirstAdministrator(): Promise<boolean> {
  if (!membersOnly(loadConfig())) return false;
  return asOwner(async () => {
    if (await everHadAnAdministrator()) return false;
    const rows = await rawQuery(`SELECT 1 FROM first_administrator_codes WHERE used_at IS NULL AND expires_at > now() LIMIT 1`);
    return rows.length > 0;
  });
}

export type CodeFailure = "NOT_AWAITED" | "WRONG_CODE" | "TOO_MANY_ATTEMPTS";

/**
 * Make the account the first administrator, if the code is one this
 * deployment printed, has not been used and has not expired, and the
 * deployment has never had an administrator.
 */
export async function becomeFirstAdministrator(input: {
  account: { id: string; externalId: string | null };
  code: string;
}): Promise<{ ok: true } | { ok: false; code: CodeFailure; message: string }> {
  if (!membersOnly(loadConfig())) {
    return { ok: false, code: "NOT_AWAITED", message: "This deployment has no administrators: it is open to everyone." };
  }
  if (wrongAttempts >= FIRST_ADMINISTRATOR_CODE_ATTEMPTS) {
    return {
      ok: false,
      code: "TOO_MANY_ATTEMPTS",
      message:
        "Too many wrong codes have been given, so no code works now. Whoever runs the deployment starts the API again, which prints a new code in its log.",
    };
  }
  const given = Buffer.from(hashOf(input.code), "hex");
  const outcome = await asOwner(() =>
    withTransaction(async (tx) => {
      const codes = await tx.query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM first_administrator_codes WHERE used_at IS NULL AND expires_at > now() FOR UPDATE`
      );
      if (codes.length === 0) return "none" as const;
      const match = codes.find((c) => {
        const kept = Buffer.from(c.code_hash, "hex");
        return kept.length === given.length && timingSafeEqual(kept, given);
      });
      if (!match) return "wrong" as const;
      const granted = await establishAsFirstAdministrator(tx, input.account);
      if (!granted) return "none" as const;
      await tx.query(`UPDATE first_administrator_codes SET used_at = now(), used_by = $2 WHERE id = $1`, [
        match.id,
        input.account.id,
      ]);
      // The other codes printed for this start are void with it.
      await tx.query(`DELETE FROM first_administrator_codes WHERE used_at IS NULL`);
      return "granted" as const;
    })
  );
  if (outcome === "granted") {
    wrongAttempts = 0;
    return { ok: true };
  }
  if (outcome === "none") {
    return {
      ok: false,
      code: "NOT_AWAITED",
      message:
        "This deployment is not waiting for a first administrator: it has had one, or no code it printed is still good. " +
        "An administrator grants permissions; where there is none, whoever runs the deployment starts the API again for a new code.",
    };
  }
  wrongAttempts += 1;
  if (wrongAttempts >= FIRST_ADMINISTRATOR_CODE_ATTEMPTS) {
    await asOwner(() => rawQuery(`DELETE FROM first_administrator_codes WHERE used_at IS NULL`));
  }
  return {
    ok: false,
    code: "WRONG_CODE",
    message:
      "That is not the code this deployment printed. It is in the API's log, on a line that begins \"The first person to sign in\"; " +
      "whoever runs the deployment can read it there.",
  };
}
