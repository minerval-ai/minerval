/**
 * What a webhook delivery carries (src/services/webhook-signing.ts): the
 * Standard Webhooks signature, checked against the scheme's published
 * example, what a caller's secret must be, and the id a subscription has.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  challengeAnswered,
  deliveryHeaders,
  makeSecret,
  messageId,
  secretBytes,
  signDelivery,
  subscriptionId,
  verifyDelivery,
} from "../../../src/services/webhook-signing.js";

describe("the signature", () => {
  // The example the Standard Webhooks libraries test themselves with.
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const at = 1614265330;
  const body = '{"test": 2432232314}';
  const signature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

  it("is the scheme's own for its published example", () => {
    expect(signDelivery(secretBytes(secret)!, id, at, body)).toBe(signature);
    expect(verifyDelivery(secretBytes(secret)!, id, at, body, signature)).toBe(true);
  });

  it("does not verify a body, an id or a time that was changed, and accepts any one of several signatures", () => {
    const key = secretBytes(secret)!;
    expect(verifyDelivery(key, id, at, '{"test":2432232314}', signature)).toBe(false);
    expect(verifyDelivery(key, `${id}x`, at, body, signature)).toBe(false);
    expect(verifyDelivery(key, id, at + 1, body, signature)).toBe(false);
    expect(verifyDelivery(key, id, at, body, `v1,AAAA ${signature}`)).toBe(true);
    expect(verifyDelivery(key, id, at, body, "")).toBe(false);
  });

  it("signs each delivery at the time it is sent, with both secrets while one is being replaced", () => {
    const key = secretBytes(secret)!;
    const old = secretBytes(makeSecret())!;
    const now = new Date(at * 1000);
    const one = deliveryHeaders({ secret: key, messageId: id, subscriptionId: "sub_x", body, now });
    expect(one).toEqual({
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(at),
      "webhook-signature": signature,
      "x-mcp-subscription-id": "sub_x",
    });
    const two = deliveryHeaders({ secret: key, previousSecret: old, messageId: id, subscriptionId: "sub_x", body, now });
    expect(two["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect(verifyDelivery(old, id, at, body, two["webhook-signature"]!)).toBe(true);
    expect(verifyDelivery(key, id, at, body, two["webhook-signature"]!)).toBe(true);
  });
});

describe("a caller's secret", () => {
  it("is whsec_ and the base64 of 24 to 64 bytes, and nothing else", () => {
    expect(secretBytes(makeSecret())).toHaveLength(32);
    expect(secretBytes("whsec_" + Buffer.alloc(24, 1).toString("base64"))).toHaveLength(24);
    expect(secretBytes("whsec_" + Buffer.alloc(64, 1).toString("base64"))).toHaveLength(64);
    expect(secretBytes("whsec_" + Buffer.alloc(23, 1).toString("base64"))).toBeNull();
    expect(secretBytes("whsec_" + Buffer.alloc(65, 1).toString("base64"))).toBeNull();
    expect(secretBytes(Buffer.alloc(32, 1).toString("base64"))).toBeNull();
    expect(secretBytes("whsec_not base64 at all, but long enough to be one")).toBeNull();
    expect(secretBytes("whsec_")).toBeNull();
    expect(secretBytes(undefined)).toBeNull();
    expect(secretBytes(42)).toBeNull();
  });
});

describe("a subscription's id", () => {
  it("is the same for the same account, address, event and arguments, however the arguments are written", () => {
    const a = subscriptionId("user:1", "https://x.test/h", "graph.change", { under: ["b", "a"], tags: ["t"] });
    expect(a).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(subscriptionId("user:1", "https://x.test/h", "graph.change", { tags: ["t"], under: ["b", "a"] })).toBe(a);
    expect(subscriptionId("user:2", "https://x.test/h", "graph.change", { under: ["b", "a"], tags: ["t"] })).not.toBe(a);
    expect(subscriptionId("user:1", "https://x.test/i", "graph.change", { under: ["b", "a"], tags: ["t"] })).not.toBe(a);
    expect(subscriptionId("user:1", "https://x.test/h", "correspondent.update", { under: ["b", "a"], tags: ["t"] })).not.toBe(a);
    expect(subscriptionId("user:1", "https://x.test/h", "graph.change", { under: ["a"], tags: ["t"] })).not.toBe(a);
    expect(subscriptionId("user:1", "https://x.test/h", "graph.change", undefined)).toBe(
      subscriptionId("user:1", "https://x.test/h", "graph.change", {})
    );
  });

  it("rests on JSON with its keys in order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe("message ids and challenges", () => {
  it("makes ids of letters, digits, _ and -, marked by kind for what is not an event", () => {
    expect(messageId()).toMatch(/^msg_[A-Za-z0-9_-]{20,}$/);
    expect(messageId("verification")).toMatch(/^msg_verification_[A-Za-z0-9_-]+$/);
    expect(messageId("terminated")).toMatch(/^msg_terminated_[A-Za-z0-9_-]+$/);
    expect(messageId()).not.toBe(messageId());
  });

  it("takes only the challenge itself as its answer", () => {
    expect(challengeAnswered("abc", '{"challenge":"abc"}')).toBe(true);
    expect(challengeAnswered("abc", '{"challenge":"abd"}')).toBe(false);
    expect(challengeAnswered("abc", '{"challenge":"abcd"}')).toBe(false);
    expect(challengeAnswered("abc", '{"challenge":7}')).toBe(false);
    expect(challengeAnswered("abc", "abc")).toBe(false);
    expect(challengeAnswered("abc", "")).toBe(false);
  });
});
