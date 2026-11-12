import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { loadConfig } from "../config.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { withSystemClearance } from "../db/clearance.js";

export type MessageHandler<T> = (message: T) => Promise<void>;

/**
 * SQS polling loop that runs in the Fastify process.
 * Polls a queue, deserializes messages, and calls the handler.
 */
export function startPoller<T>(options: {
  queueUrl: string;
  handler: MessageHandler<T>;
  pollIntervalMs?: number;
  maxMessages?: number;
  visibilityTimeout?: number;
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  const client = new SQSClient({ region: config.awsRegion });
  const pollInterval = options.pollIntervalMs ?? 5000;
  const maxMessages = options.maxMessages ?? 5;
  const visibilityTimeout = options.visibilityTimeout ?? 60;
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const response = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: options.queueUrl,
            MaxNumberOfMessages: maxMessages,
            WaitTimeSeconds: 20, // Long polling
            VisibilityTimeout: visibilityTimeout,
          })
        );

        if (response.Messages && response.Messages.length > 0) {
          for (const msg of response.Messages) {
            if (!msg.Body || !msg.ReceiptHandle) continue;

            try {
              const parsed = JSON.parse(msg.Body) as T;
              await withSystemClearance(
                "A queue handler loads the row its message names, at whatever label, and then runs the work at that row's label.",
                () => options.handler(parsed)
              );

              // Delete message on success
              await client.send(
                new DeleteMessageCommand({
                  QueueUrl: options.queueUrl,
                  ReceiptHandle: msg.ReceiptHandle,
                })
              );
            } catch (err) {
              if (err instanceof LlmBudgetExceededError) {
                options.logger.error(
                  "Budget exceeded, pausing poller for 60s:",
                  err.message
                );
                await new Promise((r) => setTimeout(r, 60_000));
              } else {
                options.logger.error(
                  "Failed to process message",
                  err instanceof Error ? err.message : err
                );
              }
              // Message will return to queue after visibility timeout
            }
          }
        }
      } catch (err) {
        if (running) {
          options.logger.error(
            "Poll error",
            err instanceof Error ? err.message : err
          );
          // Back off on error
          await new Promise((r) => setTimeout(r, pollInterval));
        }
      }
    }
  };

  // Start polling in background
  poll();

  return {
    stop: () => {
      running = false;
    },
  };
}
