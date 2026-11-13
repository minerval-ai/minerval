import { LabelChoice } from "@/components/admin/LabelChoice";
import type { ConnectionView, MyLabels, PartyView } from "@/lib/admin-api";

// The settings of a connection, as the fields of a form: the same fields
// whether one is being added or changed. No field takes a credential. A
// connection names the environment variable that holds its credential, and
// the deployment reads it at the moment of a call.
//
// The label is chosen when a connection is added, among the labels the
// administrator reads, and the connection keeps it: a connection being
// changed shows its label and offers no other.
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
      <div className="admin-form-row">
        <label>
          Name
          <input name="name" required maxLength={120} defaultValue={current?.name} autoComplete="off" />
          <small>What administrators and agents know it by, such as the system&rsquo;s name.</small>
        </label>
        <label>
          Whose system it is
          <select name="party_id" required defaultValue={current?.party.id ?? ""}>
            <option value="" disabled>
              Choose a party
            </option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Address of its MCP server
        <input name="url" type="url" required maxLength={2000} defaultValue={current?.url} autoComplete="off" />
        <small>
          An http or https address. It must carry no user name, password or key: an address is
          stored and shown.
        </small>
      </label>
      <div className="admin-form-row">
        <label>
          How the server is spoken to
          <select name="transport" defaultValue={current?.transport ?? "streamable_http"}>
            <option value="streamable_http">Streamable HTTP</option>
            <option value="sse">SSE, for a server that only speaks that</option>
          </select>
        </label>
        {current ? (
          <p className="admin-kept">
            <span className="sc">Label</span> <code>{current.label}</code>
            <small>
              A connection keeps the label it was added at. To have the same system read at another
              label, add a second connection at that label; this one can be switched off.
            </small>
          </p>
        ) : (
          <LabelChoice
            mine={labels}
            what="An agent's run is offered this connection only when the label it works at reads this one. It is chosen now and kept."
          />
        )}
      </div>
      <div className="admin-form-row">
        <label>
          The variable that holds its credential
          <input
            name="credential_env"
            pattern="CONNECTION_[A-Z0-9_]+"
            placeholder="CONNECTION_"
            defaultValue={current?.credential.env ?? ""}
            autoComplete="off"
          />
          <small>
            The name of an environment variable where the deployment runs, starting CONNECTION_.
            Never the credential itself. Leave empty for a server that asks for none.
          </small>
        </label>
        <label>
          The header it is sent in
          <input name="credential_header" defaultValue={current?.credential.header ?? "Authorization"} autoComplete="off" />
          <small>In Authorization it is sent as a bearer token; in any other header, as it is.</small>
        </label>
      </div>
      <label>
        The party&rsquo;s stake
        <textarea name="stake" required rows={2} maxLength={1000} defaultValue={current?.stake} />
        <small>
          What the party stands to gain or lose from what the system shows, in a sentence or two.
          It is recorded on every reading kept from the connection, as a fact about the source and
          never a finding against it.
        </small>
      </label>
      <div className="admin-form-row">
        <label>
          Calls a minute, all runs together
          <input name="calls_per_minute" type="number" min={1} max={6000} defaultValue={current?.calls_per_minute ?? ""} />
          <small>
            Empty for no rate. Calls cost the system and no owls, so nothing else bounds them.
            Agents are told the rate and why.
          </small>
        </label>
        <label>
          Seconds a call may go unanswered
          <input name="timeout_seconds" type="number" min={5} max={900} defaultValue={current?.timeout_seconds ?? 120} />
        </label>
        {!current && (
          <label>
            Prefix of its tool names
            <input name="tool_prefix" pattern="[a-z][a-z0-9_]*" autoComplete="off" />
            <small>A short lower-case word. Made from the name when left empty.</small>
          </label>
        )}
      </div>
    </>
  );
}
