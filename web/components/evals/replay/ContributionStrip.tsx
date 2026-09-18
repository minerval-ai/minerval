"use client";

import type { Replay, ReplayArm } from "@/lib/replay-core";
import { decisionLabel, outcomeLabel, typeLabel } from "./vocab";
import type { Nav } from "./hash";
import s from "./replay.module.css";

// The contributions of a contribution/adversarial episode, one card each:
// persona, type, gambit tag, arm, and where it stands as of each arm's
// playhead (pending → decided → appealed → ruled). Clicking a card moves that
// arm's playhead to the submission.

interface ContribState {
  id: string;
  armKey: string;
  armLabel: string;
  type: string;
  contributor: string;
  gambit: string | null;
  claimId: string | null;
  submittedAt: number;                       // event index
  decision: { text: string; badFaith: boolean; at: number } | null;
  appeal: number | null;
  ruling: { text: string; at: number } | null;
}

export function contributionsOf(replay: Replay, indexOf: (arm: ReplayArm) => number): ContribState[] {
  const out: ContribState[] = [];
  for (const arm of replay.arms) {
    const upto = indexOf(arm);
    const byId = new Map<string, ContribState>();
    arm.events.forEach((e, i) => {
      for (const d of e.deltas) {
        if (d.op === "contribution_submitted") {
          const st: ContribState = { id: d.contributionId, armKey: arm.key, armLabel: arm.label, type: d.type, contributor: d.contributor, gambit: d.gambit ?? null, claimId: d.claimId, submittedAt: i, decision: null, appeal: null, ruling: null };
          byId.set(d.contributionId, st);
          out.push(st);
        } else if (i <= upto && d.op === "review_decided") {
          const st = byId.get(d.contributionId);
          if (st) st.decision = { text: decisionLabel(d.decision), badFaith: d.badFaith, at: i };
        } else if (i <= upto && d.op === "appeal_filed") {
          const st = byId.get(d.contributionId);
          if (st) st.appeal = i;
        } else if (i <= upto && d.op === "arbitration_decided") {
          const st = byId.get(d.contributionId);
          if (st) st.ruling = { text: outcomeLabel(d.outcome), at: i };
        }
      }
    });
  }
  return out;
}

export function ContributionStrip({ replay, indexOf, nav }: { replay: Replay; indexOf: (arm: ReplayArm) => number; nav: Nav }) {
  const items = contributionsOf(replay, indexOf);
  if (items.length === 0) return null;
  const actor = (key: string) => replay.scenario?.actors.find((a) => a.key === key);
  return (
    <div className={s.contribs} role="list" aria-label="Contributions">
      {items.map((c) => {
        const arm = replay.arms.find((a) => a.key === c.armKey)!;
        const visible = c.submittedAt <= indexOf(arm);
        const who = actor(c.contributor);
        return (
          <button
            key={`${c.armKey}-${c.id}`}
            type="button"
            role="listitem"
            className={`${s.contrib}${visible ? "" : ` ${s.contribAhead}`}${c.decision?.badFaith ? ` ${s.contribBad}` : ""}`}
            onClick={() => nav.goEvent(c.armKey, c.submittedAt)}
            title={visible ? "Jump to the submission" : "Not yet submitted at this point of the replay"}
          >
            <span className={s.contribHead}>
              <span className={`${s.role} ${s[`role_${who?.role ?? "persona"}`] ?? ""}`}>{who?.displayName ?? c.contributor}</span>
            </span>
            <span className={s.contribType}>{typeLabel(c.type)}{c.gambit ? <span className="tag">{c.gambit}</span> : null}</span>
            {replay.arms.length > 1 ? <span className={s.dim}>{c.armLabel}</span> : null}
            <span className={s.contribState}>
              {!visible ? "—" : c.ruling ? <>arbitration: <strong>{c.ruling.text}</strong></> : c.appeal != null ? "appealed, awaiting ruling" : c.decision ? <><strong>{c.decision.text}</strong>{c.decision.badFaith ? <span className={s.badFaith}> · bad faith</span> : null}</> : "awaiting review"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
