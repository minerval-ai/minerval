// How a node's page says which layer something is at, inside a deployment
// with more than one label (docs/architecture.md, "A label's overlay on the
// structure below"). On the public graph the API serves none of these
// fields and nothing here is asked.
import type { ValueByLabel } from "./types";

/**
 * Where a label the reader reads holds its own importance for a node: the
 * label whose value the page shows, and a sentence naming what each other
 * label holds. Null where no label holds its own.
 */
export function importanceInEffect(byLabel: readonly ValueByLabel[] | undefined): { at: string; title: string } | null {
  const inEffect = byLabel?.find((v) => v.in_effect);
  if (!byLabel || !inEffect) return null;
  const others = byLabel.filter((v) => v !== inEffect && typeof v.value === "number");
  return {
    at: inEffect.label,
    title:
      `This is the importance ${inEffect.label} holds for the node, which is what its work goes by.` +
      (others.length > 0 ? ` ${others.map((o) => `${o.label} holds ${o.value}`).join("; ")}.` : ""),
  };
}
