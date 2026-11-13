import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, Notice, can, viewer, when } from "@/components/admin/access";
import { fetchMyLabels } from "@/lib/admin-api";
import { british, fetchKeepCurrent, fetchPublicAccount } from "@/lib/outside-api";
import { leaveOutAction, setChoiceAction, takeBackLeaveOutAction } from "../actions";

export const metadata: Metadata = { title: "Keeping public versions current · Minerval" };
export const dynamic = "force-dynamic";

// The setting that keeps the public version of a node current
// (docs/outward-acts.md): what it reveals, said before anything else; how
// it stands; what has been asked of the public graph and what was not, with
// why; and what is left out. Every member may read it. A person who may act
// on the public graph sets it.

const STATE: Record<string, string> = { waiting: "waiting until it is due", sent: "the public mandate was asked", not_sent: "not sent" };

export default async function KeepCurrentPage() {
  const who = await viewer();
  if (!who) return null;
  const [state, account, labels] = await Promise.all([
    fetchKeepCurrent(who.externalId),
    fetchPublicAccount(who.externalId),
    fetchMyLabels(who.externalId).catch(() => null),
  ]);
  const maySet = can(who, "direct");
  const mandates = account.public_mandates ?? [];

  return (
    <div className="admin-page">
      <PageHead
        kicker="The public graph"
        title="Keeping public versions current"
        lede="When this graph's own version of a public node changes, the public graph's version can be left behind. This setting asks a public mandate the organisation funds for a fresh public assessment of the node, on public evidence, so that readers outside are not left with a page nobody keeps up."
      />
      <AdminNav current="/admin/outside/keep-current" />

      <section className="acct-section admin-first" id="reveals">
        <div className="acct-head">
          <h2>What it shows outside</h2>
        </div>
        <Notice>{british(state.what_it_shows_outside)}</Notice>
      </section>

      <section className="acct-section" id="setting">
        <div className="acct-head">
          <h2>As it stands</h2>
          <span className="acct-note">{state.set_at ? `last set ${when(state.set_at)}` : "nobody has set it"}</span>
        </div>
        <p className="acct-prose acct-measure">
          <strong>{british(state.in_words)}</strong>
        </p>
        {state.last_not_taken && (
          <Notice>
            The public graph did not take the last request, on {when(state.last_not_taken.at)}, and said: {state.last_not_taken.the_public_graph_said ?? "nothing"}
          </Notice>
        )}
        {maySet ? (
          <div className="acct-cols">
            <div className="acct-main">
              <ActionForm action={setChoiceAction} submit="Set it, under my name">
                <input type="hidden" name="key" value="keep_public_current" />
                <label>
                  Setting
                  <select name="on" defaultValue={state.setting === "on" ? "true" : "false"}>
                    <option value="true">On</option>
                    <option value="false">Off, and every page shown outside says so</option>
                  </select>
                </label>
                <label>
                  The public mandate that is asked
                  <select name="public_mandate_id" defaultValue={state.public_mandate_id ?? ""}>
                    <option value="">None: nothing is sent</option>
                    {mandates.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title ?? m.id}
                      </option>
                    ))}
                  </select>
                  <small>
                    One of the organisation&rsquo;s public mandates, opened for the purpose on{" "}
                    <Link href="/admin/outside#mandates">The public graph</Link>. Its officers there decide whether its money
                    pays for each assessment asked for.
                  </small>
                </label>
                <label>
                  Wait this many hours after a version changes
                  <input name="delay_hours" type="number" min="0" max="2160" step="1" defaultValue={state.delay_hours} />
                </label>
                <label>
                  Send what is due together, every this many hours
                  <input name="batch_hours" type="number" min="0" max="2160" step="1" defaultValue={state.batch_hours} />
                  <small>0 sends each as it falls due. Waiting and batching hide when a version changed, not which node.</small>
                </label>
              </ActionForm>
            </div>
          </div>
        ) : (
          <p className="acct-note">A person who directs the graph sets this.</p>
        )}
      </section>

      <section className="acct-section" id="versions">
        <div className="acct-head">
          <h2>Changed versions</h2>
          <span className="acct-note">{state.versions_note}</span>
        </div>
        {state.versions.length === 0 ? (
          <p className="account-empty">No version of a public node has changed at a label you read since the setting was last set.</p>
        ) : (
          <table className="account-table acct-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Version of</th>
                <th>Due</th>
                <th>What became of it</th>
              </tr>
            </thead>
            <tbody>
              {state.versions.map((v) => (
                <tr key={`${v.node_id}-${v.version_of}`}>
                  <td>
                    <Link href={`/claims/${v.node_id}`}>{v.node ?? v.node_id}</Link>
                  </td>
                  <td>{when(v.version_of)}</td>
                  <td>{when(v.due_at)}</td>
                  <td>
                    {STATE[v.state] ?? v.state}
                    {v.because ? `: ${v.because}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="acct-section" id="left-out">
        <div className="acct-head">
          <h2>Left out</h2>
          <span className="acct-note">where the fact of attention is itself not to be shown</span>
        </div>
        {state.left_out.length === 0 ? (
          <p className="account-empty">Nothing is left out at a label you read.</p>
        ) : (
          <table className="account-table acct-table">
            <thead>
              <tr>
                <th>What</th>
                <th>Since</th>
                <th>By</th>
                {maySet && <th />}
              </tr>
            </thead>
            <tbody>
              {state.left_out.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.mandate_id && (
                      <>
                        Everything mandate <Link href={`/mandates/${e.mandate_id}`}>{e.mandate_id.slice(0, 8)}</Link> pays for
                      </>
                    )}
                    {e.mandate_id && e.node_id && ", for the node "}
                    {e.node_id && <Link href={`/claims/${e.node_id}`}>{e.node ?? e.node_id}</Link>}
                  </td>
                  <td>{when(e.set_at)}</td>
                  <td>{e.by ?? ""}</td>
                  {maySet && (
                    <td>
                      <ActionForm action={takeBackLeaveOutAction} submit="Take back" inline>
                        <input type="hidden" name="id" value={e.id} />
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {maySet && (
          <div className="acct-cols">
            <div className="acct-main">
              <h3 className="acct-gap">Leave something out</h3>
              <ActionForm action={leaveOutAction} submit="Leave it out">
                <label>
                  A mandate here, by id
                  <input name="mandate_id" placeholder="everything it pays for" />
                </label>
                <label>
                  A node, by id
                  <input name="node_id" placeholder="with a mandate: that node alone" />
                </label>
                {labels?.must_choose && (
                  <label>
                    Label, for a node alone
                    <select name="label" defaultValue="">
                      <option value="">Choose a label</option>
                      {labels.labels.map((l) => (
                        <option key={l.name} value={l.name}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Which nodes are left out says which are worked on, so the record is kept at a label you read. For a
                      mandate it is kept at the mandate&rsquo;s own label, and this is not asked.
                    </small>
                  </label>
                )}
              </ActionForm>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
