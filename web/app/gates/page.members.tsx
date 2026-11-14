import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { Notice, viewer, when } from "@/components/admin/access";
import { WorkNav } from "@/components/inside/nav";
import { fetchGateBacklog, fetchGates, type BacklogLine, type Gate } from "@/lib/inside-api";
import { capital } from "@/lib/inside-words";
import { british } from "@/lib/outside-api";
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
        taken up and a statement of what was spent, which start open, and an agent&rsquo;s report to Minerval&rsquo;s maintainers, which
        starts with a person deciding as well. A setting for one party&rsquo;s material is taken before one for the gate as a whole, the narrowest
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
                  <td>
                    {s.in_words}
                    {(s.delay_hours ?? 0) > 0 && <span className="acct-detail">kept back {s.delay_hours} hours</span>}
                    {(s.batch_hours ?? 0) > 0 && <span className="acct-detail">sent in batches every {s.batch_hours} hours</span>}
                  </td>
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
            <div className="admin-form-row">
              <label>
                Keep back, in hours
                <input type="number" name="delay_hours" min="0" max="2160" step="1" placeholder="0" />
              </label>
              <label>
                Then send in batches every, in hours
                <input type="number" name="batch_hours" min="0" max="2160" step="1" placeholder="0" />
                <small>So that when a thing was made is not told by when it arrives. Left empty, neither.</small>
              </label>
            </div>
            {gate.to_outside && (
              <p className="admin-kept">
                <small>
                  A setting of this gate is part of what each mandate your organisation has published says of itself on the public graph, so a
                  change is shown there with its date.
                </small>
              </p>
            )}
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
            <label>
              {gate.to_outside ? "The public mandate asked to keep the public version current, by its id" : "The mandate asked to keep the other side current, by its id"}
              <input type="text" name="keep_current_mandate" defaultValue={gate.keep_current_mandate ?? ""} placeholder="none: nothing is asked" />
              <small>
                {gate.to_outside
                  ? "When a version here changes on a node the public graph holds, this public mandate, which your organisation funds there, is asked for a fresh public assessment of the node. Each asking goes through this gate as funding, and shows outside which public nodes are worked on here and when."
                  : `When a version here changes on a node the other side has assessed, this mandate at ${gate.from} pays for a fresh assessment of the node there. Each asking goes through this gate as funding.`}
              </small>
            </label>
            {!gate.to_outside && (
              <label>
                What it pays for each, in owls
                <input type="number" name="keep_current_owls" min="0" step="0.01" defaultValue={gate.keep_current_owls ?? 0} />
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
            <p className="acct-prose acct-measure">{british(gate.keeps_the_other_side_current)}</p>
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
            <h2>
              Waiting to reach {b.to}
              {b.from ? `, from ${b.from}` : ""}
            </h2>
          </div>
          <p className="acct-prose acct-measure">
            {b.from ? "" : "From a label you do not read. "}You are shown how much waits and on whom, and nothing of what it says.
          </p>
          <Backlog lines={b.waiting} />
        </section>
      ))}

      {(backlog?.asked_from_here ?? []).length > 0 && (
        <section className="acct-section" id="asked">
          <div className="acct-head">
            <h2>What was asked from here, and what has come back</h2>
          </div>
          <p className="acct-prose acct-measure">
            Requests made at a label you read of a label above it, which you may not read. Each is paid for when it is asked. What comes
            back passes that label&rsquo;s gate.
          </p>
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>asked of</th>
                  <th>requests</th>
                  <th>told it was taken up</th>
                  <th>answered</th>
                  <th>answer at the gate</th>
                  <th>nothing back yet</th>
                </tr>
              </thead>
              <tbody>
                {backlog!.asked_from_here.map((a, i) => (
                  <tr key={i}>
                    <td>
                      {a.asked_of}
                      <span className="acct-detail">asked at {a.asked_at}</span>
                    </td>
                    <td>
                      {a.requests}
                      <span className="acct-detail">{a.owls_put_behind_them} owls behind them</span>
                    </td>
                    <td>{a.told_they_were_taken_up}</td>
                    <td>{a.answer_through_the_gate}</td>
                    <td>{a.answer_waiting_at_the_gate}</td>
                    <td>{a.nothing_back_yet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {mine.length === 0 && waitingElsewhere.length === 0 && (
        <p className="account-empty admin-first">No gate leads to a label you read, and you have a say over none.</p>
      )}
    </div>
  );
}
