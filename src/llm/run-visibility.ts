/**
 * Which agent runs' transcripts are public (#553 groundwork).
 *
 * A transcript holds a run's inputs and every tool result it saw. Public by
 * default would leak whatever a run happened to read, so a run is public only
 * when nothing in it is known to be private, and "known" is decided here:
 *
 *   - AGENT_INPUTS: whether an agent's inputs (system prompt and opening
 *     messages) are public by construction. An agent not listed starts
 *     private.
 *   - TOOL_READS: whether a tool's output can carry private data. A run that
 *     executes a private tool, or a tool not listed, becomes private.
 *
 * Reasons are recorded on the run (agent_runs.private_reasons) as it goes,
 * mechanically: trace-service.ts at the start, the LLM client after each
 * tool turn. Agent code adds a reason when it hands a run private input that
 * the agent's default does not cover (markCurrentRunPrivate). A run over a
 * reader's own content (untraced() in usage-context.ts), which exists only
 * in record mode, starts private whatever its agent's default. The rule only
 * ever narrows: nothing here makes a run public.
 *
 * Private means: anything about an account that is not public (contact
 * details, balances, keys), money and payee details, restricted attachments,
 * unpublished solver work, a reader's own content, operator data, anything
 * served only behind auth. What directs the public graph is not private: a
 * granting conversation, a funder's notes and pokes, a mandate's workspace,
 * petitions and research briefs are public (private-grantmaking.ts), except
 * where a mandate was made before that rule, under a promise of privacy.
 * Public means: what Minerval already serves without auth, the public web,
 * and confirmations of the run's own writes to public records.
 *
 * tests/unit/llm/run-visibility.test.ts fails when a tool defined in the code
 * is missing here, so every new tool gets a decision.
 *
 * Inside a members-only deployment some of these reasons are what a label
 * already holds. A run that read an organization's data through a
 * connection, ran a command over its files, or redacted a page written at a
 * label, is private here because that material is not the public's. It is
 * at the run's label, and a member who reads that label reads what the
 * agents wrote there, their runs included (constitution §26, §11).
 * REASONS_A_LABEL_COVERS lists those reasons; a run all of whose reasons
 * are on it is served to members who read its label
 * (services/run-view-service.ts), with source text held to `read_sources`
 * as in any log. Every other reason keeps a run withheld from members too:
 * a person's own conversation, a funder's words, account and payee detail,
 * operator data, reports.
 */

import { isConnectionToolName } from "../connections.js";

export type Reads = "public" | "private";

export interface Classification {
  reads: Reads;
  /** Why, in a phrase: for public, what the output is; for private, what it exposes. */
  why: string;
}

/**
 * Where a run's log holds a source's stored text (src/raw-sources.ts): the
 * agents whose opening message carries a document, and the tools whose
 * output is a window of one. A reader of the log who may not open raw
 * sources is shown these parts as withheld (services/run-view-service.ts).
 * A passage an agent chose to quote is not on this list: that is what the
 * agent wrote, and reading at the label covers it.
 *
 * tests/unit/db/raw-source-text.test.ts fails when a tool file comes to
 * read a source's stored text and is not accounted for here.
 */
export const AGENTS_GIVEN_SOURCE_TEXT: Readonly<Record<string, string>> = {
  extractor: "the document it is asked to read is in its opening message",
};

export const TOOLS_RETURNING_SOURCE_TEXT: Readonly<Record<string, string>> = {
  get_page_to_redact: "with source_id, a window of the stored text of a source the page drew on",
  open_reading: "a window of what an organization's system returned through a connection, which is the text of the source a kept reading becomes",
  run_command: "what a command printed over the files of a file set, which can be the files' own text",
  open_output: "a window of what such a command printed",
  provenance_read_source: "a window of the source's stored text",
  examination_outline: "the opening words of each segment of the examined document",
  get_contribution_details: "an excerpt of the stored text of a source proposed for intake",
};

/**
 * Whether a tool's output holds a source's text. Beside the list above, a
 * connection's own tools: each returns what an organization's system holds,
 * as it holds it, and that result is the text of the source a kept reading
 * becomes. They are named by an administrator's prefix and a server, so no
 * list can hold them, and are known by the shape of the name
 * (src/connections.ts).
 */
export function returnsSourceText(tool: string): boolean {
  return tool in TOOLS_RETURNING_SOURCE_TEXT || isConnectionToolName(tool);
}

/** Agents whose inputs are public by construction; any other agent starts private. */
export const AGENT_INPUTS: Readonly<Record<string, Classification>> = {
  assistant: { reads: "private", why: "a user's private conversation with their own agent; its marks on a page a reader has open, logged only in record mode" },
  audit: { reads: "private", why: "audit contexts can carry operator data, such as a prize claim's checker errors" },
  consistency_checker: { reads: "public", why: "a region of the public graph" },
  contribution_reviewer: { reads: "public", why: "a contribution's id; contributions are public" },
  correspondent: { reads: "public", why: "a mandate's brief, its workspace and its manager's pokes, which direct the public graph and are public; a mandate made before that rule marks its runs private (private-grantmaking.ts)" },
  curator: { reads: "public", why: "curation requests over public claims" },
  dispute_arbitrator: { reads: "public", why: "a contribution, its appeal and the trigger; all public" },
  extractor: { reads: "public", why: "a submitted source, public once submitted; on-demand analysis runs untraced, or private in record mode" },
  grantmaker: { reads: "public", why: "a granting conversation and its funder's notes, public from the first message since talking to the Grantmaker directs the public graph; a conversation or mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  grantor: { reads: "public", why: "a mandate before approval and its workspace, public since the Grantmaker drafted them; a mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  lookout: { reads: "public", why: "a public brief and workspace, and pokes, which direct the public graph; a mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  mandate_review: { reads: "public", why: "funder notes, bounty requests and the workspace, which direct the public graph and are public; a mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  matcher: { reads: "public", why: "a source's assertion, public once submitted; on-demand matching runs untraced, or private in record mode" },
  math_solver: { reads: "private", why: "an attempt and earlier attempts, unpublished until the platform publishes them" },
  program_officer: { reads: "public", why: "petitions and inbox items, which direct the public graph's money and are public; a mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  redactor: { reads: "private", why: "a page written at a label only some readers may read, before anything is removed from it" },
  researcher: { reads: "public", why: "a research task; runs Audit launched, and runs a mandate from before grantmaking was public launched, are marked private" },
  steward: { reads: "public", why: "a claim's id and context; the graph it reads is public" },
  tagger: { reads: "public", why: "public claims" },
};

/** Every tool an agent can call, by what its output can carry. */
export const TOOL_READS: Readonly<Record<string, Classification>> = {
  hold_part: { reads: "private", why: "confirms a hold on a part of a page held at a label only some readers read" },
  delay_part: { reads: "private", why: "confirms a delay on a part of a page held at a label only some readers read" },
  lift_hold: { reads: "private", why: "confirms that a hold or a delay on such a part was taken back" },
  refer_to_person: { reads: "private", why: "confirms a referral to a person of a part of a page held at a label only some readers read" },
  finish_redaction: { reads: "private", why: "the fingerprint and removal counts of a page not yet released" },
  get_page_to_redact: { reads: "private", why: "a page as written at a label only some readers read, and its sources' text" },
  leave_judgment_standing: { reads: "public", why: "confirms the run's own write, naming labels and a date and nothing the run read" },
  get_redaction_policies: { reads: "private", why: "boundaries' policies, read by the two sides of each boundary and not by everyone" },
  get_redaction_policy: { reads: "private", why: "a boundary's policy, read by the two sides of that boundary and not by everyone" },
  get_redaction_to_check: { reads: "private", why: "a page as written and as redacted, with the Redactor's notes" },
  look_at_destination: { reads: "private", why: "what is found where a page is going, looked for with words from the page before it is released" },
  record_fidelity_outcome: { reads: "private", why: "confirms an outcome on a page held at a label only some readers read" },
  redact: { reads: "private", why: "a part of a page as it reads after a removal, before release" },
  restore: { reads: "private", why: "a part of a page as it reads after a removal is taken back, before release" },
  add_answer: { reads: "public", why: "confirms the run's own write to public graph records" },
  restate_case_spec: { reads: "public", why: "confirms the run's own write to public graph records" },
  write_case_element: { reads: "public", why: "confirms the run's own write to public graph records" },
  remove_case_element: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_defeater_standing: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_case_assessment: { reads: "public", why: "confirms the run's own write to public graph records" },
  check_case_form: { reads: "public", why: "the run's own case as the graph records it: its structure and where its form fails" },
  add_list_entry: { reads: "public", why: "confirms the run's own write to public graph records" },
  remove_list_entry: { reads: "public", why: "confirms the run's own write to public graph records" },
  restate_list_spec: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_list_assessment: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_argument: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_decomposition_edge: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_feed: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  add_parent_claim: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_presupposition: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_related_claim: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_relationship_edge: { reads: "public", why: "confirms the run's own write to public graph records" },
  add_subquestion: { reads: "public", why: "confirms the run's own write to public graph records" },
  adjust_contributor_reputation: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  adjust_plan: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  allocation_report: { reads: "public", why: "mandate pipeline and allocation, public on the mandate routes" },
  amend_commissions: { reads: "public", why: "confirms the run's own write; commissions and decisions are public on the mandate routes" },
  amend_plan_items: { reads: "public", why: "confirms the run's own write; plan items and their standing are public on the mandate routes" },
  amend_objective: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  add_to_pass_budget: { reads: "public", why: "confirms the run's own write; the budget left is run spend, public on GET /changes" },
  answer_messages: { reads: "public", why: "node messages, public as summaries on GET /claims/:id and in full in public_read.messages" },
  change_node_kind: { reads: "public", why: "confirms the run's own write to public graph records" },
  check_doi: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  claims_from_source: { reads: "public", why: "mandate pipeline and allocation, public on the mandate routes" },
  close_request: { reads: "public", why: "confirms the run's own write to public graph records" },
  commission: { reads: "public", why: "confirms the commission; the budget left is run spend, public on GET /changes" },
  compare_assessments: { reads: "public", why: "claims and assessments, public on the claim routes" },
  complete_mandate: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  complete_quantity_definition: { reads: "public", why: "confirms the run's own write to public graph records" },
  confirm_bounty: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  fresh_start: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  correspondent_report: { reads: "public", why: "a Correspondent's workspace and updates, which direct a mandate's work and are public" },
  cost_sheet: { reads: "public", why: "metered spend the platform recorded and the paid tools' charges: every estimate and spend is inspectable (terms of service 7.1)" },
  create_claim: { reads: "public", why: "confirms the run's own write to public graph records" },
  decide_petitions: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  decide_prize_claim: { reads: "public", why: "the run's own decision, which goes on the public prize record" },
  decline: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  hold: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  decline_mandate: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  delegate: { reads: "private", why: "a copy's report on a user's private task" },
  detach_claim_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  elicit_search_papers: { reads: "public", why: "third-party search over published papers and trials" },
  elicit_search_trials: { reads: "public", why: "third-party search over published papers and trials" },
  escalate: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  escalate_to_curator: { reads: "public", why: "confirms the run's own write to public graph records" },
  evaluate_argument: { reads: "public", why: "confirms the run's own write to public graph records" },
  examination_note_finding: { reads: "public", why: "confirms the run's own write to public provenance records" },
  examination_outline: { reads: "public", why: "instances, edges, readings and source text, public on the claim and source routes" },
  examination_record_coverage: { reads: "public", why: "confirms the run's own write to public provenance records" },
  examination_record_finding: { reads: "public", why: "confirms the run's own write to public provenance records" },
  extend_plan: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  feed_inbox: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  feed_report: { reads: "public", why: "per-feed counts and fetch errors for a lookout's public feeds" },
  file_request: { reads: "public", why: "confirms the run's own write to public graph records" },
  final_tool_nudge: { reads: "public", why: "fixed harness text" },
  finish_extraction: { reads: "public", why: "confirmations; rejections echo the source text the run was given, public once submitted" },
  finish_sweep: { reads: "public", why: "confirms the run's own write" },
  flag_for_human_review: { reads: "public", why: "confirms the run's own decision, with public reputation figures" },
  flag_inconsistency: { reads: "public", why: "confirms the run's own write" },
  flag_issue: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  flag_reassessment: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  fund_request: { reads: "public", why: "confirms the run's own funding; a request's ledger is public on GET /requests/:id" },
  decline_asked_request: { reads: "public", why: "confirms the run's own decision on a request asked of its mandate; it returns the id of the request at its own label and fixed words" },
  get_agent_reports: { reads: "private", why: "agent reports and triage notes, served only with the service key" },
  get_argument: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_assessment_history: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_audit_findings: { reads: "private", why: "audit findings with evidence and contributor ids; no route serves them" },
  get_claim: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_claim_dependents: { reads: "public", why: "retired graph read, kept so runs that called it keep their visibility; graph reads that unauthenticated routes also serve" },
  get_claim_events: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_claim_instances: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_contribution_details: { reads: "private", why: "escalation and human-review reasons no route serves" },
  get_contributor_profile: { reads: "private", why: "moderation state (bad-faith flags, suspension reason, last active) that GET /contributors/:id leaves out" },
  get_decomposition: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_dependents: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_issue: { reads: "private", why: "other reports' bodies and maintainers' notes, served only with the service key" },
  get_parent_claims: { reads: "public", why: "retired graph read, kept so runs that called it keep their visibility; graph reads that unauthenticated routes also serve" },
  get_prize_claim: { reads: "private", why: "restricted proof source, attachment metadata including tax forms, declarations" },
  get_prize_claim_details: { reads: "private", why: "restricted proof source, attachment metadata including tax forms, declarations" },
  get_prize_claim_record: { reads: "private", why: "restricted proof source, attachment metadata including tax forms, declarations" },
  get_proof_attempt: { reads: "private", why: "solver attempts, notebooks and transcripts before publication" },
  get_recent_arbitrations: { reads: "private", why: "the funder's account id on a mandate's contributions, which the public routes hide" },
  get_recent_decisions: { reads: "private", why: "internal review fields and the funder's account id on a mandate's contributions" },
  get_request: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_research_run: { reads: "public", why: "a research run the reader launched: its brief, report and notebook, public in the Researcher's own run; a run from before grantmaking was public is read only by its launcher, whose run is private too" },
  get_review_history: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_source: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_source_context: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  get_source_examinations: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  grant_overview: { reads: "public", why: "the mandate's workspace and funder notes, which direct the public graph and are public on its page; a mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  importance_distribution: { reads: "public", why: "mandate pipeline and allocation, public on the mandate routes" },
  ingestion_report: { reads: "public", why: "mandate pipeline and allocation, public on the mandate routes" },
  keep_analysis: { reads: "private", why: "an analysis of an organization's own files, kept from the sandbox" },
  keep_file: { reads: "private", why: "a file of an organization's own file set" },
  keep_reading: { reads: "private", why: "a reading of an organization's own data, kept from a connection" },
  lean_check: { reads: "public", why: "checker and Mathlib output for text the run sent; checks are public on GET /lean-checks/:id" },
  lean_elaborate: { reads: "public", why: "checker and Mathlib output for text the run sent; checks are public on GET /lean-checks/:id" },
  lean_search: { reads: "public", why: "checker and Mathlib output for text the run sent; checks are public on GET /lean-checks/:id" },
  leave_note: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  lift_suspension: { reads: "public", why: "confirms the run's own decision, with public reputation figures" },
  link_claims: { reads: "public", why: "confirms the run's own write to public graph records" },
  list_correspondents: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  list_documents_for_review: { reads: "public", why: "figures about sources, public on GET /sources/:id/context and the claim routes" },
  list_figure_and_answer_checks: { reads: "public", why: "claims and assessments, public on the claim routes" },
  list_funded_assessments: { reads: "public", why: "mandate pipeline and allocation, public on the mandate routes" },
  list_graph_changes: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  list_lookouts: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  list_my_updates: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  list_partition_claims: { reads: "public", why: "claims and assessments, public on the claim routes" },
  list_reconciliation_events: { reads: "private", why: "curation history no route serves; private until it has one" },
  list_requests: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  load_skill: { reads: "public", why: "skill text from the repository, also served over MCP" },
  log_note: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  log_stewardship_decision: { reads: "public", why: "confirms the run's own write to public graph records" },
  lookout_report: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  mark_problem_solved_by_platform: { reads: "public", why: "confirmation plus prize-claim ids and statuses, public on GET /claims/:id/prize-claims" },
  match_claim: { reads: "public", why: "the Matcher's decision and claim ids" },
  max_tokens_recovery: { reads: "public", why: "fixed harness text" },
  merge_arguments: { reads: "public", why: "confirms the run's own write to public graph records" },
  merge_claims: { reads: "public", why: "confirms the run's own write to public graph records" },
  note_finding: { reads: "public", why: "published findings, public on GET /findings" },
  note_progress: { reads: "public", why: "confirms the run's own progress line; the output carries nothing beyond the run's input" },
  note_to_funder: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  notebook_read: { reads: "public", why: "a Researcher's own working notes, public with its run; the solver's runs, whose notebooks are unpublished until the platform publishes them, are private by agent" },
  notebook_write: { reads: "public", why: "a Researcher's own working notes, public with its run; the solver's runs, whose notebooks are unpublished until the platform publishes them, are private by agent" },
  notify_claim_steward: { reads: "public", why: "confirms the run's own write to public graph records" },
  notify_steward: { reads: "public", why: "confirms the message; the budget left it reports is run spend, public on GET /changes" },
  open_output: { reads: "private", why: "the output of a command run over an organization's own files" },
  open_reading: { reads: "private", why: "an organization's own data, as a connection returned it" },
  pangram_check_ai: { reads: "public", why: "third-party analysis of a passage or URL the run chose" },
  pangram_find_sources: { reads: "public", why: "third-party analysis of a passage or URL the run chose" },
  petition_mandate: { reads: "public", why: "a mandate's decision on a petition, public on the mandate's routes" },
  pipeline_report: { reads: "public", why: "mandate pipeline and allocation, public on the mandate routes" },
  poke_correspondent: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  poke_lookout: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  place_argument_passage: { reads: "public", why: "confirms the run's own write to public graph records" },
  post_bounty: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  propose_ingest: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  propose_mandate: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  propose_parent_edge: { reads: "public", why: "confirms the run's own write to public graph records" },
  provenance_cite_findings: { reads: "public", why: "confirms the run's own write to public provenance records" },
  provenance_get_map: { reads: "public", why: "instances, edges, readings and source text, public on the claim and source routes" },
  provenance_read_source: { reads: "public", why: "instances, edges, readings and source text, public on the claim and source routes" },
  provenance_record_edge: { reads: "public", why: "confirms the run's own write to public provenance records" },
  provenance_record_reading: { reads: "public", why: "confirms the run's own write to public provenance records" },
  provenance_record_root: { reads: "public", why: "confirms the run's own write to public provenance records" },
  provenance_record_source_relationship: { reads: "public", why: "confirms the run's own write to public provenance records" },
  provenance_write_map: { reads: "public", why: "confirms the run's own write to public provenance records" },
  publish_formalization: { reads: "public", why: "formalization versions and review notes, public on the formalization routes" },
  publish_update: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  query_sql: { reads: "public", why: "one SELECT over the public_read views; auth on POST /sql is for metering only" },
  raise_issue: { reads: "private", why: "other reports' bodies and maintainers' notes, served only with the service key" },
  read_earlier_attempt: { reads: "private", why: "solver attempts, notebooks and transcripts before publication" },
  read_event: { reads: "public", why: "queued events, among them pokes, which direct the public graph and are public; a mandate from before that rule marks its runs private (private-grantmaking.ts)" },
  read_item: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  read_listing: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  read_message: { reads: "public", why: "node messages, public as summaries on GET /claims/:id and in full in public_read.messages" },
  read_arxiv_source: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  read_page: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  reassign_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  reattach_claim_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  recent_retractions: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  reclassify_claim: { reads: "public", why: "confirms the run's own write to public graph records" },
  recommend_re_review: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  recommend_reassessment: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  recommend_recuration: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  record_arbitration_decision: { reads: "public", why: "confirms the run's own decision, with public reputation figures" },
  record_argument_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  record_claim_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  record_claims: { reads: "public", why: "confirmations; rejections echo the source text the run was given, public once submitted" },
  record_cut: { reads: "public", why: "confirms the run's own write to public graph records" },
  record_estimate: { reads: "public", why: "confirms the run's own write to public graph records" },
  record_prize_audit_outcome: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  record_quantity_reading: { reads: "public", why: "confirms the run's own write to public graph records" },
  record_question_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  record_review_decision: { reads: "public", why: "confirms the run's own decision, with public reputation figures" },
  record_source_interest: { reads: "public", why: "confirms the run's own write to public provenance records" },
  regrant: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  remove_answer: { reads: "public", why: "confirms the run's own write to public graph records" },
  remove_relationship_edge: { reads: "public", why: "confirms the run's own write to public graph records" },
  remove_subclaim_edge: { reads: "public", why: "confirms the run's own write to public graph records" },
  report: { reads: "public", why: "ends the loop; returns only an acknowledgement" },
  resolve_finding: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  resolve_identifier: { reads: "public", why: "the address a fixed resolver has for the identifier the run passed; nothing is read" },
  retire_argument: { reads: "public", why: "confirms the run's own write to public graph records" },
  restore_below: { reads: "public", why: "confirms the run's own write to public graph records" },
  reverse_reconciliation: { reads: "public", why: "confirms the run's own write to public graph records" },
  revise_argument: { reads: "public", why: "confirms the run's own write to public graph records" },
  revise_request: { reads: "public", why: "confirms the run's own write to public graph records" },
  run_command: { reads: "private", why: "the output of a command run over an organization's own files" },
  scope_sources: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  search_claims: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  search_findings: { reads: "public", why: "published findings, public on GET /findings" },
  search_issues: { reads: "private", why: "other reports' bodies and maintainers' notes, served only with the service key" },
  search_similar_claims: { reads: "public", why: "graph reads that unauthenticated routes also serve" },
  search_tags: { reads: "public", why: "the topic vocabulary, public on GET /tags" },
  set_answer_relation: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_argument_shows: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_claim_domains: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_claim_importance: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_reserve: { reads: "public", why: "confirms the run's own write; the reserve and its reason are public on the mandate's page" },
  amend_pace: { reads: "public", why: "confirms the run's own write; the pace is public on the mandate's page" },
  set_edge_relation: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_related_link: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_feed_rule: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  set_instance_order: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_quantity_definition: { reads: "public", why: "confirms the run's own write to public graph records" },
  set_request_targets: { reads: "public", why: "confirms the run's own write to public graph records" },
  spawn_correspondent: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  spawn_lookout: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  post_lookout: { reads: "public", why: "confirms the run's own write: the lookout's id, its fund and the budget the run has left" },
  amend_lookout: { reads: "public", why: "confirms the run's own write to a lookout its node's Steward posted, with what its fund holds" },
  spawn_mandate: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  split_argument: { reads: "public", why: "confirms the run's own write to public graph records" },
  submit_contribution: { reads: "public", why: "confirms the contribution, which is public, and a mandate's review budget, public on its dashboard" },
  submit_match_decision: { reads: "public", why: "the Matcher's decision and claim ids" },
  submit_plan: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  submit_tags: { reads: "public", why: "the topic vocabulary, public on GET /tags" },
  suggest_edge_to_steward: { reads: "public", why: "confirms the run's own write to public graph records" },
  suspend_contributor: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  triage_items: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  triage_report: { reads: "private", why: "agent reports and triage notes, served only with the service key" },
  ungroup_subclaim: { reads: "public", why: "confirms the run's own write to public graph records" },
  unlink_claims: { reads: "public", why: "confirms the run's own write to public graph records" },
  unsuspend_contributor: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  update_canonical_form: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_claim_assessment: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_claim_instance: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_correspondent: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  update_feed: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  update_issue: { reads: "private", why: "other reports' bodies and maintainers' notes, served only with the service key" },
  update_lookout: { reads: "public", why: "lookout records, public on the mandate's lookout route" },
  update_plan: { reads: "public", why: "correspondent updates and plans, public on GET /correspondents/:id" },
  update_quantity_estimate: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_question_assessment: { reads: "public", why: "confirms the run's own write to public graph records" },
  update_workspace: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  view_image: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  subscribe: { reads: "public", why: "confirms the run's own subscription; what it delivers arrives in tool results, each event withheld unless public or at the run's label" },
  unsubscribe: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  list_subscriptions: { reads: "public", why: "the run's own subscriptions, which it made" },
  wait_for_answers: { reads: "public", why: "petition decisions and other Stewards' answers, public; a research report that arrives marks the run private where arrivals enter (session-tools.ts)" },
  web_search: { reads: "public", why: "public web pages, search hits, feeds and registries" },
  withdraw_bounty: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  withdraw_bounty_after_audit: { reads: "public", why: "confirms the run's own write; reputation and suspension state are public" },
  withdraw_regrant: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
  write_argument: { reads: "public", why: "confirms the run's own write to public graph records" },
  write_operating_policy: { reads: "public", why: "confirms the run's own write; the output carries nothing beyond the run's input" },
};

/** The reason a run of `agent` starts private, or null when its inputs are public. */
export function agentPrivateReason(agent: string): string | null {
  const c = AGENT_INPUTS[agent];
  if (!c) return `agent:${agent}:unclassified`;
  return c.reads === "private" ? `agent:${agent}` : null;
}

/**
 * The reason executing `tool` makes a run private, or null when its output
 * is public. A connection's tools are named by its administrator's prefix
 * and its server, so no list can hold them: they are known by the shape of
 * the name (src/connections.ts), and what they return is an organization's
 * own data.
 */
export function toolPrivateReason(tool: string): string | null {
  if (isConnectionToolName(tool)) return `tool:${tool}`;
  const c = TOOL_READS[tool];
  if (!c) return `tool:${tool}:unclassified`;
  return c.reads === "private" ? `tool:${tool}` : null;
}

/** The reason an Audit run carries when what it was handed is a page whose redaction it checks, and nothing else. */
export const REDACTION_CHECK_REASON = "input:redaction-check";

/**
 * The private reasons that a label covers in a members-only deployment:
 * what each protects is material at the run's own label, written or read
 * there by an agent, which a member who reads that label reads. Each with
 * why. Text a tool returned from a source is still withheld from a reader
 * without `read_sources` (TOOLS_RETURNING_SOURCE_TEXT, returnsSourceText).
 *
 * A reason not listed keeps its run withheld from everyone but a direct
 * service caller, in every deployment. tests/unit/llm/run-visibility.test.ts
 * holds this list to private reasons that exist.
 */
export const REASONS_A_LABEL_COVERS: Readonly<Record<string, string>> = {
  "agent:redactor": "the page it is handed is the page at the run's label, which readers of that label read",
  [REDACTION_CHECK_REASON]: "the page whose redaction Audit checks is the page at the run's label",
  "input:research-report": "a report by research this run commissioned, written at the run's label",
  "tool:get_page_to_redact": "the page at the run's label; its sources' text is held to read_sources",
  "tool:redact": "a part of the page at the run's label",
  "tool:restore": "a part of the page at the run's label",
  "tool:hold_part": "a hold on a part of the page at the run's label",
  "tool:delay_part": "a delay on a part of the page at the run's label",
  "tool:lift_hold": "a hold or a delay on a part of the page at the run's label",
  "tool:refer_to_person": "a referral to a person of a part of the page at the run's label",
  "tool:finish_redaction": "the fingerprint and removal counts of the page at the run's label",
  "tool:get_redaction_policy": "the policy as the run's label reads it",
  "tool:get_redaction_policies": "the policies as the run's label reads them",
  "tool:get_redaction_to_check": "the page at the run's label, as written and as redacted, with the Redactor's notes",
  "tool:look_at_destination": "names of what the readers on the other side of a boundary read, found with words from the page at the run's label",
  "tool:record_fidelity_outcome": "an outcome on the page at the run's label",
  "tool:open_reading": "an organization's data read at the run's label; held to read_sources",
  "tool:keep_reading": "a source kept at the run's label",
  "tool:run_command": "a command over an organization's files at the run's label; its output is held to read_sources",
  "tool:open_output": "the output of such a command; held to read_sources",
  "tool:keep_analysis": "a source kept at the run's label",
  "tool:keep_file": "a source kept at the run's label",
};

/**
 * Agents whose every run works for one account and on that account's
 * credentials: the Assistant, the copies it delegates to (which run as the
 * same agent) and its marks on a page its user sent for analysis. Whatever such a run
 * read, its user could have read; so the account a run is attributed to
 * reads it whole, whatever its reasons (services/run-view-service.ts). The
 * privacy page says these transcripts are visible to their user.
 */
export const AGENTS_AN_OWNER_READS: Readonly<Record<string, string>> = {
  assistant: "a user's own agent, working with that user's own tools, or marking a page that user sent",
};

/**
 * Private reasons that the account a run is attributed to covers in a run
 * of any other agent: what each protects is that account's own words or
 * text. A run with any other reason stays withheld from its account too: a
 * granting conversation's run that read the operator's vendor prices, say.
 */
export const REASONS_AN_OWNER_COVERS: Readonly<Record<string, string>> = {
  "input:readers-own-content": "a passage or page the account handed over for analysis",
  // No run starts with this reason any more: the marks on a page are the
  // Assistant's (#1132). A deployment in record mode holds runs the
  // Extension Agent logged before that, and the account that sent the page
  // still reads them.
  "agent:extension": "the page a reader had open, which they sent, in a run logged before the marks became the Assistant's",
};

/** Whether the account this run is attributed to may read it. */
export function ownerCoversRun(agent: string, reasons: readonly string[]): boolean {
  if (agent in AGENTS_AN_OWNER_READS) return true;
  return reasons.every((r) => r in REASONS_AN_OWNER_COVERS);
}

/**
 * Whether a label covers this private reason, among all of a run's
 * reasons. A connection's tools are known by the shape of the name, as in
 * toolPrivateReason, and what they return is held to read_sources. An Audit
 * run starts private because an audit's context can carry operator data;
 * the label covers that only where the run says its context was a page to
 * check (REDACTION_CHECK_REASON).
 */
export function labelCoversReason(reason: string, all: readonly string[]): boolean {
  if (reason === "agent:audit") return all.includes(REDACTION_CHECK_REASON);
  if (reason in REASONS_A_LABEL_COVERS) return true;
  return reason.startsWith("tool:") && isConnectionToolName(reason.slice("tool:".length));
}
