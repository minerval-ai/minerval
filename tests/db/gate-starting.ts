/**
 * Gates start with a person deciding after the Redactor (gate-kinds.ts,
 * STARTING_MODE). The suites that follow an item through the Redactor's
 * own decision (the-gate, work-from-below) were written for the starting
 * positions from before that, and test that path, not where a gate starts.
 * This puts those positions back for the length of a file, as a gate whose
 * authorities had handed every kind to the Redactor would stand, and gives
 * back the function that restores the real ones. Where a gate starts is
 * tested on its own (the-gate.test.ts, "where a gate starts").
 */
import { STARTING_MODE, STARTING_MODE_OUTSIDE, type GateKind, type GateMode } from "../../src/services/gate-kinds.js";

const HANDED_TO_THE_REDACTOR: Record<GateKind, GateMode> = {
  page: "redactor",
  answer: "redactor",
  taken_up: "open",
  funding: "redactor",
  mandate: "redactor",
  message: "redactor",
  petition: "redactor",
  statement: "open",
  report: "person",
  proposal: "redactor",
};

export function startGatesWithTheRedactor(): () => void {
  const inside = { ...STARTING_MODE };
  const outside = { ...STARTING_MODE_OUTSIDE };
  Object.assign(STARTING_MODE, HANDED_TO_THE_REDACTOR);
  Object.assign(STARTING_MODE_OUTSIDE, HANDED_TO_THE_REDACTOR);
  return () => {
    Object.assign(STARTING_MODE, inside);
    Object.assign(STARTING_MODE_OUTSIDE, outside);
  };
}
