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
const mirrorWhatItIs = (mirror: MirrorBrief) =>
  `Part of what is labeled ${tick(PUBLIC_LABEL)} is the public graph itself, read through a mirror: a copy ` +
  `of its nodes, with their arguments, sources and assessments, that follows it. It shows the public ` +
  `graph as of ${asOf(mirror)}, when the newest batch applied here was cut, not as of now. A node's full ` +
  `read says under \`mirrored\` that it is one of these.`;

/** That no run changes a mirrored row, and why. */
const MIRROR_NOT_CHANGED =
  `A mirrored row is not changed by any run in this deployment, at any label: the next batch from the ` +
  `public graph would overwrite the change, and until then readers would take it for the public graph's ` +
  `own. A tool that would change one refuses and says so.`;

/** That a mirrored node the run thinks is wrong is a request, and why the request goes no further on its own. */
const MIRROR_REQUEST =
  `A request about a mirrored node stays in this deployment like any other. Raising it on the public ` +
  `graph would show what this deployment is working on, so that is for the people who direct the ` +
  `deployment to decide, and no tool of yours sends anything there.`;

/** The start of the note, by which a first message that already carries one is known. */
export const LABEL_NOTE_HEADING = "## This run's label\n\n";
export const MIRROR_NOTE_HEADING = "## The public graph, mirrored\n\n";

/**
 * The passage for a run on a deployment that mirrors the public graph and
 * has no label but `public`, where there is no label note to carry it.
 */
export function mirrorNote(mirror: MirrorBrief, opts: { writesJudgments?: boolean } = {}): string {
  return (
    MIRROR_NOTE_HEADING +
    `Part of this graph is the public graph itself, read through a mirror: a copy of its nodes, with ` +
    `their arguments, sources and assessments, that follows it. It shows the public graph as of ` +
    `${asOf(mirror)}, when the newest batch applied here was cut, not as of now. A node's full read says ` +
    `under \`mirrored\` that it is one of these.\n\n` +
    `${MIRROR_NOT_CHANGED} What this run adds to a mirrored node (an argument, a subclaim, a source) is a ` +
    `row of this deployment's own, beside what is there.` +
    (opts.writesJudgments
      ? ` The assessment of a mirrored node is the public graph's own and arrives with the mirror: no run ` +
        `here records one, and no pass on a mirrored node is opened here.`
      : "") +
    `\n\n` +
    `If you judge that the public graph has a mirrored node wrong, in its wording, its structure or its ` +
    `assessment, that is a request (file_request, where your role has it; otherwise say so in what you ` +
    `report). ${MIRROR_REQUEST}`
  );
}

/**
 * The passage for a run at `label` that reads `reads` (its own label
 * included, as the database client works it out: currentReadClearance).
 * A run of a role that records judgments (`writesJudgments`) is told how a
 * judgment at each label works for the one it writes; every other run is
 * told enough to read a node that carries more than one. `mirror` is given
 * on a deployment that mirrors the public graph, and adds what a run is
 * told of mirrored nodes.
 */
export function labelNote(
  label: string,
  reads: readonly string[],
  opts: { writesJudgments?: boolean; mirror?: MirrorBrief | null } = {}
): string {
  const mirror = opts.mirror ?? null;
  // The labels it reads besides its own, `public` last.
  const others = [...new Set(reads)]
    .filter((l) => l !== label)
    .sort((a, b) => (a === PUBLIC_LABEL ? 1 : b === PUBLIC_LABEL ? -1 : a < b ? -1 : 1));
  const canRead =
    others.length === 0
      ? `What you can read: what is labeled ${tick(label)}, and nothing else.`
      : `What you can read: what is labeled ${tick(label)}, and what is labeled ${listed(others, "or")}, ` +
        `which ${tick(label)} reads.`;
  const whoReads =
    label === PUBLIC_LABEL
      ? `Every reader of this graph may read it.`
      : `Readers who are not cleared for ${tick(label)} do not see it.`;
  return (
    `## This run's label\n\n` +
    `This graph holds material that only some of its readers may see. Everything it holds carries a ` +
    `label saying who may read it. This run works at one label, fixed before it started: ${tick(label)}.\n\n` +
    `${canRead} The database withholds everything else from the tools you read the graph with. A ` +
    `search or a read that comes back empty has looked only at what this label can read.` +
    `${mirror ? ` ${mirrorWhatItIs(mirror)}` : ""}\n\n` +
    `What you write: each new thing this run records (a judgment, an argument, a reading of a source, ` +
    `a message, a request) carries the label ${tick(label)}, whatever you read to write it. ${whoReads} ` +
    `What already carries another label is not this run's to change. A tool that would change or ` +
    `remove it refuses and says so, because that label's readers would read the change as their own ` +
    `label's work. What ${tick(label)} has to say about such a thing is recorded as something new, at ` +
    `${tick(label)}.${mirror ? ` ${MIRROR_NOT_CHANGED}` : ""}\n\n` +
    `${opts.writesJudgments ? versionsForAWriter(label, others, mirror) : versionsForAReader(mirror)}\n\n` +
    `If the work cannot be done well on what this label can read, say so in what you record, so that ` +
    `whoever reads it or pays for the next pass knows what it rests on.`
  );
}

/** What any run is told about a node that carries a judgment at more than one label. */
function versionsForAReader(mirror: MirrorBrief | null = null): string {
  return (
    `A node can carry a judgment at each label: a version, made by a run at that label from what that ` +
    `label reads, and replaced only by a run at that label. Where you can read more than one, the ` +
    `node's full read lists them under \`versions\`, each with its label, and says which are in force ` +
    `for this run. A version is in force unless another one you can read was made at a label that ` +
    `reads its label, and so with sight of everything it saw and more. Where a read gives a single ` +
    `judgment for a node, it is the one in force, and the most recent of them if two labels that do ` +
    `not read each other each have one.` +
    (mirror
      ? ` On a mirrored node the version at ${tick(PUBLIC_LABEL)} is the public graph's own assessment. ` +
        `If you judge that the public graph has a mirrored node wrong, in its wording, its structure or ` +
        `its assessment, that is a request (file_request, where your role has it; otherwise say so in ` +
        `what you report). ${MIRROR_REQUEST}`
      : "")
  );
}

/**
 * What a run that records judgments is told. Each sentence states what the
 * tools and the database do, with the reason, or what the constitution
 * already asks (§21); whether material bears on a node, and whether a
 * change beside its version matters, stay the Steward's judgment.
 */
function versionsForAWriter(label: string, others: readonly string[], mirror: MirrorBrief | null = null): string {
  const own = tick(label);
  const opening =
    `## A judgment at each label\n\n` +
    `A node in this graph can carry more than one judgment at once, one for each label: a version. ` +
    `Each is made by a run at its label, which saw only what that label reads, and each is a full ` +
    `assessment held to every standard you work under. This run writes the version at ${own} and no ` +
    `other: the tools that record an assessment, an estimate, a question's assessment or an argument's ` +
    `evaluation record it at ${own}.`;
  if (others.length === 0) {
    // A label that reads no other sees one version on any node: its own.
    return (
      `${opening}\n\n` +
      `${own} reads no other label, so on every node this run reads, the version at ${own} is the only ` +
      `one it sees. A version made at another label does not replace it: yours goes on standing for ` +
      `the readers and runs that work from it, and is reassessed on its own inputs.` +
      (mirror && label === PUBLIC_LABEL
        ? `\n\n` +
          `On a mirrored node the version at ${own} is the public graph's own assessment, which arrives ` +
          `with the mirror. No run in this deployment records one, and no pass on a mirrored node at ` +
          `${own} is opened here: a second assessment at ${own} would be this deployment's, shown to ` +
          `readers as the public graph's. If you judge that the public graph has a mirrored node wrong, ` +
          `that is a request (file_request). ${MIRROR_REQUEST}`
        : "")
    );
  }
  return (
    `${opening}\n\n` +
    `The versions you read at ${listed(others, "or")} are not yours to change, and nothing you record ` +
    `replaces them. Each goes on standing for the readers and runs that work from it, and is reassessed ` +
    `on its own inputs like any judgment. A node that carries another label is not yours to reword or ` +
    `restructure either: its wording, its importance and the structure recorded at its label belong to ` +
    `the Steward that works at that label. What you add to it (an argument, a subclaim, a source) is ` +
    `recorded at ${own}, beside what is there.` +
    (mirror && others.includes(PUBLIC_LABEL)
      ? ` On a mirrored node the version at ${tick(PUBLIC_LABEL)} is the public graph's own assessment, ` +
        `which arrives with the mirror, and the Steward at that label is the public graph's: no run in ` +
        `this deployment records a version there.`
      : "") +
    `\n\n` +
    `On a node that carries another label, a version at ${own} is stored only when material at ${own} ` +
    `bears on the node: a source labeled ${own} attached to it, a node labeled ${own} under it, or a ` +
    `node under it that carries a version at ${own}. The tool that records the version refuses when ` +
    `there is none. The reason is that a version at ${own} should differ from the one it reads only ` +
    `where material at ${own} makes the difference, so that a reader can trace the difference to ` +
    `something named. Whether a source really bears on the node is your judgment, and the tool checks ` +
    `only that one is attached. Where nothing at ${own} bears, there is nothing at ${own} to judge: ` +
    `record no version, say so with log_stewardship_decision, and the version you read stands for ` +
    `readers at ${own}. A node that itself carries the label ${own} needs no such material: its ` +
    `judgment is simply its judgment.\n\n` +
    `Where you read a version at another label, start from it. Read its reasoning as you would a ` +
    `colleague's, then ask what the material at ${own} changes. Your version owes that one coherence, ` +
    `not deference (§21): where the two differ, the material at ${own} accounts for the difference, ` +
    `and your reasoning says how. A disagreement about evidence the other version could see is a ` +
    `case against that version, not a version of your own. Record it as a request (file_request), ` +
    `which stays at ${own}.${mirror && others.includes(PUBLIC_LABEL) ? ` ${MIRROR_REQUEST}` : ""} A version that agrees with the one you read is still worth recording ` +
    `when material at ${own} changes the confidence, the credence, or what the verdict rests on.\n\n` +
    `Your version records the versions it was made beside: the current version at each label that ` +
    `${own} reads, as they stood. When one of them is replaced, readers at ${own} are shown that ` +
    `yours was made against an earlier version, and a reassessment is opened at ${own}, which runs ` +
    `when it is funded. Whether the change matters is your judgment when it does.\n\n` +
    `get_claim lists a node's versions under \`versions\`, each with its label, and says which are in ` +
    `force for this run: a version is in force unless another one you can read was made at a label ` +
    `that reads its label. Where a read gives a single judgment for a node, it is the one in force, ` +
    `and the most recent of them if two labels that do not read each other each have one.`
  );
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
