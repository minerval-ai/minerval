/**
 * A connection's credential given in the app and kept encrypted
 * (docs/connections.md, "A credential given here").
 *
 * A connection can take its credential two ways. The operator can put it in
 * an environment variable the connection names (CONNECTION_..., read by
 * connection-client.ts at the moment of a call). Or an administrator can
 * paste it into the connection's page, and it is kept here: encrypted in
 * the connection's own row, under a key that is only ever in the
 * environment. The database, its backups and anyone who reads its rows hold
 * ciphertext that opens with nothing they have.
 *
 * The rules, each for its reason:
 *
 *  - AES-256-GCM, a fresh 12-byte nonce for every sealing. The tag means a
 *    ciphertext that was changed does not open, rather than opening to
 *    something else.
 *  - The ciphertext is bound to the connection it was given for: its id, its
 *    address and its transport are the associated data. A sealed credential
 *    copied into another connection's row, or left in a row whose address
 *    was changed, does not open. The service also clears the credential when
 *    the address or transport changes (connection-service.ts); the binding
 *    is what holds if anything ever writes the row another way. Without it,
 *    whoever may change a connection could point it at a server of their own
 *    and be sent a credential somebody else gave for another system.
 *  - Each sealing records which key sealed it, by an id derived from the key
 *    and saying nothing about it. A key can then be replaced: the old one is
 *    kept among the previous keys, every credential still opens, and
 *    resealing moves them to the new key (scripts/reseal-connection-credentials.ts).
 *  - The key's variable does not start CONNECTION_. A connection may name
 *    any variable that does as its credential, and would then send the key
 *    to the address an administrator gave.
 *  - Nothing here logs, returns or stores the credential in the clear. It is
 *    opened in connection-client.ts at the moment of a call, into the
 *    request's header and nowhere else.
 *
 * This file holds no database and no network: the key, sealing, opening,
 * and what a credential may be.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/** The environment variable that holds the key credentials are sealed with. */
export const CREDENTIAL_KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";
/** Keys that sealed credentials before the current one, separated by commas or spaces: they open, they never seal. */
export const PREVIOUS_CREDENTIAL_KEYS_ENV = "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS";

/** How a key is made, for whoever sets one up. */
export const MAKE_A_KEY = "openssl rand -base64 32";

/** The longest credential a connection takes. Past any token a header carries in practice. */
export const CREDENTIAL_MAX_CHARS = 8192;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_PREFIX = "v1.";
const KEY_ID_PURPOSE = "minerval connection credential key id";
const BINDING_PURPOSE = "minerval connection credential v1";

/** What a sealed credential is bound to: the connection it was given for, where it is sent, and how. */
export interface CredentialBinding {
  connectionId: string;
  url: string;
  transport: string;
}

/** A credential as the row keeps it. */
export interface SealedCredential {
  /** `v1.` and the nonce, ciphertext and tag, in base64. */
  sealed: string;
  /** Which key sealed it (keyIdOf). */
  keyId: string;
}

export interface CredentialKeys {
  /** The key new credentials are sealed with; null when none is set, or the one set is not a key. */
  current: { id: string; key: Buffer } | null;
  /** Every key a credential may be opened with, by id: the current one and the previous ones. */
  opening: Map<string, Buffer>;
  /** What is wrong with the keys as set, in a sentence; null when nothing is. */
  problem: string | null;
}

/** A key's id: derived from the key, so it names the key without saying anything about it. */
export function keyIdOf(key: Buffer): string {
  return createHmac("sha256", key).update(KEY_ID_PURPOSE, "utf8").digest("hex").slice(0, 16);
}

/** A key as the environment gives it: 32 bytes in base64 or in hex. */
function parseKey(value: string): Buffer | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const bytes = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === KEY_BYTES) return bytes;
  }
  return null;
}

/**
 * The keys as the environment holds them now. Read at each use, so a test
 * or a restart sees what is set. The two variables are read by name here,
 * as every setting is (tests/unit/deploy/package.test.ts looks for that).
 */
export function credentialKeys(
  env: NodeJS.ProcessEnv = {
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS,
  }
): CredentialKeys {
  const opening = new Map<string, Buffer>();
  const problems: string[] = [];
  let current: CredentialKeys["current"] = null;
  const set = (env[CREDENTIAL_KEY_ENV] ?? "").trim();
  if (set) {
    const key = parseKey(set);
    if (key) {
      current = { id: keyIdOf(key), key };
      opening.set(current.id, key);
    } else {
      problems.push(
        `${CREDENTIAL_KEY_ENV} is set but is not a key: a key is 32 random bytes in base64 or hex (${MAKE_A_KEY}).`
      );
    }
  }
  const previous = (env[PREVIOUS_CREDENTIAL_KEYS_ENV] ?? "").split(/[\s,]+/).filter(Boolean);
  previous.forEach((value, i) => {
    const key = parseKey(value);
    if (key) opening.set(keyIdOf(key), key);
    else problems.push(`The ${ordinal(i + 1)} key in ${PREVIOUS_CREDENTIAL_KEYS_ENV} is not a key: 32 bytes in base64 or hex.`);
  });
  return { current, opening, problem: problems.length > 0 ? problems.join(" ") : null };
}

function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`;
}

/** The associated data a sealing is bound to. A fixed-order array, so the same binding is always the same bytes. */
function associatedData(binding: CredentialBinding): Buffer {
  return Buffer.from(JSON.stringify([BINDING_PURPOSE, binding.connectionId, binding.url, binding.transport]), "utf8");
}

/**
 * Seal a credential for one connection with the current key. Refused, with
 * why, when no key is set: a credential is never kept in the clear.
 */
export function sealCredential(
  credential: string,
  binding: CredentialBinding,
  keys: CredentialKeys = credentialKeys()
): { ok: true; value: SealedCredential } | { ok: false; message: string } {
  if (!keys.current) {
    return {
      ok: false,
      message:
        keys.problem ??
        `This deployment has no key to keep a credential with: ${CREDENTIAL_KEY_ENV} is not set where it runs. ` +
          `Whoever runs the deployment sets it (${MAKE_A_KEY}) and restarts it; until then, a connection can name ` +
          `an environment variable that holds its credential instead.`,
    };
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.current.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(binding));
  const body = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ok: true,
    value: { sealed: SEALED_PREFIX + Buffer.concat([nonce, body, tag]).toString("base64"), keyId: keys.current.id },
  };
}

/** Why a sealed credential did not open. */
export type NotOpened = "no_key" | "not_opened";

/**
 * Open a sealed credential for the connection it is bound to. `no_key`: none
 * of the keys set is the one that sealed it. `not_opened`: the key is here
 * and the ciphertext does not open under this binding, because it was
 * changed or belongs to another connection or another address.
 */
export function openCredential(
  stored: SealedCredential,
  binding: CredentialBinding,
  keys: CredentialKeys = credentialKeys()
): { ok: true; credential: string } | { ok: false; reason: NotOpened } {
  const key = keys.opening.get(stored.keyId);
  if (!key) return { ok: false, reason: "no_key" };
  if (!stored.sealed.startsWith(SEALED_PREFIX)) return { ok: false, reason: "not_opened" };
  const bytes = Buffer.from(stored.sealed.slice(SEALED_PREFIX.length), "base64");
  if (bytes.length < NONCE_BYTES + TAG_BYTES) return { ok: false, reason: "not_opened" };
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
    return { ok: true, credential: plain.toString("utf8") };
  } catch {
    return { ok: false, reason: "not_opened" };
  }
}

/** Whether a sealed credential could be opened with the keys set now, by its key's id alone. Nothing is decrypted. */
export function keyIsHere(keyId: string, keys: CredentialKeys = credentialKeys()): boolean {
  return keys.opening.has(keyId);
}

/**
 * The credential as it will be kept, or why it cannot be. Surrounding
 * spaces are dropped, since a pasted token often carries a newline. A
 * credential is one header's value, so it holds no line break or other
 * control character. In Authorization it is sent as `Bearer <credential>`,
 * so a credential pasted with "Bearer " in front would be sent with it
 * twice, and is refused with what to paste instead.
 */
export function cleanCredential(
  value: string,
  header: string
): { ok: true; value: string } | { ok: false; message: string } {
  const credential = value.trim();
  if (!credential) return { ok: false, message: "The credential is empty." };
  if (credential.length > CREDENTIAL_MAX_CHARS) {
    return { ok: false, message: `A credential is at most ${CREDENTIAL_MAX_CHARS} characters.` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(credential)) {
    return { ok: false, message: "A credential is one line, with no line breaks or other control characters." };
  }
  if (header.toLowerCase() === "authorization" && /^bearer\s/i.test(credential)) {
    return {
      ok: false,
      message: 'Paste the token without "Bearer " in front: in the Authorization header it is sent as a bearer token already.',
    };
  }
  return { ok: true, value: credential };
}
