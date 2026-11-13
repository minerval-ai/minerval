import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { loadConfig } from "../config.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { withProgressListener } from "../llm/usage-context.js";

/**
 * What a handler is given beside its message. `signal` aborts when the
 * poller gives up on the handler (it went `stallMs` without progress); a
 * handler that can stop at a checkpoint should. `progress()` resets the
 * stall clock; every metered model call already does (UsageContext
 * .onProgress), so a handler need call it only for progress that spends
 * nothing.
 */
export interface HandlerContext {
  signal: AbortSignal;
  progress: () => void;
}

export type MessageHandler<T> = (message: T, ctx: HandlerContext) => Promise<void>;

/** The part of the SQS client the poller uses (a test passes its own). */
export interface SqsLike {
  send(command: unknown): Promise<{ Messages?: Message[] } & Record<string, unknown>>;
}

type Logger = { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

/** How long a budget stop pauses the poller before it receives again. */
const BUDGET_PAUSE_MS = 60_000;

/**
 * A message whose handler the poller gave up on is visible again after
 * this long, so a later attempt takes it up soon, without racing a handler
 * that is about to notice it was given up on.
 */
const ABANDONED_RETURN_SECONDS = 30;

/**
 * SQS polling loop that runs in the Fastify process (docs/infrastructure.md,
 * "The extraction lane").
 *
 * It runs up to `concurrency` messages at once and receives only as many
 * as it has free places for, so no message waits out its visibility in
 * this process's hands behind another. While a handler runs, the poller
 * extends its message's visibility every `heartbeatMs`, so a long run is
 * not delivered to a second worker. A handler that goes `stallMs` without
 * progress is given up on: its signal aborts, its place is freed, and its
 * message is returned to the queue to be tried again (and, after the
 * queue's receive limit, to its dead-letter queue). One call that never
 * returns can no longer hold the lane.
 *
 * A budget stop (LlmBudgetExceededError) pauses receiving for a minute and
 * returns that message to the queue after the pause; the handlers already
 * running carry on.
 */
export function startPoller<T>(options: {
  queueUrl: string;
  handler: MessageHandler<T>;
  pollIntervalMs?: number;
  maxMessages?: number;
  /** Messages run at once. Default 1. */
  concurrency?: number;
  /** Seconds a received message stays invisible between heartbeats. Default 120. */
  visibilityTimeout?: number;
  /** How often a running message's visibility is extended. Default a third of the visibility. */
  heartbeatMs?: number;
  /** How long a handler may go without progress before it is given up on. Default 30 minutes. */
  stallMs?: number;
  /** Long-poll wait for a receive. Default 20 seconds. */
  waitTimeSeconds?: number;
  /** Pause after a budget stop. Default one minute. */
  budgetPauseMs?: number;
  client?: SqsLike;
  logger: Logger;
}): { stop: () => void; inFlight: () => number } {
  const client: SqsLike =
    options.client ?? (new SQSClient({ region: loadConfig().awsRegion }) as unknown as SqsLike);
  const pollInterval = options.pollIntervalMs ?? 5000;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  // SQS returns at most ten messages a receive.
  const maxMessages = Math.min(10, options.maxMessages ?? 10);
  const visibilityTimeout = options.visibilityTimeout ?? 120;
  const heartbeatMs = options.heartbeatMs ?? Math.max(1000, (visibilityTimeout * 1000) / 3);
  const stallMs = options.stallMs ?? 30 * 60_000;
  const waitTimeSeconds = options.waitTimeSeconds ?? 20;
  const budgetPauseMs = options.budgetPauseMs ?? BUDGET_PAUSE_MS;
  const logger = options.logger;
  let running = true;
  let pausedUntil = 0;
  const inFlight = new Set<Promise<void>>();

  const setVisibility = async (receiptHandle: string, seconds: number): Promise<void> => {
    try {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: options.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        })
      );
    } catch (err) {
      // A message already deleted, or a receipt that expired: nothing to hold.
      logger.error("Visibility change failed", err instanceof Error ? err.message : err);
    }
  };

  /** Run one message to its end, or until it is given up on. */
  const runOne = async (msg: Message): Promise<void> => {
    const receipt = msg.ReceiptHandle!;
    const controller = new AbortController();
    let lastProgress = Date.now();
    const progress = () => {
      lastProgress = Date.now();
    };
    const heartbeat = setInterval(() => {
      void setVisibility(receipt, visibilityTimeout);
    }, heartbeatMs);
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((resolve) => {
      const check = () => {
        const idle = Date.now() - lastProgress;
        if (idle >= stallMs) resolve("stalled");
        else stallTimer = setTimeout(check, stallMs - idle);
      };
      stallTimer = setTimeout(check, stallMs);
    });

    let parsed: T;
    try {
      parsed = JSON.parse(msg.Body!) as T;
    } catch (err) {
      clearInterval(heartbeat);
      clearTimeout(stallTimer);
      logger.error("Unparseable message left to the queue", err instanceof Error ? err.message : err);
      return;
    }

    const work = Promise.resolve()
      .then(() =>
        withProgressListener(progress, () => options.handler(parsed, { signal: controller.signal, progress }))
      )
      .then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err })
    );

    try {
      const outcome = await Promise.race([work, stalled]);
      if (outcome === "stalled") {
        controller.abort();
        logger.error(
          `Handler made no progress for ${Math.round(stallMs / 60_000)} min; ` +
            `gave up on it and returned its message to the queue (${options.queueUrl})`
        );
        // Whatever the abandoned handler does later is its own: its place
        // is free now, and the message is someone else's to take.
        void work.then((late) => {
          if (!late.ok) {
            logger.error(
              "An abandoned handler ended in an error",
              late.err instanceof Error ? late.err.message : late.err
            );
          }
        });
        clearInterval(heartbeat);
        await setVisibility(receipt, ABANDONED_RETURN_SECONDS);
        return;
      }
      clearInterval(heartbeat);
      if (outcome.ok) {
        await client.send(new DeleteMessageCommand({ QueueUrl: options.queueUrl, ReceiptHandle: receipt }));
        return;
      }
      const err = outcome.err;
      if (err instanceof LlmBudgetExceededError) {
        logger.error(`Budget exceeded, pausing poller for ${Math.round(budgetPauseMs / 1000)}s:`, err.message);
        pausedUntil = Math.max(pausedUntil, Date.now() + budgetPauseMs);
        // Back once the pause is over.
        await setVisibility(receipt, Math.ceil(budgetPauseMs / 1000));
      } else {
        logger.error("Failed to process message", err instanceof Error ? err.message : err);
        // The message returns to the queue when its visibility runs out.
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(stallTimer);
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const poll = async () => {
    while (running) {
      const pause = pausedUntil - Date.now();
      if (pause > 0) {
        await sleep(Math.min(pause, 5000));
        continue;
      }
      const free = concurrency - inFlight.size;
      if (free <= 0) {
        // Receive no more than can run: wait for a place.
        await Promise.race(inFlight);
        continue;
      }
      try {
        const response = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: options.queueUrl,
            MaxNumberOfMessages: Math.min(maxMessages, free),
            WaitTimeSeconds: waitTimeSeconds,
            VisibilityTimeout: visibilityTimeout,
          })
        );
        for (const msg of response.Messages ?? []) {
          if (!msg.Body || !msg.ReceiptHandle) continue;
          const p: Promise<void> = runOne(msg)
            .catch((err) => logger.error("Message handling failed", err instanceof Error ? err.message : err))
            .finally(() => inFlight.delete(p));
          inFlight.add(p);
        }
      } catch (err) {
        if (running) {
          logger.error("Poll error", err instanceof Error ? err.message : err);
          // Back off on error
          await sleep(pollInterval);
        }
      }
    }
  };

  // Start polling in background
  void poll();

  return {
    stop: () => {
      running = false;
    },
    inFlight: () => inFlight.size,
  };
}
