/**
 * Every role whose prompt is fixed text in the repository, with the function
 * its agent calls. One list, read by the two things that need to know what
 * the code's own prompts are: the setup service, which names a run's role
 * part and publishes its text when it matches one of these
 * (services/setup-service.ts), and the prompt set, which hashes all of them
 * into one identity (services/prompt-set.ts).
 *
 * This module imports every role's prompt module, so anything on a hot path
 * (the LLM client's prompt step) loads it lazily.
 *
 * Variants a launcher can choose (the Researcher with and without the
 * constitution) are separate entries under one name.
 */
import { getAssistantSystemPromptBlocks, getAssistantTitleSystemPrompt } from "./assistant.js";
import { getAuditAgentSystemPromptBlocks } from "./audit-agent.js";
import { getClaimStewardSystemPromptBlocks } from "./claim-steward.js";
import { getConsistencyCheckerSystemPromptBlocks } from "./consistency-checker.js";
import { getContributionReviewerSystemPromptBlocks } from "./contribution-reviewer.js";
import { getCorrespondentSystemPromptBlocks } from "./correspondent.js";
import { getCuratorSystemPromptBlocks } from "./curator.js";
import { getDisputeArbitratorSystemPromptBlocks } from "./dispute-arbitrator.js";
import { getExtractorSystemPromptBlocks } from "./extractor.js";
import { getGrantmakerSystemPromptBlocks } from "./grantmaker.js";
import { getLookoutSystemPromptBlocks } from "./lookout.js";
import { getMatcherSystemPromptBlocks } from "./matcher.js";
import { getMathSolverSystemPromptBlocks } from "./math-solver.js";
import { getQuestionStewardSystemPromptBlocks } from "./question-steward.js";
import { getResearcherSystemPromptBlocks } from "./researcher.js";
import { getTaggerSystemPrompt } from "./tagger.js";

export interface KnownRole {
  name: string;
  sourcePath: string;
  /** The role's system blocks, as its agent is given them. */
  blocks: () => string[];
}

export const KNOWN_ROLES: readonly KnownRole[] = [
  { name: "claim-steward", sourcePath: "src/llm/prompts/claim-steward.ts", blocks: getClaimStewardSystemPromptBlocks },
  { name: "question-steward", sourcePath: "src/llm/prompts/question-steward.ts", blocks: getQuestionStewardSystemPromptBlocks },
  { name: "curator", sourcePath: "src/llm/prompts/curator.ts", blocks: getCuratorSystemPromptBlocks },
  { name: "extractor", sourcePath: "src/llm/prompts/extractor.ts", blocks: () => getExtractorSystemPromptBlocks() },
  { name: "matcher", sourcePath: "src/llm/prompts/matcher.ts", blocks: getMatcherSystemPromptBlocks },
  { name: "contribution-reviewer", sourcePath: "src/llm/prompts/contribution-reviewer.ts", blocks: getContributionReviewerSystemPromptBlocks },
  { name: "dispute-arbitrator", sourcePath: "src/llm/prompts/dispute-arbitrator.ts", blocks: getDisputeArbitratorSystemPromptBlocks },
  { name: "audit-agent", sourcePath: "src/llm/prompts/audit-agent.ts", blocks: getAuditAgentSystemPromptBlocks },
  { name: "grantmaker", sourcePath: "src/llm/prompts/grantmaker.ts", blocks: getGrantmakerSystemPromptBlocks },
  { name: "lookout", sourcePath: "src/llm/prompts/lookout.ts", blocks: getLookoutSystemPromptBlocks },
  { name: "correspondent", sourcePath: "src/llm/prompts/correspondent.ts", blocks: getCorrespondentSystemPromptBlocks },
  { name: "consistency-checker", sourcePath: "src/llm/prompts/consistency-checker.ts", blocks: getConsistencyCheckerSystemPromptBlocks },
  { name: "math-solver", sourcePath: "src/llm/prompts/math-solver.ts", blocks: getMathSolverSystemPromptBlocks },
  { name: "researcher", sourcePath: "src/llm/prompts/researcher.ts", blocks: () => getResearcherSystemPromptBlocks({ includeConstitution: true }) },
  { name: "researcher", sourcePath: "src/llm/prompts/researcher.ts", blocks: () => getResearcherSystemPromptBlocks({ includeConstitution: false }) },
  { name: "tagger", sourcePath: "src/llm/prompts/tagger.ts", blocks: () => [getTaggerSystemPrompt()] },
  // Not an administrator: the agent that works for a user (#646). Its
  // prompt is published like the rest.
  { name: "assistant", sourcePath: "src/llm/prompts/assistant.ts", blocks: getAssistantSystemPromptBlocks },
  // The small model that names an Assistant conversation from its first
  // message. Its run is logged in record mode, under this name.
  { name: "assistant-title", sourcePath: "src/llm/prompts/assistant.ts", blocks: () => [getAssistantTitleSystemPrompt()] },
];
