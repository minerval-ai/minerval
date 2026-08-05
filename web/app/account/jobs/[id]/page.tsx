import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  getBudgetJob,
  type BudgetJobView,
} from "../../../../lib/account-api";
import { cancelJobAction } from "../../actions";
import { TopUpJob } from "./TopUpJob";

export const metadata: Metadata = { title: "Funded job — Minerval" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  deep_decomposition: "deep decomposition",
};

const STATUS_LINES: Record<string, string> = {
  running:
    "Running — a Steward is working through the subtree, one claim at a time.",
  paused_budget:
    "Paused — the budget is spent. Top up below to continue exactly where it left off; nothing is lost.",
  completed:
    "Completed — the subtree is fully stewarded. Any unspent budget has been returned to your balance.",
  cancelled:
    "Cancelled — the unspent budget has been returned to your balance.",
  failed: "Failed — see the error below. Unspent budget was returned.",
};

function owls(n: number): string {
  return Number(n.toFixed(3)).toString();
}

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  if (!accountApiConfigured()) notFound();

  let job: BudgetJobView;
  try {
    job = await getBudgetJob(session.externalId, id);
  } catch {
    notFound();
  }

  const spentShare =
    job.budget_owls > 0 ? Math.min(1, job.spent_owls / job.budget_owls) : 1;
  const cp = job.checkpoint;
  const open = job.status === "running" || job.status === "paused_budget";

  return (
    <div className="col account">
      <p className="claim-eyebrow">
        <Link href="/account">← account</Link>
      </p>
      <h1>{KIND_LABELS[job.kind] ?? job.kind}</h1>
      {job.claim_id && (
        <p className="account-meta">
          on <Link href={`/claims/${job.claim_id}`}>this claim</Link> and its
          subtree · funded {job.created_at.slice(0, 10)}
        </p>
      )}

      <section>
        <h2>Status</h2>
        <p>{STATUS_LINES[job.status] ?? job.status}</p>
        <div className="meter" aria-hidden>
          <div className="meter-fill" style={{ width: `${spentShare * 100}%` }} />
        </div>
        <p className="meter-caption">
          {owls(job.spent_owls)} of {owls(job.budget_owls)} owls spent
        </p>
        {job.error && <p className="form-error">{job.error}</p>}
      </section>

      <section>
        <h2>Progress</h2>
        {cp ? (
          <>
            <div className="usage-chips">
              <span className="summary-chip">
                {cp.assessed ?? 0} claim{(cp.assessed ?? 0) === 1 ? "" : "s"}{" "}
                stewarded
              </span>
              {cp.subtree && (
                <>
                  <span className="summary-chip">
                    {cp.subtree.done} done in subtree
                  </span>
                  <span className="summary-chip">
                    {cp.subtree.pending + cp.subtree.deferred} waiting
                  </span>
                </>
              )}
            </div>
            {cp.note && <p>{cp.note}</p>}
            {cp.last_claim_id && (
              <p>
                <Link href={`/claims/${cp.last_claim_id}`}>
                  most recently stewarded claim →
                </Link>
              </p>
            )}
          </>
        ) : (
          <p className="account-empty">
            No progress recorded yet — the job starts on the next worker pass.
          </p>
        )}
      </section>

      {open && (
        <section>
          <h2>Manage</h2>
          <TopUpJob jobId={job.id} paused={job.status === "paused_budget"} />
          <form action={cancelJobAction} style={{ marginTop: "0.8rem" }}>
            <input type="hidden" name="job_id" value={job.id} />
            <button className="linklike danger" type="submit">
              cancel job and refund unspent budget
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
