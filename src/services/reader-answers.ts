/**
 * The questions a Steward asks a reader, and the forms an answer takes
 * (services/separate-reader.ts says when a reader is used, and why).
 *
 * A reader is a Researcher run that has open to it sources the launching
 * Steward is not given. What comes back from it is held to this file: one
 * answer for each question the Steward asked, in the form the Steward set,
 * and nothing else. The purpose is to bound what crosses from the run that
 * read the material to the run that writes the page, in two ways.
 *
 *  - No answer holds words the reader composed. A yes or no, a number, a
 *    date and a choice among options the Steward wrote hold none. A passage
 *    is cut from the stored source by this file, at the place the reader's
 *    words match it, so every word of it is the source's and none the
 *    reader's. A question left unanswered carries one of a fixed list of
 *    reasons. An instruction planted in the material can therefore reach
 *    the Steward only as a passage of the material, marked as one, and no
 *    longer than MAX_PASSAGE_CHARS.
 *  - How much comes back is set by the questions, which the Steward wrote,
 *    and not by the reader: one answer for each. There is no count of
 *    questions. A reader's run is paid from the launching pass's budget,
 *    and the questions and answers are stored whole on the run's row, so
 *    what the page's writer was told is on the record.
 *
 * What this does not do. A number is still the reader's to choose, and so
 * is which passage: a reader that had been turned could answer falsely, or
 * pick a passage for what else it says. The first is the ordinary risk of
 * any instrument, met the ordinary way (the Steward weighs an answer and
 * can ask for the passage behind it). The second is bounded by the length
 * of a passage and by the questions asked.
 *
 * Pure: nothing here reads the database. The caller fetches a source's
 * stored text and hands it to `cutPassage`.
 */

/** The forms an answer takes. */
export const ANSWER_FORMS = ["yes_no", "number", "date", "choice", "passage"] as const;
export type AnswerForm = (typeof ANSWER_FORMS)[number];

/** What a yes-or-no question may be answered with. */
export const YES_NO = ["yes", "no", "unclear"] as const;

/**
 * Why a question has no answer, in the only words a reader may give.
 * Fixed, because a reason in the reader's own words would be free text
 * from the run that read the material.
 */
export const NO_ANSWER_REASONS = {
  not_in_what_was_opened: "What the reader opened does not say.",
  question_does_not_fit: "The question does not fit what the reader found: it can be read more than one way against the material, or assumes something the material does not bear out.",
  could_not_be_opened: "The reader could not open the material the question is about.",
  not_reached: "The reader's run ended before it answered this question.",
} as const;
export type NoAnswerReason = keyof typeof NO_ANSWER_REASONS;

/**
 * The longest passage one answer may hold, in characters. A hard limit, and
 * money cannot stand in for it: a longer passage costs the reader nothing
 * more, and the limit is what keeps one answer from carrying a page of the
 * material, or a long instruction planted in it, to the run that writes
 * the page. A Steward that needs more of a document asks for the next
 * passage with another question.
 */
export const MAX_PASSAGE_CHARS = 600;

export interface ReaderQuestion {
  /** q1, q2, ... in the order asked. */
  id: string;
  ask: string;
  form: AnswerForm;
  /** For a number: the unit the Steward wants it in, in the Steward's words. */
  unit?: string;
  /** For a choice: the options, in the Steward's words. */
  options?: string[];
}

export type ReaderAnswerValue =
  | { form: "yes_no"; value: (typeof YES_NO)[number] }
  | { form: "number"; value: number }
  | { form: "date"; value: string }
  | { form: "choice"; value: string }
  | { form: "passage"; value: string; cut_from: "the source's stored text" | "the source's text with its markup removed"; at_char: number };

export interface ReaderAnswer {
  question: string;
  /** Null where the question was not answered; `no_answer` then says why. */
  answer: ReaderAnswerValue | null;
  no_answer?: NoAnswerReason;
  /** The address of the source the answer rests on, as the graph records it. */
  source?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The questions of a launch, checked. Returns the questions, or a sentence
 * saying what is wrong with them.
 */
export function parseQuestions(input: unknown): ReaderQuestion[] | string {
  if (!Array.isArray(input) || input.length === 0) {
    return "questions is a list of at least one question, each with what you ask and the form its answer takes.";
  }
  const out: ReaderQuestion[] = [];
  for (const [n, raw] of input.entries()) {
    const id = `q${n + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${id} is not a question: give ask and form.`;
    const q = raw as Record<string, unknown>;
    const ask = str(q.ask);
    if (!ask) return `${id} has no ask: say what you want to know.`;
    const form = str(q.form);
    if (!(ANSWER_FORMS as readonly string[]).includes(form)) {
      return `${id} has form "${form}". The forms are ${ANSWER_FORMS.join(", ")}.`;
    }
    const question: ReaderQuestion = { id, ask, form: form as AnswerForm };
    if (form === "number") {
      const unit = str(q.unit);
      if (unit) question.unit = unit;
    }
    if (form === "choice") {
      const options = Array.isArray(q.options) ? q.options.map(str).filter(Boolean) : [];
      if (options.length < 2) return `${id} is a choice and needs at least two options, in your own words.`;
      if (new Set(options).size !== options.length) return `${id} lists the same option twice.`;
      question.options = options;
    }
    out.push(question);
  }
  return out;
}

/** Text with each run of whitespace as one space, and where each of its characters sits in the original. */
function collapsed(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inSpace && out.length > 0) {
        out += " ";
        at.push(i);
      }
      inSpace = true;
    } else {
      out += ch;
      at.push(i);
      inSpace = false;
    }
  }
  return { text: out, at };
}

/**
 * The stretch of `text` that `wanted` matches, comparing the two with each
 * run of whitespace taken as one space, since a model seldom reproduces
 * line breaks. What is returned is `text`'s own characters between the
 * first and last matched ones, spacing included: nothing of `wanted` is in
 * it. Null where `wanted` is not in `text`.
 */
export function cutFrom(text: string, wanted: string): { passage: string; at: number } | null {
  const needle = collapsed(wanted).text.trimEnd();
  if (!needle) return null;
  const hay = collapsed(text);
  const found = hay.text.indexOf(needle);
  if (found === -1) return null;
  const start = hay.at[found]!;
  const end = hay.at[found + needle.length - 1]! + 1;
  return { passage: text.slice(start, end), at: start };
}

/**
 * A passage answer, cut from a source's stored text: from the text as
 * stored, or, for a stored page, from its text with the markup removed
 * (`readable`, which the caller derives mechanically). A sentence saying
 * what is wrong where it cannot be.
 */
export function cutPassage(
  wanted: string,
  stored: string,
  readable: string | null
): Extract<ReaderAnswerValue, { form: "passage" }> | string {
  const exact = cutFrom(stored, wanted);
  const fromReadable = exact ? null : readable !== null ? cutFrom(readable, wanted) : null;
  const cut = exact ?? fromReadable;
  if (!cut) {
    return (
      "Those words are not in the source's stored text. A passage is given exactly as the source has it: " +
      "open the source again and copy the words, without correcting or shortening them."
    );
  }
  if (cut.passage.length > MAX_PASSAGE_CHARS) {
    return (
      `That passage is ${cut.passage.length} characters in the source, over the ${MAX_PASSAGE_CHARS} one answer may hold. ` +
      `The limit keeps one answer to what one question needs. Give the part that answers the question.`
    );
  }
  return {
    form: "passage",
    value: cut.passage,
    cut_from: exact ? "the source's stored text" : "the source's text with its markup removed",
    at_char: cut.at,
  };
}

const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/**
 * One answer that is not a passage, checked against its question. Returns
 * the value as stored, or a sentence saying what is wrong.
 */
export function checkValue(question: ReaderQuestion, value: unknown): ReaderAnswerValue | string {
  switch (question.form) {
    case "yes_no": {
      const v = str(value).toLowerCase();
      if (!(YES_NO as readonly string[]).includes(v)) return `${question.id} takes yes, no or unclear.`;
      return { form: "yes_no", value: v as (typeof YES_NO)[number] };
    }
    case "number": {
      // A number, and not a string that holds one: a string could hold anything.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${question.id} takes a number${question.unit ? ` (in ${question.unit})` : ""}, given as a number and not in words.`;
      }
      return { form: "number", value };
    }
    case "date": {
      const v = str(value);
      if (!DATE_RE.test(v)) return `${question.id} takes a date as YYYY, YYYY-MM or YYYY-MM-DD.`;
      return { form: "date", value: v };
    }
    case "choice": {
      const v = str(value);
      const options = question.options ?? [];
      if (!options.includes(v)) {
        return `${question.id} takes one of its options, exactly as written: ${options.map((o) => JSON.stringify(o)).join(", ")}.`;
      }
      return { form: "choice", value: v };
    }
    case "passage":
      return `${question.id} takes a passage, cut from a source: name the source and give the words as it has them.`;
  }
}

/** The answers of a run in the order the questions were asked, with a fixed reason for each one not answered. */
export function answersInOrder(questions: readonly ReaderQuestion[], given: ReadonlyMap<string, ReaderAnswer>): ReaderAnswer[] {
  return questions.map((q) => given.get(q.id) ?? { question: q.id, answer: null, no_answer: "not_reached" });
}

/** The answers as the launching Steward is given them: each beside the question it answers. */
export function answersForLauncher(
  questions: readonly ReaderQuestion[],
  answers: readonly ReaderAnswer[]
): Array<Record<string, unknown>> {
  const byId = new Map(answers.map((a) => [a.question, a]));
  return questions.map((q) => {
    const a = byId.get(q.id) ?? { question: q.id, answer: null, no_answer: "not_reached" as const };
    return {
      question: q.id,
      asked: q.ask,
      form: q.form,
      ...(q.unit ? { unit: q.unit } : {}),
      ...(a.answer
        ? a.answer.form === "passage"
          ? { passage: a.answer.value, cut_from: a.answer.cut_from, at_char: a.answer.at_char }
          : { answer: a.answer.value }
        : { not_answered: NO_ANSWER_REASONS[a.no_answer ?? "not_reached"] }),
      ...(a.source ? { source: a.source } : {}),
    };
  });
}
