import Link from "next/link";
import type { PublisherRecord } from "@/lib/api";
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
