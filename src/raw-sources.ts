/**
 * Opening raw sources: the permission that is separate from reading
 * (src/permissions.ts, `read_sources`).
 *
 * To read at a label is to read what the agents wrote there: a node, its
 * assessment, an instance with the passage it quotes, a reading, an
 * examination's findings. To open raw sources at a label is to open the
 * sources themselves, and it is granted on its own, label by label: a grant
 * at one label opens that label's sources and no other's, whatever the
 * label reads.
 *
 * The database cannot hold the two apart. A source's stored text is a
 * column of the source's own row, and the policies bind rows, so a person
 * who may read the row is handed the text with it. The permission is
 * therefore held here, at each place a source's stored text, or a verbatim
 * window of it, is returned to a person:
 *
 *  - the document view of a source (GET /sources/:source_id/document, and
 *    the MCP and Assistant tool made from it): the text of each segment
 *    and each heading (services/source-segment-service.ts);
 *  - a run's log (GET /runs/:run_id/steps and one step): a step in which
 *    an agent was handed a source's text, or a tool returned it
 *    (services/run-view-service.ts; llm/run-visibility.ts lists which).
 *
 * Read-only SQL returns no source text: no public_read view selects
 * sources.raw_content, and tests/unit/db/raw-source-text.test.ts fails if
 * one comes to.
 *
 * The text is withheld visibly. The response says that it is withheld and
 * which permission opens it, and never shows a source as empty.
 *
 * What this does not protect. A passage an agent quoted from a source is
 * text from the source, and it is what `read` covers: instances, readings
 * and findings are shown to everyone who reads at the label. A person
 * without this permission cannot open the document; they can read every
 * passage the agents chose to record from it. An agent's own run is not
 * held to this at all: it reads what its label reads, sources included.
 *
 * `public` sources are open to every member, and on the public graph none
 * of this applies.
 */
import { PUBLIC_LABEL } from "./labels.js";
import { membersOnly, standingOf, type Standing } from "./permissions.js";

/**
 * The labels whose raw sources the request may open, or null where nothing
 * is held: the public graph, where every source is public and open.
 */
export function rawSourceLabelsOf(auth: { standing?: Standing } | null | undefined): readonly string[] | null {
  if (!membersOnly()) return null;
  return standingOf(auth).rawSourceLabels;
}

/** Whether sources at `label` may be opened with `rawSourceLabels` (null: nothing is held). */
export function mayOpenRawSources(rawSourceLabels: readonly string[] | null, label: string): boolean {
  return rawSourceLabels === null || label === PUBLIC_LABEL || rawSourceLabels.includes(label);
}

/** What a response carries in place of text it withholds. */
export interface WithheldSourceText {
  withheld: "source_text";
  /** The permission that opens it. */
  permission: "read_sources";
  /** The label, or labels, the permission must be held at. */
  labels: string[];
  message: string;
}

const quoted = (labels: readonly string[]): string => {
  const names = labels.map((l) => `"${l}"`);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
};

/** The notice on a source whose text is withheld from this reader. */
export function withheldSourceText(label: string): WithheldSourceText {
  return {
    withheld: "source_text",
    permission: "read_sources",
    labels: [label],
    message:
      `The text of this source is withheld. Opening it takes the permission to open raw sources ` +
      `at the label "${label}", which this account does not hold. An administrator of this ` +
      `deployment grants it. What the agents recorded from the source is shown: the passages ` +
      `they quoted and how they read them.`,
  };
}

/** The notice on a step of a run's log that holds text read from sources. */
export function withheldRunSourceText(runLabel: string, missing: readonly string[]): WithheldSourceText {
  return {
    withheld: "source_text",
    permission: "read_sources",
    labels: [...missing],
    message:
      `This part of the run's log holds text taken from sources, and it is withheld. The run ` +
      `worked at the label "${runLabel}" and could open sources at every label that one reads, so ` +
      `reading this takes the permission to open raw sources at each of them. This account does ` +
      `not hold it at ${quoted(missing)}. An administrator of this deployment grants it. The rest ` +
      `of the log is shown, and the step's hash is the hash of the step as it was recorded.`,
  };
}
