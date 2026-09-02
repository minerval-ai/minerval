import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The extension's transience invariant (#356): nothing derived from a page
 * the reader has open is persisted. The pipeline writes no sources, no claim
 * instances, and — with TRACE_LEVEL=full, as production now runs — no
 * agent_runs or agent_steps, because every agent it invokes runs untraced.
 *
 * The real usage context and trace service are exercised; only the database
 * is mocked, recording every write attempt. The agent mocks go through the
 * real withAgent so a run WOULD be opened if the seam ever let it through,
 * and the last test proves that by invoking the same mocks outside the
 * extension path and watching the row appear.
 */
const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(async () => undefined),
  updateWhere: vi.fn(async () => undefined),
  seen: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({ values: mocks.insertValues }),
    update: () => ({ set: () => ({ where: mocks.updateWhere }) }),
  }),
  // The subclaim count read for a matched claim.
  rawQuery: async () => [{ count: "0" }],
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    env: "production",
    // Production's setting: everything traceable is traced.
    traceLevel: "full",
    publicWebBaseUrl: "https://minerval.ai",
    extensionModel: "test-model",
    extensionMaxClaims: 10,
  }),
}));

const CLAIM_ID = "22222222-2222-2222-2222-222222222222";

// Each agent mock runs through the real withAgent and records the ambient
// context it saw, exactly as the real agents do.
vi.mock("../../../src/llm/agents/extractor.js", async () => {
  const { withAgent, getUsageContext } = await import(
    "../../../src/llm/usage-context.js"
  );
  return {
    extractClaims: () =>
      withAgent("extractor", async () => {
        mocks.seen.push({ ...getUsageContext() });
        return [
          {
            original_text: "Dear Jane, the lockdowns did more harm than good.",
            context: null,
            proposed_canonical_form: "Lockdowns did more harm than good.",
            claim_type: "evaluative",
            confidence: 0.9,
            importance: 0.5,
            contestation: 0.8,
            source_location: null,
          },
        ];
      }),
  };
});

vi.mock("../../../src/llm/agents/matcher.js", async () => {
  const { withAgent, getUsageContext } = await import(
    "../../../src/llm/usage-context.js"
  );
  return {
    matchClaim: () =>
      withAgent("matcher", async () => {
        mocks.seen.push({ ...getUsageContext() });
        return {
          is_match: true,
          matched_claim_id: CLAIM_ID,
          new_canonical_form: null,
          instance_stance: "affirms",
          confidence: 0.9,
          reasoning: "same proposition",
          alternative_matches: [],
          relationship_notes: null,
        };
      }),
  };
});

vi.mock("../../../src/llm/agents/extension-agent.js", async () => {
  const { withAgent, getUsageContext } = await import(
    "../../../src/llm/usage-context.js"
  );
  return {
    EXTENSION_VERDICTS: ["egregious", "contested", "oversimplified", "noteworthy", "fine"],
    assessPageClaims: () =>
      withAgent("extension", async () => {
        mocks.seen.push({ ...getUsageContext() });
        return [{ index: 0, verdict: "fine", why: "", confidence: 0.9 }];
      }),
    extensionChat: () =>
      withAgent("extension", async () => {
        mocks.seen.push({ ...getUsageContext() });
        return { reply: "The graph holds this claim as contested." };
      }),
  };
});

vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: async (id: string) =>
    id === CLAIM_ID ? { id, text: "Lockdowns did more harm than good." } : null,
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: async () => ({
    status: "contested",
    confidence: 0.8,
    reasoningTrace: "Credible parties on both sides.",
  }),
}));

import {
  chatAboutPage,
  resetAnalysisCache,
  startAnalysis,
} from "../../../src/services/extension-service.js";
import { extractClaims } from "../../../src/llm/agents/extractor.js";
import { matchClaim } from "../../../src/llm/agents/matcher.js";
import { extensionChat } from "../../../src/llm/agents/extension-agent.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";
import { traceLevel } from "../../../src/services/trace-service.js";

const PAGE = {
  url: "https://mail.example.com/inbox/thread/42",
  title: "Re: lockdowns",
  content: "Dear Jane, the lockdowns did more harm than good. Yours, Bob.",
};

// The route's attribution context: the calling user and key.
const asUser = <T>(fn: () => Promise<T>) =>
  runWithUsageContext({ userId: "user-1", apiKeyId: "key-1", requestId: "r-1" }, fn);

beforeEach(() => {
  resetAnalysisCache();
  mocks.insertValues.mockClear();
  mocks.updateWhere.mockClear();
  mocks.seen.length = 0;
});

describe("extension transience (#356)", () => {
  it("is exercised with tracing on, as production runs", () => {
    expect(traceLevel()).toBe("full");
  });

  it("page analysis writes nothing: no runs, no steps, no rows of any kind", async () => {
    const result = await asUser(() => startAnalysis(PAGE, { graceMs: 2000 }));
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.analysis.annotations[0]?.claim?.id).toBe(CLAIM_ID);

    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateWhere).not.toHaveBeenCalled();

    // Extractor, matcher, and extension agent all ran, all untraced, and all
    // still attributed to the calling account for metering.
    expect(mocks.seen.map((c) => c.agent)).toEqual(["extractor", "matcher", "extension"]);
    for (const ctx of mocks.seen) {
      expect(ctx.untraced).toBe(true);
      expect(ctx.trace).toBeUndefined();
      expect(ctx.runId).toBeNull();
      expect(ctx.userId).toBe("user-1");
      expect(ctx.apiKeyId).toBe("key-1");
    }
  });

  it("chat writes nothing either", async () => {
    const { reply } = await asUser(() =>
      chatAboutPage({
        messages: [{ role: "user", content: "is this true? my doctor says otherwise" }],
        page: { url: PAGE.url, title: PAGE.title, claims: [] },
      })
    );
    expect(reply).toContain("contested");
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateWhere).not.toHaveBeenCalled();
    expect(mocks.seen).toHaveLength(1);
    expect(mocks.seen[0]).toMatchObject({ agent: "extension", untraced: true });
  });

  it("negative control: the same agents outside the extension path do open runs", async () => {
    // The extractor and matcher trace on the ingestion path, where the source
    // is public by construction — so the mocks above would have written a row
    // had the extension seam let them.
    await asUser(async () => {
      await extractClaims({ content: PAGE.content });
      await matchClaim({ extractedText: "x", proposedCanonical: "x" });
    });
    const agents = mocks.insertValues.mock.calls.map(
      (c) => (c[0] as unknown as { agent: string }).agent
    );
    expect(agents).toEqual(["extractor", "matcher"]);

    // The extension agent is untraced by name, whoever calls it.
    mocks.insertValues.mockClear();
    await asUser(() =>
      extensionChat({ messages: [], pageUrl: null, pageTitle: null, pageClaims: [] })
    );
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });
});
