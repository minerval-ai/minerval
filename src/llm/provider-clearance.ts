/**
 * The check made before text leaves the process: is the provider about to
 * receive it cleared for the label of the run sending it
 * (src/provider-labels.ts)?
 *
 * Every seam that sends text out calls assertProviderCleared first: the LLM
 * client for the model provider of each call (client.ts), the embedding
 * service, the fetch of an address on the open web (services/url-guard.ts),
 * the loop-run web search (providers/openrouter.ts), Elicit and Pangram.
 * A call that is not cleared throws there, before the request is built, so
 * a run that cannot be served fails on its first call, having spent
 * nothing. Nothing is retried on another provider, and a label is never
 * read as `public` to make the call go through.
 *
 * Which label is checked. A provider must be cleared for the label the run
 * works at (currentLabel), by name, and that is the whole test. A run at a
 * label also sends what that label reads (label_reads): a run at
 * `restricted` reads `internal` and `public` rows, and what it reads goes
 * to the model with the rest. That needs no second check, because a run at
 * a label is already trusted with everything the label reads, and so is
 * whoever it is allowed to send its text to: clearing a provider for
 * `restricted` is a decision about `restricted` text and what comes with
 * it. The other direction is the unsafe one and is not taken: being
 * cleared for a label that `restricted` reads says nothing about
 * `restricted`, and being cleared for `restricted` does not clear a
 * provider for runs at `internal`, which are a different set of runs that
 * someone has to choose to send there. Labels are not ranked, so no rule
 * of the kind "cleared for the higher, therefore the lower" could be
 * written without inventing an order they do not have.
 *
 * On the public graph the setting is empty, every provider is cleared for
 * `public`, every run works at `public`, and this check answers yes
 * without reading anything.
 */
import { loadConfig } from "../config.js";
import { PUBLIC_LABEL } from "../labels.js";
import {
  clearedLabels,
  ProviderNotClearedError,
  UndefinedProviderLabelError,
  type ProviderLabelsConfig,
} from "../provider-labels.js";
import { undefinedLabels } from "../services/label-service.js";
import { currentLabel } from "./usage-context.js";

/**
 * The setting last found to name only defined labels, by identity: the
 * loaded config is one object per process, so the table is asked once. A
 * setting that failed is asked about again on the next call, so defining
 * the missing label puts things right without a restart. A label cannot
 * stop being defined while a row carries it, and one that no row carries
 * has no run to send anything.
 */
let settingFoundWhole: object | null = null;

async function assertSettingNamesDefinedLabels(config: ProviderLabelsConfig): Promise<void> {
  const setting = config?.providerLabels;
  if (!setting || setting === settingFoundWhole) return;
  const providersByLabel = new Map<string, string[]>();
  for (const [provider, labels] of Object.entries(setting)) {
    for (const label of labels) {
      // `public` is seeded by the migration that made the table and cannot
      // be removed, so a setting that names no other label asks nothing.
      if (label === PUBLIC_LABEL) continue;
      providersByLabel.set(label, [...(providersByLabel.get(label) ?? []), provider]);
    }
  }
  if (providersByLabel.size > 0) {
    const missing = await undefinedLabels([...providersByLabel.keys()]);
    if (missing.length > 0) {
      throw new UndefinedProviderLabelError(
        missing.map((label) => ({ label, providers: providersByLabel.get(label)! }))
      );
    }
  }
  settingFoundWhole = setting;
}

/**
 * Throw unless `provider` (a model provider's name, or an outside
 * service's) is cleared for the label this run works at. Call it before
 * the request is built.
 */
export async function assertProviderCleared(
  provider: string,
  config: ProviderLabelsConfig = loadConfig()
): Promise<void> {
  await assertSettingNamesDefinedLabels(config);
  const label = currentLabel();
  const cleared = clearedLabels(provider, config);
  if (!cleared.includes(label)) throw new ProviderNotClearedError(provider, label, cleared);
}

/** Whether `provider` is cleared for the label this run works at. */
export function providerClearedHere(
  provider: string,
  config: ProviderLabelsConfig = loadConfig()
): boolean {
  return clearedLabels(provider, config).includes(currentLabel());
}

/** Test seam: forget which setting was found whole. */
export function resetProviderClearanceForTests(): void {
  settingFoundWhole = null;
}
