/**
 * A view stated to the graph directly (constitution §4), against real SQL.
 *
 *  - Filing one stores the statement as a source and a pending contribution
 *    and puts nothing on the node.
 *  - The Reviewer's accept makes it an instance of the node in the speaker's
 *    words, records the declared stake as the source's interest, and puts
 *    the reasons in the Steward's inbox; a view with no reasons sends
 *    nothing. An accepted view earns no owls.
 *  - A later statement by the same account does not replace the earlier one.
 *  - The listing sets each current view beside the judgment in force and
 *    counts where they differ, agree, cannot be compared, and where the node
 *    has not been assessed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { owlBalance, seedClaim, seedUser } from "./helpers.js";
import {
  admitStatedView,
  createStatedView,
  listStatedViews,
  parseStatedView,
  statedViewForContribution,
  statedViewsForClaim,
  type StatedViewInput,
} from "../../src/services/stated-view-service.js";
import { executeReviewerTool } from "../../src/llm/tools/reviewer-tools.js";
import { buildHandoff } from "../../src/llm/tools/notify-claim-steward.js";
import { applyAcceptanceEffects } from "../../src/services/contribution-acceptance.js";
import { getClaimInstances } from "../../src/services/claim-service.js";
import { sourceContentHash } from "../../src/services/source-content.js";
import { answerMessages, openInbox } from "../../src/services/inbox-service.js";
import { runAtLabel } from "../../src/llm/usage-context.js";

function view(kind: "claim" | "quantity" | "question", body: Record<string, unknown>): StatedViewInput {
  const parsed = parseStatedView(kind, body);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.view;
}

async function accept(contributionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await executeReviewerTool("record_review_decision", {
      contribution_id: contributionId,
      decision: "accept",
      reasoning: "A view on this node, in good faith.",
      confidence: 0.9,
      policy_citations: ["§4"],
    })
  );
}

async function assess(claimId: string, status: string, credence: number | null, at = "now()"): Promise<void> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, $2, 0.8, $3, 'db test', true, ${at})`,
    [claimId, status, credence]
  );
}

let speaker: string;
let speakerName: string;

beforeAll(async () => {
  speaker = await seedUser("stated-view speaker");
  [{ display_name: speakerName }] = await rawQuery<{ display_name: string }>(
    `SELECT display_name FROM contributors WHERE id = $1`,
    [speaker]
  ) as [{ display_name: string }];
});

describe("stating a view", () => {
  it("stores the statement as a source and a pending contribution, and puts nothing on the node", async () => {
    const claim = await seedClaim("sv-pending");
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", {
        statement: "We hold that this is false.",
        stance: "denies",
        reasons: "Our own trial found no effect.",
        stake: "We make the competing product.",
      }),
    });

    const [source] = await rawQuery<{
      title: string; raw_content: string; content_hash: string; url: string | null; authors: string[]; published_date: string;
    }>(`SELECT title, raw_content, content_hash, url, authors, published_date FROM sources WHERE id = $1`, [filed.sourceId]);
    // The source is the speaker's words and nothing else, hashed and dated.
    expect(source!.raw_content).toBe("We hold that this is false.\n\nOur own trial found no effect.");
    expect(source!.content_hash).toBe(sourceContentHash(source!.raw_content));
    expect(source!.url).toBeNull();
    expect(source!.authors).toEqual([speakerName]);
    expect(source!.title).toContain(`Statement to the graph by ${speakerName}`);
    expect(source!.published_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const [c] = await rawQuery<{ contribution_type: string; review_status: string; claim_id: string; source_id: string }>(
      `SELECT contribution_type, review_status, claim_id, source_id FROM contributions WHERE id = $1`,
      [filed.contributionId]
    );
    expect(c).toMatchObject({ contribution_type: "state_view", review_status: "pending", claim_id: claim, source_id: filed.sourceId });

    expect(await getClaimInstances(claim)).toEqual([]);
    expect(await statedViewsForClaim(claim)).toEqual([]);
    const [interests] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM source_interests WHERE source_id = $1`,
      [filed.sourceId]
    );
    expect(interests!.n).toBe(0);
    // The record shows the view as filed, with no instance yet.
    expect(await statedViewForContribution(filed.contributionId)).toMatchObject({
      stance: "denies",
      statement: "We hold that this is false.",
      reasons: "Our own trial found no effect.",
      stake: "We make the competing product.",
      instance_id: null,
      challenge: null,
      speaker: { id: speaker, name: speakerName, verified: false },
    });
  });

  it("becomes an instance with its stake and sends its reasons to the Steward when the Reviewer accepts it", async () => {
    const claim = await seedClaim("sv-accept");
    await assess(claim, "supported", 0.8);
    const before = await owlBalance(speaker);
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", {
        statement: "We hold that this is false.",
        stance: "denies",
        probability: 0.1,
        reasons: "Our own trial found no effect.",
        stake: "We make the competing product.",
        evidence_urls: ["https://example.org/trial"],
      }),
    });

    const result = await accept(filed.contributionId);
    expect(result.success).toBe(true);
    expect(String(result.message)).toContain("do not call notify_claim_steward");

    const instances = await getClaimInstances(claim);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      source_id: filed.sourceId,
      verbatim_text: "We hold that this is false.",
      stance: "denies",
      source_interest: { party: speakerName, stake: "We make the competing product.", claim_id: claim },
    });
    const [inst] = await rawQuery<{ stated_probability: number; speaker: string; created_by: string; source_date: string }>(
      `SELECT stated_probability, speaker, created_by, source_date FROM claim_instances WHERE id = $1`,
      [instances[0]!.id]
    );
    expect(inst!.stated_probability).toBeCloseTo(0.1);
    expect(inst).toMatchObject({ speaker: speakerName, created_by: "speaker" });

    // The reasons are in the Steward's inbox, with what it needs to weigh them.
    const inbox = await openInbox(claim);
    expect(inbox.ids).toHaveLength(1);
    expect(inbox.brief).toContain("contribution_accepted");
    expect(inbox.brief).toContain("a view stated to the graph directly (§4)");
    expect(inbox.brief).toContain("Our own trial found no effect.");
    expect(inbox.brief).toContain("We make the competing product.");
    expect(inbox.brief).toContain("nobody has checked who is behind it");
    expect(inbox.brief).toContain("https://example.org/trial");

    // No owls for stating a view, and the Reviewer has no handoff left to make.
    expect(await owlBalance(speaker)).toBe(before);
    const handoff = await buildHandoff({ contributionId: filed.contributionId }, "contribution_reviewer");
    expect(handoff).toHaveProperty("error");

    // Admitting twice changes nothing and sends nothing.
    const again = await admitStatedView(filed.contributionId);
    expect(again).toMatchObject({ alreadyAdmitted: true, reasonsSent: false });
    expect((await getClaimInstances(claim))).toHaveLength(1);
    expect((await openInbox(claim)).ids).toHaveLength(1);

    // Beside the assessment: the probability is read against the credence.
    const [shown] = await statedViewsForClaim(claim);
    expect(shown).toMatchObject({
      current: true,
      stance: "denies",
      probability: expect.closeTo(0.1, 5),
      stake: "We make the competing product.",
      gave_reasons: true,
      challenge: { state: "waiting", outcome: null },
      judgment: { status: "supported" },
      comparison: { relation: "differs", direction: "view_probability_lower", basis: "probability_and_credence" },
      stated: "after_current_assessment",
    });
    expect(shown).not.toHaveProperty("stance_as_stated");

    // The Steward's answer is what became of the challenge.
    await answerMessages(claim, inbox.labels, [
      { message: "m1", outcome: "no_change", note: "The trial was of a different dose; the assessment already weighs it." },
    ]);
    const [answered] = await statedViewsForClaim(claim);
    expect(answered!.challenge).toMatchObject({
      state: "answered",
      outcome: "no_change",
      note: "The trial was of a different dose; the assessment already weighs it.",
    });
    expect((await statedViewForContribution(filed.contributionId))!.challenge).toMatchObject({ state: "answered" });
  });

  it("sends nothing to the Steward when the view gives no reasons, and records no interest when none is declared", async () => {
    const claim = await seedClaim("sv-no-reasons");
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "We treat this as unsettled.", stance: "open", no_stake: true }),
    });
    const result = await accept(filed.contributionId);
    expect(String(result.message)).toContain("It gave no reasons");
    expect((await openInbox(claim)).ids).toHaveLength(0);
    const [inst] = await getClaimInstances(claim);
    // A view that treats the claim as open is recorded as posing it.
    expect(inst).toMatchObject({ stance: "poses", source_interest: null });
    const [shown] = await statedViewsForClaim(claim);
    expect(shown).toMatchObject({
      stance: "open",
      stake: null,
      gave_reasons: false,
      challenge: null,
      judgment: null,
      stated: null,
      comparison: { relation: "not_assessed" },
    });
  });

  it("keeps an earlier statement when the same account states its view again, and shows the newer as current", async () => {
    const claim = await seedClaim("sv-restated");
    const first = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "We hold that this is so.", stance: "affirms", no_stake: true }),
    });
    await accept(first.contributionId);
    await rawQuery(`UPDATE stated_views SET created_at = now() - interval '2 days' WHERE id = $1`, [first.statedViewId]);
    const second = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "On reflection we hold it only for adults.", stance: "qualifies", no_stake: true }),
    });
    await accept(second.contributionId);

    const all = await statedViewsForClaim(claim);
    expect(all.map((v) => [v.statement, v.current])).toEqual([
      ["On reflection we hold it only for adults.", true],
      ["We hold that this is so.", false],
    ]);
    // Both remain instances of the node; neither was edited.
    expect(await getClaimInstances(claim)).toHaveLength(2);
    // The listing counts each speaker once per node, by its current statement.
    const list = await listStatedViews({ claimId: claim, limit: 20, offset: 0 });
    expect(list.stated_views.map((v) => v.id)).toEqual([second.statedViewId]);
  });

  it("is not admitted onto a node that was merged away after it was stated", async () => {
    const claim = await seedClaim("sv-merged");
    const survivor = await seedClaim("sv-merged-survivor");
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "We hold that this is so.", stance: "affirms", no_stake: true }),
    });
    await rawQuery(`UPDATE claims SET state = 'merged', merged_into = $2 WHERE id = $1`, [claim, survivor]);
    const effects = await applyAcceptanceEffects(filed.contributionId, {});
    expect(effects.ok).toBe(false);
    expect((effects as { error: string }).error).toContain("A stance is stated against a node as worded");
    const result = await accept(filed.contributionId);
    expect(result.success).toBe(false);
    const [c] = await rawQuery<{ review_status: string }>(`SELECT review_status FROM contributions WHERE id = $1`, [filed.contributionId]);
    expect(c!.review_status).toBe("pending");
  });

  it("leaves nothing on the node when the Reviewer rejects it", async () => {
    const claim = await seedClaim("sv-rejected");
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "Buy our product.", stance: "affirms", no_stake: true }),
    });
    const result = JSON.parse(
      await executeReviewerTool("record_review_decision", {
        contribution_id: filed.contributionId,
        decision: "reject",
        reasoning: "Promotion, not a view on this claim.",
        confidence: 0.9,
        policy_citations: ["§13"],
      })
    );
    expect(result.success).toBe(true);
    expect(await getClaimInstances(claim)).toEqual([]);
    expect(await statedViewsForClaim(claim)).toEqual([]);
  });
});

describe("the label a stated view carries", () => {
  it("is the label of the request that files it, carried to what admission makes, and shown to no reader", async () => {
    const second = "stated-views-second";
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'A second label, for this test.') ON CONFLICT (name) DO NOTHING`,
      [second]
    );
    const claim = await seedClaim("sv-labelled");
    const filed = await runAtLabel(second, "a stated view filed in a test", () =>
      createStatedView({
        claimId: claim,
        contributorId: speaker,
        speakerDisplayName: speakerName,
        view: view("claim", { statement: "We hold that this is so.", stance: "affirms", stake: "We sell it." }),
      })
    );
    const labelOf = async (table: string, id: string) =>
      (await rawQuery<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM ${table} WHERE id = $1`, [id]))[0]!
        .sensitivity_label;
    expect(await labelOf("stated_views", filed.statedViewId)).toBe(second);
    expect(await labelOf("contributions", filed.contributionId)).toBe(second);
    expect(await labelOf("sources", filed.sourceId)).toBe(second);

    // Admitted from outside any run: the instance and the interest take the
    // stated view's label, not the label of whoever admitted it.
    const admitted = await admitStatedView(filed.contributionId);
    expect(await labelOf("claim_instances", admitted.instanceId)).toBe(second);
    const [interest] = await rawQuery<{ sensitivity_label: string }>(
      `SELECT sensitivity_label FROM source_interests WHERE source_id = $1`,
      [filed.sourceId]
    );
    expect(interest!.sensitivity_label).toBe(second);

    // A statement filed outside any run is public, as every row is on the public graph.
    const plain = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "Still so.", stance: "affirms", no_stake: true }),
    });
    expect(await labelOf("stated_views", plain.statedViewId)).toBe("public");

    // No read serves the column.
    const served = JSON.stringify([
      await statedViewsForClaim(claim),
      await listStatedViews({ claimId: claim, limit: 20, offset: 0 }),
      await statedViewForContribution(filed.contributionId),
    ]);
    expect(served).not.toContain("sensitivity_label");
    expect(served).not.toContain(second);
  });
});

describe("where stated views and assessments differ", () => {
  it("lists one speaker's current views by how each stands to the judgment, and counts them", async () => {
    const org = await seedUser(`sv-org-${randomUUID().slice(0, 8)}`);
    const [{ display_name: orgName }] = (await rawQuery<{ display_name: string }>(
      `SELECT display_name FROM contributors WHERE id = $1`,
      [org]
    )) as [{ display_name: string }];
    const state = async (claimId: string, kind: "claim" | "quantity" | "question", body: Record<string, unknown>) => {
      const filed = await createStatedView({
        claimId,
        contributorId: org,
        speakerDisplayName: orgName,
        view: view(kind, { no_stake: true, ...body }),
      });
      await accept(filed.contributionId);
      return filed;
    };

    // Affirmed, and the assessment is contradicted.
    const against = await seedClaim("sv-list-against");
    await assess(against, "contradicted", null);
    await state(against, "claim", { statement: "This is so.", stance: "affirms" });
    // Denied, and the assessment is doubtful: they agree.
    const agreeing = await seedClaim("sv-list-agrees");
    await assess(agreeing, "doubtful", null);
    await state(agreeing, "claim", { statement: "This is not so.", stance: "denies" });
    // Never assessed.
    const unexamined = await seedClaim("sv-list-unexamined");
    await state(unexamined, "claim", { statement: "This is so.", stance: "affirms" });
    // Qualified: not on the assessment's scale.
    const qualified = await seedClaim("sv-list-qualified");
    await assess(qualified, "supported", 0.7);
    await state(qualified, "claim", { statement: "Only in adults.", stance: "qualifies" });
    // A figure above the estimate's range.
    const quantity = await seedClaim("sv-list-quantity");
    await rawQuery(`UPDATE claims SET kind = 'quantity' WHERE id = $1`, [quantity]);
    await rawQuery(
      `INSERT INTO quantity_estimates (claim_id, estimate, work) VALUES ($1, $2, 'db test')`,
      [quantity, JSON.stringify({ form: "interval", low: 3, high: 8 })]
    );
    await state(quantity, "quantity", { statement: "It is twelve.", stance: "states", figure: { form: "point", central: 12 } });
    // A question the view answers and the assessment leaves open.
    const question = await seedClaim("sv-list-question");
    await rawQuery(`UPDATE claims SET kind = 'question' WHERE id = $1`, [question]);
    await rawQuery(
      `INSERT INTO question_assessments (claim_id, standing, reasoning_trace) VALUES ($1, 'open', 'db test')`,
      [question]
    );
    await state(question, "question", { statement: "Because of the tide.", stance: "answers" });

    const list = await listStatedViews({ speakerId: org, limit: 50, offset: 0 });
    expect(list.total).toBe(6);
    expect(list.summary).toEqual({
      total: 6,
      by_relation: { differs: 3, agrees: 1, not_assessed: 1, not_comparable: 1 },
      by_direction: {
        view_affirms_assessment_against: 1,
        view_definite_assessment_unsettled: 1,
        view_figure_higher: 1,
      },
    });
    const byNode = new Map(list.stated_views.map((v) => [v.node.id, v]));
    expect(byNode.get(against)!.comparison).toMatchObject({ relation: "differs", direction: "view_affirms_assessment_against" });
    expect(byNode.get(agreeing)!.comparison.relation).toBe("agrees");
    expect(byNode.get(unexamined)!).toMatchObject({ judgment: null, comparison: { relation: "not_assessed" } });
    expect(byNode.get(qualified)!.comparison.relation).toBe("not_comparable");
    expect(byNode.get(quantity)!).toMatchObject({
      node: { kind: "quantity" },
      stance: "states",
      figure: { form: "point", central: 12 },
      judgment: { estimate: { form: "interval", low: 3, high: 8 } },
      comparison: { direction: "view_figure_higher" },
    });
    expect(byNode.get(question)!).toMatchObject({
      node: { kind: "question" },
      stance: "answers",
      judgment: { standing: "open" },
      comparison: { direction: "view_definite_assessment_unsettled" },
    });
    // The quantity's figure and the question's answer are instances in their kinds' own stances.
    const [qi] = await rawQuery<{ stance: string; stated_estimate: unknown }>(
      `SELECT stance, stated_estimate FROM claim_instances WHERE claim_id = $1`,
      [quantity]
    );
    expect(qi).toMatchObject({ stance: "states", stated_estimate: { form: "point", central: 12 } });

    // One relation at a time, with the counts still over the whole set.
    const differing = await listStatedViews({ speakerId: org, relation: "differs", limit: 2, offset: 0 });
    expect(differing.total).toBe(3);
    expect(differing.stated_views).toHaveLength(2);
    expect(differing.summary.total).toBe(6);
    expect(differing.stated_views.every((v) => v.comparison.relation === "differs")).toBe(true);
  });

  it("says whether a view was stated before or after the assessment in force", async () => {
    const claim = await seedClaim("sv-before");
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "This is so.", stance: "affirms", no_stake: true }),
    });
    await accept(filed.contributionId);
    await rawQuery(`UPDATE stated_views SET created_at = now() - interval '3 days' WHERE id = $1`, [filed.statedViewId]);
    await assess(claim, "supported", null);
    const [shown] = await statedViewsForClaim(claim);
    expect(shown).toMatchObject({ stated: "before_current_assessment", comparison: { relation: "agrees" } });
  });

  it("follows the instance when the Steward's record of the stance changes, and says what was stated", async () => {
    const claim = await seedClaim("sv-flipped");
    await assess(claim, "supported", null);
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "This is so.", stance: "affirms", no_stake: true }),
    });
    await accept(filed.contributionId);
    // What a merge with the claim's negation does to every instance's stance.
    await rawQuery(`UPDATE claim_instances SET stance = 'denies' WHERE claim_id = $1`, [claim]);
    const [shown] = await statedViewsForClaim(claim);
    expect(shown).toMatchObject({
      stance: "denies",
      stance_as_stated: "affirms",
      comparison: { relation: "differs", direction: "view_denies_assessment_for" },
    });
  });

  it("leaves a detached view out of the listing and marks it on the node", async () => {
    const claim = await seedClaim("sv-detached");
    const filed = await createStatedView({
      claimId: claim,
      contributorId: speaker,
      speakerDisplayName: speakerName,
      view: view("claim", { statement: "This is so.", stance: "affirms", no_stake: true }),
    });
    await accept(filed.contributionId);
    await rawQuery(
      `UPDATE claim_instances SET detached_at = now(), detached_reason = 'About a different proposition.', detached_by = 'claim_steward'
        WHERE claim_id = $1`,
      [claim]
    );
    expect((await listStatedViews({ claimId: claim, limit: 20, offset: 0 })).total).toBe(0);
    const [shown] = await statedViewsForClaim(claim);
    expect(shown!.detached).toEqual({ reason: "About a different proposition." });
  });
});
