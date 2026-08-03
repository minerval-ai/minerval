/**
 * Action tools for the Claim Steward agent.
 *
 * These let the steward update assessments, modify canonical forms,
 * add decomposition edges, log decisions, and notify dependent stewards.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq, and } from "drizzle-orm";
import { getDb, rawQuery } from "../../db/client.js";
import {
  claims,
  assessments,
  claimRelationships,
  claimInstances,
  auditLog,
} from "../../db/schema.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { getOrCreateSource } from "../../services/source-service.js";
import {
  ARGUMENT_VERDICTS,
  addArgument,
  getArgument,
  getArgumentSubclaims,
  getEvaluationStateForClaim,
  isArgumentVerdict,
  parseClaimLinks,
  setArgumentContent,
  setArgumentEvaluation,
} from "../../services/argument-service.js";
import { loadConfig } from "../../config.js";
import { RELATION_TYPES, RELATION_GUIDANCE } from "../../schemas/common.js";
import {
  enqueueSteward,
  enqueueClaimPipeline,
  enqueueCurator,
} from "../../services/queue-service.js";

/** Coerce a tool input to a clamped unit-interval score in [0, 1], or undefined if absent/invalid. */
function clampUnit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

export function getStewardToolDefinitions(): Tool[] {
  return [
    {
      name: "update_claim_assessment",
      description:
        "Update the assessment of a claim. Marks the previous assessment " +
        "as non-current and creates a new current assessment.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to assess",
          },
          status: {
            type: "string",
            enum: [
              "verified",
              "supported",
              "contested",
              "unsupported",
              "contradicted",
              "unknown",
            ],
            description: "New assessment status",
          },
          confidence: {
            type: "number",
            description:
              "Verdict confidence (0.0-1.0): how sure you are that the status " +
              "you chose is the right reading of the evidence. Meta by design; " +
              "NOT the probability that the claim is true. A claim can be " +
              "confidently CONTESTED.",
          },
          claim_credence: {
            type: "number",
            description:
              "Optional credence (0.0-1.0): your probability that the claim, as " +
              "stated, is TRUE. Give it only where a single number is an honest " +
              "summary (typically concrete empirical questions). Omit it where " +
              "it would be false precision: normative or evaluative claims, " +
              "definitional choices, or composites whose parts pull in different " +
              "directions. Omitting is itself information, not a failure.",
          },
          assessment: {
            type: "string",
            description:
              "The reader-facing account of where the claim stands, shown first when " +
              "someone lands on its page. Self-contained prose in the third person, " +
              "like the opening of a good encyclopedia entry: what the claim rests " +
              "on, what the evidence shows, and for a contested claim where the " +
              "credible disagreement lies and what would resolve it. Let the length " +
              "follow the claim: a settled one may be two or three sentences, a " +
              "contested or foundational one a few short paragraphs. Keep " +
              "the machinery out of it: no tool or edge names (SUPPORTS/CONTRADICTS " +
              "edge), no importance numbers, no 'per the constitution', no first-" +
              "person 'I', and no narration of your own bookkeeping (merges, " +
              "canonical-form edits, importance changes go in " +
              "log_stewardship_decision). When a sentence references a subclaim, " +
              "link it inline as [[claim:<uuid>|the phrase you would use anyway]] " +
              "(same syntax as argument written forms); renderers turn it into a " +
              "link to that claim's page.",
          },
          reasoning_trace: {
            type: "string",
            description:
              "The transparent audit detail behind the verdict, shown secondary to " +
              "the assessment (behind a disclosure). Lay out the specific evidence, " +
              "source instances, and how the material subclaims weigh. This is about " +
              "the CLAIM'S TRUTH: keep structural bookkeeping out of it. Refer to " +
              "subclaims by their text (quoted or paraphrased), never by bare UUID; " +
              "ids are opaque to the human readers this trace exists for. To make a " +
              "reference followable, link it inline as [[claim:<uuid>|its text]]. " +
              "Bare source URLs render as links; cite them where the evidence rests " +
              "on them.",
          },
          marginal_yield: {
            type: "number",
            description:
              "Exit judgment (0.0-1.0): how much would another, stronger pass " +
              "improve this assessment? Near 0 for an uncontested fact you have " +
              "now assessed, or a values dispute mapped down to its terminal " +
              "disagreement — more effort would not change the product. High " +
              "when this pass hit evidence it could not fully digest (an " +
              "unresolved empirical synthesis, sources you could not reach). " +
              "Distinct from confidence: a saturated CONTESTED verdict can be " +
              "high-confidence AND zero-yield. Recorded for effort allocation; " +
              "it does not affect the verdict.",
          },
        },
        required: ["claim_id", "status", "confidence", "assessment", "reasoning_trace"],
      },
    },
    {
      name: "record_claim_instance",
      description:
        "Record an in-the-wild instance of the claim you steward: a source " +
        "you read during this pass that itself asserts the claim (or its " +
        "negation). A cheap side effect of the evidence reading you are " +
        "doing anyway — never search just to farm instances. Record only " +
        "genuine assertions: a source that merely mentions the claim, " +
        "questions it, or reports on the debate without taking a side is " +
        "not an instance; a source quoting someone who asserts it is an " +
        "instance whose speaker is the person quoted. One instance per " +
        "(claim, source): re-recording the same source is deduplicated, so " +
        "re-assessments never pile up duplicates.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim this is an instance of",
          },
          url: {
            type: "string",
            description:
              "URL of the source document you read. This is the instance's " +
              "provenance; sources are found-or-created by URL.",
          },
          title: {
            type: "string",
            description: "Title of the source document",
          },
          original_text: {
            type: "string",
            description:
              "The verbatim passage where the source states the claim (or " +
              "its negation) — the statement itself, not your paraphrase.",
          },
          context: {
            type: "string",
            description:
              "Brief surrounding context: what the source was arguing or " +
              "reporting when it made the statement.",
          },
          stance: {
            type: "string",
            enum: ["affirms", "denies"],
            description:
              "Whether this source asserts the canonical claim (affirms) or " +
              "its negation (denies).",
          },
          speaker: {
            type: "string",
            description:
              "Who asserted it, where identifiable: the author, or for a " +
              "quote the person quoted (not the outlet reporting it).",
          },
          publication: {
            type: "string",
            description:
              "The publication/outlet the statement appeared in, where " +
              "identifiable.",
          },
          source_date: {
            type: "string",
            description:
              "When the statement was made, as stated by the source, " +
              "ISO-8601 to the precision known: '2023', '2023-05', or " +
              "'2023-05-14'. Omit rather than guess.",
          },
          link: {
            type: "string",
            description:
              "Deep link to the statement itself where it differs from the " +
              "source URL (an anchor, a tweet inside a thread, a timestamped " +
              "video link). Omit when the source URL already is the link.",
          },
          confidence: {
            type: "number",
            description:
              "0.0-1.0: how confident you are this is a genuine assertion " +
              "of THIS claim (not a near-miss proposition or a passing " +
              "mention). Defaults to 1.",
          },
        },
        required: ["claim_id", "url", "original_text", "stance"],
      },
    },
    {
      name: "update_canonical_form",
      description:
        "Update the canonical form (text) of a claim. Wording is judged fresh " +
        "on its merits (constitution §3): the shortest neutral statement of the " +
        "proposition as actually debated, about fifteen words. The node's " +
        "identity and history stay stable while its wording improves; never " +
        "keep a worse form because it came first. Do not change what the claim " +
        "IS: a rewording that different considerations would bear on is a " +
        "different claim, and rewording into the negation would flip every " +
        "recorded stance. Escalate those to the Curator instead.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to update",
          },
          new_text: {
            type: "string",
            description: "The new canonical form text",
          },
          reasoning: {
            type: "string",
            description: "Why this change improves the canonical form",
          },
        },
        required: ["claim_id", "new_text", "reasoning"],
      },
    },
    {
      name: "add_argument",
      description:
        "Create a named argument (a line of reasoning) on a claim: a grouping " +
        "that subclaims attach to. Use when distinct for/against lines of reasoning " +
        "exist; pass the returned argument_id to add_relationship_edge / " +
        "add_decomposition_edge to group subclaims under it. The description is a " +
        "label for the line of reasoning, not itself a proposition. An argument is " +
        "NOT finished at creation: once its subclaim edges are attached, you MUST " +
        "give it a written form with write_argument, and when you record the " +
        "claim's assessment you evaluate it with evaluate_argument.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim this argument is about",
          },
          name: {
            type: "string",
            description: "Short descriptive name for the line of reasoning",
          },
          stance: {
            type: "string",
            enum: ["for", "against", "neutral"],
            description: "Whether this argument supports, opposes, or is neutral",
          },
          description: {
            type: "string",
            description: "Brief label for this line of reasoning (not a proposition)",
          },
        },
        required: ["claim_id", "name", "stance", "description"],
      },
    },
    {
      name: "write_argument",
      description:
        "Write (or revise) an argument's written form: a brief, logically " +
        "straightforward prose statement of HOW its subclaims combine to bear on " +
        "the claim, the inferential step the grouping alone leaves implicit. " +
        "1–3 sentences, e.g. 'Because [[claim:<uuid>]] and [[claim:<uuid>]], and " +
        "given [[claim:<uuid>]], the claim follows.' Reference EVERY subclaim in " +
        "the argument inline as [[claim:<uuid>]] (or [[claim:<uuid>|inline " +
        "phrasing]] when grammar needs it); links resolve to the claims' " +
        "canonical text at render time. The written form is structural, not " +
        "epistemic: state the inference, never a verdict on whether it holds; " +
        "your judgment of the inference belongs in evaluate_argument. " +
        "Call this after attaching the argument's subclaim edges; call it again " +
        "whenever the argument's subclaims change (and then re-evaluate).",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: {
            type: "string",
            description: "The UUID of the argument (from add_argument)",
          },
          content: {
            type: "string",
            description:
              "The written form: brief prose with inline [[claim:<uuid>]] " +
              "references to the argument's subclaims",
          },
        },
        required: ["argument_id", "content"],
      },
    },
    {
      name: "evaluate_argument",
      description:
        "Record (or revise) your evaluation of a named argument: does the " +
        "inference go through granting its premises, and which premises does " +
        "the argument currently live or die on? This is the epistemic " +
        "counterpart of the written form (which states the inference without " +
        "judging it), derived as part of assessing the claim — call it for " +
        "each named argument when you record an assessment, and again when a " +
        "premise's standing changes. It is reader-facing prose in the same " +
        "register as an assessment, not a discussion surface: contributor " +
        "exchanges stay in the contribution record.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: {
            type: "string",
            description: "The UUID of the argument (from add_argument)",
          },
          verdict: {
            type: "string",
            enum: [...ARGUMENT_VERDICTS],
            description:
              "Whether the inference goes through granting its premises. " +
              "'holds': the conclusion follows if the premises hold. " +
              "'holds_with_caveats': it goes through, but only under stated " +
              "qualifications. 'fails': the conclusion does not follow even " +
              "granting the premises. 'contested': the validity of the " +
              "argument's framework is itself live-disputed (it should then " +
              "also carry an assumes subclaim, §7).",
          },
          evaluation: {
            type: "string",
            description:
              "Two to four sentences, reader-facing (§12 voice): whether the " +
              "inference goes through, and which premises, given their current " +
              "assessments, bear the argument's weight — reference those " +
              "load-bearing premises inline as [[claim:<uuid>]] (or " +
              "[[claim:<uuid>|inline phrasing]]), the same syntax as the " +
              "written form. E.g. 'The inference is valid; the argument " +
              "stands or falls with [[claim:<uuid>]], which remains " +
              "contested.' No tool names, no UUID prose, no verdict-label " +
              "restating.",
          },
        },
        required: ["argument_id", "verdict", "evaluation"],
      },
    },
    {
      name: "add_relationship_edge",
      description:
        "Attach an EXISTING claim as a subclaim, by id. Use this when match_claim " +
        "found that the dependency you want already exists (as itself, a rewording, " +
        "or its negation): link it instead of minting a duplicate. Edges to your " +
        "claim's decomposition are yours to own.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: {
            type: "string",
            description: "The UUID of the parent claim (the claim you steward)",
          },
          child_id: {
            type: "string",
            description: "The UUID of the existing claim to attach as a subclaim",
          },
          relation: {
            type: "string",
            enum: [...RELATION_TYPES],
            description: RELATION_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why this dependency holds",
          },
          argument_id: {
            type: "string",
            description:
              "Optional UUID of an argument (from add_argument) to group this " +
              "subclaim under",
          },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    {
      name: "add_decomposition_edge",
      description:
        "Create a NEW subclaim and attach it to a claim's decomposition. Use only " +
        "after match_claim confirms the proposition does NOT already exist; " +
        "otherwise use add_relationship_edge to link the existing claim.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: {
            type: "string",
            description: "The UUID of the parent claim",
          },
          child_text: {
            type: "string",
            description: "Text of the subclaim to add",
          },
          relation: {
            type: "string",
            enum: [...RELATION_TYPES],
            description: RELATION_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why this decomposition is valid",
          },
          argument_id: {
            type: "string",
            description:
              "Optional UUID of an argument (from add_argument) to group this " +
              "subclaim under",
          },
          importance: {
            type: "number",
            description:
              "How much it is worth spending scarce intelligence to get this " +
              "subclaim right, 0..1: roughly consequence-if-wrong × contestability, " +
              "NOT logical necessity. A dependency can be maximally load-bearing " +
              "(the parent is false without it) yet LOW importance because nobody " +
              "disputes it: getting an uncontested fact right is free. Reserve " +
              "high values for contested, consequential dependencies. " +
              "This orders the work queue AND (below a threshold) leaves the " +
              "subclaim an un-decomposed embedded stub, so score uncontested " +
              "bedrock low. Defaults to 0.5 if omitted.",
          },
          contestation: {
            type: "number",
            description:
              "How live the dispute around this subclaim is (0.0-1.0), recorded " +
              "separately from importance: ~0 for settled bedrock nobody " +
              "disputes, ~1 for an actively argued crux. This is the " +
              "contestability half of the importance formula stated on its own; " +
              "it is recorded for effort allocation and does not affect " +
              "processing yet.",
          },
          seed_credence: {
            type: "number",
            description:
              "Your prior credence (0.0-1.0) that this subclaim, as stated, is " +
              "TRUE — the same judgment you form anyway while weighing what the " +
              "parent turns on, recorded so the subclaim can be read at a " +
              "glance before its own Steward runs. A seed, not an assessment: " +
              "the subclaim stays unassessed, the system marks the seed " +
              "preliminary and attributes it to you mechanically, and its own " +
              "Steward's verdict supersedes it. Omit it where one number would " +
              "be false precision, exactly as with claim_credence.",
          },
          seed_note: {
            type: "string",
            description:
              "Optional brief preliminary note to accompany seed_credence: a " +
              "paragraph or two on why the prior sits where it does, written " +
              "in the reader-facing register. NOT a full assessment — no " +
              "sub-decomposition, no verdict language, and do not write 'this " +
              "is preliminary' yourself; the page labels the note preliminary " +
              "and names you (the parent claim's Steward) automatically.",
          },
        },
        required: ["parent_id", "child_text", "relation", "reasoning"],
      },
    },
    {
      name: "set_claim_importance",
      description:
        "Set a claim's importance (0..1): how much it is worth spending scarce " +
        "intelligence to get it right (roughly consequence-if-wrong × " +
        "contestability), NOT mere logical load-bearing-ness. A revisable judgment " +
        "that scales effort and orders the work queue. Local dependents are only a " +
        "local signal: a claim central to a niche subfield is still low-importance " +
        "if the subfield is peripheral and the claim uncontested. An uncontested " +
        "fact is low importance even if much depends on it, because getting it " +
        "right is free.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The UUID of the claim" },
          importance: {
            type: "number",
            description:
              "Importance score in [0, 1]. Anchor against constitution §19: " +
              "~0.9 central, ~0.6 major, ~0.35 notable, ~0.15 minor/settled.",
          },
          contestation: {
            type: "number",
            description:
              "How live the dispute around the claim is (0.0-1.0), recorded " +
              "separately from importance: ~0 for a settled fact no informed " +
              "person disputes (even a foundational one), ~1 for an actively " +
              "argued crux with credible parties on both sides. This is the " +
              "contestability half of the importance formula stated on its own; " +
              "it is recorded for effort allocation and does not affect " +
              "processing yet.",
          },
          reasoning: {
            type: "string",
            description: "Why the claim has this importance",
          },
        },
        required: ["claim_id", "importance", "reasoning"],
      },
    },
    {
      name: "log_stewardship_decision",
      description:
        "Log a stewardship decision for the audit trail. Use this to record " +
        "significant decisions you make about a claim.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
          },
          action_taken: {
            type: "string",
            description:
              "What action was taken (e.g. 'reassessed', 'updated_canonical_form', 'no_action_needed')",
          },
          reasoning: {
            type: "string",
            description: "Full reasoning for the decision",
          },
        },
        required: ["claim_id", "action_taken", "reasoning"],
      },
    },
    {
      name: "notify_dependent_stewards",
      description:
        "Notify stewards of claims that depend on this claim, so they can " +
        "evaluate whether the change is material to their claims. Which " +
        "dependents to notify is your judgment (§22): pass parent_ids to " +
        "reach only the dependents the change could actually be material to; " +
        "omit it to notify all of them.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim whose assessment changed",
          },
          change_summary: {
            type: "string",
            description: "Brief summary of what changed",
          },
          parent_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional triage: UUIDs of the dependent (parent) claims to " +
              "notify. Omit to notify every dependent.",
          },
        },
        required: ["claim_id", "change_summary"],
      },
    },
    {
      name: "escalate_to_curator",
      description:
        "Flag a graph-level structural concern for the Curator, e.g. this claim " +
        "looks like a duplicate/counterpart of another, conflates two distinct " +
        "claims (should be split), or should be linked to a related claim. " +
        "Individuation (merge/split) and cross-claim edges are the Curator's domain, " +
        "not yours; raise it and let the Curator adjudicate.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim with the structural concern",
          },
          concern: {
            type: "string",
            description:
              "What you noticed (e.g. 'likely duplicate of <id>', 'conflates X and Y')",
          },
        },
        required: ["claim_id", "concern"],
      },
    },
  ];
}

export async function executeStewardTool(
  toolName: string,
  input: Record<string, unknown>,
  // Why this run happened (the enqueued trigger/context). Threaded into the
  // assessment row (#182) so a re-assessment records its actual cause rather
  // than a generic "steward_reassessment". `model` is the raw API id of the
  // model running this stewardship, recorded on the assessment row (#294) so
  // every verdict names its assessor.
  run: { trigger?: string; context?: string; model?: string } = {}
): Promise<string> {
  try {
    switch (toolName) {
      case "update_claim_assessment": {
        const claimId = input.claim_id as string;
        // The prompt discusses statuses in UPPERCASE (VERIFIED, CONTESTED, …)
        // but the enum — and every reader — is lowercase; normalize like the
        // relation-type writes do so a prose-following model can't persist an
        // out-of-enum value.
        const status = String(input.status).toLowerCase();
        const confidence = input.confidence as number;
        // Optional: only recorded where a probability of truth is meaningful
        // (constitution §10). null, not 0 — "no credence stated" is a distinct
        // signal from "credence that the claim is false".
        const claimCredence =
          typeof input.claim_credence === "number" ? input.claim_credence : null;
        // Optional exit judgment for effort allocation (#172 phase 1): recorded
        // on the assessment row, read by nothing yet. null = not stated.
        const marginalYield = clampUnit(input.marginal_yield) ?? null;
        const reasoningTrace = input.reasoning_trace as string;
        // Reader-facing assessment (still persisted to the `summary` column). Also
        // accept the legacy `summary` key so an in-flight tool call from the older
        // prompt still lands, and fall back to the reasoning trace when neither is
        // given, so the page never renders blank — the UI has the same fallback, but
        // keeping the column populated means a later render never has to.
        const summary =
          ((input.assessment ?? input.summary) as string | undefined)?.trim() || reasoningTrace;

        // Both texts may reference claims inline as [[claim:<uuid>|phrase]]
        // (issue #203). A link to a claim that does not exist would sit as a
        // dead link in front of every reader, so a hallucinated id bounces the
        // write back — the steward re-calls with the id fixed or the reference
        // in plain text.
        const linkedIds = [
          ...new Set(
            [...parseClaimLinks(summary), ...parseClaimLinks(reasoningTrace)].map(
              (l) => l.claimId
            )
          ),
        ];
        if (linkedIds.length > 0) {
          const found = await rawQuery<{ id: string }>(
            `SELECT id FROM claims WHERE id = ANY($1::uuid[])`,
            [linkedIds]
          );
          const foundIds = new Set(found.map((r) => r.id));
          const unknown = linkedIds.filter((id) => !foundIds.has(id));
          if (unknown.length > 0) {
            return JSON.stringify({
              success: false,
              message:
                `These linked claims do not exist: ${unknown.join(", ")}. ` +
                `Link only real claims (ids from get_claim_subclaims or from ` +
                `this run), or drop the link and name the claim in plain text.`,
            });
          }
        }

        const db = getDb();

        // Carry over the current assessment's subclaim breakdown: a steward
        // reassessment of status/confidence shouldn't wipe it. Filter on
        // isCurrent so we read the active row (not an arbitrary historical one),
        // and fall back to {} so the column is never null (it is notNull).
        const [prev] = await db
          .select({ subclaimSummary: assessments.subclaimSummary })
          .from(assessments)
          .where(and(eq(assessments.claimId, claimId), eq(assessments.isCurrent, true)))
          .limit(1);

        // Mark previous assessment as non-current
        await db
          .update(assessments)
          .set({ isCurrent: false })
          .where(eq(assessments.claimId, claimId));

        // Insert new assessment
        await db.insert(assessments).values({
          claimId,
          status,
          confidence,
          claimCredence,
          marginalYield,
          summary,
          reasoningTrace,
          subclaimSummary: prev?.subclaimSummary ?? {},
          isCurrent: true,
          trigger: run.trigger ?? "steward_reassessment",
          triggerContext: run.context?.trim() ? run.context : null,
          // Which model produced this verdict (#294). Null only when the run
          // context doesn't carry it (e.g. legacy call sites).
          model: run.model ?? null,
        });

        // Argument evaluations are derived within the assessment (issue #173),
        // so a fresh verdict makes every named argument's evaluation due: list
        // the ones that are missing or that predate this assessment. A nudge,
        // not a gate — confirming an unchanged evaluation is a cheap re-call.
        const evalStates = await getEvaluationStateForClaim(claimId);
        const missing = evalStates.filter((s) => s.content === null);
        const stale = evalStates.filter((s) => s.stale);
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(
            `${missing.length} named argument(s) have no evaluation yet: ` +
              missing.map((s) => `"${s.argument_name}"`).join(", ") +
              `. Evaluate each with evaluate_argument.`
          );
        }
        if (stale.length > 0) {
          parts.push(
            `${stale.length} argument evaluation(s) predate this assessment: ` +
              stale.map((s) => `"${s.argument_name}"`).join(", ") +
              `. Re-evaluate any whose premises' standing changed, or re-record ` +
              `them unchanged to confirm they still hold.`
          );
        }

        return JSON.stringify({
          success: true,
          message:
            `Assessment updated for claim ${claimId}: ${status} (${confidence})` +
            (parts.length > 0 ? ` ${parts.join(" ")}` : ""),
        });
      }

      case "record_claim_instance": {
        const claimId = input.claim_id as string;
        const url = typeof input.url === "string" ? input.url.trim() : "";
        const originalText =
          typeof input.original_text === "string"
            ? input.original_text.trim()
            : "";
        // Same normalization as the assessment status: the prompt discusses
        // stances in prose, so a cased value must not escape the enum.
        const stance = String(input.stance ?? "").toLowerCase();
        const optText = (v: unknown): string | undefined =>
          typeof v === "string" && v.trim() ? v.trim() : undefined;

        if (!/^https?:\/\//i.test(url)) {
          return JSON.stringify({
            success: false,
            message:
              "url must be the http(s) URL of the source you read; an " +
              "instance without provenance is not recordable.",
          });
        }
        if (!originalText) {
          return JSON.stringify({
            success: false,
            message:
              "original_text is required: the verbatim passage where the " +
              "source states the claim (or its negation).",
          });
        }
        // A passage, not a document: an instance records where the claim was
        // stated, and the source row keeps the document.
        if (originalText.length > 2000) {
          return JSON.stringify({
            success: false,
            message:
              `original_text is ${originalText.length} chars; keep it under ` +
              `2000. Record the passage that states the claim, not the ` +
              `surrounding document.`,
          });
        }
        if (stance !== "affirms" && stance !== "denies") {
          return JSON.stringify({
            success: false,
            message:
              `Unknown stance "${stance}". Use "affirms" (the source asserts ` +
              `the canonical claim) or "denies" (it asserts the negation).`,
          });
        }

        // A hallucinated claim id would otherwise surface as an opaque FK
        // error from the insert.
        const claimRows = await rawQuery<{ id: string }>(
          `SELECT id FROM claims WHERE id = $1`,
          [claimId]
        );
        if (claimRows.length === 0) {
          return JSON.stringify({
            success: false,
            message: `Claim not found: ${claimId}`,
          });
        }

        // Found-or-created by URL, WITHOUT enqueueing extraction: recording a
        // sighting must stay a cheap side effect of this run, never spawn an
        // extraction pipeline for the source.
        const source = await getOrCreateSource({
          url,
          title: optText(input.title),
        });

        // Dedup on (claim, source) so re-assessments that reread the same
        // source don't pile up duplicate instances (#278).
        const [existing] = await rawQuery<{ id: string; stance: string }>(
          `SELECT id, stance FROM claim_instances
           WHERE claim_id = $1 AND source_id = $2
           LIMIT 1`,
          [claimId, source.id]
        );
        if (existing) {
          return JSON.stringify({
            success: true,
            deduplicated: true,
            instance_id: existing.id,
            message:
              `This source is already recorded as an instance of this claim ` +
              `(stance: ${existing.stance}); nothing new was written.` +
              (existing.stance !== stance
                ? ` Note: the existing instance's stance differs from the one ` +
                  `you just observed — if the source genuinely takes both ` +
                  `sides, or the recorded stance looks wrong, weigh that in ` +
                  `your assessment and note it in your reasoning_trace.`
                : ""),
          });
        }

        const db = getDb();
        const [instance] = await db
          .insert(claimInstances)
          .values({
            claimId,
            sourceId: source.id,
            originalText,
            context: optText(input.context),
            stance,
            confidence: clampUnit(input.confidence) ?? 1.0,
            speaker: optText(input.speaker),
            publication: optText(input.publication),
            sourceDate: optText(input.source_date),
            link: optText(input.link),
            createdBy: "claim_steward",
          })
          .returning();

        return JSON.stringify({
          success: true,
          instance_id: instance!.id,
          source_id: source.id,
          message:
            `Recorded a ${stance} instance of claim ${claimId} from ` +
            `${source.url ?? url}. It now counts among the claim's source ` +
            `instances; weigh its stance in your assessment like any other.`,
        });
      }

      case "update_canonical_form": {
        const claimId = input.claim_id as string;
        const newText = input.new_text as string;

        const db = getDb();

        // Update claim text and regenerate embedding
        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(newText);
        } catch {
          // Continue without embedding update
        }

        await db
          .update(claims)
          .set({
            text: newText,
            ...(embedding ? { embedding } : {}),
            updatedAt: new Date(),
          })
          .where(eq(claims.id, claimId));

        return JSON.stringify({
          success: true,
          message: `Canonical form updated for claim ${claimId}`,
        });
      }

      case "set_claim_importance": {
        const claimId = input.claim_id as string;
        const importance = clampUnit(input.importance);
        if (importance === undefined) {
          return JSON.stringify({
            success: false,
            message: "importance must be a number in [0, 1].",
          });
        }
        // Contestation is recorded alongside importance when the Steward states
        // it (#172 phase 1); absent means "leave the stored judgment as is",
        // never "reset to unjudged".
        const contestation = clampUnit(input.contestation);

        const db = getDb();
        await db
          .update(claims)
          .set({
            importance,
            ...(contestation !== undefined ? { contestation } : {}),
            updatedAt: new Date(),
          })
          .where(eq(claims.id, claimId));

        return JSON.stringify({
          success: true,
          message:
            `Importance of claim ${claimId} set to ${importance}.` +
            (contestation !== undefined
              ? ` Contestation recorded as ${contestation}.`
              : ""),
        });
      }

      case "add_argument": {
        const claimId = input.claim_id as string;
        const name = input.name as string;
        const stance = input.stance as "for" | "against" | "neutral";
        const description = input.description as string;

        const argument = await addArgument({
          claimId,
          stance,
          content: description,
          name,
          description,
          createdBy: "claim_steward",
        });

        return JSON.stringify({
          success: true,
          message:
            `Created argument "${name}" (${stance}) on claim ${claimId}. ` +
            `Attach its subclaim edges, then give it a written form with ` +
            `write_argument, and evaluate it with evaluate_argument when you ` +
            `record the claim's assessment.`,
          argument_id: argument.id,
        });
      }

      case "write_argument": {
        const argumentId = input.argument_id as string;
        const content = ((input.content as string) ?? "").trim();

        const argument = await getArgument(argumentId);
        if (!argument) {
          return JSON.stringify({
            success: false,
            message: `Argument not found: ${argumentId}`,
          });
        }

        // Brief means brief: uuid links cost ~46 chars each, so the cap is
        // roomier than the 1–3 sentences it is meant to hold, but it still
        // stops essays.
        if (content.length > 1000) {
          return JSON.stringify({
            success: false,
            message:
              `Written form is ${content.length} chars; keep it under 1000. ` +
              `State the inference in 1–3 sentences; detail belongs in the ` +
              `subclaims themselves.`,
          });
        }

        const links = parseClaimLinks(content);
        if (links.length === 0) {
          return JSON.stringify({
            success: false,
            message:
              "The written form must reference the argument's subclaims inline " +
              "as [[claim:<uuid>]]; a written form with no links is just a " +
              "longer label.",
          });
        }

        // Mutual checkability: every link must be a subclaim edge of this
        // argument (or the parent claim itself), and every subclaim should be
        // referenced. Unknown links fail; unreferenced subclaims only warn, so
        // a steward mid-restructure is nudged, not wedged.
        const subclaims = await getArgumentSubclaims(argumentId);
        const subclaimIds = new Set(subclaims.map((s) => s.id));
        const linkedIds = new Set(links.map((l) => l.claimId));

        const unknown = [...linkedIds].filter(
          (id) => !subclaimIds.has(id) && id !== argument.claimId
        );
        if (unknown.length > 0) {
          return JSON.stringify({
            success: false,
            message:
              `These linked claims are not subclaims of this argument: ` +
              `${unknown.join(", ")}. Link only claims attached to the ` +
              `argument via add_relationship_edge / add_decomposition_edge ` +
              `(attach the edge first if it is missing).`,
          });
        }

        await setArgumentContent(argumentId, content);

        const unreferenced = subclaims.filter((s) => !linkedIds.has(s.id));
        return JSON.stringify({
          success: true,
          message:
            `Written form saved for argument "${argument.name ?? argumentId}".` +
            (unreferenced.length > 0
              ? ` Note: ${unreferenced.length} subclaim(s) in this argument are ` +
                `not referenced: ` +
                unreferenced
                  .map((s) => `${s.id} ("${s.text.slice(0, 60)}")`)
                  .join("; ") +
                `. Reference every subclaim, or detach edges that no longer ` +
                `belong to this line of reasoning.`
              : ""),
        });
      }

      case "evaluate_argument": {
        const argumentId = input.argument_id as string;
        const verdict = String(input.verdict).toLowerCase();
        const content = ((input.evaluation as string) ?? "").trim();

        if (!isArgumentVerdict(verdict)) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown verdict "${verdict}". Use one of: ` +
              `${ARGUMENT_VERDICTS.join(", ")}.`,
          });
        }

        const argument = await getArgument(argumentId);
        if (!argument) {
          return JSON.stringify({
            success: false,
            message: `Argument not found: ${argumentId}`,
          });
        }
        if (!argument.name) {
          return JSON.stringify({
            success: false,
            message:
              "Only named arguments carry an evaluation; an unnamed grouping " +
              "is judged in the claim's assessment itself.",
          });
        }

        if (content.length === 0) {
          return JSON.stringify({
            success: false,
            message: "The evaluation prose is required; a bare verdict is a label, not a judgment.",
          });
        }
        // Same brevity budget as the written form: links cost ~46 chars each,
        // so the cap is roomier than the 2–4 sentences it should hold.
        if (content.length > 1200) {
          return JSON.stringify({
            success: false,
            message:
              `Evaluation is ${content.length} chars; keep it under 1200. ` +
              `State whether the inference goes through and where the weight ` +
              `lies; the full audit detail belongs in the claim's reasoning trace.`,
          });
        }

        // Any linked claim must belong to this argument (or be the parent
        // claim); and when the argument has attached subclaims, the
        // load-bearing analysis should point at them — require at least one
        // link then. An argument whose premises live only in its written-form
        // prose has nothing to link, so zero links is allowed in that case.
        const subclaims = await getArgumentSubclaims(argumentId);
        const links = parseClaimLinks(content);
        const subclaimIds = new Set(subclaims.map((s) => s.id));
        const unknown = [...new Set(links.map((l) => l.claimId))].filter(
          (id) => !subclaimIds.has(id) && id !== argument.claimId
        );
        if (unknown.length > 0) {
          return JSON.stringify({
            success: false,
            message:
              `These linked claims are not subclaims of this argument: ` +
              `${unknown.join(", ")}. Link only claims attached to the argument ` +
              `(or the claim it is about).`,
          });
        }
        if (subclaims.length > 0 && links.length === 0) {
          return JSON.stringify({
            success: false,
            message:
              "The evaluation must say which premises bear the weight: " +
              "reference the load-bearing subclaim(s) inline as " +
              "[[claim:<uuid>]], as in the written form.",
          });
        }

        // Provenance: stamp the claim assessment this evaluation was derived
        // under, so an evaluation left behind by a later reassessment is
        // detectably stale. Call evaluate_argument AFTER update_claim_assessment
        // so the stamp lands on the fresh assessment.
        const db = getDb();
        const [currentAssessment] = await db
          .select({ id: assessments.id })
          .from(assessments)
          .where(
            and(
              eq(assessments.claimId, argument.claimId),
              eq(assessments.isCurrent, true)
            )
          )
          .limit(1);

        await setArgumentEvaluation({
          argumentId,
          verdict,
          content,
          assessmentId: currentAssessment?.id ?? null,
          createdBy: "claim_steward",
        });

        return JSON.stringify({
          success: true,
          message:
            `Evaluation recorded for argument "${argument.name}": ${verdict}.` +
            (currentAssessment
              ? ""
              : ` Note: the claim has no current assessment yet; record one ` +
                `with update_claim_assessment so the evaluation is anchored ` +
                `to it.`),
        });
      }

      case "add_relationship_edge": {
        const parentId = input.parent_id as string;
        const childId = input.child_id as string;
        const relation = input.relation as string;
        const reasoning = input.reasoning as string;
        const argumentId = (input.argument_id as string) ?? null;

        if (parentId === childId) {
          return JSON.stringify({
            success: false,
            message: "A claim cannot be its own subclaim (parent_id === child_id).",
          });
        }

        const db = getDb();

        // Link an already-existing claim; it has (or will have) its own steward
        // processing, so no enqueue here — just the edge.
        try {
          await db.insert(claimRelationships).values({
            parentClaimId: parentId,
            childClaimId: childId,
            relationType: relation.toLowerCase(),
            reasoning,
            confidence: 1.0,
            argumentId,
            createdBy: "claim_steward",
          });
        } catch {
          // Unique constraint -- this edge already exists; idempotent, ignore.
        }

        return JSON.stringify({
          success: true,
          message: `Linked existing claim ${childId} as a subclaim of ${parentId} (${relation}).`,
          child_claim_id: childId,
        });
      }

      case "add_decomposition_edge": {
        const parentId = input.parent_id as string;
        const childText = input.child_text as string;
        const relation = input.relation as string;
        const reasoning = input.reasoning as string;
        const argumentId = (input.argument_id as string) ?? null;
        const importance = clampUnit(input.importance);
        // Recorded on the new subclaim for the eventual stakes/yield split
        // (#172 phase 1); the deferral gate below still reads only importance.
        const contestation = clampUnit(input.contestation);
        // Steward-seeded prior (#285): the parent Steward's credence that this
        // subclaim is true, plus an optional brief note. Stored on the claim
        // row — never as an assessment — so the subclaim still reads as
        // unassessed everywhere; read paths label the seed preliminary and
        // attribute it to the parent claim mechanically (seedSourceClaimId).
        const seedCredence = clampUnit(input.seed_credence);
        const seedNote =
          typeof input.seed_note === "string" && input.seed_note.trim()
            ? input.seed_note.trim()
            : undefined;
        // A paragraph or two, not an assessment: links cost little here, so the
        // cap is roomier than the prose it should hold, but it stops the seed
        // from becoming the full assessment that belongs to the subclaim's own
        // Steward.
        if (seedNote && seedNote.length > 2000) {
          return JSON.stringify({
            success: false,
            message:
              `seed_note is ${seedNote.length} chars; keep it under 2000. ` +
              `It is a brief preliminary note (a paragraph or two), not the ` +
              `subclaim's assessment — that belongs to its own Steward.`,
          });
        }

        const db = getDb();

        // Create the subclaim
        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(childText);
        } catch {
          // Continue without embedding
        }

        // Economic brake (#98/#68): a subclaim the Steward judged below
        // stewardEnqueueMinImportance is left a *deferred* embedded stub — NOT
        // recursively decomposed. Uncontested bedrock (settled math/definitions)
        // now scores low importance, so this stops the "one physics claim spawns a
        // whole textbook" cost explosion at its root. Crucially the gate must set
        // steward_state='deferred', because a claim created with the default
        // 'pending' is ALREADY in the importance-ordered drain queue regardless of
        // whether we enqueue a pipeline for it — the enqueue path only sets the
        // trigger/decompositionStatus. 'deferred' keeps it out of the drain; a
        // later re-trigger (enqueueSteward, e.g. a dependent's notification) flips
        // it back to 'pending', so nothing is permanently stranded.
        const { stewardEnqueueMinImportance, pipelineEpoch } = loadConfig();
        const effectiveImportance = importance ?? 0.5;
        const gated =
          stewardEnqueueMinImportance > 0 &&
          effectiveImportance < stewardEnqueueMinImportance;

        const [newClaim] = await db
          .insert(claims)
          .values({
            text: childText,
            claimType: "empirical_derived",
            embedding: embedding ?? undefined,
            ...(importance !== undefined ? { importance } : {}),
            ...(contestation !== undefined ? { contestation } : {}),
            ...(seedCredence !== undefined ? { seedCredence } : {}),
            ...(seedNote !== undefined ? { seedNote } : {}),
            // Provenance for the mechanical "preliminary" label: which claim's
            // Steward wrote the seed. Stamped whenever any seed field is given.
            ...(seedCredence !== undefined || seedNote !== undefined
              ? { seedSourceClaimId: parentId }
              : {}),
            ...(gated ? { stewardState: "deferred" } : {}),
            pipelineEpoch,
            createdBy: "claim_steward",
          })
          .returning();

        // Create relationship
        try {
          await db.insert(claimRelationships).values({
            parentClaimId: parentId,
            childClaimId: newClaim!.id,
            relationType: relation.toLowerCase(),
            reasoning,
            confidence: 1.0,
            argumentId,
            createdBy: "claim_steward",
          });
        } catch {
          // Unique constraint -- relationship may already exist
        }

        // The new claim is created already embedded (above), so it is a valid,
        // dedup-able stub even if it is never processed. When NOT gated, we onboard
        // it so its own Steward structures + assesses it, like any other claim.
        // Steward work isn't tied to an ingestion job, so use a sentinel jobId (the
        // pipeline only threads jobId; it never looks it up). No ancestor/depth
        // threading: the child's Steward calls match_claim before creating
        // anything, so it links this parent (and any other ancestor) rather than
        // looping into it.
        if (!gated) {
          await enqueueClaimPipeline({
            claimId: newClaim!.id,
            jobId: "steward",
          });
        }

        return JSON.stringify({
          success: true,
          message:
            `Added subclaim to ${parentId}: "${childText}" (${relation})` +
            (seedCredence !== undefined
              ? `; seeded with prior credence ${seedCredence}` +
                (seedNote ? " and a preliminary note" : "")
              : seedNote
                ? `; seeded with a preliminary note`
                : "") +
            (gated
              ? `; kept as a deferred embedded stub (importance ` +
                `${effectiveImportance} below the decomposition threshold ` +
                `${stewardEnqueueMinImportance}); not recursively decomposed.`
              : ""),
          child_claim_id: newClaim!.id,
        });
      }

      case "log_stewardship_decision": {
        const claimId = input.claim_id as string;
        const actionTaken = input.action_taken as string;
        const reasoning = input.reasoning as string;

        // The durable audit trail the constitution promises (#100) — an
        // append-only row per decision, not just a bumped timestamp.
        const db = getDb();
        await db.insert(auditLog).values({
          claimId,
          action: actionTaken,
          reasoning,
          createdBy: "claim_steward",
        });
        await db
          .update(claims)
          .set({ updatedAt: new Date() })
          .where(eq(claims.id, claimId));

        return JSON.stringify({
          success: true,
          message: `Stewardship decision logged for claim ${claimId}: ${actionTaken}`,
          action: actionTaken,
          reasoning,
        });
      }

      case "notify_dependent_stewards": {
        const claimId = input.claim_id as string;
        const changeSummary = input.change_summary as string;
        // Optional triage (#182): the constitution assigns this steward the
        // judgment of WHICH dependents a change is material to, so an explicit
        // parent_ids list restricts the fan-out. Absent, all dependents are
        // notified (the correct reading of "material to everyone").
        const requested = Array.isArray(input.parent_ids)
          ? (input.parent_ids as unknown[]).map(String)
          : null;

        const parents = await rawQuery<{ parent_id: string }>(
          `SELECT DISTINCT parent_claim_id AS parent_id
           FROM claim_relationships
           WHERE child_claim_id = $1`,
          [claimId]
        );
        const parentIds = parents.map((p) => p.parent_id);

        // Intersect with the real dependent set so a hallucinated or stale id
        // can't enqueue an unrelated claim's Steward; report what was dropped
        // so the model can correct itself.
        const targets = requested
          ? parentIds.filter((id) => requested.includes(id))
          : parentIds;
        const skipped = requested
          ? requested.filter((id) => !parentIds.includes(id))
          : [];

        for (const parentId of targets) {
          await enqueueSteward({
            claimId: parentId,
            trigger: "subclaim_change",
            context: `Subclaim ${claimId} changed: ${changeSummary}`,
          });
        }

        return JSON.stringify({
          success: true,
          message: `Notified ${targets.length} dependent claim stewards`,
          parent_claim_ids: targets,
          ...(skipped.length > 0
            ? {
                skipped_not_dependents: skipped,
                note:
                  "These parent_ids are not dependents of this claim and were " +
                  "not notified.",
              }
            : {}),
        });
      }

      case "escalate_to_curator": {
        const claimId = input.claim_id as string;
        const concern = input.concern as string;

        await enqueueCurator({
          trigger: "steward_escalation",
          claimId,
          context: concern,
        });

        return JSON.stringify({
          success: true,
          message: `Escalated a structural concern about ${claimId} to the Curator.`,
        });
      }

      default:
        return `Error: Unknown steward tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
