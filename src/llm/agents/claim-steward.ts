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
  getElicitToolDefinitions,
  executeElicitTool,
  isElicitTool,
} from "../tools/elicit-tools.js";
import { createPangramTools } from "../tools/pangram-tools.js";
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
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { getReadPageToolDefinition, executeReadPage } from "../tools/read-page-tool.js";
import { withAgent, runWithUsageContext, withSkills, budgetRefusal } from "../usage-context.js";
import { runBudgetSentence } from "../prompts/turn-budget.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { createResearchTools } from "../tools/research-tools.js";
import { getQuestionStewardSystemPromptBlocks } from "../prompts/question-steward.js";
import {
  executeKindTool,
  getQuantityToolDefinitions,
  getQuestionToolDefinitions,
  getRequestToolDefinitions,
} from "../tools/kind-tools.js";
import type { NodeKind } from "../../schemas/kinds.js";

/**
 * The Steward's tools that belong to propositions and quantities, withheld
 * from a question's Steward: a question has no verdict, no arguments of its
 * own, and its instances ask or answer it (§7a).
 */
const CLAIM_ONLY_TOOLS = new Set([
  "update_claim_assessment",
  "record_claim_instance",
  "add_argument",
  "write_argument",
  "evaluate_argument",
]);

/** The tool that records each kind's assessment, which every pass must leave on the record. */
const ASSESSMENT_TOOL: Record<NodeKind, string> = {
  claim: "update_claim_assessment",
  quantity: "update_quantity_estimate",
  question: "update_question_assessment",
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The ordinary stewardship task: what this pass is and what must be on the
 * record when it ends. How to go about it is the Steward's judgment, guided
 * by its role prompt; a numbered procedure here read as a checklist to get
 * through rather than a question to think about.
 */
function defaultTask(passNote: string, kind: NodeKind = "claim"): string {
  const noun = kind === "claim" ? "claim" : kind;
  const record =
    kind === "quantity"
      ? `the estimate
(update_quantity_estimate, with the assessment and the work), an evaluation
of each named argument`
      : kind === "question"
        ? `the assessment
(update_question_assessment, with its standing and both texts)`
        : `the assessment
(update_claim_assessment, with both texts and marginal_yield), an evaluation
of each named argument`;
  return `You own this ${noun}: its structure and its assessment. Your role describes
what that involves. How you go about this pass is your judgment.

${passNote}

Read the ${noun} with get_claim. Form your own view of the question before you
read its instances. When you need them, get_claim_instances returns the
instances recorded so far; which of them belong on the ${noun}, and in what
order a reader sees them, is yours to decide.

Before the run ends, the following must be recorded: ${record}, the ${noun}'s importance and contestation, and your
decision (log_stewardship_decision). If the assessment changed materially,
notify the dependents it could matter to (notify_dependent_stewards).`;
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
1. Use get_claim to read the claim and its canonical form, and
   get_claim_instances to see how its sources state it; the statement must
   render the proposition as the discourse states it.
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
1. Use get_claim to read the claim, and get_claim_instances to read it as
   the discourse states it.
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

  // The steward has web search on every provider — it may need fresh
  // external evidence to assess any claim, atomic or compound (#30). The
  // server runs it on an Anthropic model; elsewhere the loop executes it
  // (tools/web-search-tool.ts).
  const webSearch = createWebSearch(model);

  // Same read/navigation set the Curator gets (#69): the Steward owns a claim's
  // structure, so it must be able to read parents, subclaims, and neighbors.
  const graphTools = getGraphToolDefinitions();
  const graphNames = new Set(graphTools.map((t) => t.name));

  // Claim-scoped subset only: the contribution/contributor/decision tools in
  // the full governance bundle are never referenced by the Steward's prompt.
  const claimContextTools = getClaimContextToolDefinitions();
  const claimContextNames = new Set(claimContextTools.map((t) => t.name));

  // Elicit domain tools (#299): offered whenever configured, priced per
  // call against the run's budget. Discovery failure degrades to no tools,
  // never a failed run (§20).
  const claimRow = await getClaimById(input.claimId);
  // The node's kind decides the role (a question has a Steward of its own,
  // §7a), the tools, and what the pass must leave on the record.
  const kind = (claimRow?.kind ?? "claim") as NodeKind;
  const assessmentTool = ASSESSMENT_TOOL[kind];
  const kindRole = kind === "question" ? "question_steward" : "claim_steward";
  const elicitTools = await getElicitToolDefinitions(config);
  // Pangram (AI-writing detection, original-source search), priced per
  // word against the run's budget inside the bundle.
  const pangramTools = createPangramTools({ config });

  // Domain skills (docs/mathematics.md §3.4): selected by the claim's
  // recorded domains, never by who funds the run. Their tools sit in a fixed
  // position after the Elicit tools and before web_search, so the cache
  // breakpoint on the last tool is deterministic per skill variant. There is
  // no importance gate on them: the skill text carries the judgment about
  // when a check is worth its cost, and the run's budget prices it.
  const claimDomains = sanitizeDomains(claimRow?.domains ?? []);
  const skills = skillsForDomains(claimDomains, "claim-steward");
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
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model });
  // The delegation channel (#298): the researcher, launched from this run
  // on this claim, with a per-run count cap inside the bundle.
  const researchTools = createResearchTools({
    requestedBy: "claim_steward",
    claimId: input.claimId,
  });

  const tools = [
    ...graphTools,
    ...claimContextTools,
    // A search hit is a snippet; the page is where an abstract, a results
    // table, or a retraction notice actually is (#333).
    getReadPageToolDefinition(),
    ...getStewardToolDefinitions().filter((t) => kind !== "question" || !CLAIM_ONLY_TOOLS.has(t.name)),
    ...(kind === "question" ? getQuestionToolDefinitions() : getQuantityToolDefinitions()),
    ...getRequestToolDefinitions(kindRole),
    getMatcherToolDefinition(),
    ...elicitTools,
    ...pangramTools.definitions,
    ...skillTools,
    ...researchTools.definitions,
    ...reportTools.definitions, ...findingTools.definitions,
    webSearch.tool,
  ];

  const isInitial = input.trigger === "structure_and_assess";

  const noun = kind === "claim" ? "claim" : kind;
  const passNote = isInitial
    ? `This is the ${noun}'s first pass. It has no structure yet: decompose it as
well as assess it.`
    : `This is a later pass, prompted by the change described in the context. The
${noun} already has structure; change it where what you find warrants, rather
than starting again.`;

  const iterationBudget = config.stewardMaxIterations;

  const elicitNote =
    elicitTools.length > 0
      ? `

The elicit_* tools (scholarly search over papers and trials) are in your
toolset, at $${config.elicitUsdPerCall.toFixed(2)} a call against this run's
budget. For most claims web_search is enough; reach for Elicit when the
verdict turns on the scientific literature and the claim warrants the cost.`
      : "";

  const pangramNote =
    pangramTools.definitions.length > 0
      ? `

The Pangram tools are in your toolset, each call billed per word against
this run's budget: pangram_check_ai detects AI-generated writing, and
pangram_find_sources finds web content matching a text.`
      : "";


  const skillsNote =
    skills.length > 0
      ? `

Skills active for this run: ${skills
          .map((s) => `${s.name} (version ${s.version})`)
          .join(", ")}. Each follows your role in the system prompt as its own block${
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

  // The run's date, so a dated claim is read against the world as it now
  // stands rather than as of the model's training (§9).
  const today = new Date().toISOString().slice(0, 10);

  const userMessage = `You have been triggered to steward a ${noun}.

Today's date: ${today}
Trigger: ${input.trigger}
${kind === "claim" ? "Claim" : kind === "quantity" ? "Quantity" : "Question"} ID: ${input.claimId}
Context: ${input.context}

Budget: ${runBudgetSentence() || "this run has no budget of its own."} Separately,
you have up to ${iterationBudget} tool-use iterations, a backstop against a
stuck loop, not a target. Make sure you have recorded an assessment
(${assessmentTool}) and logged your decision (log_stewardship_decision) before
either runs out, so your work is never lost mid-task. If you are warned that
little budget or few iterations remain, stop exploring and record your
conclusion immediately.

${formalTask ?? defaultTask(passNote, kind)}${elicitNote}${pangramNote}${skillsNote}`;

  // One cached block for the constitution and role, plus one per active skill,
  // so the shared block's cache entry is the same for skilled and unskilled runs.
  const system =
    kind === "question"
      ? getQuestionStewardSystemPromptBlocks({ skills })
      : getClaimStewardSystemPromptBlocks({ skills });

  // A run that ends its turn with no assessment recorded — GLM 5.3 Flash
  // has returned an empty end_turn after seventeen steps of structuring —
  // loses the whole pass. One nudge, only while nothing was recorded.
  let assessmentRecorded = false;

  await withSkills(skills.map((s) => s.name), () => toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system,
    model,
    finalToolNudge: {
      max: 1,
      when: () => !assessmentRecorded,
      message:
        kind === "claim"
          ? "You ended your turn without recording an assessment for this claim. " +
            "Record it now with update_claim_assessment (status, confidence, the " +
            "reader-facing assessment, and your reasoning_trace), then log your " +
            "decision with log_stewardship_decision."
          : `You ended your turn without recording an assessment for this ${noun}. ` +
            `Record it now with ${assessmentTool}, then log your decision with ` +
            `log_stewardship_decision.`,
    },
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    // A pure runaway backstop — judgment, not the iteration count, decides when
    // to stop. The Steward now decomposes AND assesses in one loop, so this is
    // set high; what bounds a run is its budget, shown after every turn.
    maxIterations: iterationBudget,
    iterationBudgetNotice: {
      warnWithin: 3,
      message: (remaining) =>
        `⚠ Stewardship budget notice: ${remaining} tool-use iteration(s) remain ` +
        `before you are stopped. Wrap up now: if you have not yet recorded your ` +
        `assessment with ${assessmentTool} and logged it with ` +
        `log_stewardship_decision, do so on your next turn so your work is saved.`,
    },
    executeTool: async (name, toolInput) => {
      if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const research = await researchTools.execute(name, toolInput);
      if (research !== null) return research;
      const pangram = await pangramTools.execute(name, toolInput);
      if (pangram !== null) return pangram;
      if (name === "match_claim") {
        // The Matcher receives the domains its caller knows.
        return executeMatcherTool(name, toolInput, { domains: claimDomains });
      }
      // Skill tools (docs/mathematics.md §3.5): present exactly when the
      // skill is active for this claim. A proof check is billed from the
      // checker's time, so it waits for budget like any paid tool.
      if (isSkillTool(name)) {
        if (name === "lean_check") {
          const refusal = budgetRefusal("A proof check", 0);
          if (refusal) return refusal;
        }
        return executeSkillTool(name, toolInput, {
          role: "claim-steward",
          claimId: input.claimId,
          run: { trigger: input.trigger, context: input.context, model },
        });
      }
      // Elicit calls cost real money, not just tokens (#299/#300); the
      // executor declines a call the run's budget cannot cover.
      if (isElicitTool(name)) return executeElicitTool(name, toolInput, config);
      const kindOutput = await executeKindTool(name, toolInput, {
        role: kindRole,
        claimId: input.claimId,
        model,
        trigger: input.trigger,
        context: input.context,
      });
      if (kindOutput !== null) {
        if (name === assessmentTool) {
          try {
            assessmentRecorded = (JSON.parse(kindOutput) as { success?: boolean }).success !== false;
          } catch {
            assessmentRecorded = true;
          }
        }
        return kindOutput;
      }
      if (graphNames.has(name)) {
        return executeGraphTool(name, toolInput);
      }
      if (claimContextNames.has(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      const page = await executeReadPage(name, toolInput);
      if (page !== null) return page;
      const output = await executeStewardTool(name, toolInput, {
        trigger: input.trigger,
        context: input.context,
        // Recorded on the assessment row (#294): the verdict names the model
        // that produced it. This is the same resolved id every LLM call in
        // this run uses.
        model,
      });
      if (name === "update_claim_assessment") {
        try {
          assessmentRecorded = (JSON.parse(output) as { success?: boolean }).success !== false;
        } catch {
          assessmentRecorded = true;
        }
      }
      return output;
    },
  }));
}
