/**
 * The note a run is given when this deployment has features switched off
 * (src/llm/features-off-note.ts): its wording, built from the feature list,
 * and where it goes in a conversation. That the LLM client adds it to agent
 * runs and to nothing else is in client-features-off.test.ts.
 */
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { FEATURES, FEATURE_NAMES, offFeatures } from "../../../src/features.js";
import {
  FEATURES_OFF_NOTE_SEPARATOR,
  featuresOffNote,
  withFeaturesOffNote,
} from "../../../src/llm/features-off-note.js";

type MessageParam = Anthropic.MessageParam;

const phrase = (name: string) => FEATURES.find((f) => f.name === name)!.agentPhrase;

const MATHEMATICS_OFF =
  "Some parts of Minerval are switched off in this deployment: formal " +
  "statements in Lean, the Lean checker and the solver's proof attempts; " +
  "prizes and bounties for machine-checked proofs. Their tools are not " +
  "offered to you, and what your instructions and skills say about them " +
  "does not apply here. The rest of your instructions hold as written.";

describe("the features that are off", () => {
  it("is empty with everything on, and with a config that carries no list", () => {
    expect(offFeatures({ featuresOff: [] })).toEqual([]);
    expect(offFeatures({})).toEqual([]);
  });

  it("names each feature switched off, in the list's order", () => {
    expect(offFeatures({ featuresOff: ["extension"] })).toEqual(["extension"]);
    expect(offFeatures({ featuresOff: ["prizes"] })).toEqual(["prizes"]);
    expect(offFeatures({ featuresOff: ["prizes", "extension"] })).toEqual(["extension", "prizes"]);
  });

  it("includes prizes when mathematics is off", () => {
    expect(offFeatures({ featuresOff: ["mathematics"] })).toEqual(["mathematics", "prizes"]);
  });
});

describe("every feature's phrase for agents", () => {
  it("is a short phrase that fits inside a sentence", () => {
    for (const feature of FEATURES) {
      expect(feature.agentPhrase.length, feature.name).toBeGreaterThan(10);
      expect(feature.agentPhrase.length, feature.name).toBeLessThan(100);
      // Joined with semicolons and closed with a full stop by the note.
      expect(feature.agentPhrase, feature.name).not.toMatch(/[.;:\n]/);
      expect(feature.agentPhrase, feature.name).toBe(feature.agentPhrase.trim());
      // What an agent reads about, not what an operator switches: no route
      // paths and no tool names.
      expect(feature.agentPhrase, feature.name).not.toMatch(/[/_]/);
    }
  });
});

describe("featuresOffNote", () => {
  it("is empty when every feature is on", () => {
    expect(featuresOffNote({ featuresOff: [] })).toBe("");
    expect(featuresOffNote({})).toBe("");
  });

  it("names each feature that is off by its phrase, and no other", () => {
    for (const name of FEATURE_NAMES) {
      const config = { featuresOff: [name] };
      const note = featuresOffNote(config);
      const off = offFeatures(config);
      for (const feature of FEATURES) {
        if (off.includes(feature.name)) expect(note, name).toContain(feature.agentPhrase);
        else expect(note, name).not.toContain(feature.agentPhrase);
      }
    }
  });

  it("with the extension off, names the extension alone", () => {
    expect(featuresOffNote({ featuresOff: ["extension"] })).toBe(
      "Some parts of Minerval are switched off in this deployment: the " +
        "browser extension and its page analysis. Their tools are not " +
        "offered to you, and what your instructions and skills say about them " +
        "does not apply here. The rest of your instructions hold as written."
    );
  });

  it("with prizes off, names prizes alone", () => {
    const note = featuresOffNote({ featuresOff: ["prizes"] });
    expect(note).toContain(`in this deployment: ${phrase("prizes")}. Their tools`);
  });

  it("with mathematics off, names mathematics and prizes, which follow it", () => {
    expect(featuresOffNote({ featuresOff: ["mathematics"] })).toBe(MATHEMATICS_OFF);
    // Naming prizes as well changes nothing.
    expect(featuresOffNote({ featuresOff: ["mathematics", "prizes"] })).toBe(MATHEMATICS_OFF);
  });

  it("with everything off, names all three in the list's order", () => {
    const note = featuresOffNote({ featuresOff: ["extension", "mathematics", "prizes"] });
    expect(note).toContain(
      `in this deployment: ${phrase("extension")}; ${phrase("mathematics")}; ${phrase("prizes")}. Their tools`
    );
  });

  it("is plain prose: one paragraph, no dashes, no markup", () => {
    const note = featuresOffNote({ featuresOff: ["extension", "mathematics"] });
    expect(note).not.toMatch(/\n/);
    expect(note).not.toMatch(/[—–*#`]/);
    expect(note.endsWith("The rest of your instructions hold as written.")).toBe(true);
  });
});

describe("withFeaturesOffNote", () => {
  const off = { featuresOff: ["mathematics"] };

  it("returns the same messages, untouched, when every feature is on", () => {
    const messages: MessageParam[] = [{ role: "user", content: "Assess the claim." }];
    const out = withFeaturesOffNote(messages, { featuresOff: [] });
    expect(out).toBe(messages);
    expect(out).toEqual([{ role: "user", content: "Assess the claim." }]);
  });

  it("heads a string message with the note, a rule, then the message as given", () => {
    const messages: MessageParam[] = [{ role: "user", content: "Assess the claim." }];
    const out = withFeaturesOffNote(messages, off);
    expect(out).toEqual([
      { role: "user", content: `${MATHEMATICS_OFF}${FEATURES_OFF_NOTE_SEPARATOR}Assess the claim.` },
    ]);
    // The caller's array and message are not edited.
    expect(messages).toEqual([{ role: "user", content: "Assess the claim." }]);
  });

  it("puts one text block in front of a message of content blocks", () => {
    const blocks = [
      { type: "text" as const, text: "Read this." },
      { type: "text" as const, text: "Then record it." },
    ];
    const out = withFeaturesOffNote([{ role: "user", content: blocks }], off);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: MATHEMATICS_OFF }, ...blocks] },
    ]);
  });

  it("adds it to the first user message only", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const out = withFeaturesOffNote(messages, off);
    expect(out[0]!.content).toBe(`${MATHEMATICS_OFF}${FEATURES_OFF_NOTE_SEPARATOR}first`);
    expect(out.slice(1)).toEqual(messages.slice(1));
  });

  it("leaves a conversation that already carries it alone", () => {
    const once = withFeaturesOffNote([{ role: "user", content: "first" }], off);
    expect(withFeaturesOffNote(once, off)).toBe(once);
    const blocks = withFeaturesOffNote(
      [{ role: "user", content: [{ type: "text", text: "first" }] }],
      off
    );
    expect(withFeaturesOffNote(blocks, off)).toBe(blocks);
  });

  it("has nothing to add to when there is no user message", () => {
    const empty: MessageParam[] = [];
    expect(withFeaturesOffNote(empty, off)).toBe(empty);
  });
});
