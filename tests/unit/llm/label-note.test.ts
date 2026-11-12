/**
 * The note a run is given about the label it works at, on a graph with more
 * than one label (src/llm/label-note.ts): its wording, and where it goes in
 * a conversation. That the LLM client adds it to agent runs, and adds
 * nothing where `public` is the only label, is in client-label-note.test.ts.
 */
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { FEATURES_OFF_NOTE_SEPARATOR, featuresOffNote, withFeaturesOffNote } from "../../../src/llm/features-off-note.js";
import { LABEL_NOTE_HEADING, MIRROR_NOTE_HEADING, labelNote, mirrorNote, withLabelNote } from "../../../src/llm/label-note.js";

type MessageParam = Anthropic.MessageParam;

const INTERNAL =
  "## This run's label\n\n" +
  "This graph holds material that only some of its readers may see. Everything it holds carries a label " +
  "saying who may read it. This run works at one label, fixed before it started: `internal`.\n\n" +
  "What you can read: what is labeled `internal`, and what is labeled `public`, which `internal` reads. " +
  "The database withholds everything else from the tools you read the graph with. A search or a read " +
  "that comes back empty has looked only at what this label can read.\n\n" +
  "What you write: each new thing this run records (a judgment, an argument, a reading of a source, a " +
  "message, a request) carries the label `internal`, whatever you read to write it. Readers who are not " +
  "cleared for `internal` do not see it. What already carries another label is not this run's to " +
  "change. A tool that would change or remove it refuses and says so, because that label's readers " +
  "would read the change as their own label's work. What `internal` has to say about such a thing is " +
  "recorded as something new, at `internal`.\n\n" +
  "A node can carry a judgment at each label: a version, made by a run at that label from what that " +
  "label reads, and replaced only by a run at that label. Where you can read more than one, the node's " +
  "full read lists them under `versions`, each with its label, and says which are in force for this " +
  "run. A version is in force unless another one you can read was made at a label that reads its label, " +
  "and so with sight of everything it saw and more. Where a read gives a single judgment for a node, it " +
  "is the one in force, and the most recent of them if two labels that do not read each other each have " +
  "one.\n\n" +
  "If the work cannot be done well on what this label can read, say so in what you record, so that " +
  "whoever reads it or pays for the next pass knows what it rests on.";

/** The same run, of a role that records judgments. */
const INTERNAL_STEWARD =
  "## This run's label\n\n" +
  "This graph holds material that only some of its readers may see. Everything it holds carries a label " +
  "saying who may read it. This run works at one label, fixed before it started: `internal`.\n\n" +
  "What you can read: what is labeled `internal`, and what is labeled `public`, which `internal` reads. " +
  "The database withholds everything else from the tools you read the graph with. A search or a read " +
  "that comes back empty has looked only at what this label can read.\n\n" +
  "What you write: each new thing this run records (a judgment, an argument, a reading of a source, a " +
  "message, a request) carries the label `internal`, whatever you read to write it. Readers who are not " +
  "cleared for `internal` do not see it. What already carries another label is not this run's to " +
  "change. A tool that would change or remove it refuses and says so, because that label's readers " +
  "would read the change as their own label's work. What `internal` has to say about such a thing is " +
  "recorded as something new, at `internal`.\n\n" +
  "## A judgment at each label\n\n" +
  "A node in this graph can carry more than one judgment at once, one for each label: a version. Each " +
  "is made by a run at its label, which saw only what that label reads, and each is a full assessment " +
  "held to every standard you work under. This run writes the version at `internal` and no other: the " +
  "tools that record an assessment, an estimate, a question's assessment or an argument's evaluation " +
  "record it at `internal`.\n\n" +
  "The versions you read at `public` are not yours to change, and nothing you record replaces them. " +
  "Each goes on standing for the readers and runs that work from it, and is reassessed on its own " +
  "inputs like any judgment. A node that carries another label is not yours to reword or restructure " +
  "either: its wording, its importance and the structure recorded at its label belong to the Steward " +
  "that works at that label. What you add to it (an argument, a subclaim, a source) is recorded at " +
  "`internal`, beside what is there.\n\n" +
  "On a node that carries another label, a version at `internal` is stored only when material at " +
  "`internal` bears on the node: a source labeled `internal` attached to it, a node labeled `internal` " +
  "under it, or a node under it that carries a version at `internal`. The tool that records the version " +
  "refuses when there is none. The reason is that a version at `internal` should differ from the one it " +
  "reads only where material at `internal` makes the difference, so that a reader can trace the " +
  "difference to something named. Whether a source really bears on the node is your judgment, and the " +
  "tool checks only that one is attached. Where nothing at `internal` bears, there is nothing at " +
  "`internal` to judge: record no version, say so with log_stewardship_decision, and the version you " +
  "read stands for readers at `internal`. A node that itself carries the label `internal` needs no such " +
  "material: its judgment is simply its judgment.\n\n" +
  "Where you read a version at another label, start from it. Read its reasoning as you would a " +
  "colleague's, then ask what the material at `internal` changes. Your version owes that one coherence, " +
  "not deference (\u00a721): where the two differ, the material at `internal` accounts for the difference, " +
  "and your reasoning says how. A disagreement about evidence the other version could see is a case " +
  "against that version, not a version of your own. Record it as a request (file_request), which stays " +
  "at `internal`. A version that agrees with the one you read is still worth recording when material at " +
  "`internal` changes the confidence, the credence, or what the verdict rests on.\n\n" +
  "Your version records the versions it was made beside: the current version at each label that " +
  "`internal` reads, as they stood. When one of them is replaced, readers at `internal` are shown that " +
  "yours was made against an earlier version, and a reassessment is opened at `internal`, which runs " +
  "when it is funded. Whether the change matters is your judgment when it does.\n\n" +
  "get_claim lists a node's versions under `versions`, each with its label, and says which are in force " +
  "for this run: a version is in force unless another one you can read was made at a label that reads " +
  "its label. Where a read gives a single judgment for a node, it is the one in force, and the most " +
  "recent of them if two labels that do not read each other each have one.\n\n" +
  "If the work cannot be done well on what this label can read, say so in what you record, so that " +
  "whoever reads it or pays for the next pass knows what it rests on.";

describe("labelNote", () => {
  it("says the label, what it reads, what the run's writes carry, and how to read a node's versions", () => {
    expect(labelNote("internal", ["internal", "public"])).toBe(INTERNAL);
  });

  it("tells a run that records judgments how a judgment at each label works for the one it writes", () => {
    const note = labelNote("internal", ["internal", "public"], { writesJudgments: true });
    expect(note).toBe(INTERNAL_STEWARD);
    // What the tool refuses, with the reason and what to do instead.
    expect(note).toContain("The tool that records the version refuses when there is none. The reason is that");
    expect(note).toContain("record no version, say so with log_stewardship_decision");
    // The paragraph that said a node holds one judgment in force is gone from both.
    for (const text of [INTERNAL, INTERNAL_STEWARD]) {
      expect(text).not.toContain("A node holds one judgment in force");
      expect(text).not.toContain("is not built yet");
      // No label is above another: one reads the other, or does not.
      expect(text).not.toMatch(/at or below|higher|lower|above|beneath/);
    }
  });

  it("says less to a run that records judgments at a label that reads no other", () => {
    const note = labelNote("public", ["public"], { writesJudgments: true });
    expect(note).toContain(
      "`public` reads no other label, so on every node this run reads, the version at `public` is the only one it sees."
    );
    expect(note).not.toContain("is stored only when material");
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
    for (const note of [INTERNAL, INTERNAL_STEWARD, labelNote("public", ["public"]), labelNote("c", ["a", "c", "public"])]) {
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

describe("on a deployment that mirrors the public graph", () => {
  const mirror = { publicGraphAsOf: "2026-11-12T17:08:45.113Z" };

  it("says nothing of the mirror where none is held, word for word", () => {
    for (const writesJudgments of [true, false]) {
      const plain = labelNote("internal", ["internal", "public"], { writesJudgments });
      expect(labelNote("internal", ["internal", "public"], { writesJudgments, mirror: null })).toBe(plain);
      expect(plain).not.toMatch(/mirror/i);
    }
  });

  it("tells a Steward at a private label what is mirrored and as of when, why it is not changed, whose the public version is, and where a request goes", () => {
    const note = labelNote("internal", ["internal", "public"], { writesJudgments: true, mirror });
    const plain = labelNote("internal", ["internal", "public"], { writesJudgments: true });
    const added = [
      " Part of what is labeled `public` is the public graph itself, read through a mirror: a copy of its nodes, with their arguments, sources and assessments, that follows it. It shows the public graph as of 2026-11-12 17:08 UTC, when the newest batch applied here was cut, not as of now. A node's full read says under `mirrored` that it is one of these.",
      " A mirrored row is not changed by any run in this deployment, at any label: the next batch from the public graph would overwrite the change, and until then readers would take it for the public graph's own. A tool that would change one refuses and says so.",
      " On a mirrored node the version at `public` is the public graph's own assessment, which arrives with the mirror, and the Steward at that label is the public graph's: no run in this deployment records a version there.",
      " A request about a mirrored node stays in this deployment like any other. Raising it on the public graph would show what this deployment is working on, so that is for the people who direct the deployment to decide, and no tool of yours sends anything there.",
    ];
    // Each is a sentence or two inside a passage that was already there, and
    // taking them out gives back the note as it was: nothing else moved.
    let without = note;
    for (const sentence of added) {
      expect(note.split(sentence).length - 1, sentence).toBe(1);
      without = without.replace(sentence, "");
    }
    expect(without).toBe(plain);
  });

  it("tells a run that records no judgments the same, in the passage it already has", () => {
    const note = labelNote("internal", ["internal", "public"], { mirror });
    expect(note).toContain("It shows the public graph as of 2026-11-12 17:08 UTC");
    expect(note).toContain("A mirrored row is not changed by any run in this deployment, at any label");
    expect(note).toContain(
      "On a mirrored node the version at `public` is the public graph's own assessment. No pass on a mirrored node " +
        "at `public` is opened, paid for or run in this deployment: its assessment there is the public graph's own, " +
        "and a second one made here would be this deployment's, shown to readers as the public graph's. A fresh " +
        "public assessment is funded on the public graph. If you judge that the public graph has a mirrored node " +
        "wrong, in its wording, its structure or its assessment, that is a request (file_request, where your role " +
        "has it; otherwise say so in what you report). A request about a mirrored node stays in this deployment " +
        "like any other."
    );
    expect(note).not.toContain("## A judgment at each label");
  });

  it("tells a Steward at public that no pass on a mirrored node is opened here", () => {
    const note = labelNote("public", ["public"], { writesJudgments: true, mirror });
    expect(note).toContain(
      "On a mirrored node the version at `public` is the public graph's own assessment, which arrives with the " +
        "mirror, and no run in this deployment records one. No pass on a mirrored node at `public` is opened, paid " +
        "for or run in this deployment: its assessment there is the public graph's own, and a second one made here " +
        "would be this deployment's, shown to readers as the public graph's. A fresh public assessment is funded on " +
        "the public graph. If you judge that the public graph has a mirrored node wrong, that is a request " +
        "(file_request)."
    );
  });

  it("gives a deployment with one label the passage on its own, since it has no label note", () => {
    expect(mirrorNote(mirror, { writesJudgments: true })).toBe(
      "## The public graph, mirrored\n\n" +
        "Part of this graph is the public graph itself, read through a mirror: a copy of its nodes, with their " +
        "arguments, sources and assessments, that follows it. It shows the public graph as of 2026-11-12 17:08 UTC, " +
        "when the newest batch applied here was cut, not as of now. A node's full read says under `mirrored` that " +
        "it is one of these.\n\n" +
        "A mirrored row is not changed by any run in this deployment, at any label: the next batch from the public " +
        "graph would overwrite the change, and until then readers would take it for the public graph's own. A tool " +
        "that would change one refuses and says so. What this run adds to a mirrored node (an argument, a subclaim, " +
        "a source) is a row of this deployment's own, beside what is there. No pass on a mirrored node at `public` " +
        "is opened, paid for or run in this deployment: its assessment there is the public graph's own, and a " +
        "second one made here would be this deployment's, shown to readers as the public graph's. A fresh public " +
        "assessment is funded on the public graph. No run here records an assessment of a mirrored node " +
        "either.\n\n" +
        "If you judge that the public graph has a mirrored node wrong, in its wording, its structure or its " +
        "assessment, that is a request (file_request, where your role has it; otherwise say so in what you report). " +
        "A request about a mirrored node stays in this deployment like any other. Raising it on the public graph " +
        "would show what this deployment is working on, so that is for the people who direct the deployment to " +
        "decide, and no tool of yours sends anything there."
    );
    expect(mirrorNote(mirror)).not.toContain("No run here records an assessment");
  });

  it("is said once: a note that states a newer time is not added to a first message that already carries one", () => {
    const first = labelNote("internal", ["internal", "public"], { mirror });
    const later = labelNote("internal", ["internal", "public"], { mirror: { publicGraphAsOf: "2026-11-12T18:30:00.000Z" } });
    expect(later).not.toBe(first);
    const briefed = withLabelNote([{ role: "user", content: "go" }], first, LABEL_NOTE_HEADING);
    expect(withLabelNote(briefed, later, LABEL_NOTE_HEADING)).toBe(briefed);
    const alone = withLabelNote([{ role: "user", content: [{ type: "text", text: "go" }] }], mirrorNote(mirror), MIRROR_NOTE_HEADING);
    expect(withLabelNote(alone, mirrorNote({ publicGraphAsOf: "2026-11-12T18:30:00.000Z" }), MIRROR_NOTE_HEADING)).toBe(alone);
  });

  it("is plain prose in the house style", () => {
    for (const note of [labelNote("internal", ["internal", "public"], { writesJudgments: true, mirror }), mirrorNote(mirror, { writesJudgments: true })]) {
      // No em-dashes, and American spelling for what an agent reads.
      expect(note).not.toMatch(/[\u2014\u2013]/);
      expect(note).not.toMatch(/labelled/);
    }
  });
});
