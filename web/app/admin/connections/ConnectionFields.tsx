import { Lbl, Tip } from "@/components/work/ui";
import type { ConnectionRoleView, ConnectionView, MyLabels, PartyView } from "@/lib/admin-api";
import { LabelField } from "../../sources/LabelField";

// The settings of a connection, as the fields of a form: the same fields
// whether one is being added or changed.
//
// The credential comes from one of two places. When a connection is added,
// it can be pasted here: the API seals it as it arrives, under a key only
// the deployment's environment holds, and never sends it back. Or the
// connection names an environment variable that holds it. A connection being
// changed is given a new credential in its own form (CredentialForm), not
// here, so that saving other settings never sends one.
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
  canKeepCredentials = false,
  roles = [],
}: {
  labels: MyLabels;
  parties: PartyView[];
  current?: ConnectionView;
  /** Whether the deployment has the key a pasted credential is kept with. */
  canKeepCredentials?: boolean;
  /** The agent roles a connection may be offered to, as the API lists them. */
  roles?: ConnectionRoleView[];
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
      {!current && (
        <div className="w-field">
          <label htmlFor="c-credential" className="w-row" style={{ gap: 6 }}>
            Credential {optional}
            <Tip>
              A token for the system: the narrowest that allows what you grant, and a read-only one unless you mean to grant a tool to write. It is encrypted as it arrives, under a key only the deployment&rsquo;s environment holds, and is never shown again. It is tied to this address: changing the address removes it. Or leave this empty and name an environment variable below.
            </Tip>
          </label>
          <input
            id="c-credential"
            className="w-input w-mono"
            name="credential"
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={8192}
            disabled={!canKeepCredentials}
            placeholder={canKeepCredentials ? "Paste the token, without “Bearer ”" : ""}
          />
          <span className="w-help">
            {canKeepCredentials
              ? "Kept encrypted, never shown again"
              : "This deployment has no key to keep a credential with (CREDENTIAL_ENCRYPTION_KEY). Whoever runs it can set one; until then, name a variable below."}
          </span>
        </div>
      )}
      <div style={pair}>
        <div className="w-field">
          <label htmlFor="c-env" className="w-row" style={{ gap: 6 }}>
            {current ? "Credential variable" : "Or a credential variable"} {optional}
            <Tip>
              The name of an environment variable where the deployment runs, starting CONNECTION_. Never the credential itself. Naming one replaces a credential given on this page. Leave empty for a server that asks for none.
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
          Stake {optional}
          <Tip>
            What the party stands to gain or lose from what the system shows, where that is worth saying: for an outside party&rsquo;s system, say, whose interest in what it shows the agents could not guess. Given, it is recorded on every reading kept from the connection, as a fact about the source and never a finding against it. Left empty, none is recorded, and an interest that bears on one question is recorded by the agent weighing that question.
          </Tip>
        </label>
        <textarea id="c-stake" className="w-input" name="stake" rows={2} maxLength={1000} defaultValue={current?.stake ?? ""} />
        <span className="w-help">Usually empty for your own organisation&rsquo;s systems</span>
      </div>
      {roles.length > 0 && <OfferedTo roles={roles} current={current} />}
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

// Which agents a run is offered the connection in, role by role. A new
// connection starts with every role ticked but those the API says start
// unticked, each with why; a connection being changed shows what it has.
// The hidden field says the list was on the form, so that unticking every
// role is a change and not a field left out.
function OfferedTo({ roles, current }: { roles: ConnectionRoleView[]; current?: ConnectionView }) {
  return (
    <fieldset className="w-field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="w-label w-row" style={{ gap: 6 }}>
        Offered to{" "}
        <Tip>
          The agents that may read through this connection, when they work at a label that reads its label. Only the Stewards, and a Researcher whose work records sources, may keep what they read as a source; the others read to inform their own work.
        </Tip>
      </legend>
      <input type="hidden" name="offered_to_listed" value="1" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "4px 14px" }}>
        {roles.map((r) => (
          <label key={r.role} className="w-row" style={{ gap: 6, alignItems: "flex-start", fontWeight: 400 }}>
            <input
              type="checkbox"
              name="offered_to"
              value={r.role}
              defaultChecked={current ? current.offered_to.includes(r.role) : r.off_at_first === undefined}
              style={{ marginTop: 3 }}
            />
            <span>
              {r.name}
              {r.keeps !== "no" && <span className="w-faint w-small"> · may keep readings</span>}
              {r.off_at_first && <Tip>{`Unticked on a new connection: ${r.off_at_first}`}</Tip>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
