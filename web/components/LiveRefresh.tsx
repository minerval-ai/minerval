"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Reads the page again every few seconds while it is in view, for a page
 * about something still happening (a run that has not finished). Renders
 * nothing. It stops with the tab hidden, and the page stops rendering it
 * once the thing is done.
 */
export function LiveRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(tick);
  }, [router, seconds]);
  return null;
}
