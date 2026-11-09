/**
 * record_argument_instance (#541): record where a source makes, attacks or
 * mentions one of the node's arguments, the counterpart of
 * record_claim_instance for the argument layer (§4, §7).
 *
 * The Steward records and corrects instances on its own node's arguments; a
 * researcher it launched records on the run's node and reports, and the
 * Steward owns the set. An instance is provenance: the reading records how
 * well the passage states the argument and never changes the written form,
 * and instances do not rate the inference or decide whether the argument
 * stays on the claim (§7). Retired arguments take instances too, since a
 * passage that makes a retired argument belongs on it, not on a duplicate.
 *
 * executeArgumentInstanceTool returns null for a name it does not own, so
 * executeStewardTool can delegate to it.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  ARGUMENT_INSTANCE_STANCES,
  ARGUMENT_READINGS,
  isArgumentInstanceStance,
  isArgumentReading,
  type ArgumentReading,
} from "../../schemas/common.js";
import { valueShownSchema, type ValueShown } from "../../schemas/kinds.js";
import { getArgument } from "../../services/argument-service.js";
import {
  findArgumentInstance,
  insertArgumentInstance,
  updateArgumentInstance,
} from "../../services/argument-instance-service.js";
import { getOrCreateSource } from "../../services/source-service.js";
import { notYourNode } from "./steward-ownership.js";

export const RECORD_ARGUMENT_INSTANCE = "record_argument_instance";

/** Who may record an argument instance: the Steward, or a researcher it launched. */
export type ArgumentInstanceRecorder = "claim_steward" | "researcher";

const STATED_SHOWS_SCHEMA = {
  type: "object",
  description:
    "On an argument about a quantity only: what this source says the argument shows about the " +
    "value, as the source states it, in the shape of the argument's own shows (text, and range " +
    "where it gives one). The argument's shows stays your judgment of what the inference shows; " +
    "a source that runs the same inference to a different range is recorded here.",
  properties: {
    text: { type: "string" },
    range: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["at", "about", "between", "above", "below"] },
        low: { type: "number" },
        high: { type: "number" },
        inclusive: { type: "boolean" },
      },
      required: ["side"],
    },
  },
  required: ["text"],
} as const;

const PROPERTIES = {
  argument_id: { type: "string", description: "The UUID of the argument this passage makes, attacks or mentions." },
  instance_id: {
    type: "string",
    description:
      "To correct an instance already recorded on this argument: its id (from get_argument with " +
      "include instances). Pass the fields to change; url and verbatim_text are not needed.",
  },
  url: {
    type: "string",
    description: "URL of the source you read; sources are found or created by URL.",
  },
  title: { type: "string", description: "Title of the source." },
  verbatim_text: {
    type: "string",
    description:
      "The passage where the source makes, attacks or mentions the argument, verbatim. Under " +
      "2,000 characters: the passage, not the document.",
  },
  context: { type: "string", description: "Briefly, what the source was doing when it made the passage." },
  stance: {
    type: "string",
    enum: [...ARGUMENT_INSTANCE_STANCES],
    description:
      "advances: the passage makes the argument. criticizes: it attacks the argument (record it " +
      "also as an instance of the defeating claim, if the graph holds one). mentions: it names or " +
      "reports the argument without making or attacking it; a mention counts in neither camp.",
  },
  reading: {
    type: "string",
    enum: [...ARGUMENT_READINGS],
    description:
      "How well the passage states the argument, a fact about the passage (§4): full (the " +
      "inference with what it needs), premise_unstated (it leaves a premise the inference needs " +
      "unspoken), strawman (it states a weaker version, usually to attack it). Omit for a " +
      "mention. It never changes the argument's written form. A passage that rests on a " +
      "different premise is not a reading of this argument: it makes a different one.",
  },
  stated_shows: STATED_SHOWS_SCHEMA,
  speaker: {
    type: "string",
    description: "Who made the passage, where identifiable: the author, or for a quote the person quoted.",
  },
  publication: { type: "string" },
  source_date: { type: "string", description: "ISO-8601 to the precision known; omit rather than guess." },
  link: { type: "string", description: "A deep link to the passage, where it differs from the source URL." },
} as const;

const STEWARD_DESCRIPTION =
  "Record where a source makes, attacks or mentions one of your node's arguments (§4, §7), with " +
  "the passage as it states it, or correct one you recorded (instance_id). An argument is the " +
  "inference, not anyone's statement of it: match a passage to the argument that reaches the " +
  "same conclusion through the same inference, however it is worded, and record a passage that " +
  "rests on a different premise on that other argument (add_argument if the graph lacks it). " +
  "Instances are provenance. They do not change the written form or the rating, and how widely " +
  "an argument is made bears only weakly on whether it belongs on the claim (§7). A retired " +
  "argument takes instances too; recording one does not bring it back. One instance per " +
  "(argument, source, speaker): re-recording is deduplicated.";

export function getArgumentInstanceToolDefinition(): Tool {
  return {
    name: RECORD_ARGUMENT_INSTANCE,
    description: STEWARD_DESCRIPTION,
    input_schema: {
      type: "object" as const,
      properties: { ...PROPERTIES },
      required: ["argument_id"],
    },
  };
}

/**
 * The tool as a researcher a Steward launched sees it: no instance_id,
 * since correcting the instance set is the Steward's, and a description
 * addressed to an instrument.
 */
export function getResearcherArgumentInstanceToolDefinition(): Tool {
  const { instance_id: _instanceId, ...properties } = PROPERTIES;
  return {
    name: RECORD_ARGUMENT_INSTANCE,
    description:
      "Record where a source you read makes, attacks or mentions one of the arguments on the node " +
      "this investigation serves (read them with get_claim, include arguments), with the passage " +
      "as it states it. Match a passage to the argument that reaches the same conclusion through " +
      "the same inference, however worded; a passage that rests on a different premise is a " +
      "different argument, so say so in your report instead. Instances are provenance and do not " +
      "change an argument's written form or rating. The instance is recorded as yours, and the " +
      "Steward owns the set and may correct it. List what you recorded in your report.",
    input_schema: {
      type: "object" as const,
      properties,
      required: ["argument_id", "url", "verbatim_text", "stance"],
    },
  };
}

function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}

function optText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The stated value, parsed: undefined when absent, a refusal string when malformed. */
function parseStatedShows(raw: unknown): ValueShown | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const parsed = valueShownSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `stated_shows is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  return parsed.data;
}

export async function executeArgumentInstanceTool(
  name: string,
  input: Record<string, unknown>,
  opts: { recordedBy?: ArgumentInstanceRecorder; nodeId?: string } = {}
): Promise<string | null> {
  if (name !== RECORD_ARGUMENT_INSTANCE) return null;
  const recordedBy = opts.recordedBy ?? "claim_steward";
  const byResearcher = recordedBy === "researcher";

  const argumentId = String(input.argument_id ?? "").trim();
  if (!argumentId) return refuse("argument_id is required.");
  const argument = await getArgument(argumentId);
  if (!argument) return refuse(`Argument not found: ${argumentId}`);
  // A researcher records on the run's node alone, as for claim instances;
  // the Steward on the node it stewards.
  if (opts.nodeId && argument.claimId !== opts.nodeId) {
    return refuse(
      `Argument ${argumentId} is on node ${argument.claimId}, not on ${opts.nodeId}, the node this run serves.`
    );
  }
  const foreign = notYourNode(argument.claimId, `argument ${argumentId}`);
  if (foreign) return foreign;

  const quantity = argument.stance === "neutral";
  const rawStance = input.stance === undefined ? undefined : String(input.stance).toLowerCase();
  if (rawStance !== undefined && !isArgumentInstanceStance(rawStance)) {
    return refuse(`Unknown stance "${rawStance}". Use advances, criticizes, or mentions.`);
  }
  const rawReading = input.reading === undefined || input.reading === null ? undefined : String(input.reading).toLowerCase();
  if (rawReading !== undefined && !isArgumentReading(rawReading)) {
    return refuse(`Unknown reading "${rawReading}". Use full, premise_unstated, or strawman.`);
  }
  if (rawStance === "mentions" && rawReading !== undefined) {
    return refuse("A mention does not state the argument, so it has no reading: omit reading.");
  }
  const statedShows = parseStatedShows(input.stated_shows);
  if (statedShows && "error" in statedShows) return refuse(statedShows.error);
  if (statedShows && !quantity) {
    return refuse("stated_shows is for an argument about a quantity; this argument is on a proposition.");
  }
  const retiredNote = argument.retiredAt
    ? ` The argument is retired (${argument.retiredReason ?? "no reason recorded"}); the instance is ` +
      `kept on its record and does not bring it back. If what the source shows means it belongs ` +
      `on the claim again, weigh that by §7's test.`
    : "";

  // ---- correcting an instance (the Steward's) -----------------------------
  const instanceId = optText(input.instance_id);
  if (instanceId) {
    if (byResearcher) return refuse("Correcting an instance is the Steward's; say what is wrong in your report.");
    if (rawStance === undefined && rawReading === undefined && statedShows === undefined) {
      return refuse("Nothing to change: pass stance, reading, or stated_shows.");
    }
    const changed = await updateArgumentInstance({
      instanceId,
      argumentId,
      stance: rawStance as never,
      reading: rawReading === undefined ? (rawStance === "mentions" ? null : undefined) : (rawReading as ArgumentReading),
      statedShows,
    });
    if (!changed) return refuse(`Instance ${instanceId} is not an instance of argument ${argumentId}.`);
    return JSON.stringify({ success: true, instance_id: instanceId, message: `Corrected instance ${instanceId}.` });
  }

  // ---- recording a new instance -------------------------------------------
  const url = optText(input.url) ?? "";
  if (!/^https?:\/\//i.test(url)) {
    return refuse("url must be the http(s) URL of the source you read; an instance without provenance is not recordable.");
  }
  const verbatimText = optText(input.verbatim_text) ?? "";
  if (!verbatimText) return refuse("verbatim_text is required: the passage, verbatim.");
  if (verbatimText.length > 2000) {
    return refuse(`verbatim_text is ${verbatimText.length} chars; keep it under 2000: the passage, not the document.`);
  }
  if (rawStance === undefined) return refuse("stance is required: advances, criticizes, or mentions.");

  // Found or created by URL without enqueueing extraction: recording a
  // sighting stays a cheap side effect of the run.
  const source = await getOrCreateSource({ url, title: optText(input.title) });
  const speaker = optText(input.speaker) ?? null;
  const existing = await findArgumentInstance({ argumentId, sourceId: source.id, speaker });
  if (existing) {
    const differs = existing.stance !== rawStance || (rawReading !== undefined && existing.reading !== rawReading);
    return JSON.stringify({
      success: true,
      deduplicated: true,
      instance_id: existing.id,
      message:
        `This source is already recorded as an instance of this argument (stance ${existing.stance}` +
        (existing.reading ? `, reading ${existing.reading}` : "") +
        `); nothing new was written.` +
        (differs
          ? byResearcher
            ? ` What you read differs from what is recorded: say so in your report, with the passage ` +
              `(instance_id ${existing.id}).`
            : ` What you read differs from what is recorded: correct it with instance_id ${existing.id} ` +
              `if the record is wrong.`
          : "") +
        (speaker ? "" : " If this passage is a different speaker's in the same source, record it again with speaker set."),
    });
  }

  const id = await insertArgumentInstance({
    argumentId,
    sourceId: source.id,
    verbatimText,
    stance: rawStance as never,
    reading: rawStance === "mentions" ? null : ((rawReading as ArgumentReading | undefined) ?? null),
    statedShows: statedShows ?? null,
    context: optText(input.context) ?? null,
    speaker,
    publication: optText(input.publication) ?? null,
    sourceDate: optText(input.source_date) ?? null,
    link: optText(input.link) ?? null,
    createdBy: recordedBy,
  });
  return JSON.stringify({
    success: true,
    instance_id: id,
    source_id: source.id,
    message:
      `Recorded a ${rawStance} instance of argument "${argument.name ?? argument.id}" from ${source.url ?? url}.` +
      (byResearcher ? " It is recorded as yours; the Steward owns the set. List it in your report." : "") +
      retiredNote,
  });
}
