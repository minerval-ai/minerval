/**
 * answer_messages and read_message: how a Steward deals with its node's
 * inbox (services/inbox-service.ts). The brief labels each unread message
 * m1, m2, …; these tools take those labels, so a run can only answer or read
 * what it was shown.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  answerMessages,
  readMessage,
  type MessageAnswer,
} from "../../services/inbox-service.js";

type Tool = Anthropic.Tool;

export const ANSWER_MESSAGES = "answer_messages";
export const READ_MESSAGE = "read_message";

export function getInboxToolDefinitions(): Tool[] {
  return [
    {
      name: ANSWER_MESSAGES,
      description:
        "Answer the messages in your brief, one entry for each you read. " +
        "outcome is what you did about it: changed (you changed the " +
        "assessment, structure or reasoning because of it), no_change (you " +
        "weighed it and nothing should change), or disagree (you think it is " +
        "mistaken). note says why, in a sentence or two the sender can act " +
        "on. Answers are recorded on the node's history. An answer to " +
        "another node's Steward reaches its inbox as a reply, which needs no " +
        "pass of its own. A message you leave unanswered is marked read, " +
        "with no answer recorded, when your pass ends.",
      input_schema: {
        type: "object" as const,
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "Its label from your brief: m1, m2, and so on.",
                },
                outcome: {
                  type: "string",
                  enum: ["changed", "no_change", "disagree"],
                },
                note: { type: "string", description: "Why, for the sender." },
              },
              required: ["message", "outcome"],
            },
          },
        },
        required: ["answers"],
      },
    },
    {
      name: READ_MESSAGE,
      description:
        "Read one message in this node's inbox in full, by its label (m9). " +
        "When there are many, your brief lists the oldest without their text.",
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Its label from your brief." },
        },
        required: ["message"],
      },
    },
  ];
}

/** Run an inbox tool; null when `name` is not one. */
export async function executeInboxTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { nodeId: string; labels: Map<string, string> }
): Promise<string | null> {
  if (name === ANSWER_MESSAGES) {
    const raw = Array.isArray(input.answers) ? input.answers : [];
    return answerMessages(ctx.nodeId, ctx.labels, raw as MessageAnswer[]);
  }
  if (name === READ_MESSAGE) {
    return readMessage(ctx.labels, String(input.message ?? ""));
  }
  return null;
}
