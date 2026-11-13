import { describe, it, expect, vi, beforeEach } from "vitest";

// A reader (src/services/separate-reader.ts) is commissioned as any research
// is, with `commission` (kind research) and `questions`. What is held here:
// the questions are taken only from a Steward whose run works under the
// rule, they reach the run that is opened, and what is delivered back is
// the answers and nothing in the reader's own words. A follow-up names the
// run it continues at the head of its task, where the engine reads it.

const mocks = vi.hoisted(() => ({
  commissionResearch: vi.fn(async (_input: Record<string, unknown>) => ({ ok: true as const, runId: "run-1", actionId: "action-1", waits: true })),
  ctx: { agent: "steward", claimId: "11111111-1111-4111-8111-111111111111", session: null } as Record<string, unknown>,
}));

vi.mock("../../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), getDb: vi.fn() }));
vi.mock("../../../../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/config.js")>();
  return { ...original, loadConfig: () => ({ ...original.loadConfig(), researcherEnabled: true, sessionWaitHours: 24 }) };
});
vi.mock("../../../../src/llm/usage-context.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/llm/usage-context.js")>();
  return { ...original, getUsageContext: () => mocks.ctx };
});
vi.mock("../../../../src/llm/run-funding.js", () => ({
  runPayer: () => ({ kind: "run", actionId: "action-0" }),
  runBudgetLeft: () => null,
  debitRunBudget: vi.fn(),
}));
vi.mock("../../../../src/services/research-commission-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/services/research-commission-service.js")>();
  return { ...original, commissionResearch: mocks.commissionResearch };
});

import { executeSpendTool } from "../../../../src/llm/tools/spend-tools.js";
import { READER_RETURN_NOTE } from "../../../../src/llm/tools/research-tools.js";
import { followedRunOf, renderReaderAnswers } from "../../../../src/services/research-commission-service.js";
import { withSourceTextRule, type SourceTextRule } from "../../../../src/services/separate-reader.js";
import { answersInOrder, type ReaderAnswer, type ReaderQuestion } from "../../../../src/services/reader-answers.js";

const rule: SourceTextRule = { pageLabel: "restricted", withheldLabels: ["restricted"], reader: false };
const BRIEF = "Read the monitoring report for the October evaluation and say what it shows about flagged transcripts.";
const QUESTIONS = [
  { ask: "How many of the 500 transcripts did the monitor flag?", form: "number", unit: "transcripts" },
  { ask: "Quote where the report states its threshold.", form: "passage" },
];
const stored: ReaderQuestion[] = [
  { id: "q1", ask: QUESTIONS[0]!.ask, form: "number", unit: "transcripts" },
  { id: "q2", ask: QUESTIONS[1]!.ask, form: "passage" },
];
const commission = (input: Record<string, unknown>) =>
  executeSpendTool("commission", { kind: "research", budget_owls: 1, brief: BRIEF, ...input }).then((out) => JSON.parse(out!));

beforeEach(() => {
  mocks.commissionResearch.mockClear();
  mocks.ctx = { agent: "steward", claimId: "11111111-1111-4111-8111-111111111111", session: null };
});

describe("a reader, commissioned", () => {
  it("is commissioned with its questions by a Steward whose run works under the rule", async () => {
    const result = await withSourceTextRule(rule, () => commission({ questions: QUESTIONS }));
    expect(result.success).toBe(true);
    expect(result.message).toContain("as a reader: what returns is its answers, one for each question, and its report stays with its run");
    expect(mocks.commissionResearch.mock.calls[0]![0].questions).toEqual(stored);
  });

  it("is not commissioned where the run works under no rule, by a run that is itself a reader, or by another role", async () => {
    const none = await commission({ questions: QUESTIONS });
    expect(none.success).toBe(false);
    expect(none.message).toMatch(/questions launch a reader, which a Steward does where its node's page is under a standing showing/);
    const reader = await withSourceTextRule({ ...rule, reader: true }, () => commission({ questions: QUESTIONS }));
    expect(reader.success).toBe(false);
    mocks.ctx = { ...mocks.ctx, agent: "curator" };
    const curator = await withSourceTextRule(rule, () => commission({ questions: QUESTIONS }));
    expect(curator.success).toBe(false);
    expect(mocks.commissionResearch).not.toHaveBeenCalled();
  });

  it("is refused with questions that have no form, or as an examination of a document", async () => {
    const bad = await withSourceTextRule(rule, () => commission({ questions: [{ ask: "Tell me everything.", form: "text" }] }));
    expect(bad.message).toMatch(/has form "text"\. The forms are yes_no, number, date, choice, passage\./);
    const examined = await withSourceTextRule(rule, () =>
      commission({ questions: QUESTIONS, examine_source_id: "22222222-2222-4222-8222-222222222222" })
    );
    expect(examined.message).toMatch(/A reader answers questions and records nothing on a document/);
    expect(mocks.commissionResearch).not.toHaveBeenCalled();
  });

  it("commissions ordinary research with no questions, as before", async () => {
    const result = await withSourceTextRule(rule, () => commission({}));
    expect(result.success).toBe(true);
    expect(mocks.commissionResearch.mock.calls[0]![0].questions).toBeNull();
    expect(result.message).not.toContain("reader");
  });
});

describe("what is delivered from a reader", () => {
  const run = { id: "run-1", status: "completed", spent_micro_usd: 400_000, ceiling_micro_usd: 1_000_000 };

  it("is its answers, each beside its question, and nothing in its own words", () => {
    const answers: ReaderAnswer[] = [
      { question: "q1", answer: { form: "number", value: 0 }, source: "analysis:1b2c" },
      { question: "q2", answer: { form: "passage", value: "Threshold: 0.8.", cut_from: "the source's stored text", at_char: 61 }, source: "analysis:1b2c" },
    ];
    const text = renderReaderAnswers(run, stored, answers, READER_RETURN_NOTE);
    expect(text.startsWith("Research run run-1, a reader, ended completed, having spent 0.4 of its 1 owls.")).toBe(true);
    const body = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(body.answers).toEqual([
      { question: "q1", asked: QUESTIONS[0]!.ask, form: "number", unit: "transcripts", answer: 0, source: "analysis:1b2c" },
      { question: "q2", asked: QUESTIONS[1]!.ask, form: "passage", passage: "Threshold: 0.8.", cut_from: "the source's stored text", at_char: 61, source: "analysis:1b2c" },
    ]);
    expect(text.endsWith(READER_RETURN_NOTE)).toBe(true);
    // The function is handed no report, notebook or error, so none can be in what it returns.
    expect(renderReaderAnswers.length).toBe(4);
  });

  it("is the fixed reason for each question where the run ended before answering", () => {
    const text = renderReaderAnswers({ ...run, status: "budget" }, stored, answersInOrder(stored, new Map()), READER_RETURN_NOTE);
    expect(text.match(/The reader's run ended before it answered this question\./g)).toHaveLength(2);
  });
});

describe("a follow-up", () => {
  it("names the run it continues at the head of its task, and nothing an agent writes later is read as one", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(followedRunOf(`This continues research run ${id}. Its brief was:\n\nx`)).toBe(id);
    expect(followedRunOf(`Look again. This continues research run ${id}.`)).toBeNull();
    expect(followedRunOf("This continues research run not-an-id. Its brief was")).toBeNull();
    expect(followedRunOf(BRIEF)).toBeNull();
  });
});
