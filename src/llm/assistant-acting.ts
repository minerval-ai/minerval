/**
 * Marks work the Assistant does for its user (#646), so the few places that
 * owe a reader that fact can record it: a message to the Grantmaker that the
 * user's assistant wrote is shown as such, to the Grantmaker and to the
 * user. It changes nothing about what the call may do, which is whatever
 * the user's account may do.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<true>();

export function runAsAssistant<T>(fn: () => T): T {
  return storage.run(true, fn);
}

export function actingAsAssistant(): boolean {
  return storage.getStore() === true;
}
