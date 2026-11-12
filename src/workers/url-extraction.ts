import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sources, claims, claimInstances } from "../db/schema.js";
import { NODE_KINDS, type NodeKind } from "../schemas/kinds.js";
import { sourceContentHash } from "../services/source-content.js";

const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

/**
 * The instance's stance from what the source proposed and what it matched
 * (§4, §7a). A source that gives a figure states its quantity's value; one
 * that asks the question asks it, and one that asks a question about a claim
 * or a quantity poses it; a claim matched to a question answers it.
 */
export function instanceStanceFor(proposed: NodeKind, node: NodeKind, matcherStance: string | undefined): string {
  if (proposed === "question") return node === "question" ? "asks" : "poses";
  if (node === "quantity") return "states";
  if (node === "question") return "answers";
  return matcherStance ?? "affirms";
}
import { extractClaims, type DocumentProblem, type ExtractedClaim } from "../llm/agents/extractor.js";
import { matchClaim, type MatchDecision } from "../llm/agents/matcher.js";
import { requestCuration } from "../services/curation-service.js";
import { sanitizeDomains } from "../llm/agents/skill-selection.js";
import { generateEmbedding } from "../services/embedding-service.js";
import { updateJob, getJobById } from "../services/job-service.js";
import { enqueueClaimPipeline, requestAudit } from "../services/queue-service.js";
import type { UrlExtractionMessage } from "../services/queue-service.js";
import { runAtLabel, runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { loadConfig } from "../config.js";
import { GENERIC_SOURCE_KINDS, type SourceKind } from "../schemas/common.js";
import { recordSourceKind } from "../services/source-service.js";
import { rawQuery } from "../db/client.js";
import { settleMeteredCharge } from "../services/owl-ledger-service.js";
import { fetchPublicUrl } from "../services/url-guard.js";
import { refreshSourceFactsOnce } from "../services/source-facts-service.js";
import { segmentSourceOnce } from "../services/source-segment-service.js";
import { normalizeFocus, recordExtraction, type UndecidedProposal } from "../services/ingest-focus-service.js";
import { recordArgumentPassages } from "../services/argument-passage-service.js";

/**
 * Handle a URL extraction message:
 * 1. Fetch/retrieve the source content
 * 2. Extract claims using the Extractor agent
 * 3. For each claim: match against existing claims or create new
 * 4. Create claim instances linking claims to source
 * 5. Enqueue new claims for the claim pipeline
 *
 * Extraction + matching are user-initiated agentic work, so the LLM calls in
 * here are metered against the account that submitted the source (#70): the
 * job row carries the attribution and we restore it into the usage context
 * for the duration of the run. The job row carries the label of the work
 * that submitted the source too (src/labels.ts), and the extraction runs at
 * it, so the sources and claims it records, and the claims it sends on to
 * be onboarded, keep that label.
 */
export async function handleUrlExtraction(
  message: UrlExtractionMessage
): Promise<void> {
  const job = await getJobById(message.jobId);
  let billedMicroUsd: number;
  try {
    ({ billedMicroUsd } = await runAtLabel(job?.sensitivityLabel, `job ${message.jobId}`, () =>
      runWithUsageContext(
        {
          userId: job?.userId ?? null,
          apiKeyId: job?.apiKeyId ?? null,
          // A grant-funded ingestion meters against the grant's budget job so
          // the spend draws down the escrow, not the submitter's balance.
          jobId: message.meterJobId ?? message.jobId,
        },
        () => withCostMeter(() => processUrlExtraction(message))
      )
    ));
  } catch (err) {
    // A failed extraction must still terminate the ledger ingest action —
    // left 'running' it would strand its funders' allocations, and a
    // reconcile reopen would re-submit (and re-charge) the same URL.
    // Cancelling retires the group; the plan cursor skips cancelled items.
    await cancelIngestAction(message.ingestGroup ?? `ingest:${message.url}`);
    throw err;
  }
  // Escrow-funded ingestions were never cap-charged; nothing to settle.
  if (!message.meterJobId) {
    await settleSourceIngestCharge(message.sourceId, billedMicroUsd);
  }
  // If this extraction executes a ledger ingest action (the engine
  // executor left it 'running'), close it now with the real metered cost:
  // funders' pro-rata shares follow actual spend, never the estimate.
  await completeIngestAction(
    message.ingestGroup ?? `ingest:${message.url}`,
    billedMicroUsd,
    message.meterJobId
  );
}

/** `group`: the ledger ingest group (per URL, and per focus for a scoped ingest). */
async function completeIngestAction(
  group: string,
  billedMicroUsd: number,
  meterJobId?: string
): Promise<void> {
  try {
    // 'open' too: a reconcile sweep may have reopened a slow action while
    // this extraction was still in flight — the guarded completeAction
    // closes it exactly once either way.
    const [live] = await rawQuery<{ id: string }>(
      `SELECT id FROM actions
        WHERE exclusion_group = $1 AND status IN ('running', 'open')
        LIMIT 1`,
      [group]
    );
    if (!live) return;
    const { completeAction } = await import(
      "../services/action-service.js"
    );
    await completeAction(live.id, billedMicroUsd, {
      meteredJobId: meterJobId ?? null,
    });
  } catch (err) {
    console.error(
      "[url-extraction] ingest action completion failed:",
      err instanceof Error ? err.message : err
    );
  }
}

async function cancelIngestAction(group: string): Promise<void> {
  try {
    await rawQuery(
      `UPDATE actions SET status = 'cancelled', updated_at = now()
        WHERE exclusion_group = $1 AND status IN ('open', 'running')`,
      [group]
    );
  } catch (err) {
    console.error(
      "[url-extraction] ingest action cancellation failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Settle the source_ingest cap charge behind this extraction, if there is
 * one (governed intake links the charge to the contribution; direct service
 * submissions were never charged). The submitter pays the metered cost of
 * extraction + matching, never more than the cap.
 */
async function settleSourceIngestCharge(
  sourceId: string,
  billedMicroUsd: number
): Promise<void> {
  try {
    // Every charge behind this source settles (two users can propose the
    // same URL; only one extraction runs, but each paid a cap). The first
    // charge pays the metered cost; later ones settle in full.
    const charges = await rawQuery<{
      id: string;
      user_id: string;
      amount_micro_usd: number;
      contribution_id: string;
    }>(
      `SELECT ol.id, ol.user_id, ol.amount_micro_usd, ol.contribution_id
         FROM owl_ledger ol
         JOIN contributions ct ON ct.id = ol.contribution_id
        WHERE ol.reason = 'charge' AND ol.op = 'source_ingest'
          AND ct.source_id = $1
        ORDER BY ol.created_at ASC`,
      [sourceId]
    );
    for (const [i, charge] of charges.entries()) {
      await settleMeteredCharge({
        userId: charge.user_id,
        capMicroUsd: -Number(charge.amount_micro_usd),
        meteredMicroUsd: i === 0 ? billedMicroUsd : 0,
        settleKey: charge.id,
        op: "source_ingest",
        contributionId: charge.contribution_id,
      });
    }
  } catch (err) {
    // A missed settlement favours the platform; never fail the extraction.
    console.error(
      "[url-extraction] source_ingest settlement failed:",
      err instanceof Error ? err.message : err
    );
  }
}

async function processUrlExtraction(
  message: UrlExtractionMessage
): Promise<void> {
  const db = getDb();

  try {
    await updateJob(message.jobId, { status: "processing" });

    // Get the source
    const [source] = await db
      .select()
      .from(sources)
      .where(eq(sources.id, message.sourceId))
      .limit(1);

    if (!source) {
      await updateJob(message.jobId, {
        status: "failed",
        error: `Source not found: ${message.sourceId}`,
      });
      return;
    }

    // Fetch content if not already available
    let content = source.rawContent;
    let fetchedNow = false;
    if (!content) {
      content = await fetchUrlContent(message.url);
      await db
        .update(sources)
        .set({ rawContent: content, contentHash: sourceContentHash(content) })
        .where(eq(sources.id, source.id));
      fetchedNow = true;
    }
    // The facts a source page shows without judgment (#507): authors,
    // publisher, date, DOI, an archived copy. Once per source, and again
    // when the text arrived just now, since a lookup made before it had no
    // page to read. A failure loses the facts, never the extraction.
    await refreshSourceFactsOnce(source.id, { newText: fetchedNow });

    // Extract claims
    // No claim cap: how many reusable propositions a document turns on is a
    // property of the document. The extractor's own claim bar decides what
    // qualifies, and the ledger decides how much of it anyone pays to assess.
    // A scoped ingest reads the whole document for one subject and proposes
    // only the claims bearing on it (ingest-focus-service.ts).
    const focus = normalizeFocus(message.focus);
    let documentProblem: DocumentProblem | null = null;
    let documentKind: SourceKind | null = null;
    const extracted = await extractClaims({
      content,
      // The prompt's noun for what is being read: the source's kind where
      // one is recorded, else the prompt's own default ("document").
      ...(GENERIC_SOURCE_KINDS.has(source.sourceType)
        ? {}
        : { sourceType: source.sourceType.replace(/_/g, " ") }),
      additionalContext: source.title,
      ...(focus ? { focus } : {}),
      onDocumentProblem: (p) => {
        documentProblem = p;
      },
      onDocumentKind: (k) => {
        documentKind = k;
      },
      // Where the document reasons about each claim (#541).
      recordArguments: true,
    });

    let claimsCreated = 0;
    let claimsMatched = 0;
    let claimsDecidedOnRetry = 0;
    let curationRequests = 0;
    let instancesAlreadyRecorded = 0;

    const matchFor = (claim: ExtractedClaim, proposedKind: NodeKind) =>
      // The agentic Matcher is the single decider of claim identity: it does
      // its own (multi-framing, ungated) search, so we no longer pre-fetch
      // candidates here (#25).
      matchClaim({
        extractedText: claim.verbatim_text,
        proposedCanonical: claim.proposed_canonical_form,
        kind: proposedKind,
        // The passage around the span (#721): the stance this instance
        // records is judged from context (§4).
        context: claim.context,
        // The Matcher receives the domains its caller knows: here, the
        // Extractor's prior for this claim.
        domains: sanitizeDomains(claim.domains),
      });

    // Where the document reasons about each claim (#541): each passage is
    // matched within the claim's arguments, and one that matches none waits
    // on the claim for its Steward. A failure here never fails the reading.
    let argumentPassagesPlaced = 0;
    let argumentPassagesUnplaced = 0;
    const placeArgumentPassages = async (
      claim: ExtractedClaim,
      claimId: string,
      nodeKind: NodeKind,
      sourceStance: string
    ): Promise<void> => {
      if (!claim.argument_passages?.length) return;
      try {
        const [node] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [claimId]);
        const counts = await recordArgumentPassages({
          claimId,
          claimText: node?.text ?? claim.proposed_canonical_form,
          claimKind: nodeKind,
          sourceId: source.id,
          sourceStance,
          passages: claim.argument_passages,
        });
        argumentPassagesPlaced += counts.placed;
        argumentPassagesUnplaced += counts.unplaced;
      } catch (err) {
        console.error(
          "[url-extraction] argument passages not recorded:",
          err instanceof Error ? err.message : err
        );
      }
    };

    /** Link or mint the node a decided proposal names, and record this source's instance of it. */
    const recordProposal = async (
      claim: ExtractedClaim,
      proposedKind: NodeKind,
      matchResult: MatchDecision
    ): Promise<void> => {
      let claimId: string;
      // The node's kind decides the instance's stance (§4, §7a): a figure is
      // a statement of its quantity's value, and a question is asked.
      let nodeKind: NodeKind = proposedKind;

      if (matchResult.is_match && matchResult.matched_claim_id) {
        // Link to existing claim
        claimId = matchResult.matched_claim_id;
        const [matched] = await rawQuery<{ kind: NodeKind }>(`SELECT kind FROM claims WHERE id = $1`, [claimId]);
        nodeKind = matched?.kind ?? "claim";
        claimsMatched++;
      } else {
        nodeKind = matchResult.kind ?? proposedKind;
        // Create new claim. Embed the final canonical form (which the matcher
        // may have reworded) so the stored vector matches the stored text.
        const canonicalText =
          matchResult.new_canonical_form ?? claim.proposed_canonical_form;
        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(canonicalText);
        } catch {
          // Continue without embedding: the Matcher's keyword search still
          // reaches the node (#725).
        }

        // The extractor's importance is a provisional prior (salience in the
        // document + reach in the discourse); it seeds the Steward work-queue
        // ordering and the Steward overrides it with a considered, dependency-
        // aware judgment (#67).
        const importance = clampUnit(claim.importance);
        // Contestation prior recorded alongside (#172 phase 1): the
        // liveness half of the importance formula, stored unfused so the
        // eventual stakes/yield split has data. Read by nothing yet.
        const contestation = clampUnit(claim.contestation);

        // The Extractor's domain prior (docs/mathematics.md §3.4): the tags
        // that select which domain skills the claim's Steward carries.
        // Filtered to the closed list of domains that have a skill; the
        // Steward's set_claim_domains supersedes it.
        const domains = sanitizeDomains(claim.domains);

        const [newClaim] = await db
          .insert(claims)
          .values({
            text: canonicalText,
            kind: nodeKind,
            claimType: claim.claim_type,
            ...(importance !== undefined ? { importance } : {}),
            ...(contestation !== undefined ? { contestation } : {}),
            ...(domains.length > 0 ? { domains, domainsSource: "extractor" } : {}),
            embedding,
            pipelineEpoch: loadConfig().pipelineEpoch,
            createdBy: "extractor",
            // The Matcher's reason for the form's direction (#360): chosen
            // on the proposition's terms, not this source's, so the first
            // source to mention a claim does not set the node's polarity.
            canonicalDirectionNote: cleanNote(matchResult.direction_note),
          })
          .returning();

        claimId = newClaim!.id;
        claimsCreated++;

        // Onboard the new claim (the Steward will structure + assess it)
        await enqueueClaimPipeline({
          claimId,
          jobId: message.jobId,
        });

        // No Curator sweep for every new claim. This path used to fire one
        // (`neighborhood_sweep`) for every newly created claim (#55); the
        // first live epoch measured 122 sweeps on the frontier model, ~13
        // owls, and zero writes, because the sweep only fired on claims the
        // Matcher had just searched for and declared novel.
        //
        // What reaches the Curator from here is the Matcher's own judgment
        // on a specific pair (#738): a node it minted on balance, naming the
        // near-miss a Curator should check. The request waits on the ledger
        // like a Steward's escalation; the mandates decide whether it is
        // worth a run.
        curationRequests += await requestNearMissCuration(claimId, matchResult);
      }

      // Create instance linking claim to source. stance records whether this
      // source asserts the canonical claim or its negation, judged against
      // the canonical direction rather than assumed: a new claim's first
      // instance can be "denies" (#360). A claim merged with its negation
      // thus still shows which side each source takes. The
      // extractor's proposed canonical form rides along: on a new claim the
      // Matcher may have reworded it (claims.text is the Matcher's), on a
      // match it is the wording this source would have given the existing
      // claim — either way the authorship question becomes a query.
      // A source read again (for another focus, or whole) can propose a
      // claim an earlier reading already linked here: one instance per
      // claim and source, so the second reading adds nothing for it.
      const [already] = await rawQuery<{ id: string; stance: string }>(
        `SELECT id, stance FROM claim_instances
          WHERE claim_id = $1 AND source_id = $2 AND detached_at IS NULL
          LIMIT 1`,
        [claimId, source.id]
      );
      if (already) {
        instancesAlreadyRecorded++;
        await placeArgumentPassages(claim, claimId, nodeKind, already.stance);
        return;
      }
      const stance = instanceStanceFor(proposedKind, nodeKind, matchResult.instance_stance);
      await db.insert(claimInstances).values({
        claimId,
        sourceId: source.id,
        verbatimText: claim.verbatim_text,
        proposedCanonicalForm: claim.proposed_canonical_form,
        context: claim.context,
        stance,
        confidence: claim.confidence,
        // What the source states, read while the document was in hand (§4,
        // #744): a figure on an instance of a quantity, a probability on an
        // instance of a claim.
        ...statedFigures(claim, nodeKind, stance),
      });
      await placeArgumentPassages(claim, claimId, nodeKind, stance);
    };

    // Proposals the Matcher reached no verdict on (#419). A claim minted from
    // a non-decision would be a duplicate the Curator has to find, so none
    // is minted; but nor is the proposal dropped (#738). Each gets a second,
    // fresh Matcher run once the rest of the document is done (most are a
    // run that spent its budget mid-search), and any still undecided are
    // kept on the source's extraction record, where they are shown and
    // where they stop the reading from counting as covering the document,
    // so the next ingest of it reads and matches them again.
    const deferred: Array<{ claim: ExtractedClaim; kind: NodeKind }> = [];
    const undecided: UndecidedProposal[] = [];

    for (const claim of extracted) {
      const proposedKind = NODE_KIND_SET.has(claim.kind ?? "") ? (claim.kind as NodeKind) : "claim";
      const matchResult = await matchFor(claim, proposedKind);
      if (matchResult.outcome === "undecided") {
        deferred.push({ claim, kind: proposedKind });
        continue;
      }
      await recordProposal(claim, proposedKind, matchResult);
    }

    for (const { claim, kind } of deferred) {
      const matchResult = await matchFor(claim, kind);
      if (matchResult.outcome === "undecided") {
        undecided.push({
          verbatim_text: claim.verbatim_text,
          proposed_canonical_form: claim.proposed_canonical_form,
          kind,
          context: claim.context,
        });
        continue;
      }
      claimsDecidedOnRetry++;
      await recordProposal(claim, kind, matchResult);
    }

    // A document the Extractor could not read (#740) is recorded as such.
    // Unreadable or the wrong page: the cached text is dropped, so the next
    // ingest fetches the document afresh rather than re-reading the same
    // paywall. Injected instructions: the text is kept as the evidence, and
    // Audit is asked to look (the constitution assigns injected instructions
    // to Audit's watch).
    const problem = documentProblem as DocumentProblem | null;
    if (problem) {
      await handleDocumentProblem(source.id, message.url, problem);
    }
    // What kind of document it was, as the Extractor that read it whole
    // says: kept on the source, replacing a kind recorded by an agent that
    // only cited it. Losing it never loses the extraction.
    const kind = documentKind as SourceKind | null;
    if (!problem && kind) {
      await recordSourceKind(source.id, kind, { read: true }).catch((err) =>
        console.error(`[url-extraction] recording the source kind failed for ${source.id}:`, err)
      );
    }

    // Divide the document by its own structure and anchor the instances
    // just recorded to their passages (#507). Never fails the extraction.
    await segmentSourceOnce(source.id);

    // What this reading was for, on the source's record: the whole document,
    // or a focus. Never fails the extraction.
    await recordExtraction({
      sourceId: source.id,
      focus,
      grantId: message.grantId ?? null,
      jobId: message.jobId,
      claimsExtracted: extracted.length,
      claimsCreated,
      claimsMatched,
      undecided,
      documentProblem: problem,
    }).catch((err) =>
      console.error(
        "[url-extraction] extraction record failed:",
        err instanceof Error ? err.message : err
      )
    );

    await updateJob(message.jobId, {
      status: "completed",
      result: {
        claims_extracted: extracted.length,
        claims_created: claimsCreated,
        claims_matched: claimsMatched,
        // Proposals the Matcher decided only on its second run, and those it
        // never decided, which are kept on the source's extraction record
        // (#738).
        claims_decided_on_retry: claimsDecidedOnRetry,
        claims_undecided: undecided.length,
        // Curation requests from the Matcher's curator_review (#738).
        curation_requests: curationRequests,
        // Matched to a claim this source already carries an instance of.
        instances_already_recorded: instancesAlreadyRecorded,
        // Argument passages (#541): placed on an argument, or left on the
        // claim for its Steward.
        argument_passages_placed: argumentPassagesPlaced,
        argument_passages_unplaced: argumentPassagesUnplaced,
        ...(problem ? { document_problem: problem } : {}),
        ...(focus ? { focus } : {}),
      },
    });
  } catch (err) {
    await updateJob(message.jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Curation requests for a node the Matcher minted on balance (#738), only
 * when it wrote a curator_review: a suspected duplicate (the same node, or
 * its negation) of a near-miss, carrying the review and its relationship
 * notes. One per near-miss the review names by id (#955); a review that
 * names none of its alternatives is about all of them, as before. A near-miss
 * the Matcher weighed but did not name is not raised, since the officers
 * would read it as suspected when the Matcher said nothing about it. Never
 * fails the extraction. Returns how many were recorded.
 */
export async function requestNearMissCuration(
  newClaimId: string,
  decision: Pick<MatchDecision, "curator_review" | "relationship_notes" | "alternative_matches">
): Promise<number> {
  const review = cleanNote(decision.curator_review);
  if (!review || decision.alternative_matches.length === 0) return 0;
  const notes = cleanNote(decision.relationship_notes);
  const concern = notes ? `${review}\n\nThe Matcher's notes on the near-misses: ${notes}` : review;
  const named = decision.alternative_matches.filter((id) => review.toLowerCase().includes(id.toLowerCase()));
  const suspects = named.length > 0 ? named : decision.alternative_matches;
  let recorded = 0;
  for (const other of suspects) {
    try {
      const result = await requestCuration({
        anchorClaimId: newClaimId,
        otherClaimId: other,
        source: "matcher",
        defect: "duplicate",
        concern,
      });
      if (result.ok && !result.repeat) recorded++;
    } catch (err) {
      console.error(
        "[url-extraction] curation request failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
  return recorded;
}

/**
 * The figures a source states, for its instance (§4, #744): a stated value
 * on an instance of a quantity, a stated probability on an instance of a
 * claim. The Extractor gives the probability for the proposition as it
 * proposed it, in the direction the discourse poses it; when the Matcher
 * records this source as denying the node's form, the probability the
 * source gives the node's form is its complement.
 */
export function statedFigures(
  claim: Pick<ExtractedClaim, "stated_value" | "stated_probability">,
  nodeKind: NodeKind,
  stance: string
): { statedEstimate?: unknown; statedProbability?: number } {
  const out: { statedEstimate?: unknown; statedProbability?: number } = {};
  if (nodeKind === "quantity" && claim.stated_value) out.statedEstimate = claim.stated_value;
  const p = claim.stated_probability;
  if (nodeKind === "claim" && typeof p === "number" && p >= 0 && p <= 1) {
    out.statedProbability = stance === "denies" ? 1 - p : p;
  }
  return out;
}

/**
 * What follows from the Extractor's report that the document is not what it
 * should be (#740). Never fails the extraction.
 */
async function handleDocumentProblem(
  sourceId: string,
  url: string,
  problem: DocumentProblem
): Promise<void> {
  try {
    if (problem.kind === "injected_instructions") {
      await requestAudit({
        auditType: "anomaly_investigation",
        triggeredBy: "injected_source",
        dedupeKey: `injected-source:${sourceId}`,
        context:
          `The Extractor reported text addressed to the graph's agents rather than to ` +
          `the readers of source ${sourceId} (${url}). Its note: ${problem.note}\n\n` +
          `Check what the text tried to do, whether any agent acted on it, and ` +
          `whether claims or instances from this source need attention.`,
      });
    } else {
      await rawQuery(`UPDATE sources SET raw_content = NULL, content_hash = NULL WHERE id = $1`, [sourceId]);
    }
  } catch (err) {
    console.error(
      "[url-extraction] document problem handling failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/** A trimmed non-empty string, else undefined (the column stays NULL). */
function cleanNote(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Coerce an extractor unit-interval score to [0, 1], or undefined (→ DB default) if absent/invalid. */
function clampUnit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

async function fetchUrlContent(url: string): Promise<string> {
  // SSRF-guarded: ingest URLs come from user proposals, grant plans, and
  // the review agent's own web research — every hop must be public
  // (src/services/url-guard.ts). A refused URL fails the job like any
  // other unfetchable source.
  return fetchPublicUrl(url);
}
