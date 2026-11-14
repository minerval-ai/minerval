import Link from "next/link";
import type { PublishedMandate, PublisherRecord } from "@/lib/api";
import { day, showingWords, stateWords } from "@/lib/published";

// A publisher's public record, on its contributor page
// (docs/published-pages.md): the keys it registered, where each deployment
// is said to run, and the pages it has published with the state of each.
export function PublisherRecordSection({ record }: { record: PublisherRecord }) {
  const live = record.registrations.find((r) => !r.retired_at) ?? record.registrations[0]!;
  return (
    <section>
      <h2>Pages it publishes from its own graph</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        This account has registered the signing key of a deployment of Minerval that it runs. Anyone can run a deployment and register a key, so the
        registration says who submits pages under the key and nothing about how far they are to be believed. A page it publishes is reviewed and
        weighed as any contribution is.
      </p>
      <dl className="record-rows">
        <dt>Where it runs</dt>
        <dd>{live.runs_on.charAt(0).toUpperCase() + live.runs_on.slice(1)}, by its own statement. {live.attested_by.charAt(0).toUpperCase() + live.attested_by.slice(1)}.</dd>
        <dt>Its own interest</dt>
        <dd>{live.declared_interest ?? "It has said nothing of its own interest. An interest in a particular claim is recorded on each page's source."}</dd>
        <dt>Signing key</dt>
        <dd>
          <ul className="record-list">
            {record.registrations.map((r) => (
              <li key={`${r.key_id}-${r.registered_at}`}>
                <span className="mono">{r.key_id.slice(0, 16)}</span>, registered {day(r.registered_at)}
                {r.retired_at ? `, replaced ${day(r.retired_at)} (${r.runs_on})` : ""}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      {record.record && (
        <>
          <h3 style={{ fontFamily: "var(--sans)", fontSize: ".9rem", marginBottom: ".2rem" }}>Its record on this graph</h3>
          <ul className="record-list" style={{ fontFamily: "var(--sans)", fontSize: ".84rem" }}>
            {record.record.in_words.map((line) => (
              <li key={line} style={{ marginBottom: ".3rem" }}>
                {line}
              </li>
            ))}
          </ul>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem" }}>
            These are counts and dates read from this graph&rsquo;s record when this page is opened. They are not a score, and they say nothing about
            how far a page is to be believed: that is weighed for each page by the Steward of the claim it is on.
          </p>
        </>
      )}
      {(record.published_mandates ?? []).length > 0 && (
        <>
          <h3 style={{ fontFamily: "var(--sans)", fontSize: ".9rem", marginBottom: ".2rem" }}>Mandates it published, which take requests made here</h3>
          {record.published_mandates!.map((m) => (
            <PublishedMandateRow key={m.face_id} m={m} />
          ))}
        </>
      )}
      {record.published_pages.length > 0 && (
        <ul className="record-list" style={{ fontFamily: "var(--sans)", fontSize: ".84rem" }}>
          {record.published_pages.map((p) => (
            <li key={p.published_page_id} style={{ marginBottom: ".7rem" }}>
              <Link href={p.on_the_node.on_the_nodes_page ? `/claims/${p.node_id}?published=${p.published_page_id}` : `/claims/${p.node_id}`}>{p.node ?? "A node"}</Link>
              <br />
              <span className="held-mark" aria-hidden /> {stateWords(p)}. {showingWords(p)}{" "}
              {p.on_the_node.review === "admitted"
                ? p.on_the_node.on_the_nodes_page
                  ? "On the claim's page."
                  : p.on_the_node.taken_off_by_the_nodes_steward
                    ? "Taken off the claim's page by its Steward."
                    : "Admitted to the claim's record; no page has been released."
                : p.on_the_node.review === "not admitted"
                  ? "Its submission was not admitted."
                  : "Its submission is waiting for review."}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Spelling for this page's readers: the deployment stamps its words in American English.
const british = (text: string) => text.replace(/\borganiz/g, "organis").replace(/\bOrganiz/g, "Organis");

const UNDER_SAID: Record<string, string> = {
  open: "open: it goes as written",
  redactor: "what its Redactor lets through under its published policy goes, with no person deciding after it",
  person: "a person decides as well, after its Redactor",
};

// One published mandate: its terms, how its publisher's gate is set for its
// work as the publishing deployment stamped it, and each change with its
// date. A request on this graph is addressed to it by its id.
function PublishedMandateRow({ m }: { m: PublishedMandate }) {
  const small = { color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem" } as const;
  return (
    <div style={{ fontFamily: "var(--sans)", fontSize: ".84rem", marginBottom: "1rem" }}>
      <p style={{ marginBottom: ".2rem" }}>
        <strong>{m.name}</strong>
        {m.withdrawn_at ? `, withdrawn ${day(m.withdrawn_at)}` : ""}. Published {day(m.first_published_at)}
        {m.last_changed_at !== m.first_published_at ? `, last changed ${day(m.last_changed_at)}` : ""}.{" "}
        {m.requests_addressed_to_it === 1 ? "One request has been addressed to it." : `${m.requests_addressed_to_it} requests have been addressed to it.`}
      </p>
      <p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{m.terms}</p>
      {m.gate ? (
        <>
          <p style={{ marginBottom: ".2rem" }}>What it has said it will release, as its gate to outside is set for this mandate&rsquo;s work:</p>
          <ul className="record-list">
            {m.gate.settings.map((s) => (
              <li key={s.kind}>{british(s.in_a_line)}</li>
            ))}
            {m.gate.for_requests_under.map((u) => (
              <li key={`${u.public_node_id}-${u.kind}`}>
                For requests on <Link href={`/claims/${u.public_node_id}`}>a node</Link> and what sits under it ({u.kind.replace(/_/g, " ")}): {UNDER_SAID[u.the_gate] ?? u.the_gate}, set on {u.set_on}.
              </li>
            ))}
          </ul>
          <p style={small}>
            {british(m.gate.pages_flow)} {british(m.gate.other_parties)}
            {m.gate.narrower_settings_not_listed > 0 ? ` It has ${m.gate.narrower_settings_not_listed} narrower setting${m.gate.narrower_settings_not_listed === 1 ? "" : "s"}, for single requests, that are not listed.` : ""}
          </p>
          <p style={small}>{british(m.gate.money)}</p>
        </>
      ) : (
        <p style={small}>Its package says nothing of how its gate is set.</p>
      )}
      <details>
        <summary style={small}>Its history here, and how to address a request to it</summary>
        <ul className="record-list" style={small}>
          {m.history.map((h) => (
            <li key={h.package}>
              {day(h.received_at)}: {h.changes.map(british).join(" ")}
            </li>
          ))}
        </ul>
        <p style={small}>
          To address a request to it, give <span className="mono">{m.face_id}</span> as the request&rsquo;s addressee. The request stays an ordinary
          one: anyone may fund or meet it, and its record shows what the publisher did about it. {british(m.note)}
        </p>
      </details>
    </div>
  );
}
