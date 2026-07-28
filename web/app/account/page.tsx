import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import {
  accountApiConfigured,
  fetchAccount,
  fetchUsage,
  listApiKeys,
  AccountApiError,
  type AccountUser,
  type ApiKeyMeta,
  type Entitlement,
  type UsageSummary,
} from "../../lib/account-api";
import { KeyCreator } from "./KeyCreator";
import { revokeKeyAction, signOutAction } from "./actions";
import { fetchContributorProfile } from "../../lib/api";
import type { ContributorProfile } from "../../lib/types";

export const metadata: Metadata = { title: "Account — Minerval" };
export const dynamic = "force-dynamic";

function usd(micro: number): string {
  const dollars = micro / 1_000_000;
  return dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toLocaleString("en-US");
}

function dateish(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export default async function AccountPage() {
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

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);
  const grant = entitlement.monthly_grant_micro_usd;
  const usedShare =
    grant > 0 ? Math.min(1, entitlement.used_micro_usd / grant) : 1;

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

      {/* ------------------------------------------------ plan / allowance */}
      <section>
        <h2>Plan</h2>
        <p>
          <strong>Free tier.</strong> Reading, search, and browsing the graph
          are free and unmetered. LLM-backed requests — submitting sources for
          extraction, proposing claims, and the coming browser-extension and
          query features — draw on a monthly allowance of{" "}
          <strong>{usd(grant)}</strong> in model cost. Paid credits are not
          available yet; the allowance resets monthly.
        </p>
        <div className="meter" aria-hidden>
          <div className="meter-fill" style={{ width: `${usedShare * 100}%` }} />
        </div>
        <p className="meter-caption">
          {usd(entitlement.used_micro_usd)} of {usd(grant)} used this month ·{" "}
          {usd(entitlement.remaining_micro_usd)} remaining
        </p>
      </section>

      {/* ------------------------------------------------ api keys */}
      <section>
        <h2>API keys</h2>
        <p>
          Keys authenticate requests to the Minerval API as you (header{" "}
          <code>x-api-key</code>). Create one per surface — a CLI, the browser
          extension — so each can be revoked independently.
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
                  <td>{dateish(k.last_used_at)}</td>
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
          The same account is your contributor identity —{" "}
          <a href={`/contributors/${user.id}`}>public profile</a>.
        </p>
        <div className="usage-chips">
          <span className="summary-chip">{user.kudos} kudos</span>
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
          Good-faith contribution is always free — a rejected-but-sincere
          contribution costs nothing. Accepted contributions raise reputation
          and earn kudos in proportion to the importance of the claim they
          improve.
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
            available, so contributing is paused — but the flag is appealable
            (<code>POST /appeals</code>), and a successful appeal restores
            your standing, reputation, and kudos in full.
          </p>
        )}
      </section>
    </div>
  );
}
