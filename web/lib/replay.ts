import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { isKnownVersion, type Replay } from "./replay-core";

// Replays (#334): recordings of one eval episode each, vendored by
// scripts/sync-frontend-content.ts from corpus/replays/<name>.json into
// web/content/evals/replays/<name>.json (the index: arms, events with step
// gists, deltas, matching, final graph). The untrimmed per-event detail lives
// under web/public/evals/replays/<name>/events/<detailPath> and is fetched by
// the player on demand. Read at the server; nothing here touches a database.
//
// The types and the pure helpers are in web/lib/replay-core.ts so the
// "use client" player can import them without dragging `fs` into the bundle.

export * from "./replay-core";

const REPLAYS = resolve(process.cwd(), "content", "evals", "replays");

export interface ReplayRecord {
  name: string;
  file: string;
  replay: Replay;
}

/** Every committed recording, newest first. Empty when the directory is absent. */
export function getReplays(): ReplayRecord[] {
  if (!existsSync(REPLAYS)) return [];
  const out: ReplayRecord[] = [];
  for (const file of readdirSync(REPLAYS).filter((f) => f.endsWith(".json")).sort()) {
    let replay: Replay;
    try {
      replay = JSON.parse(readFileSync(resolve(REPLAYS, file), "utf-8")) as Replay;
    } catch {
      continue; // a malformed file is left out of the index, not a build failure
    }
    const name = typeof replay?.name === "string" && replay.name ? replay.name : file.replace(/\.json$/, "");
    out.push({ name, file, replay });
  }
  return out.sort((a, b) => String(b.replay.generatedAt ?? "").localeCompare(String(a.replay.generatedAt ?? "")));
}

/** One recording by name (the file's stem, which the exporter keeps equal to `name`). Null when absent. */
export function getReplay(name: string): Replay | null {
  if (!/^[\w.-]+$/.test(name)) return null;
  const direct = resolve(REPLAYS, `${name}.json`);
  if (existsSync(direct)) {
    try {
      return JSON.parse(readFileSync(direct, "utf-8")) as Replay;
    } catch {
      return null;
    }
  }
  return getReplays().find((r) => r.name === name)?.replay ?? null;
}

/** The models an episode ran on: the union over its arms' fingerprints, agent → model. */
export function replayModels(replay: Replay): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arm of replay.arms ?? []) {
    for (const [agent, model] of Object.entries(arm.fingerprint?.models ?? {})) {
      if (model && !out[agent]) out[agent] = model;
    }
  }
  return out;
}

export { isKnownVersion };
