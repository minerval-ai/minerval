import { describe, it, expect } from "vitest";

// One status for a version of a page under a release (web/lib/pipeline.ts),
// from the stage on the side it was written at, the state on the side it is
// shown to, or both.
import { pipelineOf, NOT_YET_ASSESSED } from "../../../web/lib/pipeline";

const marks = (p: ReturnType<typeof pipelineOf>) => p.steps.map((s) => s.mark).join(" ");

describe("pipelineOf", () => {
  it("draws four steps, empty and plain before anything is assessed", () => {
    expect(NOT_YET_ASSESSED.steps.map((s) => s.label)).toEqual(["Redact", "Audit", "Consent", "Released"]);
    expect(marks(NOT_YET_ASSESSED)).toBe("todo todo todo todo");
    expect(NOT_YET_ASSESSED.pill).toEqual({ text: "Not yet assessed", tone: "neu" });
    expect(NOT_YET_ASSESSED.needs).toBeNull();
    expect(marks(pipelineOf({}))).toBe("todo todo todo todo");
  });

  it("follows the stage on the page's side", () => {
    expect(marks(pipelineOf({ stage: "to_redact", stageInWords: "waiting for the Redactor's run" }))).toBe("now todo todo todo");
    expect(pipelineOf({ stage: "to_redact" }).pill.text).toBe("Redacting");
    expect(pipelineOf({ stage: "to_redact", returnedByAudit: true }).pill.text).toBe("Redacting again");
    const check = pipelineOf({ stage: "to_check" });
    expect(marks(check)).toBe("done now todo todo");
    expect(check.pill).toEqual({ text: "Audit check", tone: "info" });
    const gate = pipelineOf({ stage: "at_gate", waitingOn: [{ party: "Acme" }, { party: "Acme" }, { party: "Northwind" }] });
    expect(marks(gate)).toBe("done done now todo");
    expect(gate.pill.text).toBe("At the gate · 2 parties");
    expect(gate.needs).toBe("review");
    expect(pipelineOf({ stage: "at_gate", waitingOn: [{ party: "Acme" }] }).pill.text).toBe("At the gate · Acme");
  });

  it("puts waiting for funds on the step the money is for, as a warning", () => {
    const redact = pipelineOf({ stage: "to_redact", stageInWords: "waiting for funds: none of the budgets that pay for its redaction could pay for it" });
    expect(marks(redact)).toBe("warn todo todo todo");
    expect(redact.pill).toEqual({ text: "Waiting for funds", tone: "warn" });
    expect(redact.needs).toBe("pay");
    expect(redact.key).toBe("funds");
    const audit = pipelineOf({ stage: "to_check", stageInWords: "waiting for funds: none of the budgets that pay for the check of its redaction could pay for it" });
    expect(marks(audit)).toBe("done warn todo todo");
  });

  it("reads the same from the other side's words alone", () => {
    const audit = pipelineOf({
      state: "held",
      heldBecause: "waiting for funds: none of the budgets that pay for the check of its redaction could pay for it",
    });
    expect(marks(audit)).toBe("done warn todo todo");
    expect(audit.needs).toBe("pay");
    expect(marks(pipelineOf({ state: "held", heldBecause: "waiting on Acme Corp and Northwind" }))).toBe("done done now todo");
    expect(pipelineOf({ state: "held", heldBecause: "delayed until 2026-12-01T00:00:00.000Z" }).pill.text).toBe("Delayed");
  });

  it("draws an overtaken version dashed and a page that cannot cross as stopped", () => {
    const over = pipelineOf({ stage: "overtaken" });
    expect(over.dashed).toBe(true);
    expect(marks(over)).toBe("todo todo todo todo");
    expect(over.pill).toEqual({ text: "Overtaken", tone: "neu" });
    expect(pipelineOf({ state: "held", heldBecause: "a later version was recorded before this one was redacted, so this one was not" }).dashed).toBe(true);
    const cannot = pipelineOf({ stage: "cannot_cross" });
    expect(marks(cannot)).toBe("bad todo todo todo");
    expect(cannot.pill.tone).toBe("bad");
    expect(cannot.needs).toBe("policy");
  });

  it("puts a hold on Consent, with its reason", () => {
    const held = pipelineOf({ stage: "at_gate", state: "held", heldBecause: "held by a person who directs the graph (still being reviewed)" });
    expect(marks(held)).toBe("done done warn todo");
    expect(held.pill).toEqual({ text: "Held: still being reviewed", tone: "warn" });
    expect(held.needs).toBeNull();
    const redactor = pipelineOf({ state: "held", heldBecause: "held by the Redactor (a legal or contractual reason)" });
    expect(marks(redactor)).toBe("done done warn todo");
    expect(redactor.needs).toBe("review");
    // A hold with nothing else said: the destination's half only.
    expect(marks(pipelineOf({ state: "held" }))).toBe("todo todo warn todo");
  });

  it("ends at Released, whole or in part, whatever stage the other side last recorded", () => {
    const whole = pipelineOf({ stage: "at_gate", state: "released_whole", ofParts: 9 });
    expect(marks(whole)).toBe("done done done done");
    expect(whole.pill).toEqual({ text: "Released whole", tone: "ok" });
    expect(whole.needs).toBeNull();
    const part = pipelineOf({ state: "released_in_part", partsHeld: 2, ofParts: 9 });
    expect(marks(part)).toBe("done done done part");
    expect(part.pill.text).toBe("Released in part (2 of 9 held)");
  });

  it("says each step in its title", () => {
    expect(pipelineOf({ stage: "to_check" }).title).toBe("Redact done · Audit now · Consent to come · Released to come");
  });
});
