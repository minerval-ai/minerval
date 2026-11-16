/**
 * A label's posture: the settings a run works under that an organization
 * may want to differ from one label to another.
 *
 * A label says who may read a row. It is not a sandbox. But an organization
 * that sets up a label for sealed evidence often wants the work there held
 * more tightly than the rest of its graph: fetches held to addresses it was
 * given, no command run over files, a feature switched off. And a label may
 * hold nothing but runs asked for from below (ask-above-service.ts), which
 * is how a "room" is made: a label, its posture, and a face to ask it by.
 *
 * So the settings that are about a run and were one for the deployment
 * have a value for each label. A label starts from the deployment's value
 * and changes what LABEL_POSTURE (the config file's [label_posture.<label>]
 * tables) says for it:
 *
 *   {"evidence-room": {"fetches": "given", "sandbox": false, "features_off": ["mathematics"]}}
 *
 *  - fetches: "any" or "given" (PRIVATE_RUN_FETCHES, for runs at this label).
 *  - sandbox: false = runs at this label are offered no command over a file
 *    set, though the deployment has a sandbox. true is the deployment's own
 *    (a label cannot have a sandbox the deployment has not configured).
 *  - features_off: features switched off for runs at this label, on top of
 *    FEATURES_OFF. A feature off for the deployment is off at every label:
 *    its pages and routes are the deployment's.
 *
 * Which model providers and outside services a label's runs use is the
 * same kind of setting and has had its own mechanism from the start
 * (PROVIDER_LABELS, provider-labels.ts). Connections and file sets carry
 * the label they are offered at. Together these are a label's posture.
 *
 * A run is told its label's own settings in its label note
 * (llm/label-note.ts), with what each changes for it.
 */
import { loadConfig } from "./config.js";
import { FEATURE_NAMES, type FeatureName } from "./features.js";

export interface LabelPostureSetting {
  fetches?: "any" | "given";
  sandbox?: boolean;
  featuresOff?: FeatureName[];
}

const EXAMPLE = '{"evidence-room":{"fetches":"given","sandbox":false,"features_off":["mathematics"]}}';

/** A LABEL_POSTURE value as the settings it gives, with everything wrong with its form. Empty in, nothing out. */
export function parseLabelPosture(raw: string): { posture: Record<string, LabelPostureSetting>; problems: string[] } {
  const text = raw.trim();
  if (!text) return { posture: {}, problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      posture: {},
      problems: [
        `LABEL_POSTURE is not valid JSON (${err instanceof Error ? err.message : String(err)}). It is a JSON object ` +
          `from a label's name to that label's own settings, for example ${EXAMPLE}.`,
      ],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { posture: {}, problems: [`LABEL_POSTURE must be a JSON object from a label's name to its settings, for example ${EXAMPLE}.`] };
  }
  const posture: Record<string, LabelPostureSetting> = {};
  const problems: string[] = [];
  for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`LABEL_POSTURE gives "${label}" something that is not a group of settings, for example ${EXAMPLE}.`);
      continue;
    }
    const own: LabelPostureSetting = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "fetches") {
        if (v === "any" || v === "given") own.fetches = v;
        else problems.push(`LABEL_POSTURE gives "${label}" fetches = ${JSON.stringify(v)}; it is "any" or "given".`);
      } else if (key === "sandbox") {
        if (typeof v === "boolean") own.sandbox = v;
        else problems.push(`LABEL_POSTURE gives "${label}" sandbox = ${JSON.stringify(v)}; it is true or false.`);
      } else if (key === "features_off") {
        const names = Array.isArray(v) ? v : null;
        const unknown = (names ?? []).filter((n) => !FEATURE_NAMES.includes(n as FeatureName));
        if (!names || unknown.length > 0) {
          problems.push(
            `LABEL_POSTURE gives "${label}" features_off = ${JSON.stringify(v)}; it is a list of feature names ` +
              `(${FEATURE_NAMES.join(", ")}).`
          );
        } else own.featuresOff = [...new Set(names as FeatureName[])];
      } else {
        problems.push(`LABEL_POSTURE gives "${label}" a setting named "${key}"; a label's settings are fetches, sandbox and features_off.`);
      }
    }
    posture[label] = own;
  }
  return { posture, problems };
}

/** The part of the config a posture is read from. */
export interface PostureConfig {
  labelPosture?: Readonly<Record<string, LabelPostureSetting>>;
  privateRunFetches?: "any" | "given";
  featuresOff?: readonly string[];
}

export interface Posture {
  fetches: "any" | "given";
  /** False where the label's runs are offered no command, whatever the deployment has. */
  sandbox: boolean;
  /** Features off for runs at the label: the deployment's and the label's own. */
  featuresOff: readonly string[];
  /** What the label sets for itself, where it differs from what it started from. */
  own: LabelPostureSetting;
}

/** The posture of a label: the deployment's values, with what the label sets for itself. */
export function postureAt(label: string | null | undefined, config: PostureConfig = loadConfig()): Posture {
  const set = (label ? config.labelPosture?.[label] : undefined) ?? {};
  const base = config.privateRunFetches ?? "any";
  const baseOff = config.featuresOff ?? [];
  const added = (set.featuresOff ?? []).filter((f) => !baseOff.includes(f));
  const own: LabelPostureSetting = {};
  if (set.fetches && set.fetches !== base) own.fetches = set.fetches;
  if (set.sandbox === false) own.sandbox = false;
  if (added.length > 0) own.featuresOff = added;
  return {
    fetches: set.fetches ?? base,
    sandbox: set.sandbox !== false,
    featuresOff: [...baseOff, ...added],
    own,
  };
}

/** The labels LABEL_POSTURE names, for the preflight's check that each is defined. */
export function postureLabels(config: PostureConfig = loadConfig()): string[] {
  return Object.keys(config.labelPosture ?? {});
}

/**
 * What a run at `label` is told of the settings its label has of its own.
 * Empty where it has none, which is every label of a deployment that sets
 * nothing. Each is a limit on the run, so each is stated with what it
 * changes; the reason is the organization's, and the note says whose.
 */
export function postureNote(label: string, config: PostureConfig = loadConfig()): string {
  const { own } = postureAt(label, config);
  const parts: string[] = [];
  if (own.fetches === "given") {
    parts.push("a page is fetched only from an address this deployment was given (a search result, a source it holds, an address in your task)");
  }
  if (own.fetches === "any") parts.push("a page may be fetched from any address");
  if (own.sandbox === false) parts.push("no command is run over a set of files");
  if (own.featuresOff?.length) parts.push(`switched off: ${own.featuresOff.join(", ")}`);
  if (parts.length === 0) return "";
  return (
    `Runs at \`${label}\` work under settings this organization chose for that label, which differ from the rest of ` +
    `this deployment because of what the label holds: ${parts.join("; ")}. A tool that is not offered, or that ` +
    `refuses for one of these, is this setting and not a fault.`
  );
}
