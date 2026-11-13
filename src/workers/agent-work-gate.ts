/**
 * The one place agent work starts (docs/deployment.md, "Preflight").
 *
 * src/index.ts hands this everything that takes work: the queue pollers,
 * the in-process runner with the engine executor, and the schedulers and
 * sweeps around them. They are started only once the gate is open
 * (agentWorkGate, src/preflight.ts). The API is not behind the gate: it
 * serves either way, so GET /setup/preflight can be read while work is held.
 *
 * On a deployment that holds only public material the gate is one read of
 * the labels and then open, so work starts as it always has.
 *
 * The gate is looked at again once a minute, because what it turns on is
 * data that changes while the process runs: a deployment defines its second
 * label, or applies the migrations it was behind on. Work that is running
 * is stopped when a deployment starts holding private material with a
 * blocking check failing, and work that was refused starts when the checks
 * pass. Each worker finishes the unit it has in hand when it is stopped.
 * The minute is not a limit on any agent: nothing an agent does waits on it.
 */
import {
  agentWorkGate,
  agentWorkRefusal,
  type AgentWorkGate,
} from "../preflight.js";

export interface Stoppable {
  stop: () => void;
}

export const GATE_RECHECK_MS = 60_000;

export function startGatedWork(options: {
  /** Start everything that takes work; called each time the gate opens. */
  start: () => Stoppable[];
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  gate?: () => Promise<AgentWorkGate>;
  recheckMs?: number;
}): Stoppable & {
  /** Look at the gate now. Resolves once work has been started, stopped or left as it was. */
  check: () => Promise<void>;
  /** Whether work is started. */
  running: () => boolean;
} {
  const gate = options.gate ?? agentWorkGate;
  let work: Stoppable[] | null = null;
  // Whether the running work was started as a private deployment's, which
  // means it has passed the blocking checks and need not be asked again.
  let passedAsPrivate = false;
  let lastSaid = "";
  let stopped = false;
  let checking: Promise<void> | null = null;

  const say = (line: string) => {
    // A refusal that has not changed is said once, not once a minute.
    if (line === lastSaid) return;
    lastSaid = line;
    options.logger.error(line);
  };

  const look = async () => {
    let verdict: AgentWorkGate;
    try {
      verdict = await gate();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // Work that is running is left running: a read that failed says
      // nothing new about the deployment. Work that has not started stays
      // unstarted, because an unread label is never taken to mean public.
      if (!work) {
        say(
          "Agent work is not started: it could not be told whether this deployment holds private material " +
            `(${why}). Looking again in ${Math.round((options.recheckMs ?? GATE_RECHECK_MS) / 1000)} seconds.`
        );
      }
      return;
    }
    if (stopped) return;
    if (verdict.open) {
      if (!work) {
        if (lastSaid) options.logger.info("The preflight's blocking checks pass; starting agent work.");
        lastSaid = "";
        work = options.start();
      }
      passedAsPrivate = verdict.holdsPrivate;
      return;
    }
    if (work) {
      for (const w of work) w.stop();
      work = null;
      options.logger.error("Agent work is stopped: this deployment now holds private material.");
    }
    passedAsPrivate = false;
    say(agentWorkRefusal(verdict.failed));
  };

  const check = (): Promise<void> => {
    // Work that passed the checks as a private deployment's keeps running;
    // nothing a later look could find is a reason to stop it mid-flight.
    if (work && passedAsPrivate) return Promise.resolve();
    checking ??= look().finally(() => {
      checking = null;
    });
    return checking;
  };

  void check();
  const timer = setInterval(() => void check(), options.recheckMs ?? GATE_RECHECK_MS);
  timer.unref();

  return {
    check,
    running: () => work !== null,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const w of work ?? []) w.stop();
      work = null;
    },
  };
}
