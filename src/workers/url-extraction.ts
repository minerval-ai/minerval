import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sources, claims, claimInstances } from "../db/schema.js";
import { extractClaims } from "../llm/agents/extractor.js";
import { matchClaim } from "../llm/agents/matcher.js";
import { generateEmbedding } from "../services/embedding-service.js";
import { updateJob, getJobById } from "../services/job-service.js";
import { enqueueClaimPipeline, enqueueCurator } from "../services/queue-service.js";
import type { UrlExtractionMessage } from "../services/queue-service.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { settleMeteredCharge } from "../services/owl-ledger-service.js";

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
 * for the duration of the run.
 */
export async function handleUrlExtraction(
  message: UrlExtractionMessage
): Promise<void> {
  const job = await getJobById(message.jobId);
  const { billedMicroUsd } = await runWithUsageContext(
    {
      userId: job?.userId ?? null,
      apiKeyId: job?.apiKeyId ?? null,
      // A grant-funded ingestion meters against the grant's budget job so
      // the spend draws down the escrow, not the submitter's balance.
      jobId: message.meterJobId ?? message.jobId,
    },
    () => withCostMeter(() => processUrlExtraction(message))
  );
  // Escrow-funded ingestions were never cap-charged; nothing to settle.
  if (!message.meterJobId) {
    await settleSourceIngestCharge(message.sourceId, billedMicroUsd);
  }
  // If this extraction executes a ledger ingest action (the engine
  // executor left it 'running'), close it now with the real metered cost:
  // funders' pro-rata shares follow actual spend, never the estimate.
  await completeIngestAction(message.url, billedMicroUsd);
}

async function completeIngestAction(
  url: string,
  billedMicroUsd: number
): Promise<void> {
  try {
    const [running] = await rawQuery<{ id: string }>(
      `SELECT id FROM actions
        WHERE exclusion_group = $1 AND status = 'running'
        LIMIT 1`,
      [`ingest:${url}`]
    );
    if (!running) return;
    const { completeAction } = await import(
      "../services/action-service.js"
    );
    await completeAction(running.id, billedMicroUsd);
  } catch (err) {
    console.error(
      "[url-extraction] ingest action completion failed:",
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
    const [charge] = await rawQuery<{
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
        ORDER BY ol.created_at ASC
        LIMIT 1`,
      [sourceId]
    );
    if (!charge) return;
    await settleMeteredCharge({
      userId: charge.user_id,
      capMicroUsd: -Number(charge.amount_micro_usd),
      meteredMicroUsd: billedMicroUsd,
      settleKey: charge.id,
      op: "source_ingest",
      contributionId: charge.contribution_id,
    });
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
    if (!content) {
      content = await fetchUrlContent(message.url);
      await db
        .update(sources)
        .set({ rawContent: content })
        .where(eq(sources.id, source.id));
    }

    // Extract claims
    const extracted = await extractClaims({
      content,
      sourceType: source.sourceType,
      additionalContext: source.title,
      maxClaims: loadConfig().extractionMaxClaims,
    });

    let claimsCreated = 0;
    let claimsMatched = 0;
    let claimsDroppedLowConfidence = 0;

    for (const claim of extracted) {
      // Validity floor (#157 phase 3): the Extractor scores each proposition
      // with a confidence that it IS a well-formed claim; previously this was
      // stored and ignored, so a non-claim could enter the graph verbatim.
      // A low backstop, not a quality judgment (Judgment over Mechanism) —
      // well-formedness is judged upstream by intake review and downstream
      // by the Steward.
      const { extractionMinConfidence } = loadConfig();
      if (
        extractionMinConfidence > 0 &&
        typeof claim.confidence === "number" &&
        claim.confidence < extractionMinConfidence
      ) {
        claimsDroppedLowConfidence++;
        continue;
      }
      // The agentic Matcher is the single decider of claim identity: it does
      // its own (multi-framing, ungated) search, so we no longer pre-fetch
      // candidates here (#25).
      const matchResult = await matchClaim({
        extractedText: claim.original_text,
        proposedCanonical: claim.proposed_canonical_form,
      });

      let claimId: string;

      if (matchResult.is_match && matchResult.matched_claim_id) {
        // Link to existing claim
        claimId = matchResult.matched_claim_id;
        claimsMatched++;
      } else {
        // Create new claim. Embed the final canonical form (which the matcher
        // may have reworded) so the stored vector matches the stored text.
        const canonicalText =
          matchResult.new_canonical_form ?? claim.proposed_canonical_form;
        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(canonicalText);
        } catch {
          // Continue without embedding
        }

        // The extractor's importance is a provisional prior (salience in the
        // document + reach in the discourse); it seeds the Steward work-queue
        // ordering and the Steward overrides it with a considered, dependency-
        // aware judgment (#67).
        const importance = clampUnit(claim.importance);
        // Contestation prior recorded alongside (#172 phase 1): the
        // contestability half of the importance formula, stored unfused so the
        // eventual stakes/yield split has data. Read by nothing yet.
        const contestation = clampUnit(claim.contestation);

        const [newClaim] = await db
          .insert(claims)
          .values({
            text: canonicalText,
            claimType: claim.claim_type,
            ...(importance !== undefined ? { importance } : {}),
            ...(contestation !== undefined ? { contestation } : {}),
            embedding,
            pipelineEpoch: loadConfig().pipelineEpoch,
            createdBy: "extractor",
          })
          .returning();

        claimId = newClaim!.id;
        claimsCreated++;

        // Onboard the new claim (the Steward will structure + assess it)
        await enqueueClaimPipeline({
          claimId,
          jobId: message.jobId,
        });

        // Proactively sweep the new claim's neighborhood with the Curator, to
        // catch duplicates/counterparts the Matcher missed and propose cross-claim
        // edges (#55). Only for *newly created* top-level claims (matched ones are
        // already placed); sampled by curatorSweepRate and bounded by curatorMaxRuns.
        const { curatorSweepRate } = loadConfig();
        if (curatorSweepRate > 0 && Math.random() < curatorSweepRate) {
          await enqueueCurator({
            trigger: "neighborhood_sweep",
            claimId,
            context:
              "A new claim was just ingested. Sweep its neighborhood for duplicates " +
              "or counterparts the Matcher may have missed, and for related claims " +
              "that should be linked.",
          });
        }
      }

      // Create instance linking claim to source. stance records whether this
      // source asserts the canonical claim or its negation, so a claim merged
      // with its counterpart still shows which side each source takes.
      await db.insert(claimInstances).values({
        claimId,
        sourceId: source.id,
        originalText: claim.original_text,
        context: claim.context,
        stance: matchResult.instance_stance ?? "affirms",
        confidence: claim.confidence,
      });
    }

    await updateJob(message.jobId, {
      status: "completed",
      result: {
        claims_extracted: extracted.length,
        claims_created: claimsCreated,
        claims_matched: claimsMatched,
        // Never truncate silently: dropped extractions are visible in the
        // job result so a low floor misconfiguration is diagnosable.
        claims_dropped_low_confidence: claimsDroppedLowConfidence,
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

/** Coerce an extractor unit-interval score to [0, 1], or undefined (→ DB default) if absent/invalid. */
function clampUnit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

async function fetchUrlContent(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Minerval/1.0 (Knowledge Graph Indexer)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}
