/**
 * Features: the optional parts of the product a deployment can switch off,
 * one by one (docs/architecture.md, "Features").
 *
 * Every feature is on unless FEATURES_OFF names it. There are no named
 * bundles: a deployment is described by the features it has switched off and
 * nothing else. Switching a feature off means its routes are not mounted
 * (src/server/app.ts), so the MCP tools generated from them do not exist;
 * its hand-written MCP tools are not registered (src/mcp/server.ts); the
 * agents are not offered its tools; and its workers are not started
 * (src/index.ts, src/workers/). Its tables stay, and a core route that
 * carries a field about it keeps the field and reports what the tables
 * hold, which is nothing where the feature has never been on.
 *
 * GET /setup/features (`list_features` on MCP) reports what this deployment
 * has, which is how the web app and outside agents learn it.
 */
import { loadConfig } from "./config.js";
import { labelOfWorkInProgress } from "./db/clearance.js";
import { postureAt } from "./label-posture.js";

interface FeatureDefinition {
  name: string;
  /** One sentence: what the feature is, and what switching it off removes. */
  description: string;
  /**
   * The feature as an agent would recognize it in its own instructions,
   * skills and tools: a short phrase, lower case, no full stop. A run in a
   * deployment with the feature off is told so by this phrase
   * (src/llm/features-off-note.ts). `description` is written for whoever
   * runs the deployment and names routes and workers an agent never sees.
   */
  agentPhrase: string;
  /** Features this one cannot run without: off when any of them is off. */
  requires: readonly string[];
}

export const FEATURES = [
  {
    name: "extension",
    description:
      "The browser extension's API (analysing the page a reader has open, " +
      "sharing an analysis by the page's address, and chat over the page); " +
      "switching it off removes the /extension routes, the get_page_analysis " +
      "tool, and the fill of page hashes on older sources that lets the " +
      "extension find pages the graph has read.",
    agentPhrase: "the browser extension and its page analysis",
    requires: [],
  },
  {
    name: "mathematics",
    description:
      "Formal statements of claims in Lean, the Lean checker, and the " +
      "solver's proof attempts; switching it off removes the formalization, " +
      "Lean-check and attempt routes and their tools, the agents' Lean and " +
      "proof-attempt tools, and the solver worker, and switches prizes off " +
      "with it.",
    agentPhrase:
      "formal statements in Lean, the Lean checker and the solver's proof attempts",
    requires: [],
  },
  {
    name: "prizes",
    description:
      "Prizes and bounties for machine-checked proofs, which need " +
      "mathematics; switching it off removes the prize, prize-claim and " +
      "bounty routes and their tools, the agents' bounty and prize-claim " +
      "tools, and the prize-check and window-closing lanes of the runner.",
    agentPhrase: "prizes and bounties for machine-checked proofs",
    requires: ["mathematics"],
  },
] as const satisfies readonly FeatureDefinition[];

export type FeatureName = (typeof FEATURES)[number]["name"];

export const FEATURE_NAMES: readonly FeatureName[] = FEATURES.map((f) => f.name);

export function isFeatureName(name: string): name is FeatureName {
  return (FEATURE_NAMES as readonly string[]).includes(name);
}

/** The names in a FEATURES_OFF value that are not features. */
export function unknownFeatureNames(raw: string): string[] {
  return splitNames(raw).filter((name) => !isFeatureName(name));
}

/** What config loading says when FEATURES_OFF names something that is not a feature. */
export function unknownFeaturesMessage(unknown: readonly string[]): string {
  return (
    `FEATURES_OFF names ${unknown.map((n) => `"${n}"`).join(", ")}, which ` +
    `${unknown.length === 1 ? "is not a feature" : "are not features"}. ` +
    `The features are: ${FEATURE_NAMES.join(", ")}.`
  );
}

/**
 * A FEATURES_OFF value as the features it names, each once, in the list's
 * order. Throws on a name that is not a feature, so a typo cannot leave a
 * feature on unnoticed; config loading reports the same message.
 */
export function parseFeaturesOff(raw: string): FeatureName[] {
  const unknown = unknownFeatureNames(raw);
  if (unknown.length > 0) throw new Error(unknownFeaturesMessage(unknown));
  const named = new Set(splitNames(raw));
  return FEATURE_NAMES.filter((name) => named.has(name));
}

function splitNames(raw: string): string[] {
  return raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/**
 * Whether a feature is on: FEATURES_OFF does not name it, and every feature
 * it requires is on. `off` is the configured list; a config without one (a
 * test's partial config) has everything on, as a deployment that sets
 * nothing does.
 */
export function featureOnGiven(name: FeatureName, off: readonly string[] | undefined): boolean {
  if (off?.includes(name)) return false;
  const feature = FEATURES.find((f) => f.name === name)!;
  return feature.requires.every((required) => featureOnGiven(required, off));
}

/** The part of the config the features read: the list FEATURES_OFF parsed to. */
export interface FeaturesConfig {
  featuresOff?: readonly string[];
}

/** Whether a feature is on in this deployment. */
export function featureOn(name: FeatureName, config?: FeaturesConfig): boolean {
  if (config) return featureOnGiven(name, config.featuresOff);
  // Asked of the deployment's own settings, inside a run: the run's label
  // may switch more off for its own runs (src/label-posture.ts). Outside a
  // run this is the deployment's list.
  return featureOnGiven(name, postureAt(labelOfWorkInProgress()).featuresOff);
}

/**
 * The features that are off in this deployment, in the list's order: those
 * FEATURES_OFF names, and those that need one of them (prizes, when
 * mathematics is off). Empty when everything is on.
 */
export function offFeatures(config: FeaturesConfig = loadConfig()): FeatureName[] {
  return FEATURE_NAMES.filter((name) => !featureOnGiven(name, config?.featuresOff));
}

export interface FeatureState {
  name: FeatureName;
  on: boolean;
  description: string;
}

/** Every feature with whether it is on here: what GET /setup/features serves. */
export function listFeatures(config: FeaturesConfig = loadConfig()): FeatureState[] {
  return FEATURES.map((f) => ({
    name: f.name,
    on: featureOnGiven(f.name, config?.featuresOff),
    description: f.description,
  }));
}
