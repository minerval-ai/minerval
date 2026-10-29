"use client";

import { useState } from "react";
import Link from "next/link";
import type { LeanCheckSummary, TreeNode, Stance } from "@/lib/types";
import {
  RELATION, STANCE_LABEL, STANCE_GLOSS, argumentVerdictMeta, showsMark,
  DECISIVE, premiseSummary,
  DEFINED_IN, STEWARD_SOURCE, BASIS,
  groupByArgument, topLevelEffects, type ArgumentGroup,
  seedVerity, SEED_PRELIM_GLOSS,
} from "@/lib/ontology";
import { buildClaimTextMap, hasClaimLinks } from "@/lib/claim-links";
import { ArgumentText } from "./ArgumentText";
import { Swatch, StandingBadge } from "./Assessment";
import { describeEstimate } from "@/lib/quantity";
import { Term } from "./Term";
import { fmtDate } from "@/lib/format";

// A stable per-argument key, shared with the left rail's jump-list so a click
// there scrolls the centre to the matching block (#204). There is one basis
// group, so "basis" is unique; named arguments key on their id.
function argKey(group: ArgumentGroup): string {
  return group.id ?? "basis";
}

// The steward's rating of the inference (issues #173, #540). Boxed like every
// verdict on the site (cf. the claim's assessment badge), so it reads as a
// judgment rather than a structural label (#250). Nothing renders until the
// argument has been evaluated.
function ArgumentVerdictTag({ verdict }: { verdict: string | null }) {
  const meta = argumentVerdictMeta(verdict);
  if (!meta) return null;
  return (
    <Term gloss={meta.gloss} href={DEFINED_IN.argument} className={`badge arg-verdict ${meta.cls}`}>
      {meta.label}
    </Term>
  );
}

// The decisive mark (§7, #540), in the argument's head: the one label on an
// argument that speaks to whether its conclusion is true.
function DecisiveTag({ decisive }: { decisive: boolean }) {
  if (!decisive) return null;
  return (
    <Term gloss={DECISIVE.gloss} href={DEFINED_IN.argument} className="badge arg-verdict arg-decisive st-verified">
      {DECISIVE.label}
    </Term>
  );
}

// Two questions side by side, so the rating of the step never appears alone
// (#540): "Does it follow?" is the steward's rating, which is conditional on
// the premises; "Do the premises hold?" counts the argument's own premises by
// their current status. Readers take "a strong argument" to mean a probably
// true conclusion, and the second row is what stops that misreading.
function ArgumentCheck({ group }: { group: ArgumentGroup }) {
  if (!argumentVerdictMeta(group.verdict)) return null;
  const premises = premiseSummary(group.nodes.map((s) => s.node));
  return (
    <dl className="argcheck">
      <dt>Does it follow?</dt>
      <dd><ArgumentVerdictTag verdict={group.verdict} /></dd>
      {premises.length > 0 && (
        <>
          <dt>Do the premises hold?</dt>
          <dd>
            {premises.map((p) => (
              <span className={`premise-count ${p.cls}`} key={p.key}>{p.label}</span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

// An argument's stance on the claim it hangs from, defined on hover/click.
function StanceTag({ stance }: { stance: Stance }) {
  return (
    <Term gloss={STANCE_GLOSS[stance]} href={DEFINED_IN.argument} className={`arg-stance ${stance}`}>
      {STANCE_LABEL[stance]}
    </Term>
  );
}

// An unassessed subclaim carrying a confident steward-seeded prior (#285)
// renders a hatched, dashed swatch tinted by where the seed credence points —
// preliminary-styled so it never reads as the solid swatch of a real verdict.
// Mid-range seeds (an honest "don't know yet") render nothing, like any
// unassessed node.
function SeedSwatch({ node }: { node: TreeNode }) {
  if (node.assessment_status) return null;
  const verity = seedVerity(node.seed_credence);
  if (verity === 0) return null;
  const cls = verity > 0 ? "st-supported" : "st-contradicted";
  return (
    <span
      className={`swatch seeded ${cls}`}
      title={`Unassessed · preliminary credence ${node.seed_credence!.toFixed(2)}. ${SEED_PRELIM_GLOSS}`}
      aria-label="unassessed, with a preliminary steward-seeded credence"
    />
  );
}

// A single subclaim in a basis / label-only argument list: a quiet link with its
// status swatch, the relation it holds, and the ↗ to open its page. No claim-type
// chip and no nested tree — the reading-first center leaves deeper structure to
// each subclaim's own page and to the map (#204). Its edge reasoning stays one
// click away, since a basis has no prose to explain why the subclaim belongs.
function BasisNode({ node }: { node: TreeNode }) {
  const [showReason, setShowReason] = useState(false);
  const rel = node.relation_type ? RELATION[node.relation_type] : null;
  return (
    <li className="basis-item">
      <div className="basis-row">
        {node.node_kind === "quantity" && node.estimate && node.unit ? (
          <span className="qty-chip" title="This premise is a quantity; its estimate stands where a status would.">
            {describeEstimate(node.estimate, node.unit).lead}
          </span>
        ) : node.node_kind === "question" ? (
          <StandingBadge standing={node.standing ?? null} />
        ) : node.assessment_status ? <Swatch status={node.assessment_status} /> : <SeedSwatch node={node} />}{" "}
        {rel && (
          <Term
            gloss={rel.gloss}
            href={DEFINED_IN.relation}
            source={STEWARD_SOURCE}
            className={`relation ${rel.cls} node-relation`}
          >
            {rel.label}
          </Term>
        )}
        <span
          className={`basis-text${node.reasoning ? " clickable" : ""}`}
          onClick={node.reasoning ? () => setShowReason((v) => !v) : undefined}
          title={node.reasoning ? "show the reasoning for this dependency" : undefined}
        >
          {node.text}
        </span>{" "}
        <Link className="plain" href={`/claims/${node.id}`} title="open this claim" style={{ color: "var(--faint)" }}>↗&#xFE0E;</Link>
        {node.subtree_collapsed && (
          <span
            className="basis-flag"
            title="A shared subclaim: it belongs to more than one branch of this decomposition, and its own subclaims are listed at its other occurrence. ↗&#xFE0E; opens its page."
          >
            {" "}· shared subclaim
          </span>
        )}
        {node.children_truncated && (
          <span className="basis-flag" title="this tree response is size-capped; open the claim to see all of its subclaims">
            {" "}· more on its page
          </span>
        )}
      </div>
      {showReason && node.reasoning && (
        <div className="node-reasoning">
          <span className="sc">Why this edge</span>
          {node.reasoning}
        </div>
      )}
    </li>
  );
}

// The one-line check record under a machine-checked argument's evaluation
// (docs/mathematics.md §2.3, §11.4): what the checker confirmed, against which
// pin, when, and the hash of what it checked. A rejected or errored check is
// stated as such; the line never dresses a failed check as a proof.
function CheckRecord({ check }: { check: LeanCheckSummary }) {
  const what =
    check.verdict === "accepted"
      ? `${check.kind} accepted by the Lean checker`
      : check.verdict === "rejected"
        ? `${check.kind} rejected by the Lean checker`
        : `${check.kind} check ended in an error`;
  return (
    <p className={`argcheck${check.verdict === "accepted" ? " accepted" : ""}`}>
      <span className="argcheck-glyph" aria-hidden>⊢</span>
      {what} · <span className="mono">{check.pin_id}</span> · {fmtDate(check.checked_at)}
      {check.submission_sha256 && (
        <>
          {" · "}
          <span className="mono" title={`submission sha256 ${check.submission_sha256}`}>
            sha256 {check.submission_sha256.slice(0, 12)}…
          </span>
        </>
      )}
      {check.submitted_by && <> · submitted by {check.submitted_by.replace(/^contributor:/, "").replace(/_/g, " ")}</>}
    </p>
  );
}

// One top-level line of reasoning, stated as prose. A named argument leads with
// its written form (issue #129) and the steward's evaluation (issue #173), the
// subclaims linked inline with ↗ (#200); the redundant chip list beneath it is
// gone (#204). An argument-less basis, or a legacy argument with no written
// form, instead shows its subclaims as a quiet list, since it has no prose.
// data-arg-anchor is the scroll target for the left rail's jump-list (#204).
function ArgumentBlock({
  group, texts, check,
}: { group: ArgumentGroup; texts: Map<string, string>; check: LeanCheckSummary | null }) {
  const isBasis = !group.name;
  const written = group.content && hasClaimLinks(group.content) ? group.content : null;
  return (
    <section className="argblock" data-arg-anchor={argKey(group)}>
      {isBasis ? (
        <div className="arghead basis-head">
          <span className="argname">{BASIS.label}</span>
        </div>
      ) : (
        <div className="arghead">
          <span className="sc">argument</span>
          <span className="argname">{group.name}</span>
          {group.stance && <StanceTag stance={group.stance} />}
          <DecisiveTag decisive={group.decisive} />
          {group.shows && (
            <span className="arg-shows" title="What this argument shows about the quantity's value (constitution §7).">
              <span className="sc">shows</span>
              <span className="arg-shows-mark" aria-hidden>{showsMark(group.shows)?.glyph}</span> {group.shows.text}
            </span>
          )}
        </div>
      )}
      {isBasis && <p className="basis-note">{BASIS.gloss}</p>}

      {written ? (
        <>
          <p className="argform">
            <ArgumentText content={written} texts={texts} />
          </p>
          <ArgumentCheck group={group} />
          {group.evaluation && (
            <p className="argeval">
              <ArgumentText content={group.evaluation} texts={texts} />
            </p>
          )}
          {check && <CheckRecord check={check} />}
        </>
      ) : (
        <ul className="basis-list">
          {group.nodes.map((s) => (
            <BasisNode node={s.node} key={s.node.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DecompositionTree({
  tree, argumentChecks,
}: {
  tree: TreeNode;
  // Checker records by argument id, from the deep payload's arguments, for
  // when the tree edges do not carry them themselves.
  argumentChecks?: Map<string, LeanCheckSummary>;
}) {
  const texts = buildClaimTextMap(tree);
  if (tree.children.length === 0) {
    return (
      <div className="tree">
        <p style={{ color: "var(--muted)", fontStyle: "italic" }}>
          This claim is atomic: it bottoms out in a bedrock fact, an open empirical
          question, or a value premise, and does not decompose further.
        </p>
      </div>
    );
  }
  // The same top-level grouping the left rail uses, so their argument keys line
  // up and a jump-list click lands on the right block.
  const groups = groupByArgument(topLevelEffects(tree));
  return (
    <div className="tree">
      {groups.map((g) => (
        <ArgumentBlock
          group={g}
          texts={texts}
          check={g.leanCheck ?? (g.id ? argumentChecks?.get(g.id) ?? null : null)}
          key={argKey(g)}
        />
      ))}
      {/* Structure lives on the map, where tracking how the pieces fit together
          is easier than in a nested list (#204, #192). */}
      <Link href={`/claims/${tree.id}/map`} className="decomp-maplink">
        See how these fit together on the map <span aria-hidden>→</span>
      </Link>
    </div>
  );
}
