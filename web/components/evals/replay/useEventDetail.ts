"use client";

import { useEffect, useState } from "react";
import { detailUrl, type ReplayEvent, type ReplayEventDetail } from "@/lib/replay-core";

// The untrimmed event, fetched from web/public on demand when a reader opens
// a step, and cached for the page's life. The index event is shown while it
// loads; a missing file is a state the panel names, not an error.

export type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; detail: ReplayEventDetail }
  | { status: "missing" }
  | { status: "error"; message: string };

const cache = new Map<string, DetailState>();
const listeners = new Map<string, Set<() => void>>();

function notify(url: string) {
  for (const l of listeners.get(url) ?? []) l();
}

async function load(url: string) {
  cache.set(url, { status: "loading" });
  notify(url);
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (res.status === 404) {
      cache.set(url, { status: "missing" });
    } else if (!res.ok) {
      cache.set(url, { status: "error", message: `HTTP ${res.status}` });
    } else {
      const detail = (await res.json()) as ReplayEventDetail;
      cache.set(url, { status: "ready", detail });
    }
  } catch (e) {
    cache.set(url, { status: "error", message: e instanceof Error ? e.message : String(e) });
  }
  notify(url);
}

export function useEventDetail(replayName: string, armKey: string, event: ReplayEvent | null, enabled: boolean): DetailState {
  const url = event ? detailUrl(replayName, armKey, event) : null;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!url || !enabled) return;
    const l = () => bump((n) => n + 1);
    if (!listeners.has(url)) listeners.set(url, new Set());
    listeners.get(url)!.add(l);
    const cur = cache.get(url);
    if (!cur || cur.status === "error") void load(url);
    return () => { listeners.get(url)?.delete(l); };
  }, [url, enabled]);
  if (!url || !enabled) return { status: "idle" };
  return cache.get(url) ?? { status: "loading" };
}
