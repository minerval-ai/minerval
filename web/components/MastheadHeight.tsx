"use client";

import { useEffect } from "react";

/**
 * Tells the stylesheet how tall the masthead is (`--masthead-height`), so a
 * page's own sticky bar can sit exactly under it. The masthead is stuck to
 * the top of every page and is taller on a phone, where its links wrap to a
 * second line; a fixed figure in the stylesheet is right at one width only.
 * Renders nothing. Without scripts the stylesheet's own figures stand.
 */
export function MastheadHeight() {
  useEffect(() => {
    const masthead = document.querySelector<HTMLElement>(".masthead");
    if (!masthead) return;
    const set = () =>
      document.documentElement.style.setProperty(
        "--masthead-height",
        `${masthead.getBoundingClientRect().height}px`
      );
    set();
    const watch = new ResizeObserver(set);
    watch.observe(masthead);
    return () => watch.disconnect();
  }, []);
  return null;
}
