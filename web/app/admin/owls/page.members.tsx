import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { OwlMark } from "@/components/OwlMark";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, Notice, can, viewer, when } from "@/components/admin/access";
import { fetchAccount, listMandates, type MandateSummaryView } from "@/lib/account-api";
import { dateish, owls, words } from "@/lib/account-format";
import {
  fetchAccounts,
  fetchCreatedOwls,
  fetchStandingMandates,
  type AccountView,
  type CreatedOwls,
  type StandingMandate,
} from "@/lib/admin-api";
import { count } from "@/lib/admin-words";
import { createOwlsAction, setUpStandingMandateAction } from "../actions";

export const metadata: Metadata = { title: "Owls · Minerval" };
export const dynamic = "force-dynamic";

// Owls in a private deployment: what one is here, how many its
// administrators have created and where they went, what its agents' runs
// have spent, the prices an owl is counted at, and the two standing mandates
// every deployment needs. Every member may read all of it, because there is
// no ceiling on what an administrator may create and this page is what
// stands in a ceiling's place. Creating owls and setting up a mandate are
// for holders of the permission to administer.

const owlWord = (n: number) => (n === 1 ? "owl" : "owls");

export default async function OwlsPage() {
  const who = await viewer();
  if (!who) return null;
  const administers = can(who, "administer");

  const [account, standing] = await Promise.all([
    fetchAccount(who.externalId),
    fetchStandingMandates(who.externalId).catch(() => [] as StandingMandate[]),
  ]);
  const createdHere = account.entitlement.owls_created_here === true;
  const created: CreatedOwls | null = createdHere ? await fetchCreatedOwls(who.externalId).catch(() => null) : null;
  let accounts: AccountView[] = [];
  let mandates: MandateSummaryView[] = [];
  if (administers && createdHere) {
    [accounts, mandates] = await Promise.all([
      fetchAccounts(who.externalId).catch(() => []),
      listMandates().catch(() => []),
    ]);
    accounts = accounts.filter((a) => !a.external_id?.startsWith("platform:"));
  }
  const openMandates = mandates.filter((m) => m.status === "active");

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title="Owls"
        lede={
          createdHere
            ? "What an owl is in this deployment, how many have been created and by whom, what the agents' runs have spent, and the two standing mandates."
            : "Owls in this deployment, and the two standing mandates."
        }
      />
      {administers && <AdminNav current="/admin/owls" />}

      {/* ------------------------------------------------ what an owl is here */}
      <section className="acct-section admin-first" id="what">
        <div className="acct-head">
          <h2>What an owl is here</h2>
        </div>
        {createdHere ? (
          <>
            <Notice>{created?.statement ?? account.entitlement.owls_statement}</Notice>
            <p className="acct-prose acct-measure">
              There is no ceiling on what an administrator may create, because it is the
              organisation&rsquo;s own budget, spent at its own model providers. What stands in a
              ceiling&rsquo;s place is this page: every act is listed with who made it, and every
              member may read it.
            </p>
          </>
        ) : (
          <p className="acct-prose acct-measure">
            Owls here are bought, as on the public graph, and nobody creates them. One owl covers
            one dollar of the agents&rsquo; metered work. A person adds to their balance from{" "}
            <Link href="/account">their account page</Link>.
          </p>
        )}
      </section>

      {created && (
        <>
          <section className="acct-figures" aria-label="Owls created and spent">
            <div className="acct-figure">
              <div className="sc">Created so far</div>
              <p className="acct-balance">
                <OwlMark size={30} />
                <strong>{owls(created.created.total_owls)}</strong>
                <span className="acct-unit">{owlWord(created.created.total_owls)}</span>
              </p>
            </div>
            <div className="acct-figure">
              <div className="sc">Into mandates</div>
              <p className="acct-figure-value">{owls(created.created.into_mandates_owls)}</p>
              <p className="acct-figure-note">Created straight into a mandate&rsquo;s budget.</p>
            </div>
            <div className="acct-figure">
              <div className="sc">Into people&rsquo;s balances</div>
              <p className="acct-figure-value">{owls(created.created.into_accounts_owls)}</p>
              <p className="acct-figure-note">
                For a person who holds the permission to fund work to put behind mandates.
              </p>
            </div>
            <div className="acct-figure">
              <div className="sc">Spent by agents&rsquo; runs</div>
              <p className="acct-figure-value">{owls(created.spent.total_owls)}</p>
              <p className="acct-figure-note">
                {created.spent.since
                  ? `The metered cost of every run since ${dateish(created.spent.since)}.`
                  : "No run has been metered yet."}
                {created.returned_owls > 0 &&
                  ` ${owls(created.returned_owls)} ${owlWord(created.returned_owls)} came back unspent from mandates that closed.`}
              </p>
            </div>
          </section>

          {/* ------------------------------------------------ creating */}
          <section className="acct-section" id="create">
            <div className="acct-head">
              <h2>Create owls</h2>
            </div>
            {administers ? (
              <div className="acct-cols">
                <div className="acct-main">
                  <ActionForm action={createOwlsAction} submit="Create the owls">
                    <div className="admin-form-row">
                      <label>
                        How many
                        <input name="amount_owls" type="number" min="0.01" step="any" required />
                      </label>
                      <label>
                        Into
                        <select name="recipient" required defaultValue="">
                          <option value="" disabled>
                            Choose where they go
                          </option>
                          <optgroup label="A mandate's budget">
                            {openMandates.map((m) => (
                              <option key={m.id} value={`mandate:${m.id}`}>
                                {m.title}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="A person's balance">
                            {accounts.map((a) => (
                              <option key={a.id} value={`account:${a.id}`}>
                                {a.display_name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </label>
                    </div>
                    <label>
                      What they are for
                      <input name="note" maxLength={500} autoComplete="off" />
                      <small>Shown with the act, in the list below and in the log.</small>
                    </label>
                  </ActionForm>
                </div>
                <aside className="acct-side acct-side-wide">
                  <p className="acct-prose">
                    Owls created into a mandate grow its budget at once. Owls created into a
                    person&rsquo;s balance are theirs to put behind mandates, if they hold the
                    permission to fund work.
                  </p>
                  <p className="acct-prose">
                    The act cannot be taken back from here. If a mandate closes with owls unspent,
                    the created share returns to the deployment&rsquo;s own account, and shows
                    above.
                  </p>
                </aside>
              </div>
            ) : (
              <p className="acct-prose acct-measure">
                Creating owls needs the permission to administer the deployment, which you do not
                hold. If your balance cannot cover something, ask an administrator to add to it.
              </p>
            )}
          </section>

          {/* ------------------------------------------------ the acts */}
          <section className="acct-section" id="acts">
            <div className="acct-head">
              <h2>Who created what</h2>
            </div>
            {created.recent.length === 0 ? (
              <p className="account-empty">
                No owls have been created yet. Until an administrator creates some, no mandate has a
                budget and no agent work can be paid for.
              </p>
            ) : (
              <div className="acct-cols">
                <div className="acct-main">
                  <div className="acct-scroll">
                    <table className="account-table acct-table">
                      <thead>
                        <tr>
                          <th>when</th>
                          <th>who</th>
                          <th>into</th>
                          <th className="acct-num">owls</th>
                        </tr>
                      </thead>
                      <tbody>
                        {created.recent.map((act, i) => (
                          <tr key={`${act.at}-${i}`}>
                            <td className="acct-num-left">{when(act.at)}</td>
                            <td>{act.by ?? ""}</td>
                            <td>
                              {act.mandate ? (
                                <>
                                  {act.mandate.withheld ? (
                                    <>the budget of a mandate at a label you do not read</>
                                  ) : (
                                    <>
                                      the budget of <Link href={`/mandates/${act.mandate.id}`}>{act.mandate.title}</Link>
                                    </>
                                  )}
                                  {act.standing_mandate && <span className="acct-detail">when it was set up</span>}
                                </>
                              ) : (
                                <>{act.account}&rsquo;s balance</>
                              )}
                              {act.note && (
                                <>
                                  <br />
                                  <span className="acct-note">{act.note}</span>
                                </>
                              )}
                            </td>
                            <td className="acct-num">{owls(act.amount_owls)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <aside className="acct-side">
                  <h3>By administrator</h3>
                  <div className="acct-scroll">
                    <table className="account-table acct-table">
                      <tbody>
                        {created.created.by_administrator.map((a) => (
                          <tr key={a.administrator}>
                            <td>
                              {a.administrator}
                              <span className="acct-detail">{count(a.acts, "act")}</span>
                            </td>
                            <td className="acct-num">{owls(a.owls)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {created.entered_by_setting.length > 0 && (
                    <>
                      <h3 className="acct-gap">Entered by a setting</h3>
                      <p className="acct-note">
                        Owls that reached a balance because the deployment is set to grant them, and
                        not by an administrator&rsquo;s act.
                      </p>
                      <div className="acct-scroll">
                        <table className="account-table acct-table">
                          <tbody>
                            {created.entered_by_setting.map((row) => (
                              <tr key={row.reason}>
                                <td>{words(row.reason)}</td>
                                <td className="acct-num">{owls(row.owls)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </aside>
              </div>
            )}
          </section>

          {/* ------------------------------------------------ prices */}
          <section className="acct-section" id="prices">
            <div className="acct-head">
              <h2>What an owl is counted at</h2>
            </div>
            <p className="acct-prose acct-measure">
              One owl covers one dollar of metered cost. A call is priced by the rate table that
              ships with Minerval, by a provider that reports the cost of each call itself, or by a
              price this deployment states for a model. Whoever runs the deployment states prices
              in its <code>MODEL_PRICES</code> setting.
            </p>
            {created.prices.unpriced_models.length > 0 && (
              <Notice>
                {count(created.prices.unpriced_models.length, "model")} that a role is set to run{" "}
                {created.prices.unpriced_models.length === 1 ? "has" : "have"} no price here. A call
                to a model with no price is refused before anything is sent, because a guessed
                rate would be a number nobody chose:{" "}
                {created.prices.unpriced_models.map((m, i) => (
                  <span key={m.setting}>
                    {i > 0 && ", "}
                    <code>{m.model}</code> ({m.setting})
                  </span>
                ))}
                .
              </Notice>
            )}
            {created.prices.stated.length === 0 ? (
              <p className="account-empty">
                This deployment states no price of its own. Every model it runs is priced by the
                rate table or by its provider.
              </p>
            ) : (
              <div className="acct-scroll">
                <table className="account-table acct-table">
                  <thead>
                    <tr>
                      <th>model</th>
                      <th className="acct-num">dollars per million tokens in</th>
                      <th className="acct-num">out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {created.prices.stated.map((p) => (
                      <tr key={p.model}>
                        <td>
                          <code>{p.model}</code>
                        </td>
                        <td className="acct-num">{p.input_usd_per_mtok}</td>
                        <td className="acct-num">{p.output_usd_per_mtok}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* ------------------------------------------------ standing mandates */}
      <section className="acct-section" id="standing-mandates">
        <div className="acct-head">
          <h2>The standing mandates</h2>
        </div>
        <p className="acct-prose acct-measure">
          No agent work runs unless a mandate pays for it. Two mandates are the
          deployment&rsquo;s own: General, which pays for the upkeep whose value is spread across
          the whole graph, and Governance, which pays for the audits of the graph&rsquo;s
          decisions. An administrator sets each up once. From then on its Grantmaker stewards it
          and revises its policy, and its page shows what it paid for.
        </p>
        {standing.some((m) => m.by_label) && (
          <p className="acct-prose acct-measure">
            This deployment holds material at more than one label, and a mandate&rsquo;s work runs
            at its label: its Grantmaker reads what that label reads, and what it pays for is work
            at that label. So each label has a General and a Governance mandate of its own, set up
            by an administrator who reads it. A label with none has nobody paying for its upkeep
            or its audits. The labels listed are the ones you read.
          </p>
        )}
        {standing
          .flatMap((s) =>
            s.by_label
              ? s.by_label.map((at) => ({ ...s, mandate: at.mandate, label: at.label as string | null }))
              : [{ ...s, label: null as string | null }]
          )
          .map((m) => (
          <div className="admin-item" key={`${m.name}:${m.label ?? ""}`}>
            <div className={`admin-state admin-state-${m.mandate ? (m.mandate.budget_owls > 0 ? "done" : "to_do") : "to_do"}`}>
              {m.mandate ? (m.mandate.budget_owls > 0 ? "Set up" : "No budget") : "Not set up"}
            </div>
            <div className="admin-item-body">
              <h3>
                {m.mandate ? <Link href={`/mandates/${m.mandate.id}`}>{m.title}</Link> : m.title}
                {m.label && (
                  <>
                    {" "}
                    at <code>{m.label}</code>
                  </>
                )}
              </h3>
              <p>{m.objective}</p>
              {m.mandate ? (
                <p>
                  A budget of {owls(m.mandate.budget_owls)} {owlWord(m.mandate.budget_owls)}
                  {m.mandate.daily_owls > 0
                    ? `, spending at most ${owls(m.mandate.daily_owls)} a day`
                    : ", with no daily rate"}
                  . {m.mandate.running ? "It is running." : "It is not running: its budget is spent, or it is waiting for one."}{" "}
                  {createdHere
                    ? "More is added by creating owls into it, above, or by anyone who holds the permission to fund work backing it."
                    : "More is added by anyone who holds the permission to fund work backing it from their balance."}
                </p>
              ) : administers ? (
                <ActionForm action={setUpStandingMandateAction} submit={m.label ? `Set up ${m.title} at ${m.label}` : `Set up ${m.title}`}>
                  <input type="hidden" name="name" value={m.name} />
                  {m.label && <input type="hidden" name="label" value={m.label} />}
                  <div className="admin-form-row">
                    {createdHere && (
                      <label>
                        Budget, in owls
                        <input name="budget_owls" type="number" min="0" step="any" />
                        <small>Created with the mandate, and logged. Empty for none yet.</small>
                      </label>
                    )}
                    <label>
                      Most it may spend in a day, in owls
                      <input name="daily_owls" type="number" min="0" step="any" placeholder={m.name === "general" ? "30" : "5"} />
                      <small>
                        Empty for {m.name === "general" ? "30" : "5"} a day, and 0 for no rate. It
                        is the most the mandate may commission in one day, whatever its budget.
                      </small>
                    </label>
                  </div>
                  {!createdHere && (
                    <small>
                      Owls are bought here, so the mandate is set up with no budget and funded
                      from a balance like any mandate.
                    </small>
                  )}
                </ActionForm>
              ) : (
                <p>An administrator of this deployment sets it up.</p>
              )}
            </div>
          </div>
        ))}
        {createdHere && (
          <p className="acct-note">
            What this deployment reports of its owl spend to the public graph, and what it never
            reports, is on <Link href="/admin/usage-report">the usage report page</Link>
            {administers ? "." : ", which administrators read."}
          </p>
        )}
      </section>
    </div>
  );
}
