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

/**
 * The passage for a run at `label` that reads `reads` (its own label
 * included, as the database client works it out: currentReadClearance).
 */
export function labelNote(label: string, reads: readonly string[]): string {
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
    `search or a read that comes back empty has looked only at what this label can read.\n\n` +
    `What you write: each new thing this run records (a judgment, an argument, a reading of a source, ` +
    `a message, a request) carries the label ${tick(label)}, whatever you read to write it. ${whoReads} ` +
    `A change to something that already carries another label, such as the wording of a node, keeps ` +
    `that label, and its readers see the change.\n\n` +
    `A node holds one judgment in force, recorded at one label. This run can replace it only where it ` +
    `was recorded at ${tick(label)}: where a node's judgment in force carries another label, the tool ` +
    `that records yours will refuse. A judgment at one label must not take the place of another ` +
    `label's, and a node keeping one for each label is not built yet.\n\n` +
    `If the work cannot be done well on what this label can read, say so in what you record, so that ` +
    `whoever reads it or pays for the next pass knows what it rests on.`
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
export function withLabelNote(messages: MessageParam[], note: string): MessageParam[] {
  if (!note) return messages;
  const at = messages.findIndex((m) => m.role === "user");
  if (at === -1) return messages;
  const first = messages[at]!;
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
