/**
 * Trying the Redactor (src/services/redactor-trial-service.ts): the page a
 * trial holds in memory, driven through the Redactor's own tools without a
 * model, and what the people trying it are shown.
 */
import { describe, expect, it } from "vitest";
import { partsOfSample, trialPage, trialTaskMessage } from "../../../src/services/redactor-trial-service.js";
import { DEFAULT_CATEGORIES, renderPolicy } from "../../../src/services/redaction-policy.js";
import { getRedactorToolDefinitions } from "../../../src/llm/tools/redactor-tools.js";

const sample = "The reserve holds 8,812,400 in escrow.\n\nCounsel thinks the claimant is a public figure.\r\n\r\n\n  That closes the matter.  ";

function page() {
  const looked: Array<string | undefined> = [];
  const p = trialPage({
    parts: partsOfSample(sample),
    categories: DEFAULT_CATEGORIES,
    referWhen: ["Whether a person named is a public figure"],
    policyText: renderPolicy(DEFAULT_CATEGORIES, 3, ["Whether a person named is a public figure"]),
    basedOnVersion: 2,
    draft: true,
    boundary: { from: "finance", to: null },
    destination: async (text) => {
      looked.push(text);
      return { destination: "outside this deployment: the public graph" };
    },
  });
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await p.execute(name, input)) as Record<string, any>;
  return { p, call, looked };
}

describe("a sample", () => {
  it("is split into parts at blank lines, trimmed", () => {
    expect(partsOfSample(sample)).toEqual(["The reserve holds 8,812,400 in escrow.", "Counsel thinks the claimant is a public figure.", "That closes the matter."]);
  });
});

describe("a trial's page", () => {
  it("offers the Redactor its own tools, refer_to_person among them, and tells it this is a trial", async () => {
    expect(getRedactorToolDefinitions().map((t) => t.name)).toContain("refer_to_person");
    const { call } = page();
    const told = await call("get_page_to_redact");
    expect(told.gate).toMatch(/^This is a trial/);
    expect(told.parts.map((x: any) => x.part)).toEqual([1, 2, 3]);
    const policy = await call("get_redaction_policy");
    expect(policy.version).toBe("a draft of the next version after 2");
    expect(policy.refer_when).toEqual(["Whether a person named is a public figure"]);
    expect(policy.policy).toContain("## When the Redactor asks a person");
    expect(trialTaskMessage()).toMatch(/Nothing you do here is released/);
  });

  it("acts as the Redactor's tools act, and refuses what they refuse, writing nothing anywhere", async () => {
    const { p, call, looked } = page();
    expect(await call("look_at_destination", { text: "8,812,400" })).toMatchObject({ success: true });
    expect(looked).toEqual(["8,812,400"]);
    expect(await call("redact", { part: 1, passage: "8,812,400", category: "anything awkward", note: "x" })).toMatchObject({ success: false, code: "NO_SUCH_CATEGORY" });
    expect(await call("redact", { part: 1, passage: "8,812,400", category: "commercial figures" })).toMatchObject({ success: false, code: "NOTE_NEEDED" });
    expect(await call("redact", { part: 9, passage: "x", category: "commercial figures", note: "x" })).toMatchObject({ success: false, code: "NO_SUCH_PART" });
    expect(await call("redact", { part: 1, passage: "not there", category: "commercial figures", note: "x" })).toMatchObject({ success: false, code: "PASSAGE_NOT_FOUND" });
    const removed = await call("redact", { part: 1, passage: "8,812,400", category: "commercial figures", note: "An account balance." });
    expect(removed).toMatchObject({ success: true, part_now_reads: "The reserve holds [redacted: commercial figures] in escrow." });
    expect(await call("redact", { part: 1, passage: "812", category: "commercial figures", note: "x" })).toMatchObject({ success: false, code: "OVERLAPS" });
    expect(await call("refer_to_person", { part: 2, recommends: "let_through" })).toMatchObject({ success: false, code: "NOTE_NEEDED" });
    expect(await call("refer_to_person", { part: 2, recommends: "remove", note: "x" })).toMatchObject({ success: false, code: "BAD_RECOMMENDATION" });
    expect(await call("refer_to_person", { part: 2, recommends: "let_through", note: "The policy's guideline on public figures applies." })).toMatchObject({ success: true });
    expect(await call("hold_part", { part: 3, reason: "timing", note: "Not before the filing." })).toMatchObject({ success: true });
    expect(await call("finish_redaction", { least_sure: [{ removal_id: removed.removal_id, why: "The figure may be in the annual report." }] })).toMatchObject({ success: true });
    expect(await call("redact", { part: 3, passage: "matter", category: "commercial figures", note: "x" })).toMatchObject({ success: false, code: "FINISHED" });

    const outcome = p.outcome();
    expect(outcome.finished).toBe(true);
    expect(outcome.parts[0]).toMatchObject({
      as_it_would_be_released: "The reserve holds [redacted: commercial figures] in escrow.",
      removals: [{ passage: "8,812,400", category: "commercial figures", note: "An account balance." }],
    });
    expect(outcome.parts[1]!.referred).toMatchObject({ recommends: "let_through", note: "The policy's guideline on public figures applies." });
    expect(outcome.parts[2]!.held).toMatchObject({ reason: "not to be released yet", note: "Not before the filing." });
    expect(outcome.least_sure).toEqual([{ part: 1, passage: "8,812,400", why: "The figure may be in the annual report." }]);
    expect(outcome.whole_item).toEqual({});
  });

  it("takes a removal back with restore, and lifts its own hold", async () => {
    const { p, call } = page();
    const removed = await call("redact", { part: 1, passage: "in escrow", category: "commercial figures", note: "Where it is held." });
    expect(await call("restore", { removal_id: removed.removal_id })).toMatchObject({ success: true, part_now_reads: "The reserve holds 8,812,400 in escrow." });
    expect(await call("hold_part", { reason: "legal", note: "Whole item." })).toMatchObject({ success: true });
    expect(p.outcome().whole_item.held).toMatchObject({ reason: "a legal or contractual reason" });
    expect(await call("lift_hold", {})).toMatchObject({ success: true, recorded: true });
    expect(p.outcome().whole_item).toEqual({});
    expect(p.outcome().finished).toBe(false);
  });
});
