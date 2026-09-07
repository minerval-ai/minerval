import type { CheckKind } from "@/lib/types";
import { MACHINE_CHECKED, DEFINED_IN, RULES_SOURCE } from "@/lib/ontology";
import { Term } from "../Term";

// The derived machine-checked badge (docs/mathematics.md §2.3, §11.4). Not a
// status: it is read off the artifacts on the page, an argument whose evidence
// is a check the Lean checker accepted, and it sits beside the status badge
// rather than replacing it. Verified-green ink with a double border, where
// every status badge wears a single one, so the eye learns the difference
// before reading the label. The gloss says what the checker settles and what
// it does not: the checker confirms the proof; the verdict beside it is still
// the steward's judgment of the claim as worded.
//
// `plain` renders the badge without the Term popover, for containers that
// clip overflow (the map's preview panel), where the meaning is given in the
// panel's own prose instead.
export function MachineChecked({
  kind, size = "sm", linkTo, align, plain = false,
}: {
  kind: CheckKind;
  size?: "sm" | "lg";
  linkTo?: string;
  align?: "center" | "start" | "end";
  plain?: boolean;
}) {
  const m = MACHINE_CHECKED[kind];
  const cls = `badge checked${size === "lg" ? " lg" : ""}`;
  if (plain) {
    return (
      <span className={cls} title={m.gloss}>
        <span className="badge-glyph" aria-hidden>{m.glyph}</span>
        {m.label}
      </span>
    );
  }
  return (
    <Term
      gloss={m.gloss}
      href={DEFINED_IN.machineChecked}
      source={RULES_SOURCE}
      linkTo={linkTo}
      align={align}
      className={cls}
    >
      <span className="badge-glyph" aria-hidden>{m.glyph}</span>
      {m.label}
    </Term>
  );
}
