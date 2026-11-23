/**
 * The starting set of questions for a safety case (constitution §7a, §7b,
 * #1211): what a careful reader of any case for an AI system's deployment
 * would ask, kept as a starting point for the kind.
 *
 * They are a starting point and not a template. A Steward thinks the
 * structure through from the conclusion (what would have to be true, and
 * what would have to have been looked for), and uses these to check what it
 * has not asked. A question that does not bear on the case in front of it
 * is left out, and one the case needs that is not here is asked anyway.
 *
 * Each names where it comes from. The sources are cited by author, title
 * and year, as they were known when this was written; they were not opened
 * and checked against this list then, and a Steward that relies on one
 * reads it (§9).
 */
export interface StartingQuestion {
  question: string;
  /** Where in a case's structure the question usually lands. */
  bears_on: string;
  sources: string[];
}

const CLYMER = "Clymer, Gabrieli, Krueger and Larsen, \"Safety Cases: How to Justify the Safety of Advanced AI Systems\" (2024)";
const BUHL = "Buhl, Sett, Koessler, Schuett and Anderljung, \"Safety cases for frontier AI\" (2024)";
const MANIFESTO = "Bloomfield and Rushby, \"Assurance 2.0: A Manifesto\" (2020)";
const DEFEATERS = "Bloomfield, Netkachova and Rushby, \"Defeaters and Eliminative Argumentation in Assurance 2.0\" (2024)";
const BLOCKS = "Bloomfield and Netkachova, \"Building Blocks for Assurance Cases\" (2014)";
const SCHEMING = "Balesni and others, \"Towards evaluations-based safety cases for AI scheming\" (2024)";
const CONTROL = "Korbak and others, \"A sketch of an AI control safety case\" (2025)";
const INABILITY = "Goemans and others, \"Safety case template for frontier AI: A cyber inability argument\" (2024)";
const INTERNATIONAL = "\"International AI Safety Report\" (2025)";

export const SAFETY_CASE_STARTING_QUESTIONS: readonly StartingQuestion[] = [
  {
    question: "Which system, in which version, with which scaffolding and tools, is the case about, and what in the deployment could change without the case being made again?",
    bears_on: "The specification: a later model or another deployment is another case.",
    sources: [BUHL, CLYMER],
  },
  {
    question: "What outcomes does the conclusion rule out, and which does it leave unaddressed?",
    bears_on: "The top claim and what the case does not cover.",
    sources: [CLYMER, BUHL],
  },
  {
    question: "Whose standard must the conclusion meet, where is it written, and what level of risk does it accept?",
    bears_on: "The specification's standard, which is disputable and stated where it can be disputed.",
    sources: [BUHL, MANIFESTO],
  },
  {
    question: "By which routes could the outcome come about, and how was it decided that the list of routes is complete?",
    bears_on: "The first decomposition and its side claim.",
    sources: [CLYMER, BLOCKS],
  },
  {
    question: "Does the case argue that the system cannot cause the outcome, that it would be stopped, that it would not try, or that a trusted party vouches for it, and does each leg rest on evidence of the kind that argument needs?",
    bears_on: "The legs under the top claim.",
    sources: [CLYMER],
  },
  {
    question: "Do the legs of each decomposition fail independently, or do they rest on a premise in common?",
    bears_on: "A decomposition's side claim: a shared premise is a defeater of it.",
    sources: [MANIFESTO, DEFEATERS],
  },
  {
    question: "Where evidence about an evaluation is used for deployment, or about an earlier model for this one, what says that it transfers?",
    bears_on: "A substitution step and its side claim.",
    sources: [BLOCKS, INABILITY, BUHL],
  },
  {
    question: "Were the evaluations able to elicit the capability or behaviour if it were there, and could the system have performed below its ability on them?",
    bears_on: "The side claim of an evidence incorporation step: that a measurement means what it is taken to mean.",
    sources: [INABILITY, SCHEMING, INTERNATIONAL],
  },
  {
    question: "Could the system tell an evaluation from deployment, and behave differently in each?",
    bears_on: "A defeater of any step from evaluation behaviour to deployment behaviour.",
    sources: [SCHEMING, CLYMER],
  },
  {
    question: "Where the case relies on oversight or monitoring, would it catch a system that was trying to avoid being caught, and who played that system in testing?",
    bears_on: "A control leg and the evidence under it.",
    sources: [CONTROL, CLYMER],
  },
  {
    question: "What was looked for and not found, and how hard was the search?",
    bears_on: "Evidence of absence, which weighs as much as the search behind it (§10).",
    sources: [DEFEATERS, MANIFESTO],
  },
  {
    question: "What evidence does the developer report without showing, who else has examined it, and what was the examiner allowed to see?",
    bears_on: "Evidence items: evidence not shown is testimony about evidence (§9).",
    sources: [BUHL, INTERNATIONAL],
  },
  {
    question: "Which doubts has the developer's own document raised and answered, which has it raised and left, and which does it never raise?",
    bears_on: "Defeaters, and the record of what the structure adds that the published document does not raise.",
    sources: [DEFEATERS, BUHL],
  },
  {
    question: "What would have to be observed after deployment for the case to be withdrawn, and is anyone placed to observe it?",
    bears_on: "What would change the verdict.",
    sources: [BUHL, MANIFESTO],
  },
  {
    question: "Which doubts remain, who has accepted each, and on what ground?",
    bears_on: "Residual doubts.",
    sources: [DEFEATERS, MANIFESTO],
  },
];

/** The questions as the Steward's prompt carries them. */
export function startingQuestionsText(): string {
  return SAFETY_CASE_STARTING_QUESTIONS.map(
    (q, n) => `${n + 1}. ${q.question}\n   Where it lands: ${q.bears_on}\n   From: ${q.sources.join("; ")}.`
  ).join("\n");
}
