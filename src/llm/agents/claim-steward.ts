/**
 * Claim Steward agent.
 *
 * Owns a claim over time: it ASSESSES the claim it stewards (there is no separate
 * Assessor — see #30), maintains its canonical form and decomposition, integrates
 * accepted contributions, and re-judges as evidence and depended-on claims change.
 * It always has web_search and may traverse the graph; on the highest-
 * importance claims it may also get Elicit scholarly search (#299). Acts
 * through tools -- no structured return value.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { toolUseLoop } from "../client.js";
import { getClaimStewardSystemPromptBlocks } from "../prompts/claim-steward.js";
import { skillsForDomains } from "../prompts/skills.js";
import {
  getGraphToolDefinitions,
  executeGraphTool,
} from "../tools/graph-tools.js";
import {
  getClaimContextToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getStewardToolDefinitions,
  executeStewardTool,
} from "../tools/steward-tools.js";
import {
  getMatcherToolDefinition,
  executeMatcherTool,
} from "../tools/matcher-tools.js";
import {
  elicitEnabledForImportance,
  getElicitToolDefinitions,
  executeElicitTool,
  isElicitTool,
} from "../tools/elicit-tools.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { isLeanTool } from "../tools/lean-tools.js";
import { sanitizeDomains } from "./skill-selection.js";
import { getClaimById } from "../../services/claim-service.js";
import { leanCheckerConfigured } from "../../services/lean-checker-client.js";
import {
  getFormalizationById,
  listFormalizations,
} from "../../services/formalization-service.js";
import { loadConfig } from "../../config.js";
import { withAgent, runWithUsageContext, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The ordinary stewardship task: structure (or re-judge) and assess. */
function defaultSteps(structureStep: string): string {
  return `1. Use get_claim_with_context to understand the claim, its subclaims and their
   assessments, its source instances (note each instance's affirm/deny stance),
   and its current assessment if any.
${structureStep}
3. Gauge the claim's importance: how much it is worth getting right
   (consequence-if-wrong × liveness), NOT mere dependency count.
   get_claim_dependents is only a local signal; an uncontested or niche claim is
   low importance even with many local dependents. Scale effort accordingly:
   consequential, contested claims warrant deeper search and a second, adversarial
   pass; minor or settled claims warrant a light touch.
4. Reach a holistic assessment using your judgment (no mechanical aggregation).
   Use web_search for external evidence where it would change the verdict.
   Credible instances that BOTH affirm and deny the claim are a strong signal
   toward CONTESTED. When a source you read itself asserts the claim (or its
   negation) — not merely reports on the debate — record that sighting with
   record_claim_instance as you go (see "Recording Instances").
5. Record it with update_claim_assessment. Provide BOTH texts: a reader-facing
   **assessment** (an encyclopedia-style account of where the claim stands, no
   internal machinery or bookkeeping) and the **reasoning_trace** (the audit
   detail behind the verdict). See "Writing the Assessment: Two Audiences".
6. If the canonical form needs improving, use update_canonical_form.
7. Log your decision with log_stewardship_decision.
8. If you established or changed a material assessment, use
   notify_dependent_stewards so claims that depend on this one are re-judged.`;
}

/**
 * The trigger-specific task for the two formalization triggers
 * (docs/mathematics.md §5.4): the first pass drafts, elaborates, reviews,
 * and records `reviewed`; the second, in a fresh context, publishes or
 * returns the statement to draft. Each carries the record it needs inline,
 * since the Steward has no tool that fetches a statement by id.
 */
async function formalizationTask(
  trigger: string,
  claimId: string,
  context: string,
  formalToolsPresent: boolean
): Promise<string | null> {
  if (trigger !== "formalize" && trigger !== "formalization_review") return null;
  if (!formalToolsPresent) {
    return `This run was triggered to ${
      trigger === "formalize" ? "write" : "review"
    } the claim's formal statement, but the formal tools are unavailable this run
(no Lean checker is configured). Do not record or publish anything: log with
log_stewardship_decision that the formalization could not proceed, and stop.`;
  }
  if (trigger === "formalize") {
    const versions = await listFormalizations(claimId).catch(() => []);
    const history =
      versions.length > 0
        ? `\nStatements already recorded for this claim (newest first):\n` +
          versions
            .map(
              (v) =>
                `- version ${v.version} (${v.status}, ${v.namespace}, pin ${v.pin_id})` +
                (v.review_notes ? `\n  review notes: ${v.review_notes.slice(0, 600)}` : "") +
                (v.status === "reviewed"
                  ? `\n  This version awaits the fresh-context review; a new draft supersedes it only if it is wrong.`
                  : "")
            )
            .join("\n") +
          "\n"
        : "\nNo formal statement has been recorded for this claim yet.\n";
    return `You have been triggered to write this claim's formal statement.
${history}
Proceed:
1. Use get_claim_with_context to read the claim, its canonical form, and its
   instances; the statement must render the proposition as the discourse
   states it.
2. Draft the statement in the checker's convention (a \`def Statement : Prop\`
   taking every definition from Mathlib), using lean_search for names and
   lean_elaborate until it type-checks. Where hypotheses could be vacuous,
   include a witness \`example\`.
3. Read the elaborated statement as an adversary would, against the vacuity
   checklist in the Mathematics skill. Where a community formalization
   exists, start from it and cite it in your review notes.
4. Record it once with publish_formalization (statement_source,
   correspondence in the graph's voice, review_notes for the audit). The
   server re-elaborates it and stores it as reviewed; a second Steward in a
   fresh context decides publication. Do not pass confirm.
5. Log your decision with log_stewardship_decision. Do not reassess the
   claim in this run unless what you learned changes its assessment.`;
  }
  const id = context.match(UUID_RE)?.[0] ?? null;
  const row = id ? await getFormalizationById(id).catch(() => null) : null;
  const record = row
    ? `Formalization ${row.id} (version ${row.version}, status ${row.status}, ${row.namespace}, pin ${row.pin_id}):

Statement file (as elaborated; pp_type: ${row.pp_type}; witness present: ${row.witness_present}):
${row.statement_source}

Own definitions: ${row.own_definitions ? "yes; the statement introduces a definition Mathlib lacks" : "no"}

Correspondence note: ${row.correspondence ?? "(none)"}

Author's review notes: ${row.review_notes ?? "(none)"}`
    : `The formalization named in the context (${context}) could not be loaded; if it does not exist, log that and stop.`;
  return `You are the second, fresh-context reviewer of a formal statement another
Steward pass drafted (Mathematics skill: "every line correct, wrong theorem" is
the failure no checker catches).

${record}

Proceed:
1. Use get_claim_with_context to read the claim as the discourse states it.
2. Judge fidelity against the vacuity checklist: does the statement say
   neither more nor less than the canonical form, are its hypotheses
   satisfiable, are the trivial witnesses the informal problem excludes
   excluded, do the definitions match Mathlib's and the literature's, and
   does the correspondence note say what the formal statement leaves out?
   Where the statement introduces a definition of the Steward's own, check
   that definition against the sources the correspondence note names.
   Use lean_elaborate to probe anything you doubt.
3. Decide with one call: publish_formalization with confirm: true and this
   formalization_id to publish it, or confirm: false with review_notes
   naming the defect to return it to draft. Pass the statement as recorded;
   do not edit it in this pass.
4. Log your decision with log_stewardship_decision.`;
}

// Tag every LLM call in this agent for the per-token meter (#70), and
// attribute it to the claim being stewarded (#217) so per-claim cost — the
// marginal-cost half of the allocation estimate — is a query, not
// archaeology. The wrapper keeps attribution correct for any call site.
export function runClaimSteward(
  input: Parameters<typeof runClaimStewardImpl>[0]
): ReturnType<typeof runClaimStewardImpl> {
  return runWithUsageContext({ claimId: input.claimId }, () =>
    withAgent("steward", () => runClaimStewardImpl(input))
  );
}

async function runClaimStewardImpl(input: {
  trigger: string;
  claimId: string;
  context: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  const model = input.model ?? config.stewardModel;

  // The steward always has web search — it may need fresh external evidence to
  // assess any claim, atomic or compound (#30).
  const webSearchTool: Anthropic.Messages.WebSearchTool20260209 = {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
  };

  // Same read/navigation set the Curator gets (#69): the Steward owns a claim's
  // structure, so it must be able to read parents, subclaims, and neighbors.
  const graphTools = getGraphToolDefinitions();
  const graphNames = new Set(graphTools.map((t) => t.name));

  // Claim-scoped subset only: the contribution/contributor/decision tools in
  // the full governance bundle are never referenced by the Steward's prompt.
  const claimContextTools = getClaimContextToolDefinitions();
  const claimContextNames = new Set(claimContextTools.map((t) => t.name));

  // Elicit domain tools (#299), gated on the claim's recorded importance:
  // scholarly search is overkill for most claims, so only the highest-
  // importance ones (stewardElicitMinImportance, §19) even see the tools.
  // The importance read here is the pre-run value — the Extractor's prior or
  // a previous pass's considered score; a claim whose importance this run
  // RAISES past the gate gets the tools on its next pass, which is the
  // conservative direction for a real-money connector. Discovery failure
  // degrades to no tools, never a failed run (§20).
  const claimRow = await getClaimById(input.claimId);
  const elicitTools = elicitEnabledForImportance(
    claimRow?.importance ?? 0.5,
    config
  )
    ? await getElicitToolDefinitions(config)
    : [];

  // Domain skills (docs/mathematics.md §3.4): selected by the claim's
  // recorded domains, never by who funds the run. Their tools sit in a fixed
  // position after the Elicit tools and before web_search, so the cache
  // breakpoint on the last tool is deterministic per skill variant. There is
  // no importance gate on them: the skill text carries the judgment about
  // when a check is worth its cost, and the per-run caps below are the
  // backstop.
  const claimDomains = sanitizeDomains(claimRow?.domains ?? []);
  const skills = skillsForDomains(claimDomains);
  // The Lean tools are present exactly when the skill is active AND a
  // checker is configured (docs/mathematics.md §6.2); without a checker the
  // run is told the formal tools are unavailable and assesses on the
  // informal evidence. The skill's other tools are not gated on the checker.
  const checkerConfigured = leanCheckerConfigured(config);
  const allSkillTools = getActiveSkillToolDefinitions(skills, "claim-steward");
  const skillTools = checkerConfigured
    ? allSkillTools
    : allSkillTools.filter((t) => !isLeanTool(t.name));
  const leanToolsWithheld = allSkillTools.some((t) => isLeanTool(t.name)) && !checkerConfigured;

  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  const tools = [
    ...graphTools,
    ...claimContextTools,
    ...getStewardToolDefinitions(),
    getMatcherToolDefinition(),
    ...elicitTools,
    ...skillTools,
    ...reportTools.definitions,
    webSearchTool,
  ];

  const isInitial = input.trigger === "structure_and_assess";

  const structureStep = isInitial
    ? `2. DECOMPOSE the claim (this is its first pass). Identify what it turns on:
   the dependencies that would undermine it if false, and the strongest
   considerations for and against it, each a subclaim passing the claim bar. A
   handful, not an exhaustive list (see the Decomposition guidance). For EACH
   dependency, FIRST call match_claim to check whether it already exists in the
   graph (as itself, a rewording, or its negation). If it matches, attach the
   existing claim with add_relationship_edge; only when the Matcher says it is
   novel, create it with add_decomposition_edge. Never mint a duplicate. If the
   claim is simple, leave it atomic; do not invent dependencies.`
    : `2. RE-ASSESS in light of what changed. Adjust structure only if you discover a
   missing dependency the claim turns on, and then match_claim FIRST, linking
   an existing claim with add_relationship_edge or creating a new one with
   add_decomposition_edge. Do not re-decompose from scratch.`;

  const iterationBudget = config.stewardMaxIterations;
  let newSubclaimsThisRun = 0;
  let instancesRecordedThisRun = 0;
  let elicitCallsThisRun = 0;
  let leanSearchesThisRun = 0;
  let leanElaborationsThisRun = 0;
  let leanChecksThisRun = 0;

  const elicitNote =
    elicitTools.length > 0
      ? `

This claim's importance clears the bar for Elicit scholarly search: the
elicit_* tools are in your toolset (up to ${
          config.stewardElicitMaxCallsPerRun > 0
            ? config.stewardElicitMaxCallsPerRun
            : "unlimited"
        } calls this run). They are
likely overkill even here — reach for them only if ordinary web_search proves
insufficient for a verdict that turns on the scientific literature.`
      : "";

  const skillsNote =
    skills.length > 0
      ? `

Domain skills active for this run: ${skills
          .map((s) => `${s.name} (version ${s.version})`)
          .join(", ")}. Each follows your role in the system prompt${
          skillTools.length > 0
            ? `, and the tools it brings (${skillTools.map((t) => t.name).join(", ")}) are in your toolset`
            : ""
        }.${
          leanToolsWithheld
            ? ` The formal tools are unavailable this run: no Lean checker is configured, so the lean_* tools and publish_formalization are absent. Assess on the informal evidence, and record in your reasoning trace that formal verification was unavailable.`
            : ""
        }`
      : "";

  const formalTask = await formalizationTask(
    input.trigger,
    input.claimId,
    input.context,
    skillTools.some((t) => isLeanTool(t.name))
  );

  const defaultTask = `You OWN this claim: its structure (decomposition) and its assessment. Proceed:`;

  const userMessage = `You have been triggered to steward a claim.

Trigger: ${input.trigger}
Claim ID: ${input.claimId}
Context: ${input.context}

Budget: you have up to ${iterationBudget} tool-use iterations for this stewardship.
That is a generous backstop, not a target: use as few or as many as the claim's
importance warrants. But it IS a hard limit: make sure you have recorded an
assessment (update_claim_assessment) and logged your decision
(log_stewardship_decision) before you approach it, so your work is never lost
mid-task. If you are warned that few iterations remain, stop exploring and record
your conclusion immediately.

${formalTask ?? `${defaultTask}
${defaultSteps(structureStep)}`}${elicitNote}${skillsNote}`;

  // One cached block for the constitution and role, plus one per active skill,
  // so the shared block's cache entry is the same for skilled and unskilled runs.
  const system = getClaimStewardSystemPromptBlocks({ skills });

  // Per-run backstops on the Lean tools (docs/mathematics.md §6.2), beside
  // the Elicit cap: each refusal tells the agent what to do instead. A
  // "fresh" replay of lean_check counts double.
  const leanCapRefusal = (name: string, toolInput: Record<string, unknown>): string | null => {
    if (name === "lean_search") {
      const cap = config.stewardLeanMaxSearchesPerRun;
      if (cap > 0 && leanSearchesThisRun >= cap) {
        return JSON.stringify({
          success: false,
          message:
            `This run has already made ${leanSearchesThisRun} Mathlib searches, ` +
            `the per-run backstop (${cap}). Work with the declarations you have ` +
            `found, confirm the ones you intend to use with lean_elaborate, and ` +
            `record what you could not find in your reasoning.`,
        });
      }
      leanSearchesThisRun++;
    } else if (name === "lean_elaborate") {
      const cap = config.stewardLeanMaxElaborationsPerRun;
      if (cap > 0 && leanElaborationsThisRun >= cap) {
        return JSON.stringify({
          success: false,
          message:
            `This run has already elaborated ${leanElaborationsThisRun} drafts, ` +
            `the per-run backstop (${cap}). Do not draft further in this pass: ` +
            `record the best draft and its errors in your reasoning, assess on ` +
            `the informal evidence, and leave the formal statement to a later pass.`,
        });
      }
      leanElaborationsThisRun++;
    } else if (name === "lean_check") {
      const cap = config.stewardLeanMaxChecksPerRun;
      const weight = toolInput.replay === "fresh" ? 2 : 1;
      if (cap > 0 && leanChecksThisRun + weight > cap) {
        return JSON.stringify({
          success: false,
          message:
            `This run has used ${leanChecksThisRun} of its ${cap} proof checks ` +
            `(a fresh replay counts double). Do not check further in this pass: ` +
            `assess on the checks already recorded and the informal evidence, ` +
            `say so in your reasoning, and set marginal_yield honestly.`,
        });
      }
      leanChecksThisRun += weight;
    }
    return null;
  };

  await withSkills(skills.map((s) => s.name), () => toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system,
    model,
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    // A pure runaway backstop — judgment, not the iteration count, decides when
    // to stop. The Steward now decomposes AND assesses in one loop, so this is
    // set high; real spend is bounded by stewardMaxRuns + the LLM budget tracker.
    maxIterations: iterationBudget,
    iterationBudgetNotice: {
      warnWithin: 3,
      message: (remaining) =>
        `⚠ Stewardship budget notice: ${remaining} tool-use iteration(s) remain ` +
        `before you are stopped. Wrap up now: if you have not yet recorded your ` +
        `assessment with update_claim_assessment and logged it with ` +
        `log_stewardship_decision, do so on your next turn so your work is saved.`,
    },
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      if (name === "match_claim") {
        // The Matcher receives the domains its caller knows.
        return executeMatcherTool(name, toolInput, { domains: claimDomains });
      }
      // Skill tools (docs/mathematics.md §3.5): present exactly when the
      // skill is active for this claim, capped per run beside the Elicit cap.
      if (isSkillTool(name)) {
        const refusal = leanCapRefusal(name, toolInput);
        if (refusal) return refusal;
        return executeSkillTool(name, toolInput, {
          role: "claim-steward",
          claimId: input.claimId,
          run: { trigger: input.trigger, context: input.context, model },
        });
      }
      // Elicit calls cost real money, not just tokens (#299/#300): a per-run
      // backstop mirrors web_search's max_uses. The judgment about whether
      // to call at all stays with the Steward.
      if (isElicitTool(name)) {
        const cap = config.stewardElicitMaxCallsPerRun;
        if (cap > 0 && elicitCallsThisRun >= cap) {
          return JSON.stringify({
            success: false,
            message:
              `This run has already made ${elicitCallsThisRun} Elicit call(s), ` +
              `the per-run backstop (${cap}). Work with what those searches ` +
              `returned plus web_search, and record your assessment.`,
          });
        }
        elicitCallsThisRun++;
        return executeElicitTool(name, toolInput, config);
      }
      if (graphNames.has(name)) {
        return executeGraphTool(name, toolInput);
      }
      if (claimContextNames.has(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      // Blast-radius backstop (#157 phase 3): cap the NEW subclaims one run
      // may mint. Like the iteration cap this is a runaway guard, not a
      // target — the judgment about how far to decompose stays with the
      // Steward (and the importance brake bounds recursion). Linking
      // existing claims (add_relationship_edge) is never capped.
      if (name === "add_decomposition_edge") {
        const cap = config.stewardMaxNewSubclaimsPerRun;
        if (cap > 0 && newSubclaimsThisRun >= cap) {
          return JSON.stringify({
            success: false,
            message:
              `This run has already minted ${newSubclaimsThisRun} new subclaims, the ` +
              `per-run backstop (${cap}). Do not create more in this pass: link any ` +
              `remaining dependencies that already exist with add_relationship_edge, ` +
              `note the rest in your reasoning_trace, and proceed to your assessment. ` +
              `A future stewardship pass can continue the decomposition.`,
          });
        }
        newSubclaimsThisRun++;
      }
      // Same runaway-guard shape for instance recording (#278): capturing
      // sightings is a cheap side effect of evidence reading, and this cap
      // only stops a loop from farming instances instead of assessing.
      if (name === "record_claim_instance") {
        const cap = config.stewardMaxInstancesPerRun;
        if (cap > 0 && instancesRecordedThisRun >= cap) {
          return JSON.stringify({
            success: false,
            message:
              `This run has already recorded ${instancesRecordedThisRun} ` +
              `instances, the per-run backstop (${cap}). Do not record more ` +
              `in this pass: note any remaining sightings in your ` +
              `reasoning_trace and proceed to your assessment.`,
          });
        }
        instancesRecordedThisRun++;
      }
      return executeStewardTool(name, toolInput, {
        trigger: input.trigger,
        context: input.context,
        // Recorded on the assessment row (#294): the verdict names the model
        // that produced it. This is the same resolved id every LLM call in
        // this run uses.
        model,
      });
    },
  }));
}
