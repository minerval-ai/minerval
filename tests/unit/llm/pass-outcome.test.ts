import { describe, it, expect } from "vitest";

/**
 * What a Steward pass concluded (#1027), from the task's own definition of
 * concluding: a recorded judgment, a logged decision that the one in force
 * stands, leaving another label's standing, a pause, or none of these. Each
 * task shape, each way a pass can end without a conclusion, and the clause
 * its payer reads.
 */
import {
  classifyPass,
  outcomeClause,
  refundsPayer,
  standsLog,
  type DoneCall,
  type PassDone,
} from "../../../src/llm/agents/pass-outcome.js";
import { defaultTask } from "../../../src/llm/agents/claim-steward.js";

const call = (input: Record<string, unknown> = {}, output = "{}"): DoneCall => ({ input, output });
const done = (entries: Record<string, DoneCall[]>): PassDone => new Map(Object.entries(entries));
const before = { id: "prior-1", status: "supported", at: "2026-11-12T10:00:00.000Z" };

/** The default revisit: a node with a current assessment at the run's own label. */
const revisit = defaultTask("note", "claim", false);
const firstPass = defaultTask("note", "claim", true);
const readsAnothers = defaultTask("note", "claim", false, true);

function classify(
  task: { judgmentTools: string[]; owed: (d: PassDone) => boolean },
  d: PassDone,
  over: Partial<Parameters<typeof classifyPass>[0]> = {}
) {
  return classifyPass({
    judgmentTools: task.judgmentTools,
    owed: task.owed,
    done: d,
    thrown: [],
    sessionStatus: "closed",
    stopReason: "end_turn",
    budget: { spentMicroUsd: 200_000, ceilingMicroUsd: 560_000 },
    before,
    ...over,
  });
}

describe("standsLog", () => {
  it("takes judgment_stands when given, and no_action_needed only where it is not", () => {
    expect(standsLog(done({ log_stewardship_decision: [call({ action_taken: "x", judgment_stands: true })] }))).not.toBeNull();
    expect(standsLog(done({ log_stewardship_decision: [call({ action_taken: "no_action_needed" })] }))).not.toBeNull();
    expect(
      standsLog(done({ log_stewardship_decision: [call({ action_taken: "no_action_needed", judgment_stands: false })] }))
    ).toBeNull();
    expect(standsLog(done({ log_stewardship_decision: [call({ action_taken: "reassessed" })] }))).toBeNull();
  });
});

describe("classifyPass", () => {
  it("reports a recorded assessment, with the status it moved from", () => {
    const o = classify(revisit, done({ update_claim_assessment: [call({ status: "doubtful" })] }));
    expect(o).toMatchObject({ kind: "recorded", tool: "update_claim_assessment", status_after: "doubtful" });
    expect(outcomeClause(o)).toBe("recorded a new assessment (supported → doubtful).");
  });

  it("reports a logged decision that the assessment stands as a conclusion, whatever it spent", () => {
    const o = classify(
      revisit,
      done({ log_stewardship_decision: [call({ action_taken: "no_action_needed", judgment_stands: true }, '{"audit_log_id":"log-1"}')] }),
      { budget: { spentMicroUsd: 560_000, ceilingMicroUsd: 560_000 } }
    );
    expect(o).toMatchObject({ kind: "stood", audit_log_id: "log-1" });
    expect(outcomeClause(o)).toBe("concluded the assessment stands (logged: no_action_needed).");
  });

  it("does not take a logged change that no tool recorded as a conclusion", () => {
    // "reassessed" logged while update_claim_assessment failed: the old
    // assessment stays in force, and the log's words are shown.
    const o = classify(revisit, done({ log_stewardship_decision: [call({ action_taken: "reassessed", judgment_stands: false })] }));
    expect(o).toMatchObject({ kind: "unconcluded", ended_by: "stopped", logged: "reassessed", platform_side: false });
    expect(outcomeClause(o)).toContain('its log says "reassessed", but nothing was recorded');
    expect(outcomeClause(o)).toContain("The assessment of 2026-11-12 is unchanged by this pass.");
  });

  it("requires an assessment on a first pass, and a logged decision does not stand in for it", () => {
    expect(
      classify(firstPass, done({ log_stewardship_decision: [call({ action_taken: "no_action_needed" })] }), { before: null })
    ).toMatchObject({ kind: "unconcluded" });
  });

  it("takes leaving another label's judgment standing as a conclusion, and not a stands-log alone", () => {
    expect(classify(readsAnothers, done({ leave_judgment_standing: [call()] }))).toMatchObject({ kind: "left_standing" });
    expect(
      classify(readsAnothers, done({ log_stewardship_decision: [call({ action_taken: "no_action_needed", judgment_stands: true })] }))
    ).toMatchObject({ kind: "unconcluded" });
  });

  it("reports a pass that paused on what it asked for as waiting, and a concluded one as also waiting", () => {
    expect(classify(revisit, done({}), { sessionStatus: "waiting" })).toMatchObject({ kind: "waiting" });
    expect(
      classify(revisit, done({ update_claim_assessment: [call({ status: "supported" })] }), { sessionStatus: "ready" })
    ).toMatchObject({ kind: "recorded", also_waiting: true });
  });

  it("says how a pass that concluded nothing ended", () => {
    expect(classify(revisit, done({}), { stopReason: "end_turn" })).toMatchObject({ ended_by: "stopped" });
    expect(classify(revisit, done({}), { stopReason: "tool_use" })).toMatchObject({ ended_by: "turn_guard" });
    expect(classify(revisit, done({}), { stopReason: "max_tokens" })).toMatchObject({ ended_by: "output_limit", platform_side: true });
  });

  it("lists what an unconcluded pass wrote, reads left out, and whether it spent its whole budget", () => {
    const o = classify(
      revisit,
      done({
        get_claim: [call(), call()],
        web_search: [call()],
        add_decomposition_edge: [call(), call(), call()],
      }),
      { stopReason: "tool_use", budget: { spentMicroUsd: 560_000, ceilingMicroUsd: 560_000 } }
    );
    expect(o).toMatchObject({ kind: "unconcluded", spent_all: true, wrote: [{ tool: "add_decomposition_edge", n: 3 }] });
    expect(outcomeClause(o)).toBe(
      "ended without recording a conclusion (it reached the turn guard; budget fully spent; it wrote add_decomposition_edge ×3). " +
        "The assessment of 2026-11-12 is unchanged by this pass."
    );
  });

  it("marks a concluding tool that failed with the platform's own error as platform-side", () => {
    const o = classify(revisit, done({}), { thrown: [{ tool: "update_claim_assessment", error: "connection reset" }] });
    expect(o).toMatchObject({ kind: "unconcluded", platform_side: true, failed: [{ tool: "update_claim_assessment" }] });
    expect(refundsPayer(o)).toBe(true);
    expect(refundsPayer(classify(revisit, done({})))).toBe(false);
    expect(refundsPayer(classify(revisit, done({ update_claim_assessment: [call({ status: "x" })] })))).toBe(false);
  });

  it("reports a formalization that could not proceed as a logged decision, not as an assessment standing", () => {
    const task = { judgmentTools: [] as string[], owed: (d: PassDone) => !(d.get("log_stewardship_decision")?.length) };
    const o = classify(task, done({ log_stewardship_decision: [call({ action_taken: "formalization_unavailable", judgment_stands: false })] }));
    expect(o).toMatchObject({ kind: "logged", logged: "formalization_unavailable" });
    expect(outcomeClause(o)).toBe("concluded with a logged decision (formalization_unavailable).");
  });

  it("says a node with no assessment still has none", () => {
    expect(outcomeClause(classify(firstPass, done({}), { before: null }))).toContain("The node still has no assessment.");
  });
});
