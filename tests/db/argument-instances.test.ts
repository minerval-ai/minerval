/**
 * Argument instances and the argument view (#541), against real SQL.
 *
 *  - record_argument_instance writes a passage on the argument, deduplicates
 *    on (argument, source, speaker), and corrects an instance in place.
 *  - A retired argument takes instances, and retiring keeps them.
 *  - get_argument returns the base view without any instance count, and
 *    its sections: evaluation (current and history), premises (grouped
 *    edges, or the written form's references once retired), and instances.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { addArgument, retireArgument, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { getArgumentView } from "../../src/services/argument-view-service.js";

const steward = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await executeStewardTool(name, input));

let claimId: string;
let premiseId: string;
let argumentId: string;

beforeAll(async () => {
  claimId = await seedClaim("conclusion");
  premiseId = await seedClaim("premise");
  const [edge] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, confidence, reasoning)
     VALUES ($1, $2, 'supports', 1, 'The premise bears on the conclusion.') RETURNING id`,
    [claimId, premiseId]
  );
  const argument = await addArgument({
    claimId,
    stance: "for",
    name: "the argument from the premise",
    content: `Because [[claim:${premiseId}]], the conclusion follows.`,
    createdBy: "claim_steward",
  });
  argumentId = argument.id;
  await rawQuery(`INSERT INTO argument_subclaims (argument_id, relationship_id) VALUES ($1, $2)`, [
    argumentId,
    edge!.id,
  ]);
});

describe("record_argument_instance", () => {
  it("records, deduplicates, and corrects", async () => {
    const url = `https://dbtest.example/${randomUUID()}`;
    const first = await steward("record_argument_instance", {
      argument_id: argumentId,
      url,
      verbatim_text: "Given the premise, the conclusion follows.",
      stance: "advances",
      reading: "full",
      speaker: "A. Author",
    });
    expect(first.success).toBe(true);

    const again = await steward("record_argument_instance", {
      argument_id: argumentId,
      url,
      verbatim_text: "Given the premise, the conclusion follows.",
      stance: "advances",
      speaker: "a. author",
    });
    expect(again.deduplicated).toBe(true);
    expect(again.instance_id).toBe(first.instance_id);

    const corrected = await steward("record_argument_instance", {
      argument_id: argumentId,
      instance_id: first.instance_id,
      reading: "premise_unstated",
    });
    expect(corrected.success).toBe(true);
    const [row] = await rawQuery<{ reading: string; stance: string; created_by: string }>(
      `SELECT reading, stance, created_by FROM argument_instances WHERE id = $1`,
      [first.instance_id]
    );
    expect(row).toEqual({ reading: "premise_unstated", stance: "advances", created_by: "claim_steward" });
  });
});

describe("get_argument", () => {
  it("serves the base view with no instance count", async () => {
    const view = (await getArgumentView(argumentId)) as { argument: Record<string, unknown> };
    expect(view.argument).toMatchObject({
      id: argumentId,
      stance: "for",
      name: "the argument from the premise",
      retired: null,
      conclusion: { id: claimId },
    });
    expect(JSON.stringify(view)).not.toContain("instance");
  });

  it("adds the evaluation with its history", async () => {
    await setArgumentEvaluation({ argumentId, verdict: "slight", content: "First look." });
    await setArgumentEvaluation({ argumentId, verdict: "likely", content: "On reflection." });
    const view = (await getArgumentView(argumentId, { include: ["evaluation"] })) as {
      evaluation: { verdict: string; stale: boolean };
      evaluation_history: { verdict: string }[];
    };
    expect(view.evaluation.verdict).toBe("likely");
    // No current assessment on the claim, so the evaluation is not dated
    // against one.
    expect(view.evaluation.stale).toBe(true);
    expect(view.evaluation_history.map((e) => e.verdict)).toEqual(["slight"]);
  });

  it("adds premises and instances", async () => {
    const view = (await getArgumentView(argumentId, { include: ["premises", "instances"] })) as {
      premises: { id: string; grouped: boolean; relation: string | null }[];
      instances: { stance: string; reading: string; speaker: string }[];
      instances_total: number;
    };
    expect(view.premises).toEqual([expect.objectContaining({ id: premiseId, grouped: true, relation: "supports" })]);
    expect(view.instances_total).toBe(1);
    expect(view.instances[0]).toMatchObject({ stance: "advances", reading: "premise_unstated", speaker: "A. Author" });
  });

  it("keeps a retired argument's record, takes new instances on it, and reads its premises from the written form", async () => {
    await retireArgument({ argumentId, reason: "Answered by later evidence." });
    const recorded = await steward("record_argument_instance", {
      argument_id: argumentId,
      url: `https://dbtest.example/${randomUUID()}`,
      verbatim_text: "Some still say the premise settles it.",
      stance: "mentions",
    });
    expect(recorded.success).toBe(true);
    expect(recorded.message).toContain("does not bring it back");

    const view = (await getArgumentView(argumentId, { include: ["premises", "instances"] })) as {
      argument: { retired: { reason: string } | null };
      premises: { id: string; grouped: boolean }[];
      instances_total: number;
    };
    expect(view.argument.retired?.reason).toBe("Answered by later evidence.");
    expect(view.premises).toEqual([expect.objectContaining({ id: premiseId, grouped: false })]);
    expect(view.instances_total).toBe(2);
  });

  it("returns null for an unknown argument", async () => {
    expect(await getArgumentView(randomUUID())).toBeNull();
  });
});
