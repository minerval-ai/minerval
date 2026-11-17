// One status for one version of a node's page under a showing, from the two
// vocabularies the API describes it in: the stage on the side it was written
// at (to_redact, to_check, at_gate, cannot_cross, overtaken; GET /showings,
// `asked`), and the state on the side it is shown to (not_yet_assessed,
// held, released_in_part, released_whole; GET /showings/:id). A reader of
// both sides sees both halves; a reader of one side sees that half only,
// and what the other half would say is left unmarked rather than guessed.
//
// Four steps: Redact, Audit (its check of the redaction), Release (the gate)
// and Shown (on the other side). Waiting for funds is a warning on Redact or
// Audit, the step the money is for; a hold is a warning on Release.
//
// Pure: components/work/Pipeline.tsx draws it, tests/unit/web/pipeline.test.ts checks it.

export type PipelineStep = "redact" | "audit" | "release" | "shown";
/** todo: not reached, or not known from this side. now: under way. part: shown in part. */
export type StepMark = "todo" | "done" | "now" | "warn" | "bad" | "part";
export type PipelineTone = "ok" | "warn" | "bad" | "info" | "neu";
/** What the version waits on someone for: money, a decision at the gate, or the boundary's policy. */
export type PipelineNeed = "pay" | "review" | "policy";

export type SourceStage = "to_redact" | "to_check" | "at_gate" | "cannot_cross" | "overtaken";
export type DestinationState = "not_yet_assessed" | "held" | "released_in_part" | "released_whole";

export interface PipelineInput {
  /** The stage, where the viewer reads the label the page was written at. */
  stage?: SourceStage | null;
  /** The API's sentence for the stage; an unpaid stage begins "waiting for funds". */
  stageInWords?: string | null;
  /** The state, where the viewer reads the side the page is shown to. */
  state?: DestinationState | null;
  /** The API's fixed words for why a version not shown is held (ShownVersion.held_because). */
  heldBecause?: string | null;
  partsHeld?: number | null;
  ofParts?: number | null;
  /** For a page at the gate: the parties it waits on (AskedPage.waiting_on). */
  waitingOn?: ReadonlyArray<{ party: string; standing?: string }> | null;
  /** Audit returned the redaction to be done again (AskedPage.audit_reasons). */
  returnedByAudit?: boolean;
}

/** Which status it is, for a filter: one per word the pill can carry. */
export type PipelineKey =
  | "not_yet_assessed" | "overtaken" | "shown_whole" | "shown_in_part" | "cannot_cross"
  | "funds" | "redacting" | "audit" | "gate" | "delayed" | "held";

export interface Pipeline {
  key: PipelineKey;
  steps: Array<{ step: PipelineStep; label: string; mark: StepMark }>;
  pill: { text: string; tone: PipelineTone };
  /** Overtaken: a later version was recorded before this one was redacted. */
  dashed: boolean;
  needs: PipelineNeed | null;
  /** The steps in words, for a title on hover. */
  title: string;
}

const LABELS: Record<PipelineStep, string> = { redact: "Redact", audit: "Audit", release: "Release", shown: "Shown" };
const ORDER: PipelineStep[] = ["redact", "audit", "release", "shown"];

const UNPAID = /^waiting for funds/i;

type Hold = { reason: string | null; by: "direct" | "redactor" };

/** What the destination side's words for a held version say about where it stands. */
function readHeld(words: string | null | undefined): { stage?: SourceStage; unpaid?: boolean; hold?: Hold; delayed?: boolean } {
  const w = (words ?? "").trim();
  if (!w) return {};
  const reason = (w.match(/\(([^)]*)\)\s*$/) ?? [])[1] ?? null;
  if (/^held by a person who directs/i.test(w)) return { hold: { reason, by: "direct" } };
  if (/^held by the Redactor/i.test(w)) return { stage: "at_gate", hold: { reason, by: "redactor" } };
  if (UNPAID.test(w)) return { stage: /check of its redaction/i.test(w) ? "to_check" : "to_redact", unpaid: true };
  if (/^waiting for the Redactor/i.test(w)) return { stage: "to_redact" };
  if (/^redacted, and waiting for Audit/i.test(w)) return { stage: "to_check" };
  if (/^it cannot be shown/i.test(w)) return { stage: "cannot_cross" };
  if (/^a later version was recorded/i.test(w)) return { stage: "overtaken" };
  if (/^delayed until/i.test(w)) return { stage: "at_gate", delayed: true };
  if (/^waiting on/i.test(w)) return { stage: "at_gate" };
  return {};
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pipelineOf(input: PipelineInput): Pipeline {
  const marks: Record<PipelineStep, StepMark> = { redact: "todo", audit: "todo", release: "todo", shown: "todo" };
  const held = input.state === "held" ? readHeld(input.heldBecause) : {};
  const stage: SourceStage | undefined = input.stage ?? held.stage;
  const unpaid = UNPAID.test(input.stageInWords ?? "") || !!held.unpaid;
  const state = input.state ?? null;

  let pill: Pipeline["pill"] = { text: "Not yet assessed", tone: "neu" };
  let key: PipelineKey = "not_yet_assessed";
  let dashed = false;
  let needs: PipelineNeed | null = null;

  const shownWhole = state === "released_whole";
  const shownInPart = state === "released_in_part";

  if (stage === "overtaken") {
    dashed = true;
    key = "overtaken";
    pill = { text: "Overtaken", tone: "neu" };
  } else if (shownWhole || shownInPart) {
    // Shown is the end of the way, whatever stage the other side last recorded.
    marks.redact = marks.audit = marks.release = "done";
    marks.shown = shownWhole ? "done" : "part";
    key = shownWhole ? "shown_whole" : "shown_in_part";
    const of = input.ofParts ?? null;
    const heldParts = input.partsHeld ?? null;
    pill = shownWhole
      ? { text: "Shown whole", tone: "ok" }
      : { text: heldParts !== null && of !== null ? `Shown in part (${heldParts} of ${of} held)` : "Shown in part", tone: "ok" };
  } else if (stage === "cannot_cross") {
    marks.redact = "bad";
    key = "cannot_cross";
    pill = { text: "Can't cross", tone: "bad" };
    needs = "policy";
  } else if (stage === "to_redact") {
    marks.redact = unpaid ? "warn" : "now";
    key = unpaid ? "funds" : "redacting";
    pill = unpaid ? { text: "Waiting for funds", tone: "warn" } : { text: input.returnedByAudit ? "Redacting again" : "Redacting", tone: "info" };
    if (unpaid) needs = "pay";
  } else if (stage === "to_check") {
    marks.redact = "done";
    marks.audit = unpaid ? "warn" : "now";
    key = unpaid ? "funds" : "audit";
    pill = unpaid ? { text: "Waiting for funds", tone: "warn" } : { text: "Audit check", tone: "info" };
    if (unpaid) needs = "pay";
  } else if (stage === "at_gate") {
    marks.redact = marks.audit = "done";
    marks.release = "now";
    key = held.delayed ? "delayed" : "gate";
    const parties = [...new Set((input.waitingOn ?? []).map((w) => w.party))];
    if (held.delayed) pill = { text: "Delayed", tone: "info" };
    else
      pill = {
        text: parties.length === 0 ? "At the gate" : parties.length === 1 ? `At the gate · ${parties[0]}` : `At the gate · ${parties.length} parties`,
        tone: "info",
      };
    needs = "review";
  } else if (state === "held") {
    // Held, and nothing says where: the destination side's half alone.
    marks.release = "warn";
    key = "held";
    pill = { text: "Held", tone: "warn" };
  }

  // A hold placed by a person who directs, or by the Redactor, sits on Release whatever came before it.
  if (held.hold && stage !== "overtaken" && stage !== "cannot_cross" && !shownWhole && !shownInPart) {
    marks.release = "warn";
    key = "held";
    pill = { text: held.hold.reason ? `Held: ${held.hold.reason}` : "Held", tone: "warn" };
    if (held.hold.by === "direct") needs = needs === "pay" ? "pay" : null;
  }

  const words: Record<StepMark, string> = { todo: "to come", done: "done", now: "now", warn: "waiting", bad: "stopped", part: "in part" };
  const title = dashed
    ? "Not redacted: a later version was recorded first"
    : ORDER.map((s) => `${LABELS[s]} ${words[marks[s]]}`).join(" · ");

  return {
    key,
    steps: ORDER.map((step) => ({ step, label: LABELS[step], mark: marks[step] })),
    pill: { ...pill, text: cap(pill.text) },
    dashed,
    needs,
    title,
  };
}

/** The status of a node under a showing that has no version yet. */
export const NOT_YET_ASSESSED: Pipeline = pipelineOf({ state: "not_yet_assessed" });
