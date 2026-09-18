// URL hash state for the player, so any level of the drill-down is linkable:
//   #arm=a&event=12&step=3&claim=<id>&view=episode&lock=source
// `event` is the event's seq (stable across re-exports), not its index.

export type DrawerView =
  | { kind: "episode" }
  | { kind: "step"; arm: string; seq: number; step: number }
  | { kind: "claim"; arm: string; claimId: string }
  | { kind: "prompt"; arm: string; sha: string };

/** What any panel can ask the player to do: move the playhead, or open a level of the drill-down. */
export interface Nav {
  goEvent(arm: string, index: number): void;
  openStep(arm: string, seq: number, step: number): void;
  openClaim(arm: string, claimId: string): void;
  openPrompt(arm: string, sha: string): void;
  openEpisode(): void;
  close(): void;
}

export interface HashState {
  arm: string | null;
  seq: number | null;
  lock: "index" | "source" | null;
  view: DrawerView | null;
}

export function parseHash(hash: string): HashState {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const arm = p.get("arm");
  const seqRaw = p.get("event");
  const seq = seqRaw != null && /^\d+$/.test(seqRaw) ? Number(seqRaw) : null;
  const lockRaw = p.get("lock");
  const lock = lockRaw === "source" ? "source" : lockRaw === "index" ? "index" : null;
  let view: DrawerView | null = null;
  const v = p.get("view");
  const step = p.get("step");
  const claim = p.get("claim");
  const sha = p.get("prompt");
  if (v === "episode") view = { kind: "episode" };
  else if (claim && arm) view = { kind: "claim", arm, claimId: claim };
  else if (sha && arm) view = { kind: "prompt", arm, sha };
  else if (step != null && /^\d+$/.test(step) && arm && seq != null) view = { kind: "step", arm, seq, step: Number(step) };
  return { arm, seq, lock, view };
}

export function buildHash(s: HashState): string {
  const p = new URLSearchParams();
  if (s.arm) p.set("arm", s.arm);
  if (s.seq != null) p.set("event", String(s.seq));
  if (s.lock === "source") p.set("lock", "source");
  const v = s.view;
  if (v?.kind === "episode") p.set("view", "episode");
  else if (v?.kind === "step") { p.set("arm", v.arm); p.set("event", String(v.seq)); p.set("step", String(v.step)); }
  else if (v?.kind === "claim") { p.set("arm", v.arm); p.set("claim", v.claimId); }
  else if (v?.kind === "prompt") { p.set("arm", v.arm); p.set("prompt", v.sha); }
  const str = p.toString();
  return str ? `#${str}` : "";
}
