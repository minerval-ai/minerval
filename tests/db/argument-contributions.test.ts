/**
 * Contributions about a node's arguments (#541), against real SQL.
 *
 *  - checkArgumentTarget is the one gate every door uses: an argument_id
 *    goes with add_instance, propose_split and propose_merge only, the
 *    argument must be on the contribution's node, a merged alias is refused
 *    by naming its survivor, and a merge names two arguments on the same
 *    side.
 *  - The contribution keeps both ids, and an accepted one's handoff tells
 *    the Steward what the argument is and whose job the change is.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedUser } from "./helpers.js";
import { addArgument } from "../../src/services/argument-service.js";
import { checkArgumentTarget, createContribution, formatContribution } from "../../src/services/contribution-service.js";
import { mergeArguments } from "../../src/services/reconciliation-service.js";
import { buildHandoff } from "../../src/llm/tools/notify-claim-steward.js";

let claim: string;
let other: string;
let a: string;
let b: string;
let against: string;
let elsewhere: string;
let contributor: string;

beforeAll(async () => {
  claim = await seedClaim("arg-contrib");
  other = await seedClaim("arg-contrib-other");
  a = (await addArgument({ claimId: claim, stance: "for", name: "A", content: "A." })).id;
  b = (await addArgument({ claimId: claim, stance: "for", name: "B", content: "B." })).id;
  against = (await addArgument({ claimId: claim, stance: "against", name: "N", content: "N." })).id;
  elsewhere = (await addArgument({ claimId: other, stance: "for", name: "E", content: "E." })).id;
  contributor = await seedUser("arg-contrib");
});

const check = (over: Partial<Parameters<typeof checkArgumentTarget>[0]>) =>
  checkArgumentTarget({ type: "add_instance", claimId: claim, ...over });

describe("checkArgumentTarget", () => {
  it("passes a contribution that names no argument", async () => {
    expect(await check({ type: "challenge" })).toEqual({ ok: true, argumentId: null, mergeTargetArgumentId: null });
  });

  it("accepts an instance, a split, and a merge of two arguments on the node", async () => {
    expect(await check({ argumentId: a })).toEqual({ ok: true, argumentId: a, mergeTargetArgumentId: null });
    expect((await check({ type: "propose_split", argumentId: a })).ok).toBe(true);
    expect(await check({ type: "propose_merge", argumentId: a, mergeTargetArgumentId: b })).toEqual({
      ok: true,
      argumentId: a,
      mergeTargetArgumentId: b,
    });
  });

  it("refuses the wrong type, node, side, or shape", async () => {
    const message = async (over: Parameters<typeof check>[0]) => {
      const out = await check(over);
      return out.ok ? "ok" : out.message;
    };
    expect(await message({ type: "challenge", argumentId: a })).toMatch(/argument_id goes with/);
    expect(await message({ argumentId: elsewhere })).toMatch(/is on node/);
    expect(await message({ argumentId: randomUUID() })).toMatch(/No argument/);
    expect(await message({ type: "propose_merge", argumentId: a })).toMatch(/name both/);
    expect(await message({ type: "propose_merge", argumentId: a, mergeTargetArgumentId: a })).toMatch(/name both/);
    expect(await message({ type: "propose_merge", argumentId: a, mergeTargetArgumentId: against })).toMatch(/opposite sides/);
    expect(
      await message({ type: "propose_merge", argumentId: a, mergeTargetArgumentId: b, mergeTargetClaimId: other })
    ).toMatch(/not both/);
    expect(await message({ mergeTargetArgumentId: b })).toMatch(/needs argument_id/);
    expect(await message({ argumentId: a, mergeTargetArgumentId: b })).toMatch(/goes with propose_merge/);
  });

  it("refuses a merged alias by naming its survivor", async () => {
    const s = (await addArgument({ claimId: claim, stance: "for", name: "S", content: "S." })).id;
    const gone = (await addArgument({ claimId: claim, stance: "for", name: "G", content: "G." })).id;
    await mergeArguments({ survivorId: s, absorbedId: gone, writtenFormFrom: "survivor", reasoning: "One inference." });
    const out = await check({ argumentId: gone });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toContain(s);
  });
});

describe("a contribution about an argument", () => {
  it("keeps the argument ids and shows them", async () => {
    const c = await createContribution({
      claimId: claim,
      contributorId: contributor,
      contributionType: "propose_merge",
      content: "A and B are the same inference.",
      argumentId: a,
      mergeTargetArgumentId: b,
    });
    expect(formatContribution(c)).toMatchObject({ argument_id: a, merge_target_argument_id: b });
  });

  it("tells the Steward what the handoff is about and whose job the change is", async () => {
    const instance = await createContribution({
      claimId: claim,
      contributorId: contributor,
      contributionType: "add_instance",
      content: "This paper makes argument A.",
      argumentId: a,
    });
    const merge = await createContribution({
      claimId: claim,
      contributorId: contributor,
      contributionType: "propose_merge",
      content: "A and B are the same inference.",
      argumentId: a,
      mergeTargetArgumentId: b,
    });
    for (const c of [instance, merge]) {
      await rawQuery(`UPDATE contributions SET review_status = 'accepted' WHERE id = $1`, [c.id]);
    }
    const first = await buildHandoff({ contributionId: instance.id }, "contribution_reviewer");
    expect("context" in first && first.context).toContain("record_argument_instance");
    expect("context" in first && first.context).toContain(`argument ${a} ("A")`);
    const second = await buildHandoff({ contributionId: merge.id }, "contribution_reviewer");
    expect("context" in second && second.context).toContain("escalate_to_curator");
    expect("context" in second && second.context).toContain(`argument ${b} ("B")`);
  });
});
