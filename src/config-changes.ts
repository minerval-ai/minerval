/**
 * Being told that the configuration was made again (src/config.ts, "The
 * layers").
 *
 * A setting an administrator changes in the app is in force without a
 * restart because loadConfig() returns the configuration as it now is. A
 * module that made something from the old one and kept it (a provider's
 * client holds the key and the timeout it was made with) says here what to
 * drop when that happens.
 *
 * It is a module of its own, importing nothing, so that a module can listen
 * without loading the configuration, and a test that stands in for the
 * configuration need not stand in for this.
 */
const listeners = new Set<() => void>();

/** Be told when the configuration is made again. */
export function onConfigChange(listener: () => void): void {
  listeners.add(listener);
}

/** Tell every listener. One that fails keeps nothing back from the rest. */
export function configChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener drops something it kept; its failure is its own.
    }
  }
}
