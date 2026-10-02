import Link from "next/link";
import type { SourcePage } from "@/lib/types";
import { EVENT_WORD, kindLabel, partialDate, when, type ExamView, type Group } from "./model";
import s from "./source.module.css";

// Identity, then what has happened to the document since: facts that need no
// judgment, first on the page (#507).
export function SourceHead({
  page, groups, exams, sample,
}: { page: SourcePage; groups: Group[]; exams: ExamView[]; sample: boolean }) {
  const { source, versions, copies, copy_of, events } = page.facts;
  const doc = page.document;
  const published = partialDate(source.published_date);
  const later = versions.filter((v) => v.later);
  const claimIds = new Set<string>();
  for (const seg of doc?.segments ?? []) seg.instances.forEach((i) => claimIds.add(i.claim.id));
  doc?.unanchored.forEach((i) => claimIds.add(i.claim.id));
  const nFindings = exams.reduce((n, e) => n + e.exam.findings.length, 0);
  const stored = doc && doc.total_chars > 0;
  const lastEvent = [...events].sort((a, b) => (b.occurred_at ?? b.detected_at).localeCompare(a.occurred_at ?? a.detected_at))[0];

  return (
    <header className={s.head}>
      <div className="claim-eyebrow">
        <span className="sc">Source</span>
        <span className="tag kind">{kindLabel(source.source_type)}</span>
        <span className="tag">{stored ? "text stored" : "no stored text"}</span>
        {sample && (
          <span className="tag" title="This preview is not connected to the live graph; this is an invented example.">
            sample
          </span>
        )}
      </div>
      <h1 className={s.hero}>{source.title}</h1>
      <p className={s.ident}>
        {source.authors.length > 0 ? <b>{source.authors.join(", ")}</b> : <span className={s.none}>Author not recorded</span>}
        {source.publisher && <span>{source.publisher}</span>}
        <span>{published ? `Published ${published}` : <span className={s.none}>Date not recorded</span>}</span>
        {source.doi && <a href={`https://doi.org/${source.doi}`}>doi {source.doi}</a>}
        {source.url && <a href={source.url} rel="noopener noreferrer">Original&#xFE0E; ↗</a>}
        {source.archived_url && <a href={source.archived_url} rel="noopener noreferrer">Archived copy</a>}
      </p>

      {events.map((e, i) => (
        <div
          key={i}
          className={`${s.notice} ${e.kind === "retraction" || e.kind === "removal" ? s.grave : ""}`}
        >
          <span className="sc">{EVENT_WORD[e.kind]}</span>
          <span>
            {e.occurred_at ? when(e.occurred_at) : `found ${when(e.detected_at)}`}
            {e.note ? ` · ${e.note}` : ""}
          </span>
          {e.notice_url && <a href={e.notice_url} rel="noopener noreferrer">Notice</a>}
        </div>
      ))}
      {later.map((v) => (
        <div key={v.id} className={`${s.notice} ${s.plain}`}>
          <span className="sc">Later version</span>
          <Link href={`/sources/${v.id}`}>{v.title}</Link>
        </div>
      ))}
      {copy_of.map((v) => (
        <div key={v.id} className={`${s.notice} ${s.plain}`}>
          <span className="sc">Copy of</span>
          <Link href={`/sources/${v.id}`}>{v.title}</Link>
        </div>
      ))}

      <div className={s.band}>
        <Fact k="Claims" v={claimIds.size ? String(claimIds.size) : "None"} quiet={!claimIds.size} />
        <Fact
          k="Examinations"
          v={exams.length ? `${exams.length} · ${nFindings} ${nFindings === 1 ? "finding" : "findings"}` : "None"}
          quiet={!exams.length}
        />
        <Fact
          k="Text"
          v={!doc ? "Not recorded" : !stored ? "Not stored" : doc.segmented ? `${groups.length} ${groups.length === 1 ? "section" : "sections"}` : "Stored, not divided"}
          quiet={!stored}
        />
        <Fact k="Versions" v={versions.length ? `${versions.length + 1} known` : "One known"} quiet={!versions.length} />
        <Fact k="Copies" v={copies.length ? `${copies.length} recorded` : "None recorded"} quiet={!copies.length} />
        <Fact
          k="Corrections"
          v={lastEvent
            ? `${EVENT_WORD[lastEvent.kind]} ${when(lastEvent.occurred_at ?? lastEvent.detected_at)}`
            : source.facts_checked_at ? "None recorded" : "Not checked"}
          quiet={!lastEvent}
        />
        <span className={s.when}>
          {source.facts_checked_at ? `Facts checked ${when(source.facts_checked_at)}` : "Facts not yet checked"}
        </span>
      </div>
    </header>
  );
}

function Fact({ k, v, quiet }: { k: string; v: string; quiet?: boolean }) {
  return (
    <div className={s.bi}>
      <span className="sc">{k}</span>
      <span className={`${s.bv} ${quiet ? s.quiet : ""}`}>{v}</span>
    </div>
  );
}
