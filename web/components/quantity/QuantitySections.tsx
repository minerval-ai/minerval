import Link from "next/link";
import type { ArgumentItem, ClaimDetail, QuantityDefinition, QuantityEstimate, ThresholdOf } from "@/lib/types";
import { argumentVerdictMeta, DEFINED_IN } from "@/lib/ontology";
import {
  describeCut, describeEstimate, describeRange, makeScale, probAbove, valuesOf,
} from "@/lib/quantity";
import { StatusBadge, Swatch, Unassessed } from "@/components/Assessment";
import { Term } from "@/components/Term";
import { EstimateStrip, ValueAxis } from "./EstimateStrip";
import styles from "./quantity.module.css";

// The quantity's page (constitution §2, §4, §7, §10): its definition, the
// graph's estimate, every source's figure grouped under the argument it
// belongs to, and the threshold claims that cut it.

function unitLabel(def: QuantityDefinition): string {
  const u = def.unit;
  if (u.kind === "proportion") return "a share, shown as a percentage";
  if (u.kind === "year") return "a calendar year";
  if (u.kind === "currency") return u.currency ?? "US dollars";
  if (u.kind === "rate") return [u.noun ? `${u.noun}s` : "events", u.per].filter(Boolean).join(" ");
  if (u.kind === "count") return u.noun ?? "a count";
  return u.symbol ?? "—";
}

/** Values that a view of this estimate must fit, including room for a bound to point. */
function fitValues(est: QuantityEstimate | null | undefined): number[] {
  if (!est) return [];
  const vals = valuesOf(est);
  if (est.form === "bound" && est.bound) {
    const v = est.bound.value;
    vals.push(est.bound.side === "above" ? v * 4 : v / 4);
  }
  return vals;
}

export function QuantityHead({ detail }: { detail: ClaimDetail }) {
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
          </div>
          <p className={styles.words}>{w.words[0].toUpperCase() + w.words.slice(1)}.</p>
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
    ...args.flatMap((a) => valuesOf(a.conclusion ?? null)),
  ];
  const scale = makeScale(unit, vals, est?.form === "magnitude" ? "log" : undefined);
  const groups: { arg: ArgumentItem | null; rows: typeof q.estimates }[] = [
    ...args.map((a) => ({ arg: a, rows: q.estimates.filter((e) => e.argument_id === a.id) })),
  ];
  const loose = q.estimates.filter((e) => !e.argument_id || !args.some((a) => a.id === e.argument_id));
  if (loose.length) groups.push({ arg: null, rows: loose });
  if (!q.estimates.length && !args.length) return null;

  return (
    <section>
      <h2>Estimates</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        Each source&apos;s figure, as it states it, under the argument it belongs to, read
        against the graph&apos;s estimate. Where a source measured something other than this
        quantity, the claim that bridges the two is shown with its status.
      </p>
      <div className={styles.plot}>
        <div className={`${styles.row} ${styles.axisRow}`}>
          <span />
          <ValueAxis scale={scale} caption={scale.kind === "log" ? "log scale" : undefined} />
        </div>
        {groups.map(({ arg, rows }) => {
          const meta = arg ? argumentVerdictMeta(arg.verdict) : null;
          return (
            <div className={styles.group} key={arg?.id ?? "loose"}>
              <div className={styles.groupHead}>
                <span className={styles.groupName}>{arg ? arg.name : "Not yet placed under an argument"}</span>
                {arg?.conclusion && (
                  <span className={styles.concludes}>concludes {describeRange(arg.conclusion, unit)}</span>
                )}
                {meta && (
                  <Term gloss={meta.gloss} href={DEFINED_IN.argument} className={`badge arg-verdict ${meta.cls}`} >
                    {meta.label}
                  </Term>
                )}
              </div>
              {arg?.conclusion && (
                <div className={styles.groupStrip}>
                  <span className={styles.groupStripLabel}>what the argument concludes</span>
                  <EstimateStrip scale={scale} range={arg.conclusion} context={est} label={`Concludes ${describeRange(arg.conclusion, unit)}`} />
                </div>
              )}
              {rows.map((e) => (
                <div className={styles.row} key={e.id}>
                  <div className={styles.rowLabel}>
                    {e.source_url ? (
                      <a className={styles.rowTitle} href={e.source_url}>{e.source_title}</a>
                    ) : (
                      <span className={styles.rowTitle}>{e.source_title}</span>
                    )}
                    <span className={styles.rowMeta}>
                      <span className={styles.rowStated}>“{e.stated_text}”</span> · {e.method}
                    </span>
                    {e.measured && <span className={styles.rowMeta}>measured: {e.measured}</span>}
                    {e.bridge && (
                      <span className={styles.bridge}>
                        <span className="sc">bridge</span>
                        <Swatch status={e.bridge.status} />
                        <Link href={`/claims/${e.bridge.id}`}>{e.bridge.text}</Link>
                      </span>
                    )}
                  </div>
                  <EstimateStrip
                    scale={scale} estimate={e.stated} tone="source" context={est}
                    label={`${e.source_title}: ${describeEstimate(e.stated, unit).words}`}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className={styles.plotKey}>
        Grey band: the graph&apos;s {est && est.form === "distribution" ? "90% interval" : "estimate"}, with
        its central value as a line. Dark marks: each source&apos;s own figure. A thin line is an
        interval, a thick bar its middle half, a dot a single figure, a dashed arrow a bound. An open
        box is the range an argument concludes.
      </p>
    </section>
  );
}

export function QuantityCuts({ detail }: { detail: ClaimDetail }) {
  const q = detail.quantity!;
  if (!q.cuts.length) return null;
  return (
    <section>
      <h2>Claims that cut this quantity</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        Each states which side of a value the quantity falls on. Its credence has to agree with
        the estimate above; the figure the estimate implies is shown beside it.
      </p>
      <div className={styles.cutsWrap}>
        <table className={styles.cuts}>
          <tbody>
            {q.cuts.map((c) => {
              const pa = q.estimate ? probAbove(q.estimate, c.value) : null;
              const implied = pa ? (c.direction === "above" ? pa.p : 1 - pa.p) : null;
              const drift = implied != null && c.credence != null && Math.abs(implied - c.credence) > 0.1;
              return (
                <tr key={c.id}>
                  <td><Link href={`/claims/${c.id}`}>{c.text}</Link></td>
                  <td>{c.status ? <StatusBadge status={c.status} /> : <Unassessed />}</td>
                  <td className="mono">{c.credence != null ? `credence ${c.credence.toFixed(2)}` : ""}</td>
                  <td className={styles.implied}>
                    {implied != null && (
                      <>
                        estimate implies {pa?.tail ? (pa.tail === "below" && c.direction === "above" ? "< " : "> ") : "≈ "}
                        {implied.toFixed(2)}
                        {drift && <span className={styles.drift}> · out of step</span>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
