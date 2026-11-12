/**
 * A mirror batch's hash, signature and form (src/services/mirror-batch.ts),
 * with no database: what a mirror checks before it looks at its own state.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  MIRROR_FEED_FORMAT,
  MirrorRefusal,
  batchFileName,
  batchHash,
  feedGenesisHash,
  generateSigningKey,
  keyIdOf,
  orderByReferences,
  parsePublicKey,
  parseSigningKey,
  publicKeyString,
  readBatch,
  sequenceOfFileName,
  signBatch,
  verifyBatch,
  type MirrorBatchBody,
} from "../../../src/services/mirror-batch.js";

const key = generateKeyPairSync("ed25519");
const publicKey = publicKeyString(key.publicKey);
const FEED = "5b0f1a52-9a43-4a0e-8a59-0e8f2c1d7b11";

function body(over: Partial<MirrorBatchBody> = {}): MirrorBatchBody {
  return {
    format: MIRROR_FEED_FORMAT,
    feed_id: FEED,
    sequence: 1,
    kind: "snapshot",
    part: { first: 1, last: true },
    cut_at: "2026-11-12T00:00:00.000Z",
    migration: { number: 126, tag: "0126_mirror" },
    shape: "a".repeat(64),
    embedding: { model: "an-embedding-model", dimensions: 1536 },
    publisher: { web_base_url: "https://public.example" },
    previous_hash: feedGenesisHash(FEED),
    rows: [{ table: "claims", rows: [{ id: "c1", text: "Water is wet", importance: 0.3 }] }],
    deletions: [],
    retractions: [],
    key_id: keyIdOf(publicKey),
    public_key: publicKey,
    ...over,
  };
}

function refusalOf(run: () => unknown): MirrorRefusal {
  try {
    run();
  } catch (err) {
    if (err instanceof MirrorRefusal) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("a batch's hash", () => {
  it("does not depend on the order of keys or on spacing", () => {
    const a = body();
    const b = Object.fromEntries(Object.entries(a).reverse()) as unknown as MirrorBatchBody;
    b.part = { last: true, first: 1 };
    b.rows = [{ rows: [{ importance: 0.3, text: "Water is wet", id: "c1" }], table: "claims" } as never];
    expect(batchHash(b)).toBe(batchHash(a));
  });

  it("changes with any of its contents, and ignores the hash and signature it carries", () => {
    const signed = signBatch(body(), key.privateKey);
    expect(batchHash(signed)).toBe(signed.hash);
    expect(batchHash(body({ sequence: 2 }))).not.toBe(signed.hash);
    expect(batchHash(body({ rows: [{ table: "claims", rows: [{ id: "c1", text: "Water is dry", importance: 0.3 }] }] }))).not.toBe(signed.hash);
    expect(batchHash(body({ deletions: [{ table: "claims", keys: ["c2"] }] }))).not.toBe(signed.hash);
  });

  it("starts each feed's chain from a genesis of its own", () => {
    expect(feedGenesisHash(FEED)).toMatch(/^[0-9a-f]{64}$/);
    expect(feedGenesisHash(FEED.toUpperCase())).toBe(feedGenesisHash(FEED));
    expect(feedGenesisHash("6b0f1a52-9a43-4a0e-8a59-0e8f2c1d7b11")).not.toBe(feedGenesisHash(FEED));
  });
});

describe("checking a batch", () => {
  const signed = signBatch(body(), key.privateKey);

  it("accepts one signed by a trusted key, whatever else is trusted", () => {
    const other = generateKeyPairSync("ed25519").publicKey;
    expect(() => verifyBatch(signed, [other, key.publicKey])).not.toThrow();
    // A batch that went through JSON, as every batch does.
    expect(() => verifyBatch(readBatch(JSON.stringify(signed)), [key.publicKey])).not.toThrow();
  });

  it("refuses altered contents, with the reason", () => {
    const altered = { ...signed, rows: [{ table: "claims", rows: [{ id: "c1", text: "Water is dry", importance: 0.3 }] }] };
    const err = refusalOf(() => verifyBatch(altered, [key.publicKey]));
    expect(err.code).toBe("hash_mismatch");
    expect(err.message).toBe(
      "Batch 1 was not applied: its contents do not match its hash, so it was altered or damaged after it was cut."
    );
    expect(err.batch).toEqual({ sequence: 1, hash: signed.hash });
  });

  it("refuses a key it was not told to trust, and never the key the batch carries", () => {
    const stranger = generateKeyPairSync("ed25519");
    const strangerKey = publicKeyString(stranger.publicKey);
    const theirs = signBatch(body({ key_id: keyIdOf(strangerKey), public_key: strangerKey }), stranger.privateKey);
    const err = refusalOf(() => verifyBatch(theirs, [key.publicKey]));
    expect(err.code).toBe("unknown_key");
    expect(err.message).toContain("which is not a key this deployment trusts (MIRROR_FEED_PUBLIC_KEYS)");
    // Claiming the trusted key's id without holding its private half.
    const posing = signBatch(body(), stranger.privateKey);
    expect(refusalOf(() => verifyBatch(posing, [key.publicKey])).code).toBe("bad_signature");
    expect(refusalOf(() => verifyBatch(signed, [])).code).toBe("unknown_key");
  });

  it("refuses what is not a batch, saying what is wrong", () => {
    expect(refusalOf(() => readBatch("not json")).message).toBe("This is not a mirror batch: it is not JSON.");
    expect(refusalOf(() => readBatch([])).code).toBe("malformed");
    expect(refusalOf(() => readBatch({ ...signed, format: 2 })).message).toBe(
      "This is not a mirror batch this deployment can read: its format is 2 and this code reads format 1."
    );
    for (const broken of [
      { ...signed, sequence: 0 },
      { ...signed, kind: "delta" },
      { ...signed, part: { first: 2, last: true } },
      { ...signed, rows: {} },
      { ...signed, deletions: [{ table: "claims" }] },
      { ...signed, previous_hash: "short" },
      { ...signed, signature: "" },
      { ...signed, migration: { number: "126", tag: "x" } },
    ]) {
      expect(refusalOf(() => readBatch(broken)).code).toBe("malformed");
    }
  });
});

describe("keys", () => {
  it("makes a signing key whose halves read back", () => {
    const made = generateSigningKey();
    expect(made.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(Buffer.from(made.publicKey, "base64")).toHaveLength(32);
    expect(made.keyId).toBe(keyIdOf(made.publicKey));
    const signedWith = signBatch(body({ key_id: made.keyId, public_key: made.publicKey }), parseSigningKey(made.privateKeyPem));
    expect(() => verifyBatch(signedWith, [parsePublicKey(made.publicKey)])).not.toThrow();
    // A key pasted into an env file with its newlines escaped.
    expect(() => parseSigningKey(made.privateKeyPem.replace(/\n/g, "\\n"))).not.toThrow();
  });

  it("refuses a key of another kind in plain words", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => parseSigningKey(rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString())).toThrow(
      "MIRROR_SIGNING_KEY must be an Ed25519 private key"
    );
    expect(() => parseSigningKey("nonsense")).toThrow("MIRROR_SIGNING_KEY is not a private key in PEM form");
    expect(() => parsePublicKey(rsa.publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow(/must be an Ed25519 key/);
    expect(() => parsePublicKey("AAAA")).toThrow(/must be an Ed25519 key/);
  });
});

describe("ordering rows that point to rows of their own table", () => {
  const flat = (groups: string[][]) => groups.flat();

  it("puts a row after every row it points to", () => {
    const refs: Record<string, string[]> = { a: ["b"], b: ["c"], c: [], d: ["a", "c"] };
    const groups = orderByReferences(["a", "b", "c", "d"], (k) => refs[k]!);
    expect(groups.every((g) => g.length === 1)).toBe(true);
    const order = flat(groups);
    expect(order.sort()).toEqual(["a", "b", "c", "d"]);
    const at = (k: string) => flat(groups).indexOf(k);
    expect(at("c")).toBeLessThan(at("b"));
    expect(at("b")).toBeLessThan(at("a"));
    expect(at("a")).toBeLessThan(at("d"));
  });

  it("keeps rows that point to each other in a circle together", () => {
    const refs: Record<string, string[]> = { a: ["b"], b: ["a"], c: ["a"], d: [] };
    const groups = orderByReferences(["c", "a", "b", "d"], (k) => refs[k]!);
    const circle = groups.find((g) => g.includes("a"))!;
    expect(circle.sort()).toEqual(["a", "b"]);
    expect(groups.indexOf(circle)).toBeLessThan(groups.findIndex((g) => g.includes("c")));
    expect(flat(groups).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores a pointer to a row that is not among them, or to itself", () => {
    const groups = orderByReferences(["a", "b"], (k) => (k === "a" ? ["zzz", "a"] : ["a"]));
    expect(groups).toEqual([["a"], ["b"]]);
  });

  it("handles a chain far deeper than a call stack", () => {
    const n = 50_000;
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    const groups = orderByReferences(keys, (k) => {
      const i = Number(k.slice(1));
      return i + 1 < n ? [`k${i + 1}`] : [];
    });
    expect(groups).toHaveLength(n);
    expect(groups[0]).toEqual([`k${n - 1}`]);
    expect(groups.at(-1)).toEqual(["k0"]);
  });
});

describe("batch files", () => {
  it("are named so that a directory lists them in order", () => {
    expect(batchFileName(7)).toBe("mirror-batch-000000000007.json");
    expect(sequenceOfFileName("mirror-batch-000000000007.json")).toBe(7);
    expect(sequenceOfFileName("mirror-batch-7.json")).toBeNull();
    expect(sequenceOfFileName("notes.txt")).toBeNull();
    expect([batchFileName(10), batchFileName(9)].sort()).toEqual([batchFileName(9), batchFileName(10)]);
  });
});
