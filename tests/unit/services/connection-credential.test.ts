import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_KEY_ENV,
  PREVIOUS_CREDENTIAL_KEYS_ENV,
  cleanCredential,
  credentialKeys,
  keyIdOf,
  keyIsHere,
  openCredential,
  sealCredential,
} from "../../../src/services/connection-credential.js";
import { CREDENTIAL_ENV_PREFIX } from "../../../src/connections.js";

/**
 * A credential given on a connection's page, sealed and opened
 * (src/services/connection-credential.ts): what it is bound to, what a key
 * is, and what is refused.
 */

const key = () => randomBytes(32).toString("base64");
const keysOf = (current: string | undefined, previous: string[] = []) =>
  credentialKeys({
    ...(current !== undefined ? { [CREDENTIAL_KEY_ENV]: current } : {}),
    ...(previous.length > 0 ? { [PREVIOUS_CREDENTIAL_KEYS_ENV]: previous.join(",") } : {}),
  } as NodeJS.ProcessEnv);
const binding = { connectionId: "11111111-1111-4111-8111-111111111111", url: "https://mcp.example.com/mcp", transport: "streamable_http" };

function sealed(credential: string, keys = keysOf(key())) {
  const out = sealCredential(credential, binding, keys);
  if (!out.ok) throw new Error(out.message);
  return { keys, value: out.value };
}

describe("sealing and opening", () => {
  it("opens to what was sealed, and the sealed text holds nothing of it", () => {
    const { keys, value } = sealed("ntn_secret_token_123");
    expect(value.sealed.startsWith("v1.")).toBe(true);
    expect(value.sealed).not.toContain("ntn_secret_token_123");
    expect(Buffer.from(value.sealed.slice(3), "base64").toString("latin1")).not.toContain("ntn_secret");
    expect(value.keyId).toBe(keys.current!.id);
    expect(openCredential(value, binding, keys)).toEqual({ ok: true, credential: "ntn_secret_token_123" });
  });

  it("seals the same credential differently each time", () => {
    const keys = keysOf(key());
    const a = sealed("same", keys).value.sealed;
    const b = sealed("same", keys).value.sealed;
    expect(a).not.toBe(b);
  });

  it("does not open for another connection, another address or another transport", () => {
    const { keys, value } = sealed("token");
    expect(openCredential(value, { ...binding, connectionId: "22222222-2222-4222-8222-222222222222" }, keys)).toEqual({ ok: false, reason: "not_opened" });
    expect(openCredential(value, { ...binding, url: "https://attacker.example/mcp" }, keys)).toEqual({ ok: false, reason: "not_opened" });
    expect(openCredential(value, { ...binding, transport: "sse" }, keys)).toEqual({ ok: false, reason: "not_opened" });
  });

  it("does not open once changed", () => {
    const { keys, value } = sealed("token");
    const bytes = Buffer.from(value.sealed.slice(3), "base64");
    bytes[bytes.length - 20] ^= 1;
    expect(openCredential({ ...value, sealed: `v1.${bytes.toString("base64")}` }, binding, keys)).toEqual({ ok: false, reason: "not_opened" });
    expect(openCredential({ ...value, sealed: "v1.AAAA" }, binding, keys)).toEqual({ ok: false, reason: "not_opened" });
    expect(openCredential({ ...value, sealed: "v2." + value.sealed.slice(3) }, binding, keys)).toEqual({ ok: false, reason: "not_opened" });
  });

  it("says when the key that sealed it is not here, and opens with it among the previous keys", () => {
    const old = key();
    const { value } = sealed("token", keysOf(old));
    const replaced = keysOf(key());
    expect(openCredential(value, binding, replaced)).toEqual({ ok: false, reason: "no_key" });
    expect(keyIsHere(value.keyId, replaced)).toBe(false);
    const both = keysOf(key(), [old]);
    expect(keyIsHere(value.keyId, both)).toBe(true);
    expect(openCredential(value, binding, both)).toEqual({ ok: true, credential: "token" });
    // A previous key opens and never seals.
    expect(sealCredential("x", binding, both).ok && sealCredential("x", binding, both)).toMatchObject({ value: { keyId: both.current!.id } });
  });

  it("is refused, and nothing is sealed, where no key is set", () => {
    const out = sealCredential("token", binding, keysOf(undefined));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain(CREDENTIAL_KEY_ENV);
  });
});

describe("the key", () => {
  it("is 32 bytes, in base64 or hex, and its id says nothing of it", () => {
    const bytes = randomBytes(32);
    const b64 = keysOf(bytes.toString("base64"));
    const hex = keysOf(bytes.toString("hex"));
    expect(b64.current!.id).toBe(hex.current!.id);
    expect(b64.current!.id).toBe(keyIdOf(bytes));
    expect(b64.current!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(bytes.toString("hex")).not.toContain(b64.current!.id);
    expect(b64.problem).toBeNull();
  });

  it("is refused, with why, when what is set is not a key", () => {
    for (const bad of ["short", randomBytes(16).toString("base64"), "not base64 at all!!"]) {
      const keys = keysOf(bad);
      expect(keys.current, bad).toBeNull();
      expect(keys.problem, bad).toContain(CREDENTIAL_KEY_ENV);
    }
    expect(keysOf(key(), ["nope"]).problem).toContain(PREVIOUS_CREDENTIAL_KEYS_ENV);
    expect(keysOf(undefined).problem).toBeNull();
  });

  it("is in a variable a connection cannot name as its credential", () => {
    expect(CREDENTIAL_KEY_ENV.startsWith(CREDENTIAL_ENV_PREFIX)).toBe(false);
    expect(PREVIOUS_CREDENTIAL_KEYS_ENV.startsWith(CREDENTIAL_ENV_PREFIX)).toBe(false);
  });
});

describe("what a credential may be", () => {
  it("drops surrounding space, as a pasted token carries", () => {
    expect(cleanCredential("  tok\n", "Authorization")).toEqual({ ok: true, value: "tok" });
  });

  it("refuses an empty one, a line break inside, and one past the length", () => {
    expect(cleanCredential("   ", "Authorization").ok).toBe(false);
    expect(cleanCredential("a\nb", "X-Api-Key").ok).toBe(false);
    expect(cleanCredential("a\u0000b", "X-Api-Key").ok).toBe(false);
    expect(cleanCredential("x".repeat(8193), "X-Api-Key").ok).toBe(false);
  });

  it("refuses one pasted with Bearer in front where it is sent as a bearer token", () => {
    const out = cleanCredential("Bearer abc", "authorization");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("Bearer");
    expect(cleanCredential("Bearer abc", "X-Api-Key")).toEqual({ ok: true, value: "Bearer abc" });
  });
});
