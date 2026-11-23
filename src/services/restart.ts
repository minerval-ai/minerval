/**
 * Starting the API again from the app (docs/settings.md, "In force").
 *
 * Some settings are read only where the process starts. An administrator
 * who has changed one ends the API's process here; whatever runs the
 * deployment starts it again (the Compose file's `restart: unless-stopped`,
 * an orchestrator's own rule), and the new process reads the settings as
 * they now are.
 *
 * The process is ended the way the machine would end it: with the signal
 * its shutdown already answers (src/index.ts), so requests in flight are
 * given their time and every run in flight hands its claim back.
 */

/** How long after the answer is sent the process is told to stop, so the answer leaves first. */
const RESTART_DELAY_MS = 500;

let endProcess: () => void = () => {
  process.kill(process.pid, "SIGTERM");
};

/** For a test: what stands in for ending the process. Returns the function that was there. */
export function setProcessEnder(fn: () => void): () => void {
  const before = endProcess;
  endProcess = fn;
  return before;
}

/** End this process shortly, to be started again. */
export function endProcessSoon(): void {
  setTimeout(() => endProcess(), RESTART_DELAY_MS).unref();
}
