/**
 * The note a run is given about the label it works at, on a graph with more
 * than one label (src/llm/label-note.ts): its wording, and where it goes in
 * a conversation. That the LLM client adds it to agent runs, and adds
 * nothing where `public` is the only label, is in client-label-note.test.ts.
 */
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { FEATURES_OFF_NOTE_SEPARATOR, featuresOffNote, withFeaturesOffNote } from "../../../src/llm/features-off-note.js";
import { labelNote, withLabelNote } from "../../../src/llm/label-note.js";

type MessageParam = Anthropic.MessageParam;

const INTERNAL =
  "## This run's label\n\n" +
  "This graph holds material that only some of its readers may see. Everything it holds carries a " +
  "label saying who may read it. This run works at one label, fixed before it started: `internal`.\n\n" +
  "What you can read: what is labeled `internal`, and what is labeled `public`, which `internal` reads. " +
  "The database withholds everything else from the tools you read the graph with. A search or a read " +
  "that comes back empty has looked only at what this label can read.\n\n" +
  "What you write: each new thing this run records (a judgment, an argument, a reading of a source, " +
  "a message, a request) carries the label `internal`, whatever you read to write it. Readers who are " +
  "not cleared for `internal` do not see it. A change to something that already carries another label, " +
  "such as the wording of a node, keeps that label, and its readers see the change.\n\n" +
  "A node holds one judgment in force, recorded at one label. This run can replace it only where it " +
  "was recorded at `internal`: where a node's judgment in force carries another label, the tool that " +
  "records yours will refuse. A judgment at one label must not take the place of another label's, and " +
  "a node keeping one for each label is not built yet.\n\n" +
  "If the work cannot be done well on what this label can read, say so in what you record, so that " +
  "whoever reads it or pays for the next pass knows what it rests on.";

describe("labelNote", () => {
  it("says the label, what it reads and what the run's writes carry", () => {
    expect(labelNote("internal", ["internal", "public"])).toBe(INTERNAL);
  });

  it("names every label the run's label reads, public last", () => {
    const note = labelNote("restricted", ["public", "restricted", "partner-a", "internal"]);
    expect(note).toContain(
      "What you can read: what is labeled `restricted`, and what is labeled `internal`, `partner-a` or " +
        "`public`, which `restricted` reads."
    );
    expect(note).toContain("carries the label `restricted`, whatever you read to write it.");
    expect(note).toContain("Readers who are not cleared for `restricted` do not see it.");
  });

  it("says a run at public reads public alone, and that everyone reads what it writes", () => {
    const note = labelNote("public", ["public"]);
    expect(note).toContain("fixed before it started: `public`.");
    expect(note).toContain("What you can read: what is labeled `public`, and nothing else.");
    expect(note).toContain("carries the label `public`, whatever you read to write it. Every reader of this graph may read it.");
    expect(note).not.toContain("not cleared for");
  });

  it("is plain prose in the house style", () => {
    for (const note of [INTERNAL, labelNote("public", ["public"]), labelNote("c", ["a", "c", "public"])]) {
      // No em-dashes, and American spelling for what an agent reads.
      expect(note).not.toMatch(/[—–]/);
      expect(note).not.toMatch(/labelled/);
    }
  });
});

describe("withLabelNote", () => {
  const note = labelNote("internal", ["internal", "public"]);

  it("leaves the messages as they are when there is no note", () => {
    const messages: MessageParam[] = [{ role: "user", content: "go" }];
    expect(withLabelNote(messages, "")).toBe(messages);
  });

  it("heads the first user message, a string staying a string and blocks gaining a block", () => {
    expect(withLabelNote([{ role: "user", content: "go" }], note)).toEqual([
      { role: "user", content: `${note}${FEATURES_OFF_NOTE_SEPARATOR}go` },
    ]);
    const blocks: MessageParam[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    expect(withLabelNote(blocks, note)).toEqual([
      { role: "user", content: [{ type: "text", text: note }, { type: "text", text: "go" }] },
    ]);
    // The messages given are not changed.
    expect(blocks[0]!.content).toHaveLength(1);
  });

  it("is added once, however many times the conversation is sent, alone or behind the note of what is off", () => {
    const off = { featuresOff: ["mathematics"] };
    const brief = (messages: MessageParam[]) => withFeaturesOffNote(withLabelNote(messages, note), off);
    const once = brief([{ role: "user", content: "go" }]);
    expect(once[0]!.content).toBe(
      `${featuresOffNote(off)}${FEATURES_OFF_NOTE_SEPARATOR}${note}${FEATURES_OFF_NOTE_SEPARATOR}go`
    );
    expect(brief(once)).toEqual(once);
    expect(brief(brief(once))).toEqual(once);

    const blocks = brief([{ role: "user", content: [{ type: "text", text: "go" }] }]);
    expect(blocks[0]!.content).toEqual([
      { type: "text", text: featuresOffNote(off) },
      { type: "text", text: note },
      { type: "text", text: "go" },
    ]);
    expect(brief(blocks)).toEqual(blocks);
  });

  it("finds no user message to head and changes nothing", () => {
    const messages: MessageParam[] = [{ role: "assistant", content: "hello" }];
    expect(withLabelNote(messages, note)).toBe(messages);
  });
});
