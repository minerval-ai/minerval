import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { Notice, viewer, when } from "@/components/admin/access";
import { WorkNav } from "@/components/inside/nav";
import { fetchGateBacklog, fetchGates, type BacklogLine, type Gate } from "@/lib/inside-api";
import { capital } from "@/lib/inside-words";
import { endGateSettingAction, setGateAction, setGateModeAction } from "../showings/actions";

export const metadata: Metadata = { title: "Gates · Minerval" };
export const dynamic = "force-dynamic";

// The gates (GET /gates, GET /gate/backlog; docs/the-gate.md). Anything
// that goes from a label to people who do not read it passes a gate, and
// there is one for each pair: where a thing is written and where it goes.
// Every member is shown how much waits at the gates toward a label they
// read, in counts. A person with a say over a gate (an administrator, or a
// holder of release for a party) is shown its settings as well and changes
// them here.

function waited(hours: number): string {
  return hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.floor(hours / 24)} days`;
}

function Backlog({ lines }: { lines: BacklogLine[] }) {
  if (lines.length === 0) return <p className="account-empty">Nothing waits at this gate.</p>;
  return (
    <div className="acct-scroll">
      <table className="account-table acct-table">
        <thead>
          <tr>
            <th>kind</th>
            <th>waiting on</th>
            <th>items</th>
            <th>oldest</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>{capital(l.kind_in_words)}</td>
              <td>
                {capital(l.in_words)}
                {l.party && <span className="acct-detail">for {l.party}</span>}
              </td>
              <td>
                {l.items}
                {l.parts ? <span className="acct-detail">{l.parts} part{l.parts === 1 ? "" : "s"}</span> : null}
              </td>
              <td>{waited(l.oldest_waiting_hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settings({ gate, modes, kinds, scopes }: { gate: Gate; modes: Record<string, string>; kinds: Record<string, string>; scopes: Record<string, string> }) {
  const maySet = gate.you_may_set.the_gate_as_a_whole || gate.you_may_set.for_parties.length > 0;
  return (
    <>
      <p className="acct-prose acct-measure">
        Where nothing is set, a gate starts from the Redactor&rsquo;s decision for everything except the bare fact that a request was
        taken up, which starts open. A setting for one party&rsquo;s material is taken before one for the gate as a whole, the narrowest
        scope that covers an item before a wider one, and a setting for one kind of thing before one for every kind.
      </p>
      {gate.settings.length === 0 ? (
        <p className="account-empty">Nothing is set: everything is at its starting position.</p>
      ) : (
        <div className="acct-scroll">
          <table className="account-table acct-table">
            <thead>
              <tr>
                <th>for</th>
                <th>the gate</th>
                <th>set</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {gate.settings.map((s) => (
                <tr key={s.setting_id}>
                  <td>
                    {s.kind === "*" ? "Every kind of thing" : capital(kinds[s.kind] ?? s.kind)}
                    <span className="acct-detail">
                      {capital(s.scope_in_words)}
                      {s.scope_ref ? ` (${s.scope_ref})` : ""}
                    </span>
                    <span className="acct-detail">{s.party ? `${s.party.name}'s material` : "every party that has not said"}</span>
                  </td>
                  <td>{s.in_words}</td>
                  <td>
                    {when(s.set_at)}
                    <span className="acct-detail">
                      {s.set_by ? `by ${s.set_by}, holding ${s.set_holding.join(", ")}` : (s.made_from_release_rule ?? "by the deployment")}
                    </span>
                  </td>
                  <td>
                    {(s.party ? gate.you_may_set.for_parties.some((p) => p.id === s.party!.id) : gate.you_may_set.the_gate_as_a_whole) && (
                      <ActionForm action={endGateSettingAction} submit="end" inline danger>
                        <input type="hidden" name="setting_id" value={s.setting_id} />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {maySet && (
        <details className="admin-args">
          <summary>set how this gate treats something</summary>
          <ActionForm action={setGateModeAction} submit="Set">
            <input type="hidden" name="gate_id" value={gate.gate_id} />
            <fieldset className="admin-fieldset inside-choices">
              <legend>The gate</legend>
              {Object.entries(modes).map(([mode, words]) => (
                <label className="admin-check" key={mode}>
                  <input type="radio" name="mode" value={mode} required />
                  <span>{words}</span>
                </label>
              ))}
            </fieldset>
            <div className="admin-form-row">
              <label>
                For
                <select name="kind" defaultValue="*">
                  <option value="*">every kind of thing</option>
                  {Object.entries(kinds).map(([kind, words]) => (
                    <option key={kind} value={kind}>
                      {words}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Whose material
                <select name="party_id" defaultValue={gate.you_may_set.the_gate_as_a_whole ? "" : (gate.you_may_set.for_parties[0]?.id ?? "")}>
                  {gate.you_may_set.the_gate_as_a_whole && <option value="">every party that has not said</option>}
                  {gate.you_may_set.for_parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="admin-form-row">
              <label>
                Scope
                <select name="scope" defaultValue="boundary">
                  {Object.entries(scopes).map(([scope, words]) => (
                    <option key={scope} value={scope}>
                      {words}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                The mandate, node or request, by id
                <input type="text" name="scope_ref" placeholder="not needed for the whole boundary" />
              </label>
            </div>
          </ActionForm>
        </details>
      )}
      {gate.you_may_set.the_gate_as_a_whole && (
        <details className="admin-args">
          <summary>what flows to this gate, and what the other side is shown</summary>
          <ActionForm action={setGateAction} submit="Save">
            <input type="hidden" name="gate_id" value={gate.gate_id} />
            {gate.to_outside && <input type="hidden" name="outside" value="yes" />}
            <fieldset className="admin-fieldset inside-choices">
              <legend>What flows without anyone asking item by item</legend>
              <label className="admin-check">
                <input type="radio" name="flow" value="asked" defaultChecked={gate.flow === "asked"} />
                <span>
                  What was asked for.
                  <small>
                    An answer to a request taken up here, that it was taken up, and an answer to a message go to the gate when they are
                    ready. A node&rsquo;s page goes where a flow was set for it, on <Link href="/showings">Showings</Link>.
                  </small>
                </span>
              </label>
              <label className="admin-check">
                <input type="radio" name="flow" value="everything" defaultChecked={gate.flow === "everything"} />
                <span>
                  Everything.
                  <small>
                    Every page at {gate.from} goes to the gate as each version is finished, and each mandate there is offered with its
                    terms. Each page costs a Redactor&rsquo;s run and Audit&rsquo;s check of it, paid from the budget of the work that
                    produced the page.
                  </small>
                </span>
              </label>
            </fieldset>
            <label className="admin-check">
              <input type="checkbox" name="backlog_shown" defaultChecked={gate.backlog_shown_to_the_other_side} />
              <span>Show the people on the other side how much waits at this gate, in counts.</span>
            </label>
            {gate.to_outside && (
              <label className="admin-check">
                <input type="checkbox" name="send_as_released" defaultChecked={gate.send_as_released === true} />
                <span>Send what is released to the public graph as it is released, with no person sending each package.</span>
              </label>
            )}
          </ActionForm>
        </details>
      )}
    </>
  );
}

export default async function GatesPage() {
  const who = await viewer();
  if (!who) return null;
  const [gates, backlog] = await Promise.all([
    fetchGates(who.externalId).catch(() => null),
    fetchGateBacklog(who.externalId).catch(() => null),
  ]);
  const mine = gates?.gates ?? [];
  const waitingElsewhere = (backlog?.gates ?? []).filter((b) => !mine.some((g) => g.gate_id === b.gate_id));

  return (
    <div className="admin-page">
      <PageHead
        title="Gates"
        lede="Anything that goes from a label to people who do not read it passes a gate: a node's page, an answer to a request, a mandate's terms or funding, an answer to a message. There is one gate for each pair of where a thing is written and where it goes. Each can be open, left to the Redactor, or set so that a person decides as well."
      />
      <WorkNav who={who} current="/gates" />
      {backlog && <Notice>{backlog.note}</Notice>}

      {mine.map((gate, n) => {
        const waiting = backlog?.gates.find((b) => b.gate_id === gate.gate_id);
        return (
          <section className={`acct-section${n === 0 ? " admin-first" : ""}`} key={gate.gate_id} id={`gate-${gate.gate_id}`}>
            <div className="acct-head">
              <h2>
                From {gate.from} to {gate.to}
              </h2>
            </div>
            <p className="acct-prose acct-measure">
              {gate.flow_in_words}{" "}
              {gate.backlog_shown_to_the_other_side
                ? "The people on the other side are shown how much waits here."
                : "The people on the other side are not shown how much waits here."}
              {gate.to_outside &&
                (gate.send_as_released
                  ? " What is released is sent to the public graph as it is released."
                  : " A person sends each package to the public graph.")}{" "}
              What the Redactor removes is decided by <Link href="/redaction-policies">this gate&rsquo;s redaction policy</Link>, which is
              where a gate is mostly tightened or loosened.
            </p>
            <h3 className="sc">Waiting</h3>
            <Backlog lines={waiting?.waiting ?? []} />
            <h3 className="sc">Settings</h3>
            <Settings gate={gate} modes={gates!.modes} kinds={gates!.kinds} scopes={gates!.scopes} />
          </section>
        );
      })}

      {waitingElsewhere.map((b, n) => (
        <section className={`acct-section${mine.length === 0 && n === 0 ? " admin-first" : ""}`} key={b.gate_id}>
          <div className="acct-head">
            <h2>Waiting to reach {b.to}</h2>
          </div>
          <p className="acct-prose acct-measure">
            From a label you do not read. You are shown how much waits and on whom, and nothing of what it says.
          </p>
          <Backlog lines={b.waiting} />
        </section>
      ))}

      {mine.length === 0 && waitingElsewhere.length === 0 && (
        <p className="account-empty admin-first">No gate leads to a label you read, and you have a say over none.</p>
      )}
    </div>
  );
}
