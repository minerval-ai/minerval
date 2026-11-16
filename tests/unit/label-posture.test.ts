/**
 * A label's own posture (src/label-posture.ts): what LABEL_POSTURE may say,
 * what a label starts from, and what a run at the label is told.
 */
import { describe, expect, it } from "vitest";
import { parseLabelPosture, postureAt, postureNote } from "../../src/label-posture.js";
import { featureOn } from "../../src/features.js";
import { labelNote } from "../../src/llm/label-note.js";
import { askableNote } from "../../src/services/ask-above-service.js";

describe("LABEL_POSTURE", () => {
  it("is empty by default, and every label then works under the deployment's settings", () => {
    expect(parseLabelPosture("")).toEqual({ posture: {}, problems: [] });
    expect(postureAt("room", { privateRunFetches: "given", featuresOff: ["prizes"] })).toEqual({
      fetches: "given", sandbox: true, featuresOff: ["prizes"], own: {},
    });
    expect(postureNote("room", {})).toBe("");
  });

  it("gives a label its own value, starting from the deployment's", () => {
    const { posture, problems } = parseLabelPosture('{"room":{"fetches":"given","sandbox":false,"features_off":["mathematics"]},"open":{"fetches":"any"}}');
    expect(problems).toEqual([]);
    const config = { labelPosture: posture, privateRunFetches: "given" as const, featuresOff: ["prizes"] };
    expect(postureAt("room", config)).toEqual({
      fetches: "given", sandbox: false, featuresOff: ["prizes", "mathematics"], own: { sandbox: false, featuresOff: ["mathematics"] },
    });
    // Looser than the deployment is a label's choice too.
    expect(postureAt("open", config)).toMatchObject({ fetches: "any", own: { fetches: "any" } });
    expect(postureAt("other", config).own).toEqual({});
    expect(postureAt(undefined, config).fetches).toBe("given");
    expect(postureNote("open", config)).toContain("a page may be fetched from any address");
  });

  it("says what is wrong with a value in words an installer can act on", () => {
    expect(parseLabelPosture("{").problems[0]).toContain("LABEL_POSTURE is not valid JSON");
    expect(parseLabelPosture("[]").problems[0]).toContain("must be a JSON object");
    expect(parseLabelPosture('{"room":{"fetches":"some","sandbox":"no","features_off":["nothing"],"model":"x"}}').problems).toEqual([
      'LABEL_POSTURE gives "room" fetches = "some"; it is "any" or "given".',
      'LABEL_POSTURE gives "room" sandbox = "no"; it is true or false.',
      'LABEL_POSTURE gives "room" features_off = ["nothing"]; it is a list of feature names (extension, mathematics, prizes).',
      'LABEL_POSTURE gives "room" a setting named "model"; a label\'s settings are fetches, sandbox and features_off.',
    ]);
  });

  it("leaves a feature asked about with an explicit config, or outside a run, to the deployment's list", () => {
    expect(featureOn("mathematics", { featuresOff: [] })).toBe(true);
    expect(featureOn("mathematics", { featuresOff: ["mathematics"] })).toBe(false);
  });
});

describe("what a run is told", () => {
  it("adds the posture after what it writes and what can be asked last, and nothing where there is neither", () => {
    const plain = labelNote("internal", ["internal", "public"]);
    expect(labelNote("internal", ["internal", "public"], { posture: "", askable: "" })).toBe(plain);
    const asked = askableNote([{ id: "f1", name: "Finance desk", can_be_asked: "Questions its records would settle" }]);
    expect(asked).toBe(
      'Work can be asked of a label above this one, which this run does not read: "Finance desk" (f1): Questions its records would settle. ' +
        "What is asked there is done by an agent that reads what that label reads, is paid for from here, and comes back only through that " +
        "label's gate, where it may be redacted or held."
    );
    const note = labelNote("internal", ["internal", "public"], { posture: "POSTURE", askable: asked });
    expect(note.endsWith(asked)).toBe(true);
    expect(note.indexOf("POSTURE")).toBeGreaterThan(note.indexOf("What you write:"));
    expect(note.replace("\n\nPOSTURE", "").replace(`\n\n${asked}`, "")).toBe(plain);
  });
});
