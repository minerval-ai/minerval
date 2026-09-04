/**
 * The bad-faith categories as the Reviewer and Arbitrator prompts describe
 * them. Built from the enum the tools validate against, so a category
 * cannot exist in the schema without a description in the prompt, or vice
 * versa. Constitution §13 carries the doctrine; this is the vocabulary the
 * suspected_bad_faith parameter takes.
 */
import {
  BAD_FAITH_CATEGORIES,
  type BadFaithCategory,
} from "../../services/reputation-service.js";

const DESCRIPTIONS: Record<BadFaithCategory, string> = {
  spam: "promotional, off-topic, or bulk low-effort content",
  vandalism: "attempts to damage or deface claims and their structure",
  sybil:
    "coordinated contributions from apparently related accounts\n" +
    "  (identical phrasing, synchronized timing, mutual reinforcement)",
  misinformation:
    "fabricated sources, misquoted evidence, or\n" +
    "  knowingly false assertions, never honest error",
};

/** A markdown list of the categories, one bullet each. */
export const BAD_FAITH_CATEGORY_LIST = BAD_FAITH_CATEGORIES.map(
  (c) => `- **${c}**: ${DESCRIPTIONS[c]}`
).join("\n");
