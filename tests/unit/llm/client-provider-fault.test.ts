import { describe, it, expect, vi, beforeEach } from "vitest";

// Every provider call goes through the client's seam (clearedAdapter). A
// failure leaves it stamped with the provider that answered, and a
// deployment fault (the account out of credits, the key rejected) is put on
// record for the operator there, whichever agent met it: on 2026-11-12 the
// Matcher's refusals reached nobody, because a tool turned each one into a
// tool result (#967, #971).

const h = vi.hoisted(() => ({
  fail: null as unknown,
  noted: [] as Array<{ err: unknown; surface?: string }>,
}));

vi.mock("../../../src/llm/providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/llm/providers/index.js")>()),
  getAdapter: () => ({
    name: "openrouter",
    complete: async (options: { model: string }) => {
      if (h.fail) throw h.fail;
      return { content: "ok", model: options.model, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
    completeWithTools: async () => {
      throw h.fail;
    },
    completeStructured: async () => {
      throw h.fail;
    },
  }),
}));
vi.mock("../../../src/llm/provider-clearance.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/llm/provider-clearance.js")>()),
  assertProviderCleared: vi.fn(async () => undefined),
  providerClearedHere: () => true,
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../../../src/services/deployment-fault-service.js", () => ({
  noteDeploymentFault: vi.fn(async (err: unknown, opts: { surface?: string } = {}) => {
    h.noted.push({ err, surface: opts.surface });
    return "credits_fault";
  }),
}));

import { complete, completeStructured } from "../../../src/llm/client.js";
import { errorProvider } from "../../../src/llm/errors.js";
import { withAgent } from "../../../src/llm/usage-context.js";
import { OPENROUTER_MODELS } from "../../../src/llm/models.js";

const model = OPENROUTER_MODELS.flash;
const refused = () =>
  Object.assign(new Error("402 This request's maximum cost exceeds your available credits."), { status: 402 });

beforeEach(() => {
  h.fail = null;
  h.noted = [];
});

describe("the client's seam and a provider fault", () => {
  it("rethrows the provider's refusal unchanged, stamped with the provider, and records it once for the operator", async () => {
    const err = refused();
    h.fail = err;
    await expect(
      withAgent("matcher", () => complete({ model, messages: [{ role: "user", content: "same proposition?" }] }))
    ).rejects.toBe(err);
    expect(errorProvider(err)).toBe("openrouter");
    expect(h.noted).toHaveLength(1);
    expect(h.noted[0]!.err).toBe(err);
    expect(h.noted[0]!.surface).toBe("the matcher agent");
  });

  it("covers the structured path too, and a rejected key", async () => {
    h.fail = Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
    await expect(
      completeStructured({
        model,
        messages: [{ role: "user", content: "x" }],
        schema: { type: "object", properties: {} },
        schemaName: "s",
      })
    ).rejects.toBe(h.fail);
    expect(errorProvider(h.fail)).toBe("openrouter");
    expect(h.noted).toHaveLength(1);
  });

  it("stamps but does not record a failure that is not a deployment fault", async () => {
    for (const fail of [
      Object.assign(new Error("529 overloaded"), { status: 529 }),
      Object.assign(new Error("400 max_tokens is too large"), { status: 400 }),
    ]) {
      h.fail = fail;
      await expect(complete({ model, messages: [{ role: "user", content: "x" }] })).rejects.toBe(fail);
      expect(errorProvider(fail)).toBe("openrouter");
    }
    expect(h.noted).toEqual([]);
  });

  it("leaves a call that succeeds alone", async () => {
    const res = await complete({ model, messages: [{ role: "user", content: "x" }] });
    expect(res.content).toBe("ok");
    expect(h.noted).toEqual([]);
  });
});
