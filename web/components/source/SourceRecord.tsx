import Link from "next/link";
import type { SourcePage } from "@/lib/types";
import { agentName, EVENT_WORD, kindLabel, partialDate, when, type Group } from "./model";
import s from "./source.module.css";

// Every recorded fact about the document in full, each saying plainly when it
// was not found rather than leaving a gap (#507).
export function SourceRecord({ page, groups }: { page: SourcePage; groups: Group[] }) {
  const { source, versions, copies, copy_of, events } = page.facts;
  const doc = page.document;
  const nLeaves = groups.reduce((n, g) => n + g.leaves.length, 0);
  const none = (t = "Not recorded") => <span className={s.quiet}>{t}</span>;
  const earlier = versions.filter((v) => !v.later);
  const later = versions.filter((v) => v.later);

  return (
    <section id="record">
      <h2 className={s.h2}>Record</h2>
      <dl className={s.rec}>
        <dt>Kind</dt>
        <dd>{kindLabel(source.source_type)}</dd>
        <dt>Authors</dt>
        <dd>{source.authors.length ? source.authors.join(", ") : none()}</dd>
        <dt>Publisher</dt>
        <dd>{source.publisher ?? none()}</dd>
        <dt>Published</dt>
        <dd>{partialDate(source.published_date) ?? none()}</dd>
        <dt>DOI</dt>
        <dd>{source.doi ? <a href={`https://doi.org/${source.doi}`}>{source.doi}</a> : none("None")}</dd>
        <dt>Link</dt>
        <dd>{source.url ? <a href={source.url} rel="noopener noreferrer">{source.url}</a> : none()}</dd>
        <dt>Archived copy</dt>
        <dd>{source.archived_url ? <a href={source.archived_url} rel="noopener noreferrer">{source.archived_url}</a> : none("None found")}</dd>
        <dt>Stored text</dt>
        <dd>
          {!doc
            ? none()
            : doc.total_chars === 0
              ? none("None; quoted passages only")
              : `${doc.total_chars.toLocaleString("en-US")} characters, retrieved ${when(source.retrieved_at)}${doc.segmented ? ` · ${groups.length} sections, ${nLeaves} passages` : " · not yet divided"}`}
        </dd>
        <dt>Versions</dt>
        <dd>
          {versions.length === 0 ? (
            none("One known")
          ) : (
            <ul>
              {earlier.map((v) => <li key={v.id}><span className={s.quiet}>Earlier · </span><Link href={`/sources/${v.id}`}>{v.title}</Link></li>)}
              <li><span className={s.quiet}>This version</span></li>
              {later.map((v) => <li key={v.id}><span className={s.quiet}>Later · </span><Link href={`/sources/${v.id}`}>{v.title}</Link></li>)}
            </ul>
          )}
        </dd>
        <dt>Copies</dt>
        <dd>
          {copies.length === 0 ? (
            none("None recorded")
          ) : (
            <ul>{copies.map((c) => <li key={c.id}><Link href={`/sources/${c.id}`}>{c.title}</Link></li>)}</ul>
          )}
        </dd>
        {copy_of.length > 0 && (
          <>
            <dt>Copy of</dt>
            <dd><ul>{copy_of.map((c) => <li key={c.id}><Link href={`/sources/${c.id}`}>{c.title}</Link></li>)}</ul></dd>
          </>
        )}
        <dt>Corrections</dt>
        <dd>
          {events.length === 0 ? (
            none(source.facts_checked_at ? "None recorded" : "Not yet checked")
          ) : (
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
          )}
        </dd>
        <dt>Facts checked</dt>
        <dd>{source.facts_checked_at ? when(source.facts_checked_at) : none("Not yet")}</dd>
      </dl>
    </section>
  );
}
