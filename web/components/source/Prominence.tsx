import Link from "next/link";
import type { InstanceSupport, SourceContext } from "@/lib/types";
import { plural, SUPPORT_CLS, SUPPORT_WORD, when } from "./model";
import s from "./source.module.css";

// What the record shows about how much this document matters (#507): its
// reach, where it stands in claims' stories, and what the Stewards found on
// reading it. Figures as they are; no score is computed from them.
export function Prominence({ context }: { context: SourceContext | null | undefined }) {
  if (!context) return null;
  const { reach, structure: st, evidence: ev } = context.prominence;

  const reachV = reach.copies ? plural(reach.copies, "republication") : "No copies recorded";
  const reachS = reach.copies && reach.direct_copies < reach.copies
    ? `${reach.direct_copies} direct, ${reach.copies - reach.direct_copies} through copies of copies`
    : reach.copies ? "All made directly from it" : "";

  const structV = st.origin_on
    ? `Origin on ${plural(st.origin_on, "claim")}`
    : st.underlying_on
      ? `Underlying on ${plural(st.underlying_on, "claim")}`
      : st.claims
        ? `In ${plural(st.claims, "claim's map", "claims' maps")}`
        : "No recorded edges";
  const structS = [
    st.origin_on && st.origin_by_steward ? `by the Steward's reading on ${st.origin_by_steward}` : null,
    st.origin_on && st.underlying_on ? `underlying on ${st.underlying_on}` : null,
    st.claims_read ? `${plural(st.downstream, "source")} downstream across ${plural(st.claims_read, "claim")}` : null,
    st.claims_read < st.claims ? `of the first ${st.claims_read} of ${st.claims} claims read` : null,
  ].filter(Boolean).join(" · ");

  const bySupport = (Object.entries(ev.readings_by_support) as Array<[InstanceSupport, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const readings = bySupport.reduce((n, [, k]) => n + k, 0);
  const evV = readings ? `${plural(readings, "reading")} · ${ev.read_whole} read whole` : "Not yet read";

  return (
    <div className={s.promWrap}>
      <div className={s.prom}>
        <div>
          <span className="sc">Reach</span>
          <span className={s.pv}>{reachV}</span>
          {reachS && <span className={s.ps}>{reachS}</span>}
        </div>
        <div>
          <span className="sc">Structure</span>
          <span className={s.pv}>{structV}</span>
          {structS && <span className={s.ps}>{structS}</span>}
        </div>
        <div>
          <span className="sc">Evidence</span>
          <span className={s.pv}>{evV}</span>
          {bySupport.length > 0 && (
            <span className={s.ps}>
              {bySupport.map(([k, n], i) => (
                <span key={k}>
                  {i > 0 && " · "}
                  <span className={SUPPORT_CLS[k]}>{SUPPORT_WORD[k] ?? k}</span> {n}
                </span>
              ))}
            </span>
          )}
          {readings > 0 && (
            <span className={s.ps}>
              {ev.claims_citing_findings
                ? `${plural(ev.claims_citing_findings, "claim")} ${ev.claims_citing_findings === 1 ? "cites" : "cite"} examinations' findings`
                : "No claim cites an examination's findings"}
            </span>
          )}
        </div>
      </div>
      {ev.notes.length > 0 && (
        <details className={s.flist}>
          <summary>Stewards&rsquo; notes · {ev.notes.length}</summary>
          <ul className={s.snotes}>
            {ev.notes.map((n, i) => (
              <li key={i}>
                <Link className={s.nclaim} href={`/claims/${n.claim.id}`}>{n.claim.text}</Link>
                <p className={s.nread}>
                  <b className={SUPPORT_CLS[n.support]}>{SUPPORT_WORD[n.support] ?? n.support}.</b> {n.note}{" "}
                  <span className={s.caution}>{when(n.read_at)}</span>
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
