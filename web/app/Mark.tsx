/**
 * The Minerval mark — the owl of Athena, traced from the adopted logo artwork
 * (issue #207). Single source of truth for the inline wordmark; kept in visual
 * sync with app/icon.svg (the favicon, which swaps to paper in dark mode) and
 * app/apple-icon.tsx (the touch icon, which carries the full composition with
 * the olive sprig on an opaque paper tile).
 */
import { OWL_INK, OWL_PATH } from "@/lib/owl-mark";

// Re-exported for the components that already read them from here.
export { OWL_INK, OWL_PATH };

export function Mark({ size = "1em" }: { size?: string | number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "-0.12em" }}
    >
      <path d={OWL_PATH} style={{ fill: `var(--owl-ink, ${OWL_INK})` }} fillRule="evenodd" />
    </svg>
  );
}
