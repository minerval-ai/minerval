/**
 * MIRA export (#515) against real Postgres: a question with its answers, an
 * answer relation, its standing, and a request on it, assembled through the
 * same reads the route uses and held to the pinned profile schema
 * (docs/mira/minerval-mira-0.1.schema.json).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { seedClaim } from "./helpers.js";
import {
  addAnswer,
  markQuestion,
  recordQuestionAssessment,
  setAnswerRelation,
} from "../../src/services/question-service.js";
import { fileRequest } from "../../src/services/request-service.js";
import { citationUrl } from "../../src/services/citation-service.js";
import { assembleClaimMira } from "../../src/services/mira-service.js";

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => new Array(1536).fill(0.01)),
}));

const ajv = new Ajv({ allErrors: true, strict: true });
(addFormatsModule as unknown as (a: Ajv) => Ajv)(ajv);
const validate = ajv.compile(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../docs/mira/minerval-mira-0.1.schema.json", import.meta.url)),
      "utf8"
    )
  )
);

describe("assembleClaimMira", () => {
  it("returns null for an unknown node", async () => {
    expect(await assembleClaimMira("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("exports a question with its answers, standing, and requests, and an answer linked back", async () => {
    const q = await seedClaim("question");
    await markQuestion(q);
    const a1 = await seedClaim("answer one");
    const a2 = await seedClaim("answer two");
    await addAnswer({ questionId: q, answerId: a1, basis: "quality", reasoning: "r", createdBy: "dbtest" });
    await addAnswer({ questionId: q, answerId: a2, basis: "prominence", reasoning: "r", createdBy: "dbtest" });
    await setAnswerRelation({ questionId: q, answerA: a1, answerB: a2, relation: "excludes", createdBy: "dbtest" });
    await recordQuestionAssessment({
      claimId: q,
      standing: "leaning",
      favoredClaimIds: [a1],
      reasoningTrace: `Leaning toward [[claim:${a1}]].`,
    });
    await fileRequest({
      ask: "A survey of the competing answers.",
      why: "The standing turns on which answer the literature favors.",
      satisfiedBy: "A review covering both.",
      claimIds: [q],
      filer: { kind: "admin", agent: "question_steward" },
    });

    const bundle = await assembleClaimMira(q);
    expect(validate(bundle)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const root = bundle!.records[0]!;
    expect(root).toMatchObject({ type: "question", id: citationUrl(q) });
    expect(root.extensions!.mv).toMatchObject({ standing: "leaning", favored_answers: [citationUrl(a1)] });
    expect(JSON.stringify(bundle)).not.toContain("[[claim:");
    const answer = bundle!.records.find((r) => r.id === citationUrl(a1));
    expect(answer).toMatchObject({ type: "claim" });
    expect((answer as { links: unknown[] }).links).toContainEqual({ rel: "excludes", target: citationUrl(a2) });
    expect(bundle!.records.find((r) => r.type === "request")).toMatchObject({
      state: "open",
      attribution: [{ name: "Question Steward", kind: "agent", role: "filer" }, { role: "publisher" }],
    });

    const fromAnswer = await assembleClaimMira(a1);
    expect(validate(fromAnswer)).toBe(true);
    expect(fromAnswer!.records[0]).toMatchObject({ type: "claim" });
    expect((fromAnswer!.records[0] as { links: unknown[] }).links).toContainEqual({
      rel: "answers",
      target: citationUrl(q),
    });
  });
});
