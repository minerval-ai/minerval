import type { ArgumentPage } from "./types";
import { ARG_DIRECT_EVALUATION, ARG_DIRECT_WRITTEN } from "./fixtures";

// The offline sample for the argument page (#541): the flagship claim's
// direct-measurement argument, with its premises, an evaluation history and
// a few instances, so the page can be designed without the live graph.
const ARG_DIRECT: ArgumentPage = {
  argument: {
    id: "arg-direct",
    conclusion: {
      id: "inflation-2022",
      text: "US CPI inflation in 2022 exceeded the threshold for “high” inflation.",
      kind: "claim",
    },
    name: "Direct measurement",
    stance: "for",
    shows: null,
    written_form: ARG_DIRECT_WRITTEN,
    has_written_form: true,
    created_at: "2024-11-02T14:25:00Z",
    retired: null,
    merged_into: null,
  },
  evaluation: {
    verdict: "certain",
    decisive: false,
    content: ARG_DIRECT_EVALUATION,
    stale: false,
    assessment_id: "a2",
    estimate_id: null,
    created_at: "2026-03-18T09:12:00Z",
  },
  evaluation_history: [
    {
      verdict: "likely",
      decisive: false,
      content:
        "The inference goes through if the threshold premise is read as 5%; the premise " +
        "was then unassessed, so the rating was held below certain.",
      stale: true,
      assessment_id: "a1",
      estimate_id: null,
      created_at: "2024-11-02T15:02:00Z",
    },
  ],
  premises: [
    {
      id: "bls-cpi",
      text: "The BLS measured US CPI-U growth of 6.5% for December 2022 over December 2021.",
      relation: "requires",
      grouped: true,
      assessment_status: "verified",
      assessment_confidence: 0.97,
      assessment_credence: 0.99,
      page_url: "/claims/bls-cpi",
    },
    {
      id: "threshold-def",
      text: "Annual inflation above 5% counts as “high” inflation.",
      relation: "requires",
      grouped: true,
      assessment_status: "inconclusive",
      assessment_confidence: 0.6,
      assessment_credence: null,
      page_url: "/claims/threshold-def",
    },
  ],
  instances: [
    {
      id: "ai-1",
      source: { id: "bls-release", url: "https://www.bls.gov/news.release/archives/cpi_01122023.htm", title: "Consumer Price Index — December 2022" },
      verbatim_text:
        "The all items index increased 6.5 percent for the 12 months ending December, the smallest 12-month increase since the period ending October 2021.",
      context: "The release reports the figure; it does not itself call the rate high.",
      stance: "mentions",
      reading: null,
      speaker: null,
      publication: "Bureau of Labor Statistics",
      source_date: "2023-01-12",
      link: null,
      recorded_by: "claim_steward",
      recorded_at: "2024-11-02T14:40:00Z",
    },
    {
      id: "ai-2",
      source: { id: "op-ed", url: "https://example.org/inflation-was-high", title: "Yes, 2022's inflation was high" },
      verbatim_text: "At 6.5%, inflation ran well past anything a reasonable person would call normal.",
      context: null,
      stance: "advances",
      reading: "premise_unstated",
      speaker: "A columnist",
      publication: "Example Review",
      source_date: "2023-02",
      link: null,
      recorded_by: "matcher",
      recorded_at: "2025-06-01T10:00:00Z",
    },
    {
      id: "ai-3",
      source: { id: "blog", url: "https://example.org/threshold", title: "Whose threshold?" },
      verbatim_text: "Calling 6.5% ‘high’ just assumes the answer: high relative to what?",
      context: "The post argues no fixed threshold is standard.",
      stance: "criticizes",
      reading: "full",
      speaker: null,
      publication: null,
      source_date: "2025-09",
      link: null,
      recorded_by: "matcher",
      recorded_at: "2025-09-20T08:00:00Z",
    },
  ],
  instances_total: 3,
};

const FIXTURES: Record<string, ArgumentPage> = { "arg-direct": ARG_DIRECT };

export const ARGUMENT_FIXTURE_IDS = Object.keys(FIXTURES);

export function getArgumentPageFixture(id: string): ArgumentPage | null {
  return FIXTURES[id] ?? null;
}
