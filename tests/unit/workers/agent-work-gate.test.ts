/**
 * The seam agent work starts behind (src/workers/agent-work-gate.ts): what
 * it starts, holds and stops as the gate's answer changes, and what it logs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { startGatedWork } from "../../../src/workers/agent-work-gate.js";
import type { AgentWorkGate } from "../../../src/preflight.js";

const OPEN_PUBLIC: AgentWorkGate = { open: true, holdsPrivate: false, failed: [] };
const OPEN_PRIVATE: AgentWorkGate = { open: true, holdsPrivate: true, failed: [] };
const CLOSED: AgentWorkGate = {
  open: false,
  holdsPrivate: true,
  failed: [
    { name: "run_log", status: "fail", blocking: true, message: "The run log is in best-effort mode." },
    { name: "reports_stay_inside", status: "fail", blocking: true, message: "Reports are filed outside." },
  ],
};

function harness(answers: Array<AgentWorkGate | Error>) {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const start = vi.fn(() => {
    const stop = vi.fn();
    stops.push(stop);
    return [{ stop }];
  });
  const logger = { info: vi.fn(), error: vi.fn() };
  let asked = 0;
  const gate = vi.fn(async () => {
    const answer = answers[Math.min(asked++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  // The timer is far off: each look is asked for by the test.
  const work = startGatedWork({ start, logger, gate, recheckMs: 3_600_000 });
  return { work, start, stops, logger, gate };
}

let running: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const w of running) w.stop();
  running = [];
});

describe("startGatedWork", () => {
  it("starts work at once on a deployment that holds only public material, and logs nothing", async () => {
    const h = harness([OPEN_PUBLIC]);
    running.push(h.work);
    await h.work.check();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.work.running()).toBe(true);
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.logger.info).not.toHaveBeenCalled();
    // Looked at again, it is still open and nothing is started twice.
    await h.work.check();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("refuses to start while a blocking check fails, naming each failed check once", async () => {
    const h = harness([CLOSED]);
    running.push(h.work);
    await h.work.check();
    await h.work.check();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.work.running()).toBe(false);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.logger.error.mock.calls[0]![0]).toBe(
      "Agent work is not started: this deployment holds private material and 2 preflight checks that must pass " +
        "first have failed. run_log: The run log is in best-effort mode. reports_stay_inside: Reports are filed " +
        "outside. The API is serving, so GET /setup/preflight and `npm run preflight` show every check."
    );
  });

  it("starts the work it refused once the checks pass, and then stops asking", async () => {
    const h = harness([CLOSED, OPEN_PRIVATE]);
    running.push(h.work);
    await h.work.check();
    expect(h.start).not.toHaveBeenCalled();
    await h.work.check();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith("The preflight's blocking checks pass; starting agent work.");
    const asked = h.gate.mock.calls.length;
    await h.work.check();
    expect(h.gate.mock.calls.length).toBe(asked);
  });

  it("stops running work when the deployment starts holding private material with a blocking check failing", async () => {
    const h = harness([OPEN_PUBLIC, CLOSED]);
    running.push(h.work);
    await h.work.check();
    expect(h.work.running()).toBe(true);
    await h.work.check();
    expect(h.stops[0]).toHaveBeenCalledTimes(1);
    expect(h.work.running()).toBe(false);
    expect(h.logger.error.mock.calls.map((c) => c[0])).toEqual([
      "Agent work is stopped: this deployment now holds private material.",
      expect.stringContaining("Agent work is not started"),
    ]);
  });

  it("does not start while the labels cannot be read, and starts when they can", async () => {
    const h = harness([new Error("connection refused"), OPEN_PUBLIC]);
    running.push(h.work);
    await h.work.check();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.logger.error.mock.calls[0]![0]).toBe(
      "Agent work is not started: it could not be told whether this deployment holds private material " +
        "(connection refused). Looking again in 3600 seconds."
    );
    await h.work.check();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("leaves running work running when a later look cannot read the labels", async () => {
    const h = harness([OPEN_PUBLIC, new Error("connection refused")]);
    running.push(h.work);
    await h.work.check();
    await h.work.check();
    expect(h.work.running()).toBe(true);
    expect(h.stops[0]).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("stops what it started, and starts nothing afterwards", async () => {
    const h = harness([OPEN_PUBLIC]);
    await h.work.check();
    h.work.stop();
    expect(h.stops[0]).toHaveBeenCalledTimes(1);
    expect(h.work.running()).toBe(false);
  });
});
