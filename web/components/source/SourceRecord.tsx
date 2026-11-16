import Link from "next/link";
import type { SourcePage } from "@/lib/types";
import { agentName, EVENT_WORD, kindLabel, partialDate, when, type Group } from "./model";
import s from "./source.module.css";
import { isReadingAddress } from "@/lib/source-address";

// Every recorded fact about the document (#507). A fact that was found gets
// its row; those not found share one row that names them, so the gaps are
// still said plainly without a column of "None". When the history holds only
// the intake steps every source goes through, they are one line here rather
// than a section of their own.
export function SourceRecord({
  page, groups, intakeOnly = false,
}: { page: SourcePage; groups: Group[]; intakeOnly?: boolean }) {
  const { source, versions, copies, copy_of, events } = page.facts;
  const doc = page.document;
  const nLeaves = groups.reduce((n, g) => n + g.leaves.length, 0);
  const earlier = versions.filter((v) => !v.later);
  const later = versions.filter((v) => v.later);
  const published = partialDate(source.published_date);
  const missing: string[] = [];
  if (!source.authors.length) missing.push("authors");
  if (!source.publisher) missing.push("publisher");
  if (!published) missing.push("date");
  if (!source.doi) missing.push("DOI");
  if (!source.url) missing.push("link");
  if (!source.archived_url) missing.push("archived copy");
  if (!doc) missing.push("stored text");
  if (!doc?.extractions?.length) missing.push("claims extracted");
  if (!versions.length) missing.push("other versions");
  if (!copies.length) missing.push("copies");
  if (!events.length && source.facts_checked_at) missing.push("corrections");
  const intake = intakeOnly
    ? [...(page.context?.history ?? [])].sort((a, b) => a.at.localeCompare(b.at))
    : [];

  return (
    <section id="record">
      <h2 className={s.h2}>Record</h2>
      <dl className={s.rec}>
        <dt>Kind</dt>
        <dd>{kindLabel(source.source_type)}</dd>
        {source.authors.length > 0 && <><dt>Authors</dt><dd>{source.authors.join(", ")}</dd></>}
        {source.publisher && <><dt>Publisher</dt><dd>{source.publisher}</dd></>}
        {published && <><dt>Published</dt><dd>{published}</dd></>}
        {source.doi && <><dt>DOI</dt><dd><a href={`https://doi.org/${source.doi}`}>{source.doi}</a></dd></>}
        {source.url && (
          <>
            <dt>Link</dt>
            <dd>
              {isReadingAddress(source.url) ? (
                <code>{source.url}</code>
              ) : (
                <a href={source.url} rel="noopener noreferrer">{source.url}</a>
              )}
            </dd>
          </>
        )}
        {source.archived_url && (
          <><dt>Archived copy</dt><dd><a href={source.archived_url} rel="noopener noreferrer">{source.archived_url}</a></dd></>
        )}
        {doc && (
          <>
            <dt>Stored text</dt>
            <dd>
              {doc.total_chars === 0
                ? <span className={s.quiet}>None; quoted passages only</span>
                : `${doc.total_chars.toLocaleString("en-US")} characters, retrieved ${when(source.retrieved_at)}${doc.segmented ? ` · ${groups.length} sections, ${nLeaves} passages` : " · not yet divided"}`}
            </dd>
          </>
        )}
        {doc?.extractions && doc.extractions.length > 0 && (
          <>
            <dt>Claims extracted</dt>
            <dd>
              <ul>
                {doc.extractions.map((e, i) => (
                  <li key={i}>
                    {e.focus ? <>For <q>{e.focus}</q></> : "The whole document"}
                    {` · ${e.claims_extracted} claim${e.claims_extracted === 1 ? "" : "s"} (${e.claims_created} new)`}
                    <span className={s.quiet}>
                      {" · "}{when(e.created_at)}
                      {e.grant_id && <> for <Link href={`/mandates/${e.grant_id}`}>{e.grant_name ?? "a mandate"}</Link></>}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {versions.length > 0 && (
          <>
            <dt>Versions</dt>
            <dd>
              <ul>
                {earlier.map((v) => <li key={v.id}><span className={s.quiet}>Earlier · </span><Link href={`/sources/${v.id}`}>{v.title}</Link></li>)}
                <li><span className={s.quiet}>This version</span></li>
                {later.map((v) => <li key={v.id}><span className={s.quiet}>Later · </span><Link href={`/sources/${v.id}`}>{v.title}</Link></li>)}
              </ul>
            </dd>
          </>
        )}
        {copies.length > 0 && (
          <>
            <dt>Copies</dt>
            <dd><ul>{copies.map((c) => <li key={c.id}><Link href={`/sources/${c.id}`}>{c.title}</Link></li>)}</ul></dd>
          </>
        )}
        {copy_of.length > 0 && (
          <>
            <dt>Copy of</dt>
            <dd><ul>{copy_of.map((c) => <li key={c.id}><Link href={`/sources/${c.id}`}>{c.title}</Link></li>)}</ul></dd>
          </>
        )}
        {events.length > 0 && (
          <>
            <dt>Corrections</dt>
            <dd>
              <ul>
                {events.map((e, i) => (
                  <li key={i}>
                    <b>{EVENT_WORD[e.kind]}</b> {e.occurred_at ? when(e.occurred_at) : "date not given"}
                    {e.note && ` · ${e.note}`}
                    {e.notice_url && <> · <a href={e.notice_url} rel="noopener noreferrer">Notice</a></>}
                    <span className={s.quiet}> · found {when(e.detected_at)} by {agentName(e.detected_by)}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Facts checked</dt>
        <dd>{source.facts_checked_at ? when(source.facts_checked_at) : <span className={s.quiet}>Not yet; corrections not checked</span>}</dd>
        {missing.length > 0 && (
          <>
            <dt>Not recorded</dt>
            <dd className={s.quiet}>{sentence(missing)}</dd>
          </>
        )}
        {intake.length > 0 && (
          <>
            <dt>History</dt>
            <dd>
              {when(intake[0]!.at)}
              {" · "}
              {intake.map((h) => h.text).join(" · ")}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function sentence(items: string[]): string {
  const t = items.join(", ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
