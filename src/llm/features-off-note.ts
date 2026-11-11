/**
 * What a run is told when this deployment has features switched off
 * (src/features.ts; docs/architecture.md, "Features").
 *
 * The role prompts and skills are the same text in every deployment: there
 * is one published prompt set with one hash (services/prompt-set.ts), and
 * "this run used the published prompts" stays a comparison of hashes. So a
 * run in a deployment with mathematics off still reads about formal
 * statements and proof attempts, and is offered none of their tools. This
 * note is how it learns why: one passage at the head of the conversation's
 * first task message, outside the hashed role text, naming what is off. It
 * states the fact and its reason and nothing more; what to make of it is the
 * agent's judgment.
 *
 * With every feature on there is no note, and nothing a run is sent changes.
 *
 * The LLM client adds it (client.ts, withRunBrief), so every agent run is
 * told without any agent file knowing of it, and the run's prompt step
 * records the message as it was sent. The list itself is on the step's
 * setup (`setup.featuresOff`, services/setup-split.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { FEATURES, offFeatures, type FeaturesConfig } from "../features.js";

type MessageParam = Anthropic.MessageParam;

/**
 * What stands between the note and the task message it heads: the rule the
 * chat agents already put between context they add and a person's words.
 */
export const FEATURES_OFF_NOTE_SEPARATOR = "\n\n---\n\n";

/**
 * The passage for this deployment: "" when every feature is on. Each feature
 * that is off is named by its `agentPhrase`, in the list's order, so a
 * feature added to src/features.ts is covered without a change here.
 */
export function featuresOffNote(config?: FeaturesConfig): string {
  const off = new Set<string>(offFeatures(config));
  if (off.size === 0) return "";
  const phrases = FEATURES.filter((f) => off.has(f.name)).map((f) => f.agentPhrase);
  return (
    `Some parts of Minerval are switched off in this deployment: ${phrases.join("; ")}. ` +
    `Their tools are not offered to you, and what your instructions and skills ` +
    `say about them does not apply here. The rest of your instructions hold as written.`
  );
}

/**
 * `messages` with the note at the head of the first user message, or
 * `messages` itself when nothing is off. Nothing else is touched: a string
 * message stays a string (the note, the rule, then the message as given),
 * and a message of content blocks gains one text block in front.
 *
 * A first message that already opens with the note is left as it is, so a
 * conversation sent again (each turn of a tool loop, a paused session's
 * transcript on resume) carries it once.
 */
export function withFeaturesOffNote(
  messages: MessageParam[],
  config?: FeaturesConfig
): MessageParam[] {
  const note = featuresOffNote(config);
  if (!note) return messages;
  const at = messages.findIndex((m) => m.role === "user");
  if (at === -1) return messages;
  const first = messages[at]!;
  let briefed: MessageParam;
  if (typeof first.content === "string") {
    if (first.content.startsWith(note)) return messages;
    briefed = { role: "user", content: `${note}${FEATURES_OFF_NOTE_SEPARATOR}${first.content}` };
  } else {
    const head = first.content[0];
    if (head?.type === "text" && head.text === note) return messages;
    briefed = { role: "user", content: [{ type: "text", text: note }, ...first.content] };
  }
  const out = [...messages];
  out[at] = briefed;
  return out;
}
