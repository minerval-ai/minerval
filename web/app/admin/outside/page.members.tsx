import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, Notice, can, viewer, when } from "@/components/admin/access";
import { british, fetchOutwardLog, fetchPublicAccount, type OutwardAct } from "@/lib/outside-api";
import { backPublicMandateAction, openPublicMandateAction } from "./actions";

export const metadata: Metadata = { title: "The public graph · Minerval" };
export const dynamic = "force-dynamic";

// What this deployment does on the public graph besides showing pages
// (docs/outward-acts.md): the organisation's account there, its public owls
// and public mandates, and every act made in its name, with who made it
// and exactly what was sent. Every member may read this page. The forms are
// shown to those who hold the permission the deployment names for acting
// on the public graph, which the API says in its own words.

export default async function OutsidePage() {
  const who = await viewer();
  if (!who) return null;
  const [account, log] = await Promise.all([fetchPublicAccount(who.externalId), fetchOutwardLog(who.externalId).catch(() => [] as OutwardAct[])]);
  const mayAct = can(who, "direct");

  return (
    <div className="admin-page">
      <PageHead
        kicker="This deployment"
        title="The public graph"
        lede="This graph acts on the public graph as any account does and only as one: through the routes any account uses, under the organisation's own account there. Every act shows something outside, at least where the organisation's attention is, so each is made by a person who holds the permission for it, and each is listed here with who made it and exactly what was sent."
      />
      <AdminNav current="/admin/outside" />

      <section className="acct-section admin-first" id="account">
        <div className="acct-head">
          <h2>The organisation&rsquo;s account there</h2>
          <span className="acct-note">{british(account.who_may_act)}</span>
        </div>
        {!account.connected ? (
          <Notice>{british(account.in_words ?? "This deployment is not connected to the public graph.")}</Notice>
        ) : (
          <>
            <p className="acct-prose acct-measure">
              Acting as <strong>{account.account?.name ?? "an account"}</strong>, with{" "}
              <strong>{(account.public_owls ?? 0).toLocaleString("en-GB", { maximumFractionDigits: 2 })} public owls</strong>.{" "}
              {british(account.public_owls_statement ?? "")} This deployment&rsquo;s own owls are on <Link href="/admin/owls">Owls</Link>.
            </p>
          </>
        )}
      </section>

      {account.connected && (
        <section className="acct-section" id="mandates">
          <div className="acct-head">
            <h2>Public mandates</h2>
            <span className="acct-note">public on the public graph, and paid for in public owls</span>
          </div>
          {(account.public_mandates ?? []).length === 0 ? (
            <p className="account-empty">The organisation funds no mandate on the public graph.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>Mandate</th>
                  <th>Where it stands</th>
                  <th className="admin-num">Public owls</th>
                  {mayAct && <th>Add to it</th>}
                </tr>
              </thead>
              <tbody>
                {(account.public_mandates ?? []).map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.title ?? "A public mandate"} <span className="acct-detail">public</span>
                      <br />
                      <code>{m.id}</code>
                    </td>
                    <td>{m.status ?? ""}</td>
                    <td className="admin-num">
                      {m.spent_owls !== null && m.budget_owls !== null ? `${m.spent_owls} of ${m.budget_owls} spent` : (m.budget_owls ?? "")}
                    </td>
                    {mayAct && (
                      <td>
                        <ActionForm action={backPublicMandateAction} submit="Add public owls" inline>
                          <input type="hidden" name="mandate_id" value={m.id} />
                          <input name="owls" type="number" min="0.01" step="0.01" aria-label="Public owls to add" style={{ width: "6rem" }} />
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          {mayAct && (
            <div className="acct-cols">
              <div className="acct-main">
                <h3 className="acct-gap">New public mandate</h3>
                <Notice>{british(account.what_a_public_mandate_shows ?? "")}</Notice>
                <ActionForm action={openPublicMandateAction} submit="Send to the public Grantmaker">
                  <label>
                    What the mandate is for, in your own words
                    <textarea name="message" rows={5} required maxLength={10000} />
                    <small>
                      These words leave the deployment exactly as you write them and are read on the public graph. Write
                      nothing here that is not for the public.
                    </small>
                  </label>
                  <label className="admin-check">
                    <input type="checkbox" name="understood" value="yes" /> I have read what this shows outside.
                  </label>
                </ActionForm>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="acct-section" id="log">
        <div className="acct-head">
          <h2>Every act on the public graph</h2>
          <span className="acct-note">
            besides pages sent, which are on <Link href="/outbound">Pages sent outside</Link>
          </span>
        </div>
        {log.length === 0 ? (
          <p className="account-empty">Nothing has been done on the public graph from this deployment.</p>
        ) : (
          log.map((a) => (
            <div key={a.id} className="admin-report">
              <div className="acct-sub">
                <h3>
                  {a.what.charAt(0).toUpperCase() + a.what.slice(1)}
                  {a.result !== "done" && <span className="acct-detail">{a.result === "refused" ? "not taken" : "not sent"}</span>}
                </h3>
                <span className="acct-note">
                  {when(a.at)} · {a.by ?? "nobody"}
                  {a.holding.length > 0 ? `, holding ${a.holding.join(", ")}` : ""}
                </span>
              </div>
              <p className="acct-note">
                {a.on_the_public_graph && (
                  <>
                    On the public graph: <code>{a.on_the_public_graph}</code>.{" "}
                  </>
                )}
                {Object.keys(a.sent).length === 0 ? "Nothing was sent with it." : "Exactly what was sent:"}
              </p>
              {Object.keys(a.sent).length > 0 && <pre className="admin-pre">{JSON.stringify(a.sent, null, 1)}</pre>}
              {a.the_public_graph_said && <p className="acct-note">The public graph answered: {a.the_public_graph_said}</p>}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
