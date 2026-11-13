import { describe, it, expect, afterEach } from "vitest";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { startPoller, type HandlerContext, type SqsLike } from "../../../src/workers/poller.js";
import { LlmBudgetExceededError } from "../../../src/llm/errors.js";
import { noteProgress } from "../../../src/llm/usage-context.js";

/**
 * The queue poller (docs/infrastructure.md, "The extraction lane"): several
 * messages at once and never more received than it can run, a visibility
 * heartbeat while a handler runs, and a stall timeout that frees the place
 * of a handler that stopped making progress and returns its message.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

class FakeQueue implements SqsLike {
  waiting: Message[] = [];
  receives: Array<{ max: number; at: number }> = [];
  deleted: string[] = [];
  visibility: Array<{ receipt: string; seconds: number }> = [];
  private n = 0;

  push(body: unknown): string {
    const receipt = `r${++this.n}`;
    this.waiting.push({ Body: JSON.stringify(body), ReceiptHandle: receipt, MessageId: receipt });
    return receipt;
  }

  async send(command: unknown): Promise<{ Messages?: Message[] }> {
    if (command instanceof ReceiveMessageCommand) {
      const max = command.input.MaxNumberOfMessages ?? 1;
      this.receives.push({ max, at: Date.now() });
      if (this.waiting.length === 0) {
        await sleep(5);
        return {};
      }
      return { Messages: this.waiting.splice(0, max) };
    }
    if (command instanceof DeleteMessageCommand) {
      this.deleted.push(command.input.ReceiptHandle!);
      return {};
    }
    if (command instanceof ChangeMessageVisibilityCommand) {
      this.visibility.push({ receipt: command.input.ReceiptHandle!, seconds: command.input.VisibilityTimeout! });
      return {};
    }
    throw new Error("unexpected command");
  }
}

const quiet = { info: () => undefined, error: () => undefined };
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function start<T>(
  queue: FakeQueue,
  handler: (m: T, ctx: HandlerContext) => Promise<void>,
  opts: Partial<Parameters<typeof startPoller>[0]> = {}
) {
  const p = startPoller<T>({
    queueUrl: "q",
    handler,
    client: queue,
    logger: quiet,
    waitTimeSeconds: 0,
    visibilityTimeout: 120,
    heartbeatMs: 1000,
    stallMs: 10_000,
    ...opts,
  });
  stops.push(p.stop);
  return p;
}

describe("the queue poller", () => {
  it("runs up to its concurrency at once, and receives no more than it has places for", async () => {
    const q = new FakeQueue();
    for (let i = 0; i < 5; i++) q.push({ i });
    let live = 0;
    let most = 0;
    const release: Array<() => void> = [];
    const done: number[] = [];
    start<{ i: number }>(
      q,
      async (m) => {
        live++;
        most = Math.max(most, live);
        await new Promise<void>((r) => release.push(r));
        live--;
        done.push(m.i);
      },
      { concurrency: 3 }
    );
    await until(() => live === 3);
    await sleep(30);
    // Three run; the other two are still in the queue, not held here.
    expect(live).toBe(3);
    expect(q.waiting).toHaveLength(2);
    expect(q.receives.every((r) => r.max <= 3)).toBe(true);
    release.splice(0).forEach((r) => r());
    await until(() => live === 2 && q.waiting.length === 0);
    release.splice(0).forEach((r) => r());
    await until(() => done.length === 5);
    expect(most).toBe(3);
    await until(() => q.deleted.length === 5);
  });

  it("keeps one at a time by default", async () => {
    const q = new FakeQueue();
    q.push({ i: 1 });
    q.push({ i: 2 });
    let live = 0;
    let most = 0;
    start<{ i: number }>(q, async () => {
      live++;
      most = Math.max(most, live);
      await sleep(20);
      live--;
    });
    await until(() => q.deleted.length === 2);
    expect(most).toBe(1);
  });

  it("extends a running message's visibility until its handler finishes, then deletes it", async () => {
    const q = new FakeQueue();
    const receipt = q.push({});
    start(q, async () => sleep(120), { heartbeatMs: 25, visibilityTimeout: 90 });
    await until(() => q.deleted.includes(receipt));
    const beats = q.visibility.filter((v) => v.receipt === receipt);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.every((b) => b.seconds === 90)).toBe(true);
    const after = q.visibility.length;
    await sleep(80);
    // No heartbeat after the handler finished.
    expect(q.visibility.length).toBe(after);
  });

  it("gives up on a handler that makes no progress, frees its place and returns its message", async () => {
    const q = new FakeQueue();
    const hung = q.push({ hang: true });
    const next = q.push({ hang: false });
    let signal: AbortSignal | undefined;
    start<{ hang: boolean }>(
      q,
      async (m, ctx) => {
        if (m.hang) {
          signal = ctx.signal;
          await new Promise(() => undefined); // never returns
        }
      },
      { stallMs: 60, heartbeatMs: 20 }
    );
    // One place: the second message runs only once the first is given up on.
    await until(() => q.deleted.includes(next));
    expect(signal?.aborted).toBe(true);
    expect(q.deleted).not.toContain(hung);
    expect(q.visibility.filter((v) => v.receipt === hung).at(-1)).toEqual({ receipt: hung, seconds: 30 });
    const beats = q.visibility.filter((v) => v.receipt === hung).length;
    await sleep(80);
    // Its heartbeat stopped with it.
    expect(q.visibility.filter((v) => v.receipt === hung).length).toBe(beats);
  });

  it("counts progress, its own or a metered call's, against the stall window", async () => {
    const q = new FakeQueue();
    const a = q.push({ via: "ctx" });
    const b = q.push({ via: "meter" });
    start<{ via: string }>(
      q,
      async (m, ctx) => {
        for (let i = 0; i < 8; i++) {
          await sleep(20);
          // A finished model call reports through the usage context.
          if (m.via === "ctx") ctx.progress();
          else noteProgress();
        }
      },
      { stallMs: 60, concurrency: 2 }
    );
    await until(() => q.deleted.includes(a) && q.deleted.includes(b));
    expect(q.visibility.filter((v) => v.seconds === 30)).toEqual([]);
  });

  it("pauses receiving after a budget stop and returns that message after the pause", async () => {
    const q = new FakeQueue();
    const receipt = q.push({});
    let calls = 0;
    start(
      q,
      async () => {
        calls++;
        throw new LlmBudgetExceededError("over");
      },
      { budgetPauseMs: 150 }
    );
    await until(() => calls === 1);
    const stoppedAt = Date.now();
    await sleep(100);
    // No receive during the pause.
    expect(q.receives.filter((r) => r.at > stoppedAt + 5)).toEqual([]);
    expect(q.visibility).toContainEqual({ receipt, seconds: 1 });
    expect(q.deleted).toEqual([]);
    await until(() => q.receives.some((r) => r.at >= stoppedAt + 140));
  });
});
