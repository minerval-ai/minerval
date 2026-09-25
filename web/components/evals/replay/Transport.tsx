"use client";

import s from "./replay.module.css";

// Play/pause, step, scrub, speed. Keyboard handling lives in the player so it
// works wherever focus is; the buttons carry the same labels.

export const SPEEDS = [0.5, 1, 2, 4] as const;

export function Transport({
  index, count, playing, speed, onIndex, onPlaying, onSpeed, label,
}: {
  index: number;
  count: number;
  playing: boolean;
  speed: number;
  onIndex: (i: number) => void;
  onPlaying: (p: boolean) => void;
  onSpeed: (x: number) => void;
  label?: string;
}) {
  const last = Math.max(0, count - 1);
  return (
    <div className={s.transport} role="group" aria-label="Playback">
      <button type="button" className={s.tbtn} onClick={() => onIndex(0)} disabled={index <= 0} title="First event (Home)">⇤</button>
      <button type="button" className={s.tbtn} onClick={() => onIndex(Math.max(0, index - 1))} disabled={index <= 0} title="Step back (←)">←</button>
      <button
        type="button"
        className={`${s.tbtn} ${s.tplay}`}
        onClick={() => onPlaying(!playing)}
        title={playing ? "Pause (space)" : "Play (space)"}
        aria-pressed={playing}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button type="button" className={s.tbtn} onClick={() => onIndex(Math.min(last, index + 1))} disabled={index >= last} title="Step forward (→)">→</button>
      <button type="button" className={s.tbtn} onClick={() => onIndex(last)} disabled={index >= last} title="Last event (End)">⇥</button>
      <input
        type="range"
        className={s.scrub}
        min={0}
        max={last}
        value={Math.min(index, last)}
        onChange={(e) => onIndex(Number(e.target.value))}
        aria-label="Scrub events"
      />
      <span className={s.counter}>{count === 0 ? "0 / 0" : `${index + 1} / ${count}`}{label ? <span className={s.dim}> · {label}</span> : null}</span>
      <span className={s.speeds} role="group" aria-label="Speed">
        {SPEEDS.map((x) => (
          <button key={x} type="button" className={`${s.speed}${x === speed ? ` ${s.speedOn}` : ""}`} onClick={() => onSpeed(x)} aria-pressed={x === speed}>
            {x}×
          </button>
        ))}
      </span>
    </div>
  );
}
