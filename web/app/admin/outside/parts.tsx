import type { ReactNode } from "react";
import { AccountApiError } from "@/lib/account-api";
import { british, fetchPublicAccount, type PublicAccount } from "@/lib/outside-api";
import { Banner, Pill, Tip } from "@/components/work/ui";
import "./outside.css";

// What every page about the public graph shares: the organisation's account
// there, read once per page (GET /outside/account), and the pill in the page's
// head that says whether this deployment is connected and as whom. A read that
// fails is said in one line on the page, never thrown.

/** A failed read, in one line: the API's own sentence where it gave one. */
export function problemOf(err: unknown, what: string): string {
  if (err instanceof AccountApiError) return `${what}: ${british(err.message)}`;
  return `${what}: the API did not answer. Reload in a moment.`;
}

/** Run a read, and say in one line what went wrong instead of throwing. */
export async function tryRead<T>(read: () => Promise<T>, what: string): Promise<{ data: T | null; problem: string | null }> {
  try {
    return { data: await read(), problem: null };
  } catch (err) {
    return { data: null, problem: problemOf(err, what) };
  }
}

export function loadAccount(externalId: string) {
  return tryRead<PublicAccount>(() => fetchPublicAccount(externalId), "The organisation's account on the public graph could not be read");
}

/** "Connected as <account>", or "Not connected" with the reason on hover. */
export function ConnectionPill({ account, problem }: { account: PublicAccount | null; problem?: string | null }) {
  if (account?.connected) {
    return (
      <Pill tone="ok" title="This deployment acts on the public graph under the organisation's own account there.">
        <span className="w-dot w-ok" aria-hidden />
        Connected as {account.account?.name ?? "the organisation's account"}
      </Pill>
    );
  }
  const why = account ? british(account.in_words ?? "This deployment is not connected to the public graph.") : (problem ?? "The account could not be read.");
  return (
    <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
      <Pill tone="warn">
        <span className="w-dot w-warn" aria-hidden />
        {account ? "Not connected" : "Connection unknown"}
      </Pill>
      <Tip>{why}</Tip>
    </span>
  );
}

/** The sub line of a page head: the pill, then a few words. */
export function HeadSub({ account, problem, children }: { account: PublicAccount | null; problem?: string | null; children?: ReactNode }) {
  return (
    <span className="w-row" style={{ gap: 10 }}>
      <ConnectionPill account={account} problem={problem} />
      {children && <span>{children}</span>}
    </span>
  );
}

/** A one-line banner: the shared Banner, with its words kept beside the icon however long they run. */
export function Note({ tone = "neu", children }: { tone?: "neu" | "warn" | "bad" | "ok"; children: ReactNode }) {
  return (
    <Banner tone={tone}>
      <span style={{ flex: "1 1 0", minWidth: 0 }}>{children}</span>
    </Banner>
  );
}
