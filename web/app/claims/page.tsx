import Link from "next/link";
import { loadClaims, loadOpenPrizes, loadTerritories } from "@/lib/data";
import { claimTypeMeta, DEFINED_IN, IMPORTANCE_FLOORS, importanceFloorMin } from "@/lib/ontology";
import type { ImportanceFloor } from "@/lib/ontology";
import { StatusBadge, Unassessed, Importance } from "@/components/Assessment";
import { Term } from "@/components/Term";
import { ClaimsControls } from "@/components/ClaimsControls";
import { Territories, RecentClaims, OpenPrizes } from "@/components/Territories";
import { ProposeClaim } from "@/components/ProposeClaim";
import { PrizeChip } from "@/components/claim/PrizeChip";
import { MachineChecked } from "@/components/claim/MachineChecked";
import type { AssessedFilter, ClaimType } from "@/lib/types";

// How many newest claims the demoted "recently added" strip shows in the
// overview. Small on purpose: it is orientation, not the feed.
const RECENT_STRIP = 8;
// How many open prizes the strip under the territories shows (§8.3).
const PRIZE_STRIP = 8;

export default async function ClaimsIndex({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; assessed?: string; imp?: string; prizes?: string; type?: string }>;
}) {
  const { q, assessed: assessedRaw, imp: impRaw, prizes: prizesRaw, type: typeRaw } = await searchParams;

  // The browse feed defaults to assessed-only (the unassessed long tail is mostly
  // queued stubs). "all" and "unassessed" are opt-in; anything else is the default.
  const assessed: AssessedFilter =
    assessedRaw === "all" || assessedRaw === "unassessed" ? assessedRaw : "assessed";
  const impFloor: ImportanceFloor =
    IMPORTANCE_FLOORS.find((f) => f.value === impRaw)?.value ?? "any";
  const minImportance = importanceFloorMin(impFloor);
  // Only claims with a live prize (docs/mathematics.md §8.3), and a claim-type
  // restriction (the listing-backed territory's front door); an unknown type
  // is ignored rather than passed through.
  const withPrizes = prizesRaw === "1" || prizesRaw === "true";
  const claimType: ClaimType | undefined =
    typeRaw && claimTypeMeta(typeRaw) ? (typeRaw as ClaimType) : undefined;
  const filtersActive = assessed !== "assessed" || minImportance > 0 || withPrizes || !!claimType;

  // Before any search or filter, /claims shows what the graph CONTAINS — a few
  // curated investigations — not a stack of newest claims that reads like search
  // results the user never asked for (#206). A query or an active filter switches
  // to the result list, unchanged.
  const overview = !q && !filtersActive;

  if (overview) {
    const [territories, recent, prizes] = await Promise.all([
      loadTerritories(),
      loadClaims(undefined, { assessed, minImportance }),
      loadOpenPrizes(PRIZE_STRIP),
    ]);

    return (
      <div className="col-wide">
        <p className="sc" style={{ marginBottom: ".5rem" }}>Browse</p>
        <h1>Claims</h1>
        <p className="lede" style={{ fontSize: "1.05rem" }}>
          Claimspace is every claim the graph holds, each decomposed to its bedrock and weighed
          against the evidence. Right now it gathers around a few investigations. Search it by
          meaning, or start from one below.
        </p>

        <p className="sc" style={{ marginTop: "-0.4rem", marginBottom: "1.4rem" }}>
          {territories.length} investigations · growing as claims are ingested
        </p>

        <ClaimsControls q="" assessed={assessed} imp={impFloor} />

        <Territories territories={territories} />

        <OpenPrizes items={prizes.prizes.slice(0, PRIZE_STRIP)} />

        <RecentClaims items={recent.results.slice(0, RECENT_STRIP)} />

        {/* provenance: these clusters are the FLF Epistack case studies (#78) */}
        <p
          style={{
            marginTop: "2.4rem",
            fontFamily: "var(--sans)",
            fontSize: ".82rem",
            color: "var(--muted)",
          }}
        >
          These investigations began as the case studies in the{" "}
          <Link href="/flf">FLF Epistack competition</Link>: the origin of SARS-CoV-2, the safety
          of micro black holes, and eggs and cardiovascular risk.
        </p>

        <ProposeClaim />
      </div>
    );
  }

  const { results: claims, source } = await loadClaims(q, {
    assessed, minImportance, withPrizes, claimType,
  });

  return (
    <div className="col-wide">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Browse</p>
      <h1>Claims</h1>
      <p className="lede" style={{ fontSize: "1.05rem" }}>
        Search the graph by meaning. Each result carries its current verdict; open one to
        see its decomposition, provenance, and the reasoning behind the assessment.
      </p>

      <ClaimsControls
        q={q ?? ""}
        assessed={assessed}
        imp={impFloor}
        prizes={withPrizes}
        type={claimType}
        resultCount={claims.length}
      />

      {source === "fixture" && (
        <p style={{ marginTop: "-0.6rem", marginBottom: "1.4rem" }}>
          <span className="tag" title="The API is not connected; showing design fixtures.">
            fixture data
          </span>
        </p>
      )}

      {claims.length === 0 ? (
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)" }}>
          {filtersActive
            ? "No claims match these filters. Try widening the importance band or the assessment filter."
            : q
              ? "No claims match that search. If it is a real claim the graph should hold, propose it below."
              : "No assessed claims yet."}
        </p>
      ) : (
        <div className="cards">
          {claims.map((c) => {
            const kind = claimTypeMeta(c.claim_type);
            const claimHref = `/claims/${c.id}`;
            return (
              // A div with a stretched link, not a Link: the footer's ontology
              // terms are themselves clickable (#198), and interactive elements
              // may not nest inside an anchor. Each term is given the claim's own
              // href (`linkTo`) so a click opens the claim like the rest of the
              // card, while hover still reveals the definition (#247).
              <div className="card" key={c.id}>
                <Link href={claimHref} className="card-link">
                  <div className="card-claim">{c.text}</div>
                </Link>
                <div className="card-foot">
                  {c.assessment_status ? <StatusBadge status={c.assessment_status} linkTo={claimHref} /> : <Unassessed linkTo={claimHref} />}
                  {kind ? (
                    <Term gloss={kind.gloss} href={DEFINED_IN.claimType} linkTo={claimHref} className="tag kind">
                      {kind.label}
                    </Term>
                  ) : (
                    <span className="tag kind">{c.claim_type?.replace(/_/g, " ")}</span>
                  )}
                  {c.state !== "active" && <span className="tag">{c.state.replace(/_/g, " ")}</span>}
                  {/* mathematics (§8.3): the prize chip after the type tag
                      and the small machine-checked badge; the importance
                      figure stays alone at the far right */}
                  {c.prize_micro_usd != null && <PrizeChip micro={c.prize_micro_usd} linkTo={claimHref} />}
                  {c.checked && <MachineChecked kind={c.checked} size="sm" linkTo={claimHref} />}
                  <span style={{ marginLeft: "auto" }}>
                    {/* No numbers in this corner. Verdict confidence sat here
                        as a bare figure and read as P(claim true) (#160); the
                        raw cosine then did the same, a muted number fused with
                        a muted meter. Rank order already carries relevance —
                        the exact score meant nothing to readers. */}
                    <Importance value={c.importance} linkTo={claimHref} />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* the "I know something the graph is missing" entry (#174); claim-scoped
          contributions live on each claim's own page */}
      <ProposeClaim searchQuery={claims.length === 0 ? q : undefined} />
    </div>
  );
}
