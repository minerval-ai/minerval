/**
 * A single observer shown the text of every statement db/client.ts sends,
 * before it runs. The usage context registers one to mark the open agent run
 * when it writes to the graph (db/graph-writes.ts).
 *
 * Its own module, with no imports, so the client and the usage context can
 * both reach it without either importing the other, and so tests that mock
 * the client keep the registry intact.
 */
let observer: ((sql: string) => void) | null = null;

export function setStatementObserver(fn: ((sql: string) => void) | null): void {
  observer = fn;
}

/** Show `sql` to the observer. Never throws: observation must not fail a query. */
export function observeStatement(sql: string): void {
  if (!observer) return;
  try {
    observer(sql);
  } catch {
    // Swallowed on purpose.
  }
}
