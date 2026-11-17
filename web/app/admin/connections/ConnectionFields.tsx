import { Lbl, Tip } from "@/components/work/ui";
import type { ConnectionView, MyLabels, PartyView } from "@/lib/admin-api";
import { LabelField } from "../../sources/LabelField";

// The settings of a connection, as the fields of a form: the same fields
// whether one is being added or changed. No field takes a credential. A
// connection names the environment variable that holds its credential, and
// the deployment reads it at the moment of a call.
//
// The label is chosen when a connection is added, among the labels the
// administrator reads, and the connection keeps it: a connection being
// changed shows its label and offers no other.

const pair = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 } as const;
const optional = (
  <span className="w-faint" style={{ fontWeight: 400 }}>
    optional
  </span>
);

export function ConnectionFields({
  labels,
  parties,
  current,
}: {
  labels: MyLabels;
  parties: PartyView[];
  current?: ConnectionView;
}) {
  return (
    <>
      <div style={pair}>
        <div className="w-field">
          <label htmlFor="c-name">Name</label>
          <input id="c-name" className="w-input" name="name" required maxLength={120} defaultValue={current?.name} autoComplete="off" />
          <span className="w-help">Such as the system&rsquo;s name</span>
        </div>
        <div className="w-field">
          <label htmlFor="c-party">Party</label>
          <select id="c-party" className="w-select" name="party_id" required defaultValue={current?.party.id ?? ""}>
            <option value="" disabled>
              Whose system it is
            </option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="w-field">
        <label htmlFor="c-url" className="w-row" style={{ gap: 6 }}>
          MCP server address{" "}
          <Tip>An http or https address, expected to be inside the organisation&rsquo;s network. It must carry no user name, password or key: an address is stored and shown.</Tip>
        </label>
        <input id="c-url" className="w-input w-mono" name="url" type="url" required maxLength={2000} defaultValue={current?.url} autoComplete="off" placeholder="https://" />
      </div>
      <div style={pair}>
        <div className="w-field">
          <label htmlFor="c-transport">Transport</label>
          <select id="c-transport" className="w-select" name="transport" defaultValue={current?.transport ?? "streamable_http"}>
            <option value="streamable_http">Streamable HTTP</option>
            <option value="sse">SSE, for a server that only speaks that</option>
          </select>
        </div>
        {current ? (
          <div className="w-field">
            <span className="w-label w-row" style={{ gap: 6 }}>
              Label{" "}
              <Tip>
                A connection keeps the label it was added at. To have the same system read at another label, add a second connection at that label; this one can be switched off.
              </Tip>
            </span>
            <span style={{ height: 32, display: "flex", alignItems: "center" }}>
              <Lbl name={current.label} />
            </span>
          </div>
        ) : (
          <LabelField
            mine={labels}
            tip="An agent's run is offered this connection only when the label it works at reads this one. It is chosen now and kept."
          />
        )}
      </div>
      <div style={pair}>
        <div className="w-field">
          <label htmlFor="c-env" className="w-row" style={{ gap: 6 }}>
            Credential variable {optional}
            <Tip>
              The name of an environment variable where the deployment runs, starting CONNECTION_. Never the credential itself. Leave empty for a server that asks for none.
            </Tip>
          </label>
          <input
            id="c-env"
            className="w-input w-mono"
            name="credential_env"
            pattern="CONNECTION_[A-Z0-9_]+"
            placeholder="CONNECTION_"
            defaultValue={current?.credential.env ?? ""}
            autoComplete="off"
          />
        </div>
        <div className="w-field">
          <label htmlFor="c-header" className="w-row" style={{ gap: 6 }}>
            Header <Tip>In Authorization it is sent as a bearer token; in any other header, as it is.</Tip>
          </label>
          <input id="c-header" className="w-input w-mono" name="credential_header" defaultValue={current?.credential.header ?? "Authorization"} autoComplete="off" />
        </div>
      </div>
      <div className="w-field">
        <label htmlFor="c-stake" className="w-row" style={{ gap: 6 }}>
          Stake{" "}
          <Tip>
            What the party stands to gain or lose from what the system shows, in a sentence or two. It is recorded on every reading kept from the connection, as a fact about the source and never a finding against it.
          </Tip>
        </label>
        <textarea id="c-stake" className="w-input" name="stake" required rows={2} maxLength={1000} defaultValue={current?.stake} />
        <span className="w-help">What the party stands to gain or lose from what the system shows</span>
      </div>
      <div style={pair}>
        <div className="w-field">
          <label htmlFor="c-rate" className="w-row" style={{ gap: 6 }}>
            Calls a minute {optional}
            <Tip>All runs together. Empty for no rate. Calls cost the system and no owls, so nothing else bounds them. Agents are told the rate and why.</Tip>
          </label>
          <input id="c-rate" className="w-input" name="calls_per_minute" type="number" min={1} max={6000} defaultValue={current?.calls_per_minute ?? ""} />
        </div>
        <div className="w-field">
          <label htmlFor="c-timeout">Timeout, seconds</label>
          <input id="c-timeout" className="w-input" name="timeout_seconds" type="number" min={5} max={900} defaultValue={current?.timeout_seconds ?? 120} />
        </div>
        {!current && (
          <div className="w-field">
            <label htmlFor="c-prefix" className="w-row" style={{ gap: 6 }}>
              Tool prefix {optional}
              <Tip>A short lower-case word agents see before each tool&rsquo;s name. Made from the name when left empty.</Tip>
            </label>
            <input id="c-prefix" className="w-input w-mono" name="tool_prefix" pattern="[a-z][a-z0-9_]*" autoComplete="off" />
          </div>
        )}
      </div>
    </>
  );
}
