/**
 * Partial responses (`fields=` on GET routes): the pure pruning function,
 * the parser, and the hooks on a small app with the API's error handler.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  FIELDS_MAX_LENGTH,
  FieldsError,
  parseFields,
  pruneToFields,
  registerPartialResponse,
} from "../../../src/server/plugins/partial-response.js";
import { registerErrorHandler } from "../../../src/server/plugins/error-handler.js";
import { registerRouteCatalog } from "../../../src/server/plugins/route-catalog.js";

const prune = (value: unknown, fields: string) => pruneToFields(value, parseFields(fields));

describe("parseFields", () => {
  it("splits a comma-separated list of dotted paths", () => {
    expect(parseFields("claim.text,assessment.status")).toEqual([
      ["claim", "text"],
      ["assessment", "status"],
    ]);
  });

  it("allows spaces around a path and drops a repeated path", () => {
    expect(parseFields(" id , text,id")).toEqual([["id"], ["text"]]);
  });

  it.each([
    ["an empty value", ""],
    ["only spaces", "   "],
    ["a leading comma", ",id"],
    ["a trailing comma", "id,"],
    ["a doubled comma", "id,,text"],
    ["a doubled dot", "claim..text"],
    ["a leading dot", ".claim"],
    ["a trailing dot", "claim."],
    ["a space inside a path", "claim text"],
    ["a bracket", "results[0].id"],
    ["a wildcard", "results.*"],
    ["a slash", "claim/text"],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseFields(raw)).toThrow(FieldsError);
  });

  it("rejects a value given more than once, or not as text", () => {
    expect(() => parseFields(["id", "text"])).toThrow(FieldsError);
    expect(() => parseFields(3)).toThrow(FieldsError);
  });

  it("rejects a value over the stated length", () => {
    expect(() => parseFields("a".repeat(FIELDS_MAX_LENGTH))).not.toThrow();
    expect(() => parseFields("a".repeat(FIELDS_MAX_LENGTH + 1))).toThrow(FieldsError);
  });
});

describe("pruneToFields", () => {
  const claim = {
    claim: { id: "c1", text: "Water boils at 100°C.", state: "active", contestation: 0.4 },
    assessment: { status: "supported", confidence: 0.8, summary: "long" },
    subclaim_count: 3,
    tags: [
      { slug: "physics", name: "Physics" },
      { slug: "water", name: "Water" },
    ],
  };

  it("keeps only the named nested paths", () => {
    expect(prune(claim, "claim.text,assessment.status,assessment.confidence")).toEqual({
      claim: { text: "Water boils at 100°C." },
      assessment: { status: "supported", confidence: 0.8 },
    });
  });

  it("keeps a whole subtree when the path stops at it", () => {
    expect(prune(claim, "assessment,subclaim_count")).toEqual({
      assessment: claim.assessment,
      subclaim_count: 3,
    });
  });

  it("lets a shorter path win over a longer one below it, in either order", () => {
    expect(prune(claim, "assessment,assessment.status")).toEqual({ assessment: claim.assessment });
    expect(prune(claim, "assessment.status,assessment")).toEqual({ assessment: claim.assessment });
  });

  it("applies a path through an array to each element, in place", () => {
    expect(prune(claim, "tags.slug")).toEqual({
      tags: [{ slug: "physics" }, { slug: "water" }],
    });
    expect(
      prune({ results: [{ id: 1, text: "a", x: 1 }, { id: 2, text: "b" }], total: 2 }, "results.id,results.text")
    ).toEqual({ results: [{ id: 1, text: "a" }, { id: 2, text: "b" }] });
  });

  it("goes through arrays of arrays and nested arrays of objects", () => {
    expect(prune({ grid: [[{ a: 1, b: 2 }], [{ a: 3, b: 4 }]] }, "grid.a")).toEqual({
      grid: [[{ a: 1 }], [{ a: 3 }]],
    });
    expect(
      prune({ args: [{ id: 1, subclaims: [{ id: 2, text: "t" }] }] }, "args.subclaims.id")
    ).toEqual({ args: [{ subclaims: [{ id: 2 }] }] });
  });

  it("keeps array positions: an element that matches nothing becomes {}", () => {
    expect(prune({ results: [{ id: 1 }, { other: 2 }, null] }, "results.id")).toEqual({
      results: [{ id: 1 }, {}, null],
    });
  });

  it("keeps an empty array as an empty array", () => {
    expect(prune({ results: [], total: 0 }, "results.id")).toEqual({ results: [] });
  });

  it("leaves out a path that matches nothing", () => {
    expect(prune(claim, "nope,claim.nope,claim.text.deeper,subclaim_count.x")).toEqual({});
    expect(prune(claim, "nope,claim.id")).toEqual({ claim: { id: "c1" } });
  });

  it("keeps a null on the way as null: unassessed is an answer, not a gap", () => {
    expect(prune({ claim: { id: "c1" }, assessment: null }, "claim.id,assessment.status")).toEqual({
      claim: { id: "c1" },
      assessment: null,
    });
    expect(prune({ assessment_status: null, x: 1 }, "assessment_status")).toEqual({
      assessment_status: null,
    });
  });

  it("keeps the response's key order, not the order asked", () => {
    expect(Object.keys(prune(claim, "subclaim_count,claim") as object)).toEqual([
      "claim",
      "subclaim_count",
    ]);
  });

  it("does not modify its input", () => {
    const before = JSON.stringify(claim);
    prune(claim, "claim.text,tags.slug");
    expect(JSON.stringify(claim)).toBe(before);
  });

  it("does not read inherited properties", () => {
    expect(prune({ a: 1 }, "constructor,toString,__proto__")).toEqual({});
  });

  it("prunes each element of a top-level array", () => {
    expect(prune([{ id: 1, x: 1 }, { id: 2 }], "id")).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

async function buildApp() {
  process.env.LOG_LEVEL = "fatal";
  const app = Fastify();
  await registerErrorHandler(app);
  await registerPartialResponse(app);
  await registerRouteCatalog(app);

  const thing = () => ({
    claim: { id: "c1", text: "t", secret: "not declared" },
    assessment: null,
    made_at: new Date("2026-01-02T03:04:05.000Z"),
    items: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ],
  });

  app.get("/thing", {
    schema: {
      querystring: { type: "object", properties: { depth: { type: "integer" } } },
      response: {
        200: {
          type: "object",
          properties: {
            claim: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } },
            assessment: { type: "object", nullable: true, properties: { status: { type: "string" } } },
            made_at: { type: "string", format: "date-time" },
            items: {
              type: "array",
              items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
            },
          },
          // A pruned body must not trip the serializer's required check.
          required: ["claim", "made_at"],
        },
      },
    },
    handler: async () => thing(),
  });
  // No response schema: the payload is served as it is.
  app.get("/loose", async () => thing());
  app.get("/missing", async (_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "nope" } })
  );
  app.get("/text", async (_request, reply) => reply.type("text/plain").send("claim, text"));
  app.get("/json-string", async (_request, reply) =>
    reply.type("application/ld+json; charset=utf-8").send(JSON.stringify({ a: 1, b: 2 }))
  );
  app.get("/prizes.atom", async (_request, reply) =>
    reply.type("application/atom+xml").send("<feed/>")
  );
  app.post("/thing", async () => thing());
  await app.ready();
  return app;
}

describe("fields on GET routes", () => {
  it("serves the full response when fields is absent", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/thing" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      claim: { id: "c1", text: "t" },
      assessment: null,
      made_at: "2026-01-02T03:04:05.000Z",
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    });
  });

  it("prunes to the paths asked, keeping the JSON content type", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/thing?fields=claim.text,items.id,assessment.status",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({
      claim: { text: "t" },
      assessment: null,
      items: [{ id: 1 }, { id: 2 }],
    });
    // The body's length header describes the pruned body.
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
  });

  it("prunes before onSend, so later hooks see the final body", async () => {
    process.env.LOG_LEVEL = "fatal";
    const app = Fastify();
    await registerPartialResponse(app);
    let seen = "";
    app.addHook("onSend", async (_request, _reply, payload) => {
      seen = String(payload);
      return payload;
    });
    app.get("/thing", async () => ({ a: 1, b: 2 }));
    const res = await app.inject({ method: "GET", url: "/thing?fields=a" });
    expect(seen).toBe('{"a":1}');
    expect(res.body).toBe('{"a":1}');
  });

  it("selects from what the route serves: an undeclared property stays out", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/thing?fields=claim.secret,claim.id" });
    expect(res.json()).toEqual({ claim: { id: "c1" } });
  });

  it("serves values as the route's serializer writes them", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/thing?fields=made_at" });
    expect(res.json()).toEqual({ made_at: "2026-01-02T03:04:05.000Z" });
  });

  it("answers {} when no path matches", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/thing?fields=nothing.here" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("works on a route with no response schema", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/loose?fields=claim.secret,items.name" });
    expect(res.json()).toEqual({
      claim: { secret: "not declared" },
      items: [{ name: "a" }, { name: "b" }],
    });
  });

  it("leaves the route's other query parameters working", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/thing?depth=2&fields=claim.id" });
    expect(res.json()).toEqual({ claim: { id: "c1" } });
  });

  it.each(["", "claim..text", "claim.text,", "items[0].id", "a b"])(
    "answers 400 in the error envelope for malformed fields %j",
    async (fields) => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/thing", query: { fields } });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toMatch(/fields/);
      expect(body.error.details[0].path).toBe("fields");
      expect(typeof body.error.request_id).toBe("string");
    }
  );

  it("answers 400 when fields is given more than once", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/thing?fields=claim&fields=items" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("does not prune an error response", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/missing?fields=claim" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "nope" } });
  });

  it("leaves text and pre-serialized bodies alone", async () => {
    const app = await buildApp();
    const text = await app.inject({ method: "GET", url: "/text?fields=claim" });
    expect(text.body).toBe("claim, text");
    const ld = await app.inject({ method: "GET", url: "/json-string?fields=a" });
    expect(ld.json()).toEqual({ a: 1, b: 2 });
  });

  it("does not apply to other methods", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/thing?fields=claim.id" });
    expect(Object.keys(res.json())).toEqual(["claim", "assessment", "made_at", "items"]);
    // Nor is a malformed one an error there: POST routes do not take it.
    const bad = await app.inject({ method: "POST", url: "/thing?fields=a..b" });
    expect(bad.statusCode).toBe(200);
  });

  it("declares fields in the querystring of covered GET routes only", async () => {
    const app = await buildApp();
    const fieldsOf = (method: string, url: string) => {
      const route = app.routeCatalog.find((r) => r.method === method && r.url === url)!;
      const query = route.schema?.querystring as
        | { properties?: Record<string, { type?: string; maxLength?: number }> }
        | undefined;
      return query?.properties?.fields;
    };
    expect(fieldsOf("GET", "/thing")).toMatchObject({ type: "string", maxLength: FIELDS_MAX_LENGTH });
    expect(fieldsOf("GET", "/loose")).toMatchObject({ type: "string" });
    // The route's own parameters are kept beside it.
    const thing = app.routeCatalog.find((r) => r.method === "GET" && r.url === "/thing")!;
    expect(Object.keys((thing.schema!.querystring as { properties: object }).properties)).toEqual([
      "depth",
      "fields",
    ]);
    expect(fieldsOf("POST", "/thing")).toBeUndefined();
    // A feed is not a JSON object: fields is neither declared nor checked.
    expect(fieldsOf("GET", "/prizes.atom")).toBeUndefined();
    const feed = await app.inject({ method: "GET", url: "/prizes.atom?fields=a..b" });
    expect(feed.statusCode).toBe(200);
  });
});
