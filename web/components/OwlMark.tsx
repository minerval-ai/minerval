import { OWL_PATH } from "../app/Mark";

/**
 * The owl mark — the unit icon for Minerval's currency (issue #282).
 *
 * A silver tetradrachm reverse: the brand owl (the exact trace shared with
 * Mark.tsx and the favicon) engraved inside the square incuse punch of an
 * Athenian tetradrachm — round silver flan, subtly indented square, dark
 * engraved bird. Quiet greys keep it a coin, not jewellery; the geometry is
 * simple enough to stay legible at 14–16 px inline next to a number.
 *
 * Same artwork, full fidelity: public/episteme-logo/owl-tetradrachm.svg.
 * Plain server-compatible component — no hooks, safe in client islands too.
 */

/** Warm-silver palette, tuned to read on the paper background and in dark UIs. */
const FLAN_LIGHT = "#e6e3dc";
const FLAN_DARK = "#c3bfb3";
const RIM = "#918d81";
const INCUSE = "#ccc8bc";
const INCUSE_SHADOW = "#aeaa9d";
const INCUSE_LIGHT = "#edebe3";
const ENGRAVED = "#4c473e";

export function OwlMark({
  size = 16,
  title,
  className,
}: {
  /** Rendered width/height in px (the artwork is square). */
  size?: number;
  /** Accessible name; omitted (the default) the mark is aria-hidden. */
  title?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.15em" }}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        {/* One id shared by every instance: the defs are identical, so
            whichever renders first resolves for all of them. */}
        <linearGradient id="owlmark-silver" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={FLAN_LIGHT} />
          <stop offset="1" stopColor={FLAN_DARK} />
        </linearGradient>
      </defs>
      {/* the flan */}
      <circle
        cx="12"
        cy="12"
        r="11.3"
        fill="url(#owlmark-silver)"
        stroke={RIM}
        strokeWidth="0.8"
      />
      {/* the incuse punch: a sunk square — darker field, shadowed top-left
          edge, lit bottom-right edge (hairlines vanish gracefully when small) */}
      <rect
        x="4.5"
        y="4.5"
        width="15"
        height="15"
        rx="0.5"
        fill={INCUSE}
      />
      <path
        d="M4.7 19.3 V4.7 H19.3"
        fill="none"
        stroke={INCUSE_SHADOW}
        strokeWidth="0.4"
      />
      <path
        d="M19.3 4.7 V19.3 H4.7"
        fill="none"
        stroke={INCUSE_LIGHT}
        strokeWidth="0.4"
      />
      {/* the owl of Athena — the same bird as the site mark, engraved */}
      <g transform="translate(4.95 4.98) scale(0.585)">
        <path d={OWL_PATH} fill={ENGRAVED} fillRule="evenodd" />
      </g>
    </svg>
  );
}
