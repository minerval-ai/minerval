import type { AssessmentStatus, QuantityEstimate, ValueRange } from "@/lib/types";
import {
  type ValueScale, centralOf, innerOf, outerOf,
} from "@/lib/quantity";
import styles from "./quantity.module.css";

// One estimate on one axis. Drawn in HTML rather than SVG so the marks stay
// crisp and the labels stay legible at any width: every position is a
// percentage of the axis, whatever the scale (linear, log) underneath.
//
// The vocabulary is small and fixed, so a reader learns it once:
//   thin line   the outer interval (the 90% interval, or a stated range)
//   thick bar   the middle half, when a distribution gives one
//   tick        the central value
//   dot         a single figure
//   dashed run  a bound, open toward the arrow
//   hatched     an order of magnitude
//   open box    the range an argument concludes
//   shaded side a threshold claim's side of its cut

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

function span(scale: ValueScale, lo: number, hi: number): React.CSSProperties {
  const a = scale.pos(Math.min(lo, hi));
  const b = scale.pos(Math.max(lo, hi));
  return { left: pct(a), width: pct(Math.max(b - a, 0.004)) };
}

export function EstimateMark({
  scale, estimate, tone = "graph",
}: { scale: ValueScale; estimate: QuantityEstimate; tone?: "graph" | "source" }) {
  const toneCls = tone === "graph" ? styles.toneGraph : styles.toneSource;
  const o = outerOf(estimate);
  const inner = innerOf(estimate);
  const c = centralOf(estimate);
  switch (estimate.form) {
    case "distribution":
    case "interval":
      return (
        <>
          {o && <span className={`${styles.outer} ${toneCls}`} style={span(scale, o.lo, o.hi)} />}
          {inner && <span className={`${styles.inner} ${toneCls}`} style={span(scale, inner.lo, inner.hi)} />}
          {c != null && estimate.form === "distribution" && (
            <span className={`${styles.mid} ${toneCls}`} style={{ left: pct(scale.pos(c)) }} />
          )}
          {c != null && estimate.form === "interval" && (
            <span className={`${styles.dot} ${toneCls}`} style={{ left: pct(scale.pos(c)) }} />
          )}
        </>
      );
    case "point":
      return c != null ? <span className={`${styles.dot} ${toneCls}`} style={{ left: pct(scale.pos(c)) }} /> : null;
    case "bound": {
      const b = estimate.bound!;
      const x = scale.pos(b.value);
      const run = b.side === "above" ? { left: pct(x), width: pct(1 - x) } : { left: "0%", width: pct(x) };
      return (
        <>
          <span className={`${styles.boundRun} ${toneCls}`} style={run} />
          <span className={`${styles.boundStop} ${toneCls}`} style={{ left: pct(x) }} />
          <span
            className={`${styles.arrow} ${b.side === "above" ? styles.arrowRight : styles.arrowLeft} ${toneCls}`}
            style={b.side === "above" ? { left: "100%" } : { left: "0%" }}
          />
        </>
      );
    }
    case "magnitude":
      return o ? (
        <>
          <span className={`${styles.mag} ${toneCls}`} style={span(scale, o.lo, o.hi)} />
          {c != null && <span className={`${styles.mid} ${toneCls}`} style={{ left: pct(scale.pos(c)) }} />}
        </>
      ) : null;
    case "none":
    default:
      return null;
  }
}

/** Where an argument places the value (§7): an open box for a range or a side, an open ring for a figure. */
export function RangeMark({ scale, range }: { scale: ValueScale; range: ValueRange }) {
  if ((range.side === "at" || range.side === "about") && range.low != null) {
    // a figure: an open ring, hollow where an estimate's dot is solid
    return <span className={`${styles.rangePoint}${range.side === "about" ? ` ${styles.rangeAbout}` : ""}`} style={{ left: pct(scale.pos(range.low)) }} />;
  }
  if (range.side === "between" && range.low != null && range.high != null) {
    return <span className={styles.range} style={span(scale, range.low, range.high)} />;
  }
  const v = range.side === "above" ? range.low : range.high;
  if (v == null) return null;
  const x = scale.pos(v);
  return range.side === "above" ? (
    <>
      <span className={`${styles.range} ${styles.rangeOpenRight}`} style={{ left: pct(x), width: pct(1 - x) }} />
      <span className={`${styles.arrow} ${styles.arrowRight} ${styles.toneRange}`} style={{ left: "100%" }} />
    </>
  ) : (
    <>
      <span className={`${styles.range} ${styles.rangeOpenLeft}`} style={{ left: "0%", width: pct(x) }} />
      <span className={`${styles.arrow} ${styles.arrowLeft} ${styles.toneRange}`} style={{ left: "0%" }} />
    </>
  );
}

export interface StripProps {
  scale: ValueScale;
  estimate?: QuantityEstimate | null;
  tone?: "graph" | "source";
  range?: ValueRange | null;
  // The graph's own estimate as a faint band behind a source's figure, so
  // every row reads against the same judgment.
  context?: QuantityEstimate | null;
  cut?: { direction: "above" | "below"; value: number; status: AssessmentStatus | null } | null;
  label: string;
  tall?: boolean;
}

export function EstimateStrip({ scale, estimate, tone, range, context, cut, label, tall }: StripProps) {
  const ctx = context ? outerOf(context) : null;
  const ctxMid = context ? centralOf(context) : null;
  const zero = scale.kind === "linear" && scale.lo < 0 && scale.hi > 0 ? scale.pos(0) : null;
  return (
    <div className={`${styles.strip}${tall ? ` ${styles.tall}` : ""}`} role="img" aria-label={label}>
      <span className={styles.track} />
      {zero != null && <span className={styles.zero} style={{ left: pct(zero) }} />}
      {ctx && <span className={styles.ctx} style={span(scale, ctx.lo, ctx.hi)} />}
      {ctxMid != null && <span className={styles.ctxMid} style={{ left: pct(scale.pos(ctxMid)) }} />}
      {cut && (
        <>
          <span
            className={styles.cutShade}
            style={{
              ...(cut.direction === "above"
                ? { left: pct(scale.pos(cut.value)), width: pct(1 - scale.pos(cut.value)) }
                : { left: "0%", width: pct(scale.pos(cut.value)) }),
              background: `color-mix(in srgb, var(--st-${cut.status ?? "unassessed"}) 16%, transparent)`,
            }}
          />
          <span className={styles.cutLine} style={{ left: pct(scale.pos(cut.value)), borderColor: `var(--st-${cut.status ?? "unassessed"})` }} />
        </>
      )}
      {range && <RangeMark scale={scale} range={range} />}
      {estimate && <EstimateMark scale={scale} estimate={estimate} tone={tone} />}
    </div>
  );
}

/** Tick labels for a strip column, aligned so the end labels never overflow. */
export function ValueAxis({ scale, caption }: { scale: ValueScale; caption?: string }) {
  return (
    <div className={styles.axis} aria-hidden>
      {scale.ticks.map((t) => {
        const x = scale.pos(t.v);
        const align = x < 0.04 ? styles.tickStart : x > 0.96 ? styles.tickEnd : "";
        return (
          <span
            key={t.v}
            className={`${styles.tick} ${t.major ? "" : styles.tickMinor} ${align}`}
            style={{ left: pct(x) }}
          >
            {t.label}
          </span>
        );
      })}
      {caption && <span className={styles.axisCaption}>{caption}</span>}
    </div>
  );
}
