/**
 * What a run is told about the label it works at, on a graph that holds
 * material only some of its readers may see (src/labels.ts,
 * src/db/clearance.ts).
 *
 * Where a deployment has more than one label, the database holds every
 * run to a clearance: it reads the rows at its own label and at the labels
 * that label reads, and nothing else comes back from any tool. That is a
 * limit the run works under, and a run is told its limits up front, with
 * the reason. The role prompts cannot say it, because they are the same
 * text in every deployment, so it is one passage in the run's first task
 * message, added by the LLM client beside the note of what is switched off
 * (client.ts, withRunBrief; features-off-note.ts).
 *
 * Every sentence states what the database and the write seams do. Nothing
 * here asks the agent to keep a secret: the wall is the database's, and
 * the note is there so that an empty search is read correctly and so that
 * the run knows who will read what it writes.
 *
 * On the public graph, where `public` is the only label, there is no note
 * and nothing a run is sent changes.
 *
 * A deployment that mirrors the public graph (docs/mirror.md) tells its
 * runs that here too, and nowhere else: which of what it reads is the
 * public graph's and as of when, that no run changes it and why, that the
 * judgment of a mirrored node at the node's own label is the public
 * graph's, and that a mirrored node the run thinks is wrong is a request.
 * These are sentences inside the passages below, each beside the sentence
 * it qualifies, so that a run is told once, in one voice, what it may
 * change and what it may not. A deployment that mirrors and has one label
 * has no label note to put them in, and gets them as a short passage of
 * their own (mirrorNote). Where nothing is mirrored none of them is said,
 * and the note is word for word what it was.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { PUBLIC_LABEL } from "../labels.js";
import { FEATURES_OFF_NOTE_SEPARATOR } from "./features-off-note.js";

type MessageParam = Anthropic.MessageParam;

const tick = (label: string) => `\`${label}\``;

function listed(labels: readonly string[], joiner: "and" | "or"): string {
  const names = labels.map(tick);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]!}`;
}

/** The roles whose runs record judgments: a node's assessment, estimate or answer, and its arguments' evaluations. */
export const ROLES_THAT_WRITE_JUDGMENTS: ReadonlySet<string> = new Set(["steward"]);

/** What a run is told of the mirror: when the public graph cut the newest batch applied here. */
export interface MirrorBrief {
  /** ISO time. */
  publicGraphAsOf: string;
}

const asOf = (mirror: MirrorBrief) => `${mirror.publicGraphAsOf.slice(0, 10)} ${mirror.publicGraphAsOf.slice(11, 16)} UTC`;

/** Which of what the run reads is the public graph's, and as of when. */
const mirrorWhatItIs = (mirror: MirrorBrief, where: string) =>
  `Part of ${where} is the public graph itself, copied here by a mirror that follows it. The copy shows ` +
  `the public graph as of ${asOf(mirror)}, not as of now, and a node's full read says so under \`mirrored\`.`;

/** That no run changes a mirrored row, and why. */
const MIRROR_NOT_CHANGED =
  `No run here changes a mirrored row, and a tool that would refuses: the next batch from the public graph ` +
  `would overwrite the change, and until then readers would take it for the public graph's own.`;

/** Whose the judgment of a mirrored node at `public` is, and why none is made here. */
const MIRROR_PUBLIC_JUDGMENT =
  `On a mirrored node the judgment at ${tick(PUBLIC_LABEL)} is the public graph's own. None is made or paid ` +
  `for in this deployment, because readers would take it for the public graph's; a fresh one is funded on ` +
  `the public graph.`;

/** What a run does when it thinks the public graph has a mirrored node wrong, and why that goes no further on its own. */
const MIRROR_REQUEST =
  `If you judge that the public graph has a mirrored node wrong, in its wording, its structure or its ` +
  `assessment, record a request (file_request, where your role has it; otherwise say so in what you ` +
  `report). The request stays in this deployment: raising it on the public graph would show what this ` +
  `deployment is working on, which is for the people who direct it to decide.`;

/** The same, for a run already told in the sentence before what a request is for. */
const MIRROR_REQUEST_AFTER_REQUEST =
  `That holds for a mirrored node you judge the public graph has wrong, in its wording, its structure or ` +
  `its assessment: the request stays in this deployment, since raising it on the public graph would show ` +
  `what this deployment is working on, which is for the people who direct it to decide.`;

/** The start of the note, by which a first message that already carries one is known. */
export const LABEL_NOTE_HEADING = "## This run's label\n\n";
export const MIRROR_NOTE_HEADING = "## The public graph, mirrored\n\n";

/**
 * The passage for a run on a deployment that mirrors the public graph and
 * has no label but `public`, where there is no label note to carry it.
 */
export function mirrorNote(mirror: MirrorBrief): string {
  return (
    MIRROR_NOTE_HEADING +
    `${mirrorWhatItIs(mirror, "this graph")}\n\n` +
    `${MIRROR_NOT_CHANGED} What this run adds to a mirrored node (an argument, a subclaim, a source) is ` +
    `this deployment's own, beside what is there. ${MIRROR_PUBLIC_JUDGMENT}\n\n` +
    MIRROR_REQUEST
  );
}

/**
 * The passage for a run at `label` that reads `reads` (its own label
 * included, as the database client works it out: currentReadClearance).
 * A run of a role that records judgments (`writesJudgments`) is told how a
 * judgment at each label works for the one it writes; every other run is
 * told enough to read a node that carries more than one. `mirror` is given
 * on a deployment that mirrors the public graph, and adds what a run is
 * told of mirrored nodes. Each thing is said once.
 */
export function labelNote(
  label: string,
  reads: readonly string[],
  opts: { writesJudgments?: boolean; mirror?: MirrorBrief | null } = {}
): string {
  const mirror = opts.mirror ?? null;
  const own = tick(label);
  // The labels it reads besides its own, `public` last.
  const others = [...new Set(reads)]
    .filter((l) => l !== label)
    .sort((a, b) => (a === PUBLIC_LABEL ? 1 : b === PUBLIC_LABEL ? -1 : a < b ? -1 : 1));
  const canRead =
    others.length === 0
      ? `What you can read: what is labeled ${own}, and nothing else.`
      : `What you can read: what is labeled ${own}, and what is labeled ${listed(others, "or")}, which ${own} reads.`;
  const whoReads =
    label === PUBLIC_LABEL
      ? `Every reader of this graph may read it.`
      : `Readers who are not cleared for ${own} do not see it.`;
  // A run that reads no other label never meets a row at one, so it is not
  // told what happens when it tries to change one. The reason given is the
  // one that matters: what a run at this label writes is shaped by what it
  // read here, and that goes to other readers only as a page shown to them.
  const othersRows =
    others.length === 0
      ? ""
      : ` What carries another label is not this run's to change, and a tool that would change or remove ` +
        `it refuses. The reason is that this run has read material at ${own}, and what a run at ${own} ` +
        `writes reaches readers who are not cleared for ${own} only as a page shown to them, with what was ` +
        `removed marked. What ${own} has to say about such a thing is recorded as something new, at ${own}.`;
  const judgments = opts.writesJudgments ? judgmentsForAWriter(label, others, mirror) : judgmentsForAReader(others, mirror);
  const paragraphs = [
    `${LABEL_NOTE_HEADING}` +
      `This graph holds material that only some of its readers may see, and everything in it carries a ` +
      `label saying who may read it. This run works at one label, fixed before it started: ${own}.`,
    `${canRead} No tool returns anything else, so a search or a read that comes back empty has looked ` +
      `only there.${mirror ? ` ${mirrorWhatItIs(mirror, `what is labeled ${tick(PUBLIC_LABEL)}`)}` : ""}`,
    `What you write: everything this run records carries the label ${own}, whatever you read to write ` +
      `it. ${whoReads}${othersRows}${mirror ? ` ${MIRROR_NOT_CHANGED}` : ""}`,
    judgments,
    opts.writesJudgments ? shownBelowNote(label) : "",
    `If the work cannot be done well on what this label can read, say so in what you record, so that ` +
      `whoever reads it or pays for the next pass knows what it rests on.`,
  ];
  return paragraphs.filter(Boolean).join("\n\n");
}

/**
 * What a run that records judgments is told about its page being shown to
 * readers who do not read its label (services/showing-service.ts). One
 * passage, separate from the rest of the note: what the machinery does,
 * why, that the run writes what it concludes either way, and the one thing
 * it may do about it.
 */
export function shownBelowNote(label: string): string {
  const own = tick(label);
  return (
    `## Showing a page to readers who do not read its label\n\n` +
    `A person who directs this graph may ask for a node's page at ${own} to be shown to readers who do ` +
    `not read ${own}, at another label here or outside this deployment, so that what was concluded can ` +
    `be read where the evidence for it cannot. What is shown is the page as you wrote it, less the ` +
    `passages a Redactor removes under that boundary's policy and marks in place, and less the parts ` +
    `that the people who hold the permission to release decide to hold. Nobody rewords it. ` +
    `get_redaction_policies returns the policies for pages written at ${own}. Write what you conclude, ` +
    `whether or not the page is shown. You may arrange the reasoning so that a reader can follow it ` +
    `after removals, for example by saying what a sensitive figure shows in a sentence apart from the ` +
    `figure.`
  );
}

/** How a read tells a run which of several judgments it is given. */
const WHICH_JUDGMENT =
  `lists the judgments you can read under \`versions\`, each with its label, and marks which are in force ` +
  `for this run: one is in force unless another you can read was made at a label that reads its label. A ` +
  `read that gives a single judgment gives the one in force, or the most recent where two labels that do ` +
  `not read each other each have one.`;

/** What a run that records no judgment is told about a node that carries one at more than one label. */
function judgmentsForAReader(others: readonly string[], mirror: MirrorBrief | null): string {
  const ofMirror = mirror ? `${MIRROR_PUBLIC_JUDGMENT} ${MIRROR_REQUEST}` : "";
  // A run that reads one label sees one judgment on any node.
  if (others.length === 0) return ofMirror;
  return (
    `A node can carry a judgment at each label, each made by a run at that label from what that label ` +
    `reads. A node's full read ${WHICH_JUDGMENT}` +
    (ofMirror ? ` ${ofMirror}` : "")
  );
}

/**
 * What a run that records judgments is told. Each sentence states what the
 * tools and the database do, with the reason, or what the constitution
 * already asks (§10, §21). The judgment a run records is its own assessment
 * of everything it reads: it is not asked to agree with the one at another
 * label wherever its own label's material is silent, since that would be
 * deference, and it is asked to say which part of a difference its own
 * label's material makes, so that a reader can see it.
 */
function judgmentsForAWriter(label: string, others: readonly string[], mirror: MirrorBrief | null): string {
  const own = tick(label);
  const opening =
    `## A judgment at each label\n\n` +
    `A node can carry a judgment at each label, each made by a run at that label from what that label ` +
    `reads. This run records the one at ${own}.`;
  if (others.length === 0) {
    return (
      `${opening} ${own} reads no other label, so the judgment at ${own} is the only one this run sees on ` +
      `any node. One made at another label does not replace it.` +
      (mirror && label === PUBLIC_LABEL ? `\n\n${MIRROR_PUBLIC_JUDGMENT} ${MIRROR_REQUEST}` : "")
    );
  }
  const mirrored = mirror !== null && others.includes(PUBLIC_LABEL);
  return [
    opening,
    `Yours does not replace the judgments you read at ${listed(others, "or")}: readers at those labels go ` +
      `on reading them, and each is reassessed on its own inputs. A node that carries another label keeps ` +
      `its wording, its importance and its structure, which belong to the Steward at that label; what you ` +
      `add to it (an argument, a subclaim, a source) is recorded at ${own}.` +
      (mirrored ? ` ${MIRROR_PUBLIC_JUDGMENT}` : ""),
    `On a node that carries another label you record your own judgment at ${own}, or you may leave the ` +
      `judgment you read standing (leave_judgment_standing). Leaving it standing is a complete outcome: ` +
      `readers at ${own} go on reading that judgment, and the node's page shows them that it was examined ` +
      `at ${own}, when, and your reasons.`,
    `Where you read a judgment at another label, read its reasoning as you would a colleague's. Yours is ` +
      `your own assessment of everything you read, and owes the other coherence, not deference (§21). ` +
      `Where the two differ, your reasoning says why: what the material at ${own} changes, and, where you ` +
      `read the evidence you share differently, that you do and how. A judgment that agrees with the one ` +
      `you read is still worth recording when material at ${own} changes the confidence, the credence, or ` +
      `what the verdict rests on. The Steward at the other label does not read what is written at ${own}, ` +
      `so a point against its judgment is recorded as a request (file_request), which the people who ` +
      `direct this graph can act on.` +
      (mirrored ? ` ${MIRROR_REQUEST_AFTER_REQUEST}` : ""),
    `Your judgment records the judgment it was made beside at each label ${own} reads. When one of those ` +
      `is replaced, readers at ${own} are shown that, and a reassessment at ${own} is opened, which runs ` +
      `when it is funded. Whether the change matters is your judgment then. The same is done when a ` +
      `judgment you left standing is replaced.`,
    `get_claim ${WHICH_JUDGMENT}`,
  ].join("\n\n");
}

/**
 * `messages` with the note at the head of the first user message, or
 * `messages` itself when there is no note. A string message stays a string
 * and a message of content blocks gains one text block in front, as with
 * the note of what is switched off, which is added after this one and so
 * stands before it.
 *
 * A first message that already carries the note is left as it is, so a
 * conversation sent again (each turn of a tool loop, a paused session's
 * transcript on resume) carries it once.
 */
export function withLabelNote(messages: MessageParam[], note: string, heading?: string): MessageParam[] {
  if (!note) return messages;
  const at = messages.findIndex((m) => m.role === "user");
  if (at === -1) return messages;
  const first = messages[at]!;
  // A note that states the time the mirror stood at is not the same text
  // from one turn to the next once a batch has been applied in between. A
  // run is told once, as things stood when it started: where `heading` is
  // given, a first message that carries a note under it is left as it is.
  if (heading) {
    const carries =
      typeof first.content === "string"
        ? first.content.includes(heading)
        : first.content.some((block) => block.type === "text" && block.text.startsWith(heading));
    if (carries) return messages;
  }
  let briefed: MessageParam;
  if (typeof first.content === "string") {
    if (first.content.includes(note)) return messages;
    briefed = { role: "user", content: `${note}${FEATURES_OFF_NOTE_SEPARATOR}${first.content}` };
  } else {
    if (first.content.some((block) => block.type === "text" && block.text === note)) return messages;
    briefed = { role: "user", content: [{ type: "text", text: note }, ...first.content] };
  }
  const out = [...messages];
  out[at] = briefed;
  return out;
}
