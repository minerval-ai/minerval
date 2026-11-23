/**
 * A model's refusal reaching a REST route is answered as a refusal (#1044):
 * 422 MODEL_REFUSED with the model's words and category, not a 500 that
 * hides it. Nothing retried it on another model.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerErrorHandler } from "../../../src/server/plugins/error-handler.js";
import { LlmRefusalError } from "../../../src/llm/errors.js";

async function appThrowing(err: Error) {
  const app = Fastify({ logger: false });
  await registerErrorHandler(app);
  app.get("/work", async () => {
    throw err;
  });
  await app.ready();
  return app;
}

describe("the error handler, on a model's refusal", () => {
  it("answers 422 MODEL_REFUSED with the category", async () => {
    const app = await appThrowing(new LlmRefusalError("claude-opus-5-5", "bio"));
    const res = await app.inject({ method: "GET", url: "/work" });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; message: string; category?: string } };
    expect(body.error.code).toBe("MODEL_REFUSED");
    expect(body.error.message).toBe("Model claude-opus-5-5 refused the request (category: bio)");
    expect(body.error.category).toBe("bio");
    await app.close();
  });

  it("leaves the category out when the provider named none", async () => {
    const app = await appThrowing(new LlmRefusalError("claude-fable-5-2", null));
    const res = await app.inject({ method: "GET", url: "/work" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: Record<string, unknown> }).error).not.toHaveProperty("category");
    await app.close();
  });
});
