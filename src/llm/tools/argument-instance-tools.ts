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
  dismissPassage,
  findArgumentInstance,
  getUnplacedPassage,
  insertArgumentInstance,
  placePassage,
  updateArgumentInstance,
} from "../../services/argument-instance-service.js";
import { getOrCreateSource } from "../../services/source-service.js";
import { sourceAddressProblem } from "../../services/reading-address.js";
import { SOURCE_KIND_PROPERTY, applyStatedSourceKind, sourceKindRefusal } from "./source-kind.js";
import { rawQuery } from "../../db/client.js";
import { notYourNode } from "./steward-ownership.js";

export const RECORD_ARGUMENT_INSTANCE = "record_argument_instance";
export const PLACE_ARGUMENT_PASSAGE = "place_argument_passage";

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
  source_kind: SOURCE_KIND_PROPERTY,
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
 * place_argument_passage (#541): the Steward's decision on a passage
 * ingestion left unplaced on its node. Only the Steward creates arguments
 * (Part VIII), so a passage that matched none of them waits here.
 */
export function getPlaceArgumentPassageToolDefinition(): Tool {
  return {
    name: PLACE_ARGUMENT_PASSAGE,
    description:
      "Decide a passage that ingestion left unplaced on your node: reasoning a source gives " +
      "about the claim that matched none of its arguments (get_claim with include arguments " +
      "lists them as unplaced_argument_passages). Place it on the argument it makes or attacks " +
      "(argument_id; create the argument first with add_argument when the claim's page should " +
      "carry it and the graph lacks it), or dismiss it with dismiss_reason: it makes no argument, " +
      "or one the claim's page should not carry by §7's test. A dismissed passage is kept as " +
      "provenance with your reason. Placing records an instance of the argument; it does not " +
      "change the argument's written form or rating.",
    input_schema: {
      type: "object" as const,
      properties: {
        instance_id: { type: "string", description: "The unplaced passage's instance_id." },
        argument_id: { type: "string", description: "The argument it makes or attacks, on your node." },
        stance: {
          type: "string",
          enum: ["advances", "criticizes", "mentions"],
          description: "With argument_id: advances, criticizes, or mentions; defaults to the recorded stance.",
        },
        reading: PROPERTIES.reading,
        dismiss_reason: { type: "string", description: "Instead of argument_id: why the passage is not placed." },
      },
      required: ["instance_id"],
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
  if (name === PLACE_ARGUMENT_PASSAGE) return placeArgumentPassage(input);
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
  if (argument.mergedInto) {
    return refuse(`Argument ${argumentId} was merged into ${argument.mergedInto}; record on that argument.`);
  }

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
  // An http(s) URL, or the address of a reading kept from a connection.
  const addressProblem = await sourceAddressProblem(
    url,
    "url must be the http(s) URL of the source you read; an instance without provenance is not recordable."
  );
  if (addressProblem) return refuse(addressProblem);
  const verbatimText = optText(input.verbatim_text) ?? "";
  if (!verbatimText) return refuse("verbatim_text is required: the passage, verbatim.");
  if (verbatimText.length > 2000) {
    return refuse(`verbatim_text is ${verbatimText.length} chars; keep it under 2000: the passage, not the document.`);
  }
  if (rawStance === undefined) return refuse("stance is required: advances, criticizes, or mentions.");

  // Found or created by URL without enqueueing extraction: recording a
  // sighting stays a cheap side effect of the run.
  const kindRefusal = sourceKindRefusal(input.source_kind);
  if (kindRefusal) return refuse(kindRefusal);
  const source = await getOrCreateSource({ url, title: optText(input.title) });
  const sourceKind = await applyStatedSourceKind(source.id, input.source_kind);
  const speaker = optText(input.speaker) ?? null;
  const existing = await findArgumentInstance({ argumentId, sourceId: source.id, speaker });
  if (existing) {
    const differs = existing.stance !== rawStance || (rawReading !== undefined && existing.reading !== rawReading);
    return JSON.stringify({
    ...sourceKind,
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
    ...sourceKind,
    success: true,
    instance_id: id,
    source_id: source.id,
    message:
      `Recorded a ${rawStance} instance of argument "${argument.name ?? argument.id}" from ${source.url ?? url}.` +
      (byResearcher ? " It is recorded as yours; the Steward owns the set. List it in your report." : "") +
      retiredNote,
  });
}

async function placeArgumentPassage(input: Record<string, unknown>): Promise<string> {
  const instanceId = optText(input.instance_id);
  if (!instanceId) return refuse("instance_id is required: the unplaced passage's id, from get_claim.");
  const passage = await getUnplacedPassage(instanceId);
  if (!passage) return refuse(`No unplaced passage ${instanceId}; a placed instance is corrected with record_argument_instance.`);
  const foreign = notYourNode(passage.claim_id, `passage ${instanceId}`);
  if (foreign) return foreign;

  const argumentId = optText(input.argument_id);
  const dismissReason = optText(input.dismiss_reason);
  if (argumentId && dismissReason) return refuse("Pass argument_id to place it or dismiss_reason to dismiss it, not both.");

  if (dismissReason) {
    await dismissPassage(instanceId, dismissReason);
    return JSON.stringify({ success: true, instance_id: instanceId, message: "Dismissed; the passage is kept as provenance with your reason." });
  }
  if (!argumentId) return refuse("Pass argument_id to place the passage, or dismiss_reason to dismiss it.");

  const argument = await getArgument(argumentId);
  if (!argument) return refuse(`Argument not found: ${argumentId}`);
  if (argument.mergedInto) {
    return refuse(`Argument ${argumentId} was merged into ${argument.mergedInto}; place the passage on that argument.`);
  }
  if (argument.claimId !== passage.claim_id) {
    return refuse(`Argument ${argumentId} is on node ${argument.claimId}, not on ${passage.claim_id}, the node the passage is about.`);
  }
  const [current] = await rawQuery<{ stance: string }>(`SELECT stance FROM argument_instances WHERE id = $1`, [instanceId]);
  const rawStance = input.stance === undefined ? current?.stance ?? "advances" : String(input.stance).toLowerCase();
  if (!isArgumentInstanceStance(rawStance)) return refuse(`Unknown stance "${rawStance}". Use advances, criticizes, or mentions.`);
  const rawReading = input.reading === undefined || input.reading === null ? undefined : String(input.reading).toLowerCase();
  if (rawReading !== undefined && !isArgumentReading(rawReading)) {
    return refuse(`Unknown reading "${rawReading}". Use full, premise_unstated, or strawman.`);
  }
  if (rawStance === "mentions" && rawReading !== undefined) return refuse("A mention has no reading: omit reading.");

  // One instance per (argument, source): a passage whose source already has
  // one on this argument is dismissed as a duplicate instead.
  const existing = await findArgumentInstance({ argumentId, sourceId: passage.source_id, speaker: null });
  if (existing) {
    await dismissPassage(instanceId, `This source is already recorded on argument ${argumentId} (instance ${existing.id}).`);
    return JSON.stringify({
      success: true,
      deduplicated: true,
      instance_id: existing.id,
      message: `This source already has an instance of the argument (${existing.id}); the passage was dismissed as a duplicate.`,
    });
  }
  await placePassage({
    instanceId,
    argumentId,
    stance: rawStance,
    reading: rawStance === "mentions" ? null : ((rawReading as ArgumentReading | undefined) ?? null),
  });
  return JSON.stringify({
    success: true,
    instance_id: instanceId,
    message:
      `Placed the passage on argument "${argument.name ?? argument.id}" as a ${rawStance} instance.` +
      (argument.retiredAt ? " The argument is retired; the instance joins its record and does not bring it back." : ""),
  });
}
