import "server-only";
import { auth } from "../auth";
import { accountApiConfigured, accountFetch } from "./account-api";
import type { RunStep, RunStepSummary, RunSummary, WithheldRun } from "./types";

// A run that is not public is still its own account's to read when it
// worked only for that account: the Assistant's runs, the extension's, and
// a run over text the account handed in (the API decides, run-view-service.ts
// in the backend). The public reads in lib/api.ts are anonymous and cached,
// so a run page that gets a withheld run asks again as the signed-in reader.
// Nothing here is cached: what it returns is that reader's alone.

async function asReader<T>(path: string): Promise<T | null> {
  if (!accountApiConfigured()) return null;
  const session = await auth();
  if (!session?.externalId) return null;
  try {
    return await accountFetch<T>(path, { actingUser: session.externalId });
  } catch {
    return null;
  }
}

/** The run as the signed-in reader may read it, or null when they may not. */
export async function fetchOwnRun(id: string): Promise<RunSummary | null> {
  const r = await asReader<RunSummary | WithheldRun>(`/runs/${encodeURIComponent(id)}`);
  return r && !("withheld" in r) ? r : null;
}

export async function fetchOwnRunSteps(
  id: string,
): Promise<{ steps: RunStepSummary[]; next_after: number | null } | null> {
  const r = await asReader<{ steps: RunStepSummary[]; next_after: number | null } | WithheldRun>(
    `/runs/${encodeURIComponent(id)}/steps?limit=200`,
  );
  return r && "steps" in r ? r : null;
}

export async function fetchOwnRunStep(id: string, seq: number): Promise<RunStep | null> {
  const r = await asReader<RunStep | WithheldRun>(`/runs/${encodeURIComponent(id)}/steps/${seq}`);
  return r && "content" in r ? r : null;
}
