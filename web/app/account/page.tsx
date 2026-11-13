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
  listGrants,
  AccountApiError,
  type AccountUser,
  type ApiKeyMeta,
  type AssessmentOrderView,
  type BudgetJobView,
  type GrantView,
  type OwlLedgerEntry,
  type OwlPack,
  type Entitlement,
  type UsageSummary,
} from "../../lib/account-api";
import { BuyOwls } from "./BuyOwls";
import { KeyCreator } from "./KeyCreator";
import { OwlMark } from "../../components/OwlMark";
import { OwlHistory, type JobName } from "../../components/account/OwlHistory";
import { PrizeAward } from "../../components/account/PrizeAward";
import { UsageCharts } from "../../components/account/UsageCharts";
import { revokeKeyAction, signOutAction } from "./actions";
import { fetchClaimTexts, fetchContributorProfile } from "../../lib/api";
import { clip, dateish, owlParts, owls, tokens, usd, words } from "../../lib/account-format";
import { loadFeatures } from "../../lib/data";
import { featureOn } from "../../lib/features";
import type { ContributorProfile, OpenPrizeClaim } from "../../lib/types";
import { MastheadHeight } from "@/components/MastheadHeight";
import { PageHead } from "@/components/PageHead";
import { grantText, listed } from "../../lib/admin-words";
import { loadStanding } from "../../lib/standing";

export const metadata: Metadata = { title: "Account · Minerval" };
export const dynamic = "force-dynamic";

// How much of the ledger the history reads: the most the API returns in one
// read, so that a hold and the return from it are both in hand and the
// history can be paged through here. The page shows a screenful at a time.
const LEDGER_ENTRIES = 500;
// How many ordered assessments are listed before the rest fold away.
const ORDERS_SHOWN = 6;

/** A job still holding owls in escrow: at work, or paused at its budget. */
function isOpen(job: BudgetJobView): boolean {
  return job.status === "running" || job.status === "paused_budget";
}

/** An amount of owls with its fraction set smaller (lib/account-format.ts, owlParts). */
function OwlFigure({ value }: { value: number }) {
  const { whole, fraction } = owlParts(value);
  return (
    <>
      {whole}
      {fraction && <span className="acct-fraction">{fraction}</span>}
    </>
  );
}

function sentence(s: string): string {
  const w = words(s);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string; return?: string; history?: string; hp?: string }>;
}) {
  const { purchase, return: back, history, hp } = await searchParams;
  const historyPage = Number.isInteger(Number(hp)) && Number(hp) > 1 ? Number(hp) : 1;
  // Sent here to buy owls for something (a decomposition the balance could
  // not cover): checkout brings the reader back there. Same-site paths only.
  const returnTo = back && /^\/(?![\/\\])/.test(back) ? back : null;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  const externalId = session.externalId;

  if (!accountApiConfigured()) {
    return (
      <div className="col">
        <PageHead title="Account" />
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
  let prizeClaims: OpenPrizeClaim[];
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
    prizeClaims = account.open_prize_claims ?? [];
  } catch (err) {
    const detail =
      err instanceof AccountApiError ? err.message : "Unexpected error.";
    return (
      <div className="col">
        <PageHead title="Account" />
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
  let grants: GrantView[] = [];
  // A ledger hiccup shouldn't take down the whole account page, and one
  // list failing shouldn't take the others with it.
  [ledger, orders, jobs, grants] = await Promise.all([
    fetchOwlLedger(externalId, LEDGER_ENTRIES).catch(() => []),
    listAssessmentOrders(externalId).catch(() => []),
    listBudgetJobs(externalId).catch(() => []),
    listGrants(externalId).catch(() => []),
  ]);

  // Names for what the lists hold by id: a claim by its wording, a job by
  // its grant's name or by what it does to which claim.
  const recent = profile?.recent_contributions ?? [];
  const claimTexts = await fetchClaimTexts(
    [
      ...ledger.map((e) => e.claim_id),
      ...orders.map((o) => o.claim_id),
      ...jobs.map((j) => j.claim_id),
      ...recent.map((r) => r.claim_id),
    ].filter((id): id is string => typeof id === "string")
  );
  const grantByJob = new Map(grants.map((g) => [g.budget_job_id, g]));
  const jobNames = new Map<string, JobName>(
    jobs.map((j) => {
      const grant = grantByJob.get(j.id);
      if (grant) {
        return [j.id, { name: grant.name, href: `/account/grants/${grant.id}`, grant: true }];
      }
      const claim = j.claim_id ? claimTexts.get(j.claim_id) : undefined;
      const kind = sentence(j.kind);
      return [
        j.id,
        { name: claim ? `${kind}: ${claim}` : kind, href: `/account/jobs/${j.id}`, grant: false },
      ];
    })
  );
  const openJobs = jobs.filter(isOpen);
  const closedJobs = jobs.filter((j) => !isOpen(j));
  const escrowLeft = openJobs.reduce((n, j) => n + Math.max(0, j.budget_owls - j.spent_owls), 0);
  const escrowed = openJobs.reduce((n, j) => n + j.budget_owls, 0);

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);
  const caps = entitlement.caps_owls ?? {};
  // What the account shows about an optional part of the product goes with
  // that part: the extension's price rows, and the prize sections, whose
  // forms post to routes that do not exist where prizes are off. The ledger
  // below is left whole, because it is a record of what was charged and
  // paid, whatever is switched on today.
  const features = await loadFeatures();
  const extensionOn = featureOn(features, "extension");
  const prizesOn = featureOn(features, "prizes");


  const usageByKey = new Map(usage.by_key.map((k) => [k.api_key_id, k]));
  const sessionUsage = usageByKey.get(null) ?? null;
  const activeKeyIds = new Set(activeKeys.map((k) => k.id));
  // Usage in the window by keys since revoked: counted in the totals, so it
  // is said here, where the table has no row for it.
  const revokedUsage = usage.by_key.filter((k) => k.api_key_id && !activeKeyIds.has(k.api_key_id));
  // A deployment that creates its own owls sells none: there is no buying
  // there, and what an owl is comes in the API's own words
  // (entitlement.owls_statement; docs/accounts.md, "Owls a deployment creates
  // for itself").
  const createdHere = entitlement.owls_created_here === true;
  const canBuy = !createdHere && creditsEnabled && packs.length > 0;
  // What the person holds in a members-only deployment. Nothing on the
  // public graph, where this is not read.
  const standing = await loadStanding();
  const held = standing.state === "signed_in" ? standing.mine.grants : [];
  const priceRows = [
    ["Propose a claim (reviewed, then assessed)", caps.claim_proposal],
    ["Order a claim assessment", caps.assessment],
    ["Submit a source for extraction", caps.source_ingest],
    ...(extensionOn ? [["Extension page analysis", caps.extension_analysis]] : []),
    ["API text analysis (match, extract, assess)", caps.text_analysis],
  ].filter((row): row is [string, number] => typeof row[1] === "number");
  const contributionDays = [...new Set(recent.map((r) => dateish(r.submitted_at)))];

  return (
    <div className="account-home">
      <MastheadHeight />
      <PageHead
        kicker="Account"
        title={user.display_name}
        actions={
          <form action={signOutAction}>
            <button className="linklike" type="submit">
              sign out
            </button>
          </form>
        }
        meta={
          <>
            {user.email ?? "no email"} · {user.external_id} · member since{" "}
            {dateish(user.created_at)} · <a href={`/contributors/${user.id}`}>public profile</a>
          </>
        }
      />

      {held.length > 0 && (
        <p className="acct-prose acct-measure" id="permissions">
          In this deployment you hold the permission to {listed([...new Set(held.map(grantText))])}.{" "}
          <a href="/admin/people">Who may do what, and the log of every grant →</a>
        </p>
      )}

      {purchase === "success" && (
        <p className="key-reveal" role="status">
          Payment received. Your owls arrive as soon as Stripe confirms the purchase, usually
          within seconds; refresh if the balance hasn&rsquo;t moved yet.
        </p>
      )}
      {purchase === "cancelled" && <p role="status">Purchase cancelled. Nothing was charged.</p>}
      {user.contribution_standing === "must_pay" && (
        <p className="key-reveal" role="status">
          <strong>Contribution paused:</strong> a contribution from this account was flagged as
          suspected bad faith, which moves the account to pay-to-contribute standing. Deposits
          are not yet available, so contributing is paused for now. The flag is appealable (
          <code>POST /appeals</code>), and a successful appeal restores your standing,
          reputation, and owls in full.
        </p>
      )}

      {/* ------------------------------------------------ the four figures */}
      <section className="acct-figures" aria-label="Summary">
        <div className="acct-figure">
          <div className="sc">Balance</div>
          <p className="acct-balance">
            <OwlMark size={30} />
            <strong>
              <OwlFigure value={entitlement.owl_balance} />
            </strong>
            <span className="acct-unit">owl{entitlement.owl_balance === 1 ? "" : "s"}</span>
          </p>
          <p className="acct-figure-note">
            {canBuy && (
              <a className="acct-buy" href="#buy-owls">
                Buy owls
              </a>
            )}
            free to spend now
          </p>
        </div>
        <div className="acct-figure">
          <div className="sc">Held in running work</div>
          <p className="acct-figure-value">
            <OwlFigure value={escrowLeft} />
          </p>
          <p className="acct-figure-note">
            {openJobs.length > 0 ? (
              <>
                left of {owls(escrowed)} escrowed across{" "}
                <a href="#work">
                  {openJobs.length} open job{openJobs.length === 1 ? "" : "s"}
                </a>
                . What they don&rsquo;t spend returns to your balance.
              </>
            ) : (
              <>Nothing is in escrow. A grant or a funded job holds its budget here.</>
            )}
          </p>
        </div>
        <div className="acct-figure">
          <div className="sc">Metered work · {usage.days} days</div>
          <p className="acct-figure-value">{usd(usage.totals.cost_micro_usd)}</p>
          <p className="acct-figure-note">
            {usage.totals.calls.toLocaleString("en-US")} model calls on your account.{" "}
            <a href="#usage">By day and by agent</a>
          </p>
        </div>
        <div className="acct-figure">
          <div className="sc">Contributor standing</div>
          <p className="acct-figure-value">
            {user.reputation_score.toFixed(0)} <span className="acct-unit">{user.trust_level}</span>
          </p>
          <p className="acct-figure-note">
            {user.contributions_accepted} contribution{user.contributions_accepted === 1 ? "" : "s"}{" "}
            accepted, {user.contributions_rejected} rejected.{" "}
            <a href="#contributions">Recent decisions</a>
          </p>
        </div>
      </section>

      <nav className="acct-nav" aria-label="On this page">
        <a href="#owls">Owls</a>
        {prizesOn && prizeClaims.length > 0 && <a href="#prizes">Prizes</a>}
        <a href="#work">Funded work</a>
        <a href="#usage">Usage</a>
        <a href="#keys">API keys</a>
        <a href="#contributions">Contributions</a>
      </nav>

      {/* ------------------------------------------------ owls */}
      <section className="acct-section" id="owls">
        <div className="acct-cols acct-cols-flush">
          <div className="acct-main">
            <OwlHistory
              entries={ledger}
              view={history === "entries" ? "entries" : "work"}
              limit={LEDGER_ENTRIES}
              page={historyPage}
              owlCost={entitlement.owl_cost_micro_usd}
              claimTexts={claimTexts}
              jobNames={jobNames}
            />
            {ledger.length === 0 && <p className="account-empty">No owl history yet.</p>}
          </div>

          <aside className="acct-side">
            {canBuy && (
              <>
                <div className="acct-head" id="buy-owls">
                  <h2>Buy owls</h2>
                </div>
                {returnTo && (
                  <p className="meter-caption">
                    Your balance did not cover what you were funding. Once the purchase goes
                    through you will be taken back to it.
                  </p>
                )}
                <BuyOwls packs={packs} returnTo={returnTo} />
              </>
            )}
            <h3 className={canBuy ? "acct-gap" : undefined}>What an owl is</h3>
            {createdHere ? (
              <>
                <p className="acct-prose">{entitlement.owls_statement}</p>
                <p className="acct-prose">
                  To add to your balance, ask an administrator of this deployment. How many owls
                  have been created, by whom, and what the agents&rsquo; runs have spent is open
                  to every member on <a href="/admin/owls">the Owls page →</a>
                </p>
              </>
            ) : (
              <p className="acct-prose">
                One owl covers {usd(entitlement.owl_cost_micro_usd)} of metered work, enough for a
                full claim assessment by the best available model. Buying one costs{" "}
                {usd(entitlement.owl_price_micro_usd)}. The difference is the platform&rsquo;s
                whole margin, and it funds the graph&rsquo;s own standing mandates.
              </p>
            )}
            <p className="acct-prose">
              Nothing has a fixed price. The figures below are ceilings: the ceiling is held
              when work starts, the cost is metered as it runs, and the unused part returns.
            </p>
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>action</th>
                  <th className="acct-num">at most</th>
                </tr>
              </thead>
              <tbody>
                {priceRows.map(([label, cap]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="acct-num">
                      {owls(cap)} owl{cap === 1 ? "" : "s"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {createdHere ? (
              <p className="acct-note">Reading, searching and browsing the graph are free.</p>
            ) : (
              <p className="acct-note">
                Reading, searching and browsing the graph are free. Accepted contributions{" "}
                <em>earn</em> owls. New accounts start with {entitlement.signup_grant_owls} free
                owls
                {entitlement.monthly_grant_owls > 0 && (
                  <>, and every account gets {owls(entitlement.monthly_grant_owls)} more each month</>
                )}
                .
              </p>
            )}
          </aside>
        </div>
      </section>

      {/* ------------------------------------------------ prizes (§8.7) */}
      {prizesOn && prizeClaims.length > 0 && (
        <section className="acct-section" id="prizes">
          <div className="acct-head">
            <h2>Prizes</h2>
          </div>
          <p className="acct-prose acct-measure">
            A prize is offered for a machine-checked proof or disproof of a claim&rsquo;s formal
            statement. It is paid in owls, one owl per dollar, once the checker, the
            claim&rsquo;s steward, and the public challenge window have all passed it, and once
            the winner has completed the three steps below.
          </p>
          <PrizeAward claims={prizeClaims} />
        </section>
      )}

      {/* ------------------------------------------------ grants, jobs, orders, the Assistant */}
      <section className="acct-section" id="work">
        <div className="acct-head">
          <h2>Funded work</h2>
          <nav className="acct-links" aria-label="More of your funded work">
            <a href="/account/grants">All your grants →</a>
            <a href="/ask">The Assistant →</a>
          </nav>
        </div>
        <div className="acct-cols">
          <div className="acct-main">
            <div className="acct-sub">
              <h3>Running now</h3>
              {openJobs.length > 0 && <span className="acct-note">spent of budget, in owls</span>}
            </div>
            {openJobs.map((j) => {
              const name = jobNames.get(j.id)!;
              const pct = j.budget_owls > 0 ? Math.min(100, (j.spent_owls / j.budget_owls) * 100) : 0;
              return (
                <div className="acct-job" key={j.id}>
                  <div className="acct-job-head">
                    <div>
                      <a href={name.href}>{clip(name.name)}</a>
                      <span className="acct-detail">
                        {j.status === "paused_budget" ? "paused at its budget" : words(j.status)} ·
                        funded {dateish(j.created_at)}
                      </span>
                    </div>
                    <div className="acct-amount">
                      <strong>{owls(j.spent_owls)}</strong>{" "}
                      <span className="acct-quiet">of {owls(j.budget_owls)}</span>
                    </div>
                  </div>
                  <div
                    className="meter"
                    role="img"
                    aria-label={`${pct.toFixed(0)} percent of the budget spent`}
                  >
                    <div className="meter-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="acct-note">
                    {owls(Math.max(0, j.budget_owls - j.spent_owls))} owls left in escrow
                  </div>
                </div>
              );
            })}
            {openJobs.length === 0 && (
              <p className="account-empty">Nothing is running on your owls right now.</p>
            )}
            <p className="acct-prose acct-measure">
              A grant funds sustained attention on the part of the graph you care about, from a
              handful of claims to a whole literature. You describe the work to the Grantmaker,
              it drafts a mandate and quotes the cost in owls, and nothing is spent until you
              fund the plan. <a href="/account/grants/new">Start a grant →</a>
            </p>
            <p className="acct-prose acct-measure">
              The Assistant is an agent that works for you with this account&rsquo;s tools,
              charged in owls at what its work costs. Its conversations, the pages it saved for
              you, and what it may do without asking are on <a href="/ask">the Ask page →</a>
            </p>
            {closedJobs.length > 0 && (
              <details className="acct-asTable">
                <summary>
                  {closedJobs.length} finished job{closedJobs.length === 1 ? "" : "s"}
                </summary>
                {closedJobs.map((j) => {
                  const name = jobNames.get(j.id)!;
                  return (
                    <div className="acct-line" key={j.id}>
                      <div>
                        <a href={name.href}>{clip(name.name)}</a>
                        <span className="acct-detail">
                          {words(j.status)} · funded {dateish(j.created_at)}
                        </span>
                      </div>
                      <div className="acct-amount">
                        {owls(j.spent_owls)} <span className="acct-quiet">of {owls(j.budget_owls)}</span>
                      </div>
                    </div>
                  );
                })}
              </details>
            )}
          </div>

          <div className="acct-side">
            <div className="acct-sub">
              <h3>Assessments ordered</h3>
              {orders.length > 0 && <span className="acct-note">cost in owls</span>}
            </div>
            {orders.length === 0 && (
              <p className="account-empty">
                None yet. Any claim&rsquo;s page can order its assessment.
              </p>
            )}
            {orders.slice(0, ORDERS_SHOWN).map((o) => (
              <OrderLine key={o.id} order={o} text={claimTexts.get(o.claim_id)} />
            ))}
            {orders.length > ORDERS_SHOWN && (
              <details className="acct-asTable">
                <summary>{orders.length - ORDERS_SHOWN} earlier</summary>
                {orders.slice(ORDERS_SHOWN).map((o) => (
                  <OrderLine key={o.id} order={o} text={claimTexts.get(o.claim_id)} />
                ))}
              </details>
            )}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ usage */}
      <section className="acct-section" id="usage">
        <div className="acct-head">
          <h2>
            Usage <span className="account-window">last {usage.days} days</span>
          </h2>
          <span className="acct-note">
            {tokens(usage.totals.input_tokens)} tokens in · {tokens(usage.totals.output_tokens)} out ·{" "}
            {tokens(usage.totals.cache_read_tokens)} cache reads
          </span>
        </div>
        {usage.by_day.length > 0 ? (
          <UsageCharts usage={usage} today={new Date()} />
        ) : (
          <p className="account-empty">
            No metered usage yet. Reads are free; usage appears here when you submit sources or
            propose claims through the API.
          </p>
        )}
      </section>

      {/* ------------------------------------------------ api keys */}
      <section className="acct-section" id="keys">
        <div className="acct-head">
          <h2>API keys</h2>
        </div>
        <div className="acct-cols acct-cols-end">
          <p className="acct-prose acct-main acct-measure">
            Keys authenticate requests to the Minerval API as you (header <code>x-api-key</code>).
            Create one for each surface
            {extensionOn && <>, a CLI or the browser extension,</>} so that each can be revoked on
            its own.
          </p>
          <div className="acct-side">
            <KeyCreator extension={extensionOn} />
          </div>
        </div>
        <div className="acct-scroll">
          <table className="account-table acct-table acct-keys">
            <thead>
              <tr>
                <th>name</th>
                <th>key</th>
                <th>created</th>
                <th>last used</th>
                <th className="acct-num">calls · {usage.days}d</th>
                <th className="acct-num">cost</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {activeKeys.map((k) => {
                const used = usageByKey.get(k.id);
                return (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td className="acct-num-left">{dateish(k.created_at)}</td>
                    <td className="acct-num-left">{dateish(k.last_used_at, "never")}</td>
                    <td className={used ? "acct-num" : "acct-num acct-quiet"}>
                      {(used?.calls ?? 0).toLocaleString("en-US")}
                    </td>
                    <td className={used ? "acct-num" : "acct-num acct-quiet"}>
                      {usd(used?.cost_micro_usd ?? 0)}
                    </td>
                    <td className="acct-num">
                      <form action={revokeKeyAction}>
                        <input type="hidden" name="key_id" value={k.id} />
                        <button className="linklike danger" type="submit">
                          revoke
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
              {sessionUsage && (
                <tr>
                  <td colSpan={4}>
                    <em>Signed in on the site, no key</em>
                  </td>
                  <td className="acct-num">{sessionUsage.calls.toLocaleString("en-US")}</td>
                  <td className="acct-num">{usd(sessionUsage.cost_micro_usd)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {activeKeys.length === 0 && <p className="account-empty">No active keys.</p>}
        {revokedKeys.length > 0 && (
          <p className="account-empty">
            {revokedKeys.length} revoked key{revokedKeys.length > 1 ? "s" : ""} (usage history is
            preserved)
            {revokedUsage.length > 0 && (
              <>
                ; in these {usage.days} days they made{" "}
                {revokedUsage.reduce((n, k) => n + k.calls, 0).toLocaleString("en-US")} calls
                costing {usd(revokedUsage.reduce((n, k) => n + k.cost_micro_usd, 0))}
              </>
            )}
            .
          </p>
        )}
      </section>

      {/* ------------------------------------------------ contributor half */}
      <section className="acct-section" id="contributions">
        <div className="acct-head">
          <h2>Contributions</h2>
          <nav className="acct-links" aria-label="Your contributor identity">
            <a href={`/contributors/${user.id}`}>Your public profile →</a>
          </nav>
        </div>
        <div className="acct-cols">
          <div className="acct-main">
            <div className="acct-sub">
              <h3>Recent decisions</h3>
              {recent.length > 0 && (
                <span className="acct-note">each is recorded with its reasoning</span>
              )}
            </div>
            {recent.length === 0 && (
              <p className="account-empty">
                No contributions yet. Any claim&rsquo;s page takes evidence, arguments and
                corrections.
              </p>
            )}
            {contributionDays.map((day) => (
              <div key={day}>
                <div className="acct-day sc">{day}</div>
                {recent
                  .filter((r) => dateish(r.submitted_at) === day)
                  .map((r) => {
                    const text = r.claim_id ? claimTexts.get(r.claim_id) : undefined;
                    return (
                      <div className="acct-line acct-line-3" key={r.id}>
                        <div>
                          {sentence(r.contribution_type)}
                          {text && r.claim_id && (
                            <>
                              : <a href={`/claims/${r.claim_id}`}>{clip(text)}</a>
                            </>
                          )}
                        </div>
                        <div className={`acct-status acct-status-${r.review_status}`}>
                          {words(r.review_status)}
                        </div>
                        <div className="acct-record">
                          <a href={`/contributions/${r.id}`}>record →</a>
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>

          <aside className="acct-side">
            <h3>Standing</h3>
            <table className="account-table acct-table">
              <tbody>
                <tr>
                  <td>Reputation</td>
                  <td className="acct-num">
                    <strong>{user.reputation_score.toFixed(0)}</strong>{" "}
                    <span className="acct-quiet">· {user.trust_level}</span>
                  </td>
                </tr>
                <tr>
                  <td>Accepted</td>
                  <td className="acct-num">
                    <strong>{user.contributions_accepted}</strong>
                  </td>
                </tr>
                <tr>
                  <td>Rejected</td>
                  <td className="acct-num">{user.contributions_rejected}</td>
                </tr>
                <tr>
                  <td>Escalated</td>
                  <td className="acct-num">{user.contributions_escalated}</td>
                </tr>
                <tr>
                  <td>Owls earned</td>
                  <td className="acct-num">{owls(user.owls_earned)}</td>
                </tr>
                {/* prize owls beside, not inside, owls earned (§8.7): the
                    leaderboard sum excludes them */}
                {prizesOn && typeof user.owls_prized === "number" && user.owls_prized > 0 && (
                  <tr>
                    <td>Owls in prizes</td>
                    <td className="acct-num">{owls(user.owls_prized)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="acct-prose">
              Good-faith contribution is always free: a sincere contribution that is rejected
              costs nothing, and any proposal charge is refunded. Accepted contributions raise
              reputation and earn spendable owls in proportion to the importance of the claim
              they improve, so the contributors who build the graph gain real say over what it
              assesses next.
            </p>
          </aside>
        </div>
      </section>
    </div>
  );
}

/** One ordered assessment: the claim, where the order stands, what it cost. */
function OrderLine({ order: o, text }: { order: AssessmentOrderView; text: string | undefined }) {
  const open = o.status === "pending" || o.status === "running";
  return (
    <div className="acct-line">
      <div>
        <a href={`/claims/${o.claim_id}`}>{text ? clip(text, 90) : "view claim"}</a>
      </div>
      <div className="acct-amount">
        {typeof o.cost_owls === "number"
          ? owls(o.cost_owls)
          : !o.charged
            ? "not charged"
            : open
              ? `up to ${owls(o.price_cap_owls)}`
              : "—"}
      </div>
      <div className="acct-note acct-line-under">
        {words(o.status)} · ordered {dateish(o.created_at)}
        {typeof o.cost_owls === "number" && <> · of up to {owls(o.price_cap_owls)}</>}
      </div>
    </div>
  );
}
