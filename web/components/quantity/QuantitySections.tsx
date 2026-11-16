import Link from "next/link";
import type { ReactNode } from "react";
import type { ArgumentItem, ClaimDetail, QuantityDefinition, QuantityEstimate, QuantityUnit, ThresholdOf } from "@/lib/types";
import { argumentVerdictMeta, DEFINED_IN, showsMark } from "@/lib/ontology";
import {
  describeCut, describeEstimate, makeScale, probAbove, valuesOf,
} from "@/lib/quantity";
import { StatusBadge, Swatch, Unassessed } from "@/components/Assessment";
import { Term } from "@/components/Term";
import { EstimateStrip, ValueAxis } from "./EstimateStrip";
import styles from "./quantity.module.css";
import { sourceHref } from "@/lib/source-address";

// The quantity's page (constitution §2, §3, §4, §7, §10): its definition,
// the graph's estimate, every figure a source states grouped under the
// argument it belongs to, the readings that bear on it, and, rarely, claims
// about which side of a figure it lies that have nodes of their own.

function unitLabel(def: QuantityDefinition): string {
  const u = def.unit;
  if (u.kind === "proportion") return "a share, shown as a percentage";
  if (u.kind === "year") return "a calendar year";
  if (u.kind === "currency") return u.currency ?? "US dollars";
  if (u.kind === "rate") return [u.noun ? `${u.noun}s` : "events", u.per].filter(Boolean).join(" ");
  if (u.kind === "count") return u.noun ?? "a count";
  return u.symbol ?? "—";
}

/** Values that a view of this estimate must fit, with a little room for a bound to point. */
function fitValues(est: QuantityEstimate | null | undefined): number[] {
  if (!est) return [];
  const vals = valuesOf(est);
  if (est.form === "bound" && est.bound) {
    const v = est.bound.value;
    // Room for the arrow, wide enough that the axis does not suggest a
    // precision the bound does not claim.
    vals.push(est.bound.side === "above" ? v * 2 : v * 0.5);
  }
  return vals;
}

function sentence(s: string): string {
  const t = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// "Author (year), “Title”, Venue": the citation's head set apart from the
// rest, so a long title does not bury who said it.
function SourceLabel({ title, url }: { title: string; url?: string | null }) {
  const m = /^(.*?\(\d{4}\)),\s*(.*)$/.exec(title);
  const head = m ? m[1] : title;
  const rest = m ? m[2] : null;
  return (
    <>
      {url ? <a className={styles.rowTitle} href={url}>{head}</a> : <span className={styles.rowTitle}>{head}</span>}
      {rest && <span className={styles.rowWork}>{rest}</span>}
    </>
  );
}

export function QuantityHead({ detail, aside }: { detail: ClaimDetail; aside?: React.ReactNode }) {
  const q = detail.quantity!;
  const def = q.definition;
  const est = q.estimate;
  const w = est ? describeEstimate(est, def.unit) : null;
  const vals = [...fitValues(est), ...q.cuts.map((c) => c.value)];
  const scale = makeScale(def.unit, vals, est?.form === "magnitude" ? "log" : undefined);
  return (
    <>
      <dl className={styles.defn}>
        <dt>Measures</dt><dd>{def.measures}</dd>
        {def.population && (<><dt>Population</dt><dd>{def.population}</dd></>)}
        {def.conditions && (<><dt>Conditions</dt><dd>{def.conditions}</dd></>)}
        <dt>Unit</dt><dd>{unitLabel(def)}</dd>
      </dl>
      {est && w ? (
        <>
          <div className={styles.lead}>
            <span className={styles.leadFigure}>{w.lead}</span>
            {def.unit.kind === "count" && def.unit.noun && <span className={styles.leadUnit}>{def.unit.noun}</span>}
            {aside}
          </div>
          <p className={styles.words}>{sentence(w.words)}</p>
          {est.form !== "none" && (
            <div className={styles.headStrip}>
              <EstimateStrip scale={scale} estimate={est} tone="graph" tall label={`The graph's estimate: ${w.words}`} />
              <ValueAxis scale={scale} caption={scale.kind === "log" ? "log scale" : undefined} />
            </div>
          )}
          <p className={styles.formNote}>
            Stated as {w.formLabel}, the precision the evidence supports.
            {est.shape ? ` ${est.shape}` : ""}
          </p>
        </>
      ) : (
        <p className={styles.words}>Not yet estimated.</p>
      )}
    </>
  );
}

export function QuantityEstimates({ detail }: { detail: ClaimDetail }) {
  const q = detail.quantity!;
  const unit = q.definition.unit;
  const args = (detail.arguments ?? []).filter((a) => a.name);
  const est = q.estimate;
  const vals = [
    ...fitValues(est),
    ...q.estimates.flatMap((e) => fitValues(e.stated)),
    ...args.flatMap((a) => valuesOf(a.shows?.range ?? null)),
  ];
  const scale = makeScale(unit, vals, est?.form === "magnitude" ? "log" : undefined);
  const groups: { arg: ArgumentItem | null; rows: typeof q.estimates }[] = args
    .map((a) => ({ arg: a, rows: q.estimates.filter((e) => e.argument_id === a.id) }))
    .filter((g) => g.rows.length > 0 || g.arg.shows?.range);
  const loose = q.estimates.filter((e) => !e.argument_id || !args.some((a) => a.id === e.argument_id));
  if (loose.length) groups.push({ arg: null, rows: loose });
  if (!groups.length) return null;

  return (
    <section id="estimates">
      <h2>Estimates</h2>
      <div className={styles.plot}>
        <div className={`${styles.row} ${styles.axisRow}`}>
          <span />
          <ValueAxis scale={scale} caption={scale.kind === "log" ? "log scale" : undefined} />
        </div>
        {groups.map(({ arg, rows }) => {
          const meta = arg ? argumentVerdictMeta(arg.verdict) : null;
          const range = arg?.shows?.range ?? null;
          return (
            <div className={styles.group} key={arg?.id ?? "loose"}>
              <div className={styles.groupHead}>
                <span className={styles.groupName}>{arg ? arg.name : "Not yet placed under an argument"}</span>
                {meta && (
                  <Term gloss={meta.gloss} href={DEFINED_IN.argument} className={`badge arg-verdict ${meta.cls}`}>
                    {meta.label}
                  </Term>
                )}
              </div>
              {arg?.shows && (
                <div className={styles.groupStrip}>
                  <span className={styles.groupStripLabel}>
                    <span className="sc">shows</span>{" "}
                    <span className={styles.showsMark} title={showsMark(arg.shows)?.label}>{showsMark(arg.shows)?.glyph}</span>{" "}
                    {arg.shows.text}
                  </span>
                  {range ? (
                    <EstimateStrip scale={scale} range={range} context={est} label={`The argument shows ${arg.shows.text}`} />
                  ) : (
                    <span />
                  )}
                </div>
              )}
              {rows.map((e, i) => (
                <div className={`${styles.row}${i > 0 && rows[i - 1].source_title === e.source_title ? ` ${styles.rowSame}` : ""}`} key={e.id}>
                  <div className={styles.rowLabel}>
                    {!(i > 0 && rows[i - 1].source_title === e.source_title) && (
                      <SourceLabel title={e.source_title} url={e.source_url} />
                    )}
                    <span className={styles.rowMeta}>
                      {e.verbatim_text ? (
                        <span className={styles.rowStated}>“{e.verbatim_text}”</span>
                      ) : (
                        <>{describeEstimate(e.stated, unit, 3).words}, from the source&apos;s tables</>
                      )}
                    </span>
                  </div>
                  <EstimateStrip
                    scale={scale} estimate={e.stated} tone="source" context={est}
                    label={`${e.source_title}: ${describeEstimate(e.stated, unit, 3).words}`}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <PlotKey unit={unit} graphLabel={est && est.form === "distribution" ? "the graph's 90% interval" : "the graph's estimate"} />
    </section>
  );
}

/** Readings of instruments taken to indicate the quantity: evidence about it, kept in its provenance (§3). */
export function QuantityReadings({ detail }: { detail: ClaimDetail }) {
  const readings = detail.quantity?.readings ?? [];
  if (!readings.length) return null;
  return (
    <div className={styles.readings}>
      <h3>Readings</h3>
      <p className={styles.intro}>Evidence about the quantity, not its value.</p>
      {readings.map((r) => (
        <div className={styles.reading} key={r.id}>
          <div className={styles.readingHead}>
            {sourceHref(r.source_url) ? <a href={sourceHref(r.source_url)!}>{r.source_title}</a> : <span>{r.source_title}</span>}
            <span className={styles.readingFigure}>{r.figure}</span>
          </div>
          <dl className={styles.readingDl}>
            <dt>measured</dt><dd>{r.measured}</dd>
            <dt>bearing</dt><dd>{r.bearing}</dd>
          </dl>
          {r.claim && (
            <p className={styles.readingClaim}>
              <Swatch status={r.claim.status} />{" "}
              <Link href={`/claims/${r.claim.id}`}>{r.claim.text}</Link>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function QuantityCuts({ detail }: { detail: ClaimDetail }) {
  const q = detail.quantity!;
  if (!q.cuts.length) return null;
  return (
    <section>
      <h2>Claims about where the value lies</h2>
      <p className={styles.intro}>
        Each one&apos;s credence has to agree with the estimate; the figure the estimate implies
        is shown beside it.
      </p>
      <ul className={styles.cuts}>
        {q.cuts.map((c) => {
          const pa = q.estimate ? probAbove(q.estimate, c.value) : null;
          const implied = pa ? (c.direction === "above" ? pa.p : 1 - pa.p) : null;
          const drift = implied != null && c.credence != null && Math.abs(implied - c.credence) > 0.1;
          return (
            <li key={c.id}>
              <Link href={`/claims/${c.id}`} className={styles.cutText}>{c.text}</Link>
              <div className={styles.cutMeta}>
                {c.status ? <StatusBadge status={c.status} /> : <Unassessed />}
                {c.credence != null && <span className="mono">credence {c.credence.toFixed(2)}</span>}
                {implied != null && (
                  <span className={styles.implied}>
                    estimate implies {pa?.tail ? (pa.tail === "below" && c.direction === "above" ? "< " : "> ") : "≈ "}
                    {implied.toFixed(2)}
                    {drift && <span className={styles.drift}> · out of step</span>}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A threshold claim's panel: where its quantity's estimate falls against the cut. */
export function ThresholdPanel({ t, credence, status }: {
  t: ThresholdOf; credence: number | null; status: ClaimDetail["assessment"] extends infer A ? A extends { status: infer S } ? S : null : null;
}) {
  const unit = t.definition.unit;
  const est = t.estimate;
  const scale = makeScale(unit, [...fitValues(est), t.value]);
  const pa = est ? probAbove(est, t.value) : null;
  const implied = pa ? (t.direction === "above" ? pa.p : 1 - pa.p) : null;
  const cutWords = describeCut(t.direction, t.value, unit);
  return (
    <div className={styles.panel}>
      <span className="sc">Where the value falls</span>
      <div style={{ marginTop: ".5rem" }}>
        <EstimateStrip
          scale={scale} estimate={est} tone="graph" tall
          cut={{ direction: t.direction, value: t.value, status: status ?? null }}
          label={`The estimate of ${t.quantity_text}, with the region ${cutWords} shaded`}
        />
        <ValueAxis scale={scale} caption={scale.kind === "log" ? "log scale" : undefined} />
      </div>
      <p className={styles.panelCap}>
        The graph estimates <Link href={`/claims/${t.quantity_id}`}>{t.quantity_text.charAt(0).toLowerCase() + t.quantity_text.slice(1)}</Link>{" "}
        at {est ? describeEstimate(est, unit).words : "no figure yet"}.
        {implied != null && (
          <>
            {" "}That puts about {Math.round(implied * 100)}% of its weight {cutWords}, the shaded side
            {credence != null && (
              Math.abs(implied - credence) <= 0.1
                ? <>, which is this claim&apos;s credence.</>
                : <>; this claim&apos;s credence is {credence.toFixed(2)}, out of step with it.</>
            )}
            {credence == null && "."}
          </>
        )}
      </p>
    </div>
  );
}

// The plot's key, drawn with the marks themselves rather than described: each
// a short strip on a scale of its own, with the word for it.
function PlotKey({ unit, graphLabel }: { unit: QuantityUnit; graphLabel: string }) {
  const scale = makeScale(unit, [0, 10], "linear");
  const graph: QuantityEstimate = { form: "interval", low: 2, high: 8, central: 5 };
  const marks: { label: string; strip: ReactNode }[] = [
    { label: graphLabel, strip: <EstimateStrip scale={scale} context={graph} label="" /> },
    { label: "a source's interval", strip: <EstimateStrip scale={scale} tone="source" estimate={{ form: "interval", low: 2, high: 8 }} label="" /> },
    {
      label: "its middle half",
      strip: (
        <EstimateStrip
          scale={scale} tone="source" label=""
          estimate={{ form: "distribution", quantiles: [{ p: 0.05, v: 1 }, { p: 0.25, v: 3.5 }, { p: 0.5, v: 5 }, { p: 0.75, v: 6.5 }, { p: 0.95, v: 9 }] }}
        />
      ),
    },
    { label: "a single figure", strip: <EstimateStrip scale={scale} tone="source" estimate={{ form: "point", central: 5 }} label="" /> },
    { label: "a bound", strip: <EstimateStrip scale={scale} tone="source" estimate={{ form: "bound", bound: { side: "above", value: 4 } }} label="" /> },
    { label: "where an argument places it", strip: <EstimateStrip scale={scale} range={{ side: "between", low: 3, high: 7 }} label="" /> },
  ];
  return (
    <ul className={styles.plotKey} aria-label="Key to the plot">
      {marks.map((m) => (
        <li key={m.label}>
          <span className={styles.plotKeyMark} aria-hidden>{m.strip}</span>
          {m.label}
        </li>
      ))}
    </ul>
  );
}
