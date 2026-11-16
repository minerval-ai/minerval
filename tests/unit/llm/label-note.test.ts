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
  "This graph holds material that only some of its readers may see, and everything in it carries a label saying who may read it. This run works at one label, fixed before it started: `internal`.\n\n" +
  "What you can read: what is labeled `internal`, and what is labeled `public`, which `internal` reads. No tool returns anything else, so a search or a read that comes back empty has looked only there.\n\n" +
  "What you write: everything this run records carries the label `internal`, whatever you read to write it. Readers who are not cleared for `internal` do not see it. What carries another label is not this run's to change, and no tool changes or removes it. The reason is that this run has read material at `internal`, and what a run at `internal` writes reaches readers who are not cleared for `internal` only as a page shown to them, with what was removed marked. What `internal` has to say about such a thing is recorded as something new, at `internal`. A problem report this run files (raise_issue) is kept in this deployment and not filed as an issue for Minerval's maintainers, because a report quotes what its run was working on; it reaches them when the people who may release for the organization send it on, which takes Audit finding it to be about Minerval's machinery and a Redactor's pass over it.\n\n" +
  "A node can carry a judgment at each label, each made by a run at that label from what that label reads. A node's full read lists the judgments you can read under `versions`, each with its label, and marks which are in force for this run: one is in force unless another you can read was made at a label that reads its label. A read that gives a single judgment gives the one in force, or the most recent where two labels that do not read each other each have one.\n\n" +
  "If the work cannot be done well on what this label can read, say so in what you record, so that whoever reads it or pays for the next pass knows what it rests on.";

const INTERNAL_STEWARD =
  "## This run's label\n\n" +
  "This graph holds material that only some of its readers may see, and everything in it carries a label saying who may read it. This run works at one label, fixed before it started: `internal`.\n\n" +
  "What you can read: what is labeled `internal`, and what is labeled `public`, which `internal` reads. No tool returns anything else, so a search or a read that comes back empty has looked only there.\n\n" +
  "What you write: everything this run records carries the label `internal`, whatever you read to write it. Readers who are not cleared for `internal` do not see it. What carries another label is not this run's to change, and no tool changes or removes it. The reason is that this run has read material at `internal`, and what a run at `internal` writes reaches readers who are not cleared for `internal` only as a page shown to them, with what was removed marked. What `internal` has to say about such a thing is recorded as something new, at `internal`. A problem report this run files (raise_issue) is kept in this deployment and not filed as an issue for Minerval's maintainers, because a report quotes what its run was working on; it reaches them when the people who may release for the organization send it on, which takes Audit finding it to be about Minerval's machinery and a Redactor's pass over it.\n\n" +
  "## A judgment at each label\n\n" +
  "A node can carry a judgment at each label, each made by a run at that label from what that label reads. This run records the one at `internal`.\n\n" +
  "Yours does not replace the judgments you read at `public`: readers at those labels go on reading them, and each is reassessed on its own inputs. A node that carries another label keeps its wording, which is its own Steward's. What you add to it (an argument, a subclaim, a source) is recorded at `internal`, and so is what you hold differently for readers at `internal`: on a row at a label below, set_claim_importance records your importance for the node, and remove_subclaim_edge, set_edge_relation and retire_argument set the edge or argument aside, at `internal` only.\n\n" +
  "On a node that carries another label you record your own judgment at `internal`, or you may leave the judgment you read standing (leave_judgment_standing). Leaving it standing is a complete outcome: readers at `internal` go on reading that judgment, and the node's page shows them that it was examined at `internal`, when, and your reasons.\n\n" +
  "Where you read a judgment at another label, read its reasoning as you would a colleague's. Yours is your own assessment of everything you read, and owes the other coherence, not deference (§21). The Steward at the other label does not read what is written at `internal`, so a point against its judgment or its structure is recorded as a request (file_request), which the people who direct this graph can act on.\n\n" +
  "Your judgment records the judgment it was made beside at each label `internal` reads. When one of those is replaced, readers at `internal` are shown that, and a reassessment at `internal` is opened, which runs when it is funded. Whether the change matters is your judgment then. The same is done when a judgment you left standing is replaced.\n\n" +
  "get_claim lists the judgments you can read under `versions`, each with its label, and marks which are in force for this run: one is in force unless another you can read was made at a label that reads its label. A read that gives a single judgment gives the one in force, or the most recent where two labels that do not read each other each have one.\n\n" +
  "## Showing a page to readers who do not read its label\n\n" +
  "A person who directs this graph may ask for a node's page at `internal` to be shown to readers who do not read `internal`, at another label here or outside this deployment, so that what was concluded can be read where the evidence for it cannot. What is shown is the page as you wrote it, less the passages a Redactor removes under that boundary's policy and marks in place, and less the parts that the people who hold the permission to release decide to hold. Nobody rewords it. get_redaction_policies returns the policies for pages written at `internal`. Write what you conclude, whether or not the page is shown. You may arrange the reasoning so that a reader can follow it after removals, for example by saying what a sensitive figure shows in a sentence apart from the figure.\n\n" +
  "If the work cannot be done well on what this label can read, say so in what you record, so that whoever reads it or pays for the next pass knows what it rests on.";

const MIRROR_ALONE =
  "## The public graph, mirrored\n\n" +
  "Part of this graph is the public graph itself, copied here by a mirror that follows it. The copy shows the public graph as of 2026-11-12 17:08 UTC, not as of now, and a node's full read says so under `mirrored`.\n\n" +
  "No run here changes a mirrored row, and a tool that would refuses: the next batch from the public graph would overwrite the change, and until then readers would take it for the public graph's own. What this run adds to a mirrored node (an argument, a subclaim, a source) is this deployment's own, beside what is there. On a mirrored node the judgment at `public` is the public graph's own. None is made or paid for in this deployment, because readers would take it for the public graph's; a fresh one is funded on the public graph.\n\n" +
  "If you judge that the public graph has a mirrored node wrong, in its wording, its structure or its assessment, record a request (file_request, where your role has it; otherwise say so in what you report). The request stays in this deployment: raising it on the public graph would show what this deployment is working on, which is for the people who direct it to decide.";


describe("labelNote", () => {
  it("says the label, what it reads, what the run's writes carry, and how to read a node's versions", () => {
    expect(labelNote("internal", ["internal", "public"])).toBe(INTERNAL);
  });

  it("tells a run that records judgments how a judgment at each label works for the one it writes", () => {
    const note = labelNote("internal", ["internal", "public"], { writesJudgments: true });
    expect(note).toBe(INTERNAL_STEWARD);
    // The two outcomes on a node at another label, and how the second is recorded.
    expect(note).toContain("you record your own judgment at `internal`, or you may leave the judgment you read standing (leave_judgment_standing)");
    expect(note).toContain("Leaving it standing is a complete outcome");
    // Nothing is said to be attached, and nothing makes material at the label a condition of a judgment.
    expect(note).not.toContain("attached");
    expect(note).not.toMatch(/only when|only where/);
    // It is the run's own assessment of everything it reads, and says which part of a difference its label's material makes.
    expect(note).toContain("Yours is your own assessment of everything you read, and owes the other coherence, not deference (§21).");
    expect(note).not.toContain("not a version of your own");
    // The reason it may not change another label's rows is the one that matters: what it read here.
    expect(note).toContain("reaches readers who are not cleared for `internal` only as a page shown to them");
    expect(note).not.toContain("would read the change as their own label's work");
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
    expect(note).toContain("`public` reads no other label, so the judgment at `public` is the only one this run sees on any node.");
    expect(note).not.toContain("only when something at");
    // A run that reads no other label never meets a row at one.
    expect(note).not.toContain("is not this run's to change");
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
    // Where a report stays is said to the runs it is true of: those at another label.
    expect(note).not.toContain("raise_issue");
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
  const WHAT_IT_IS =
    "Part of what is labeled `public` is the public graph itself, copied here by a mirror that follows it. The copy " +
    "shows the public graph as of 2026-11-12 17:08 UTC, not as of now, and a node's full read says so under `mirrored`.";
  const NOT_CHANGED =
    "No run here changes a mirrored row, and a tool that would refuses: the next batch from the public graph would " +
    "overwrite the change, and until then readers would take it for the public graph's own.";
  const PUBLIC_JUDGMENT =
    "On a mirrored node the judgment at `public` is the public graph's own. None is made or paid for in this " +
    "deployment, because readers would take it for the public graph's; a fresh one is funded on the public graph.";
  const REQUEST_STAYS =
    "raising it on the public graph would show what this deployment is working on, which is for the people who " +
    "direct it to decide.";

  it("says nothing of the mirror where none is held, word for word", () => {
    for (const writesJudgments of [true, false]) {
      const plain = labelNote("internal", ["internal", "public"], { writesJudgments });
      expect(labelNote("internal", ["internal", "public"], { writesJudgments, mirror: null })).toBe(plain);
      expect(plain).not.toMatch(/mirror/i);
    }
  });

  it("tells every run what is mirrored and as of when, why it is not changed, whose the public judgment is, and where a request goes, each once", () => {
    const runs = [
      labelNote("internal", ["internal", "public"], { writesJudgments: true, mirror }),
      labelNote("internal", ["internal", "public"], { mirror }),
      labelNote("public", ["public"], { writesJudgments: true, mirror }),
      labelNote("public", ["public"], { mirror }),
    ];
    for (const note of runs) {
      for (const sentence of [WHAT_IT_IS, NOT_CHANGED, PUBLIC_JUDGMENT, REQUEST_STAYS]) {
        expect(note.split(sentence).length - 1, sentence).toBe(1);
      }
    }
    // Taking the mirror's sentences out of a private Steward's note gives back the note without a mirror.
    const plain = labelNote("internal", ["internal", "public"], { writesJudgments: true });
    let without = runs[0]!;
    for (const sentence of [
      ` ${WHAT_IT_IS}`,
      ` ${NOT_CHANGED}`,
      ` ${PUBLIC_JUDGMENT}`,
      " That holds for a mirrored node you judge the public graph has wrong, in its wording, its structure or its " +
        `assessment: the request stays in this deployment, since ${REQUEST_STAYS}`,
    ]) {
      without = without.replace(sentence, "");
    }
    expect(without).toBe(plain);
    expect(runs[1]).not.toContain("## A judgment at each label");
  });

  it("gives a deployment with one label the passage on its own, since it has no label note", () => {
    expect(mirrorNote(mirror)).toBe(MIRROR_ALONE);
    expect(MIRROR_ALONE).toContain(NOT_CHANGED);
    expect(MIRROR_ALONE).toContain(PUBLIC_JUDGMENT);
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
    for (const note of [labelNote("internal", ["internal", "public"], { writesJudgments: true, mirror }), mirrorNote(mirror)]) {
      // No em-dashes, and American spelling for what an agent reads.
      expect(note).not.toMatch(/[—–]/);
      expect(note).not.toMatch(/labelled/);
    }
  });
});
