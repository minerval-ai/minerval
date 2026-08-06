import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import {
  accountApiConfigured,
  fetchAccount,
  fetchOwlLedger,
  fetchUsage,
  listApiKeys,
  listAssessmentOrders,
  listBudgetJobs,
  AccountApiError,
  type AccountUser,
  type ApiKeyMeta,
  type AssessmentOrderView,
  type BudgetJobView,
  type OwlLedgerEntry,
  type OwlPack,
  type Entitlement,
  type UsageSummary,
} from "../../lib/account-api";
import { BuyOwls } from "./BuyOwls";
import { KeyCreator } from "./KeyCreator";
import { OwlMark } from "../../components/OwlMark";
import { revokeKeyAction, signOutAction } from "./actions";
import { fetchContributorProfile } from "../../lib/api";
import type { ContributorProfile } from "../../lib/types";

export const metadata: Metadata = { title: "Account · Minerval" };
export const dynamic = "force-dynamic";

function usd(micro: number): string {
  const dollars = micro / 1_000_000;
  return dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`;
}

/** Owls, trimmed: 5 → "5", 0.75 → "0.75", -0.1 → "−0.1". */
function owls(n: number): string {
  const s = Number(n.toFixed(3)).toString();
  return s.startsWith("-") ? s.replace("-", "\u2212") : s;
}

/** A ledger row's human line: what the entry was for. */
const LEDGER_REASONS: Record<string, string> = {
  purchase: "owls purchased",
  signup_grant: "signup grant",
  monthly_grant: "monthly grant",
  contribution_award: "earned by contribution",
  refund: "refunded",
  escrow_hold: "escrowed for funded work",
  claim_contribution: "put toward a claim's assessment",
  escrow_refund: "unspent escrow returned",
  admin_adjust: "adjustment",
};

const LEDGER_OPS: Record<string, string> = {
  assessment: "an assessment",
  claim_proposal: "a claim proposal",
  source_ingest: "a source submission",
  extension_analysis: "a page analysis",
  extension_chat: "an extension chat",
  text_analysis: "a text analysis",
};

function ledgerLabel(e: OwlLedgerEntry): string {
  const op = e.op ? (LEDGER_OPS[e.op] ?? e.op.replace(/_/g, " ")) : null;
  if (e.reason === "charge") return op ? `held for ${op}` : "held";
  if (e.reason === "meter_settlement") {
    return op ? `unused part returned from ${op}` : "unused part returned";
  }
  const reason = LEDGER_REASONS[e.reason] ?? e.reason.replace(/_/g, " ");
  return op ? `${reason} · ${op}` : reason;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toLocaleString("en-US");
}

function dateish(iso: string | null, whenAbsent = ""): string {
  if (!iso) return whenAbsent;
  return iso.slice(0, 10);
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string }>;
}) {
  const { purchase } = await searchParams;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  const externalId = session.externalId;

  if (!accountApiConfigured()) {
    return (
      <div className="col">
        <h1>Account</h1>
        <p>
          The frontend is not connected to a Minerval API (set{" "}
          <code>MINERVAL_API_URL</code>), so account data is unavailable.
        </p>
      </div>
    );
  }

  let user: AccountUser;
  let entitlement: Entitlement;
  let packs: OwlPack[];
  let usage: UsageSummary;
  let keys: ApiKeyMeta[];
  try {
    const [account, usageSummary, keyList] = await Promise.all([
      fetchAccount(externalId),
      fetchUsage(externalId, 30),
      listApiKeys(externalId),
    ]);
    user = account.user;
    entitlement = account.entitlement;
    packs = account.packs ?? [];
    usage = usageSummary;
    keys = keyList;
  } catch (err) {
    const detail =
      err instanceof AccountApiError ? err.message : "Unexpected error.";
    return (
      <div className="col">
        <h1>Account</h1>
        <p>
          Could not load your account from the API: <em>{detail}</em>
        </p>
      </div>
    );
  }

  // The user's own contribution history, from the same public profile data
  // anyone can see; absence (no contributions yet) just hides the table.
  const profile: ContributorProfile | null = await fetchContributorProfile(
    user.id
  );

  // Purchases are possible only when the API deployment has Stripe on; the
  // ledger (grants, charges, awards) exists either way.
  const creditsEnabled = entitlement.credits_enabled === true;
  let ledger: OwlLedgerEntry[] = [];
  let orders: AssessmentOrderView[] = [];
  let jobs: BudgetJobView[] = [];
  try {
    [ledger, orders, jobs] = await Promise.all([
      fetchOwlLedger(externalId),
      listAssessmentOrders(externalId),
      listBudgetJobs(externalId),
    ]);
  } catch {
    // A ledger hiccup shouldn't take down the whole account page.
  }

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);
  const caps = entitlement.caps_owls ?? {};

  return (
    <div className="col-wide account">
      <p className="claim-eyebrow">account</p>
      <div className="account-head">
        <h1>{user.display_name}</h1>
        <form action={signOutAction}>
          <button className="linklike" type="submit">
            sign out
          </button>
        </form>
      </div>
      <p className="account-meta">
        {user.email ?? "no email"} · {user.external_id} · member since{" "}
        {dateish(user.created_at)}
      </p>

      {/* ------------------------------------------------ owls */}
      <section>
        <h2>Owls</h2>
        {purchase === "success" && (
          <p className="key-reveal" role="status">
            Payment received. Your owls arrive as soon as Stripe confirms the
            purchase, usually within seconds; refresh if the balance
            hasn&rsquo;t moved yet.
          </p>
        )}
        {purchase === "cancelled" && (
          <p role="status">Purchase cancelled. Nothing was charged.</p>
        )}
        <p className="owl-balance">
          <OwlMark size={20} className="owl-mark" />
          <strong>{owls(entitlement.owl_balance)}</strong>{" "}
          owl{entitlement.owl_balance === 1 ? "" : "s"}
        </p>
        <p>
          The owl is Minerval&rsquo;s unit of account. Cost is measured in
          dollars, and one owl covers{" "}
          {usd(entitlement.owl_cost_micro_usd)} of metered work: enough for
          a full claim assessment by the best available model. Buying an owl
          costs {usd(entitlement.owl_price_micro_usd)}; the difference is
          the platform&rsquo;s whole margin, stated plainly, and it funds
          the graph&rsquo;s own standing mandates. Nothing has a fixed
          price. Each figure below is a ceiling,
          set near what the work usually costs: the ceiling is held when the
          work starts, the actual cost is metered as it runs, and the unused
          part returns to your balance when it finishes. Reading, searching,
          and browsing the graph are always free, and accepted contributions{" "}
          <em>earn</em> owls. New accounts start with{" "}
          {entitlement.signup_grant_owls} free owls
          {entitlement.monthly_grant_owls > 0 && (
            <>
              , plus {owls(entitlement.monthly_grant_owls)} more each month
            </>
          )}
          .
        </p>
        <table className="account-table">
          <thead>
            <tr>
              <th>action</th>
              <th>at most</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["propose a claim (reviewed, then assessed)", caps.claim_proposal],
              ["order a claim assessment", caps.assessment],
              ["submit a source for extraction", caps.source_ingest],
              ["extension page analysis", caps.extension_analysis],
              ["extension chat exchange", caps.extension_chat],
              ["API text analysis (match / extract / assess)", caps.text_analysis],
            ]
              .filter(([, cap]) => typeof cap === "number")
              .map(([label, cap]) => (
                <tr key={String(label)}>
                  <td>{label}</td>
                  <td>
                    <OwlMark size={14} className="owl-mark" />
                    {owls(Number(cap))} owl{Number(cap) === 1 ? "" : "s"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {creditsEnabled && packs.length > 0 && (
          <>
            <h3>Buy owls</h3>
            <BuyOwls packs={packs} />
          </>
        )}
        {ledger.length > 0 && (
          <>
            <h3>Owl history</h3>
            <table className="account-table">
              <thead>
                <tr>
                  <th>date</th>
                  <th>owls</th>
                  <th>what</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.id}>
                    <td>{dateish(e.created_at)}</td>
                    <td>
                      <OwlMark size={14} className="owl-mark" />
                      {owls(e.amount_micro_usd / entitlement.owl_cost_micro_usd)}
                    </td>
                    <td>
                      {e.claim_id ? (
                        <a href={`/claims/${e.claim_id}`}>{ledgerLabel(e)}</a>
                      ) : e.contribution_id ? (
                        <a href={`/contributions/${e.contribution_id}`}>
                          {ledgerLabel(e)}
                        </a>
                      ) : (
                        ledgerLabel(e)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* ------------------------------------------------ grants */}
      <section>
        <h2>Grants</h2>
        <p>
          A grant funds sustained attention on the part of the graph you care
          about, from a handful of claims to a whole literature. You describe
          the work to the Grantmaker, it drafts a mandate and quotes the cost
          in owls, and nothing is spent until you fund the plan.{" "}
          <a href="/account/grants">your grants →</a>
        </p>
      </section>

      {/* ------------------------------------------------ orders & jobs */}
      {(orders.length > 0 || jobs.length > 0) && (
        <section>
          <h2>Assessments you&rsquo;ve ordered</h2>
          {orders.length > 0 && (
            <table className="account-table">
              <thead>
                <tr>
                  <th>claim</th>
                  <th>status</th>
                  <th>owls</th>
                  <th>ordered</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <a href={`/claims/${o.claim_id}`}>view claim</a>
                    </td>
                    <td>{o.status.replace(/_/g, " ")}</td>
                    <td>
                      {o.charged
                        ? `up to ${owls(o.price_cap_owls)}`
                        : "not charged"}
                    </td>
                    <td>{dateish(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {jobs.length > 0 && (
            <>
              <h3>Funded jobs</h3>
              <table className="account-table">
                <thead>
                  <tr>
                    <th>job</th>
                    <th>status</th>
                    <th>budget</th>
                    <th>funded</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <a href={`/account/jobs/${j.id}`}>
                          {j.kind.replace(/_/g, " ")}
                        </a>
                      </td>
                      <td>{j.status.replace(/_/g, " ")}</td>
                      <td>
                        {owls(j.spent_owls)} / {owls(j.budget_owls)}
                      </td>
                      <td>{dateish(j.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {/* ------------------------------------------------ api keys */}
      <section>
        <h2>API keys</h2>
        <p>
          Keys authenticate requests to the Minerval API as you (header{" "}
          <code>x-api-key</code>). Create one for each surface, a CLI or the
          browser extension, so that each can be revoked on its own.
        </p>
        <KeyCreator />
        {activeKeys.length > 0 && (
          <table className="account-table">
            <thead>
              <tr>
                <th>name</th>
                <th>key</th>
                <th>created</th>
                <th>last used</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {activeKeys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.key_prefix}…</code>
                  </td>
                  <td>{dateish(k.created_at)}</td>
                  <td>{dateish(k.last_used_at, "never")}</td>
                  <td>
                    <form action={revokeKeyAction}>
                      <input type="hidden" name="key_id" value={k.id} />
                      <button className="linklike danger" type="submit">
                        revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {activeKeys.length === 0 && (
          <p className="account-empty">No active keys.</p>
        )}
        {revokedKeys.length > 0 && (
          <p className="account-empty">
            {revokedKeys.length} revoked key{revokedKeys.length > 1 ? "s" : ""}{" "}
            (usage history is preserved).
          </p>
        )}
      </section>

      {/* ------------------------------------------------ usage */}
      <section>
        <h2>Usage <span className="account-window">(last {usage.days} days)</span></h2>
        <div className="usage-chips">
          <span className="summary-chip">
            {usage.totals.calls.toLocaleString("en-US")} LLM calls
          </span>
          <span className="summary-chip">
            {tokens(usage.totals.input_tokens)} in /{" "}
            {tokens(usage.totals.output_tokens)} out
          </span>
          <span className="summary-chip">
            {tokens(usage.totals.cache_read_tokens)} cache reads
          </span>
          <span className="summary-chip">{usd(usage.totals.cost_micro_usd)}</span>
        </div>

        {usage.by_day.length > 0 ? (
          <>
            <table className="account-table">
              <thead>
                <tr>
                  <th>day</th>
                  <th>calls</th>
                  <th>input</th>
                  <th>output</th>
                  <th>cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.by_day.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{d.calls}</td>
                    <td>{tokens(d.input_tokens)}</td>
                    <td>{tokens(d.output_tokens)}</td>
                    <td>{usd(d.cost_micro_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>By agent</h3>
            <table className="account-table">
              <thead>
                <tr>
                  <th>agent</th>
                  <th>calls</th>
                  <th>input</th>
                  <th>output</th>
                  <th>cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.by_agent.map((a) => (
                  <tr key={a.agent}>
                    <td>{a.agent}</td>
                    <td>{a.calls}</td>
                    <td>{tokens(a.input_tokens)}</td>
                    <td>{tokens(a.output_tokens)}</td>
                    <td>{usd(a.cost_micro_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>By key</h3>
            <table className="account-table">
              <thead>
                <tr>
                  <th>key</th>
                  <th>calls</th>
                  <th>cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.by_key.map((k) => (
                  <tr key={k.api_key_id ?? "session"}>
                    <td>{k.key_name ?? "(session / no key)"}</td>
                    <td>{k.calls}</td>
                    <td>{usd(k.cost_micro_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="account-empty">
            No metered usage yet. Reads are free; usage appears here when you
            submit sources or propose claims through the API.
          </p>
        )}
      </section>

      {/* ------------------------------------------------ contributor half */}
      <section>
        <h2>Contributor standing</h2>
        <p>
          The same account is your contributor identity:{" "}
          <a href={`/contributors/${user.id}`}>public profile</a>.
        </p>
        <div className="usage-chips">
          <span className="summary-chip">
            {owls(user.owls_earned)} owls earned
          </span>
          <span className="summary-chip">
            reputation {user.reputation_score.toFixed(0)} ({user.trust_level})
          </span>
          <span className="summary-chip">
            {user.contributions_accepted} accepted ·{" "}
            {user.contributions_rejected} rejected ·{" "}
            {user.contributions_escalated} escalated
          </span>
        </div>
        <p>
          Good-faith contribution is always free: a sincere contribution that
          is rejected costs nothing, and any proposal charge is refunded.
          Accepted contributions raise reputation and earn spendable owls in
          proportion to the importance of the claim they improve, so the
          contributors who build the graph gain real say over what it
          assesses next.
        </p>
        {profile && profile.recent_contributions.length > 0 && (
          <>
            <h3>Recent contributions</h3>
            <p>
              Each decision is recorded with its reasoning on the
              contribution&rsquo;s public record.
            </p>
            <table className="account-table">
              <thead>
                <tr>
                  <th>type</th>
                  <th>status</th>
                  <th>submitted</th>
                  <th aria-label="record" />
                </tr>
              </thead>
              <tbody>
                {profile.recent_contributions.map((r) => (
                  <tr key={r.id}>
                    <td>{r.contribution_type.replace(/_/g, " ")}</td>
                    <td>{r.review_status.replace(/_/g, " ")}</td>
                    <td>{dateish(r.submitted_at)}</td>
                    <td>
                      <a href={`/contributions/${r.id}`}>view record</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {user.contribution_standing === "must_pay" && (
          <p>
            <strong>Contribution paused:</strong> a contribution from this
            account was flagged as suspected bad faith, which moves the
            account to pay-to-contribute standing. Deposits are not yet
            available, so contributing is paused for now. The flag is
            appealable (<code>POST /appeals</code>), and a successful appeal
            restores your standing, reputation, and owls in full.
          </p>
        )}
      </section>
    </div>
  );
}
