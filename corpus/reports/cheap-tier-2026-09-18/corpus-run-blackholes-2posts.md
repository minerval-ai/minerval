# Corpus run report — blackholes

_generated 2026-09-18T21:33:45.144Z · database `episteme_corpus`_

Read this alongside [`corpus/RUBRIC.md`](../../corpus/RUBRIC.md). Each section notes the
rubric dimension it serves. Nothing here is a verdict — it's organized raw material for
your judgment. Log anything that looks wrong in the rubric's Field Notes (section I).

## 1. Counts — rubric A, C, E

| metric | value |
|---|---|
| sources ingested | 25 |
| claims (total) | 32 |
| &nbsp;&nbsp;by creator | claim_steward 21, extractor 11 |
| top-level claims (≥1 instance) | 16 |
| instances (extracted mentions) | 31 |
| **dedup ratio** (instances ÷ top-level claims) | **1.94** |
| relationships | 28 (supports 11, contradicts 9, requires 5, assumes 3) |
| arguments | 9 |
| decomposition status | complete 29, pending 3 |
| claim types | empirical_derived 23, empirical_verifiable 8, causal 1 |
| current assessments | contested 4, supported 1 |

> A dedup ratio near 1.0 means almost nothing collapsed across posts (possible
> fragmentation, rubric C); a very high ratio on few claims may signal over-merging.

## 2. Per-source — rubric A

| source | instances | distinct claims |
|---|--:|--:|
| The safety of the LHC | 7 | 7 |
| https://ar5iv.labs.arxiv.org/html/hep-th/0402145 | 0 | 0 |
| Direct detection of primordial black hole relics as dark matter | 1 | 1 |
| https://doi.org/10.1103/PhysRevD.110.056029 | 1 | 1 |
| https://arxiv.org/abs/2006.00011 | 1 | 1 |
| https://doi.org/10.1103/PhysRevD.110.036004 | 1 | 1 |
| https://export.arxiv.org/pdf/2608.12139 | 1 | 1 |
| https://arxiv.org/html/2503.21005v1 | 2 | 2 |
| https://inspirehep.net/literature/2904988 | 1 | 1 |
| https://arxiv.org/html/2405.13117v1 | 0 | 0 |
| https://arxiv.org/abs/2608.12139 | 0 | 0 |
| https://arxiv.org/abs/2402.14069 | 1 | 1 |
| https://arxiv.org/abs/2503.21005 | 1 | 1 |
| https://arxiv.org/html/2503.21005v2 | 0 | 0 |
| BBN constraints on primordial black holes with a continuous memory-bu… | 2 | 2 |
| https://export.arxiv.org/pdf/2503.21740 | 1 | 1 |
| https://ar5iv.labs.arxiv.org/html/2503.21005 | 0 | 0 |
| https://ar5iv.labs.arxiv.org/html/2503.21740 | 0 | 0 |
| https://doi.org/10.1103/jnzl-2k57 | 0 | 0 |
| New mass window for primordial black holes as dark matter from the me… | 1 | 1 |
| https://arxiv.org/abs/2503.21740 | 1 | 1 |
| https://arxiv.org/abs/2404.16815 | 1 | 1 |
| https://arxiv.org/abs/2606.04707 | 1 | 1 |
| https://arxiv.org/abs/2506.13861 | 1 | 1 |
| Astrophysical implications of hypothetical stable TeV-scale black hol… | 6 | 6 |

## 3. Canonical claims and what collapsed into them — rubric B, C

Every top-level claim with its instances. This is the core disambiguation view:
read the instances under each claim and ask whether they are really the same
proposition (good merge) or were wrongly fused (over-merge). Multi-source claims
are where cross-document canonicalization actually happened.

### 6× — The memory burden effect halts black hole evaporation partway, stabilizing the hole.
_empirical_derived · contested · created_by claim_steward · **6 sources**_
- _https://arxiv.org/abs/2006.00011_: "Applied to black holes, this predicts a metamorphosis, including a drastic deviation from Hawking evaporation, at the latest after losing half of the mass."
- _https://arxiv.org/html/2503.21005v1_: "Unless memory burden sets in almost instantaneously in a black hole's evolution, effectively preventing any Hawking radiation from being produced, we find that PBHs in this mass range cannot make up a significant fracti…"
- _https://doi.org/10.1103/PhysRevD.110.03…_: "Quantum effects such as memory burden take the evaporation process out of the semiclassical regime latest by the time the black hole loses half of its mass. What happens beyond this time is currently not known. However,…"
- _https://doi.org/10.1103/PhysRevD.110.05…_: "The memory burden effect suppresses a further decay of a black hole, the latest, after it has emitted about half of its initial mass."
- _https://export.arxiv.org/pdf/2608.12139_: "We have exhibited models in which the mechanisms that are supposed to be operative in memory burden constraints on black hole evaporation are present, but do not change naive predictions for the evaporation rate."
- _https://inspirehep.net/literature/29049…_: "We show for the first time that this is true only if the transition from the semiclassical phase of a black hole to its memory-burdened phase is practically instantaneous."

### 4× — The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-burdened transition
_empirical_derived · contested · created_by claim_steward · **4 sources**_
- _https://arxiv.org/abs/2404.16815_: "What happens beyond this time is currently not known. However, theoretical evidence based on prototype models indicates that the evaporation slows down, thereby extending the lifetime of a black hole."
- _https://arxiv.org/abs/2503.21740_: "As key novelty of this work, we shall now present different estimates for the transition to MB. Physically, the transition period defines an intermediate state in which while master mode is affected, the interaction rat…"
- _https://arxiv.org/abs/2506.13861_: "Obviously, the value of δ in the transitioning phase is not known and therefore ought to be left arbitrary for the purpose of phenomenological studies."
- _https://arxiv.org/abs/2606.04707_: "No exact mass-evolution solution is known once memory burden builds up continuously, so this step is explicitly phenomenological."

### 4× — The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous.
_empirical_derived · contested · created_by claim_steward · **4 sources**_
- _BBN constraints on primordial black hol…_: "Existing cosmological studies often model the onset of this phase as an instantaneous transition between semi-classical and burden-dominated evaporation. We instead treat the crossover as continuous and compare additive…"
- _New mass window for primordial black ho…_: "Quantum effects such as memory burden take the evaporation process out of the semiclassical regime latest by the time the black hole loses half of its mass. What happens beyond this time is currently not known. However,…"
- _https://arxiv.org/html/2503.21005v1_: "A central point of this letter is that this conclusion is highly sensitive to the instantaneous nature of the transition between the semi-classical and memory-burdened phases. To allow for a more continuous and realisti…"
- _https://export.arxiv.org/pdf/2503.21740_: "We show that the smooth transition from semi-classical evaporation to the memory-burdened phase [changes] the abundance of small PBHs. The most stringent constraints come from present-day fluxes of astrophysical particl…"

### 3× — Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to constitute all of the dark matter
_empirical_derived · contested · created_by claim_steward · **3 sources**_
- _BBN constraints on primordial black hol…_: "For $10^{5}\,\mathrm{g}\lesssim M_{i}\lesssim 10^{10}\,\mathrm{g}$ , the additive case can permit $f_{\mathrm{PBH},0}\sim 10^{-1}$ where the multiplicative case gives $f_{\mathrm{PBH},0}\lesssim 10^{-2}$ ."
- _https://arxiv.org/abs/2402.14069_: "We show that previous constraints are largely relaxed when the PBH lifetime is extended, making it possible for PBHs to constitute all of DM in previously excluded mass ranges. In particular, this is the case for PBHs l…"
- _https://arxiv.org/abs/2503.21005_: "We show for the first time that this is true only if the transition from the semi-classical phase of a black hole to its memory-burdened phase is practically instantaneous. If this transition is instead more continuous,…"

### 3× — Microscopic black holes evaporate essentially instantly through Hawking radiation.
_empirical_derived · supported · created_by extractor · **3 sources**_
- _Astrophysical implications of hypotheti…_: "the strong theoretical expectation that any micro black hole evaporates essentially instantly via Hawking radiation"
- _Direct detection of primordial black ho…_: "Such small black holes are expected to be unstable due to Hawking radiation: they should completely evaporate within the lifetime of the universe."
- _The safety of the LHC_: "a microscopic black hole would lose mass faster than it could gain it and would evaporate essentially instantly"

### 1× — Black holes emit Hawking radiation.
_empirical_verifiable · unassessed · created_by extractor_
- _The safety of the LHC_: "There is broad consensus among physicists on the reality of Hawking radiation, but so far no experiment has had the sensitivity required to find direct evidence for it."

### 1× — Collisions at the LHC present no danger.
_causal · unassessed · created_by extractor_
- _The safety of the LHC_: "LHC collisions present no danger and that there are no reasons for concern."

### 1× — Cosmic rays striking white dwarfs or neutron stars would produce the same black holes the LHC could produce.
_empirical_derived · unassessed · created_by extractor_
- _Astrophysical implications of hypotheti…_: "The key observation is that cosmic rays produce exactly the same black holes when they strike other bodies in the universe."

### 1× — Cosmic-ray collisions in dense stars rule out LHC production of dangerous stable black holes.
_empirical_verifiable · unassessed · created_by extractor_
- _The safety of the LHC_: "The continued existence of white dwarfs and neutron stars — and of the Earth itself — rules out the possibility that the LHC could produce a dangerous black hole."

### 1× — Cosmic-ray-produced black holes would be captured inside white dwarfs and neutron stars despite their high velocities.
_empirical_derived · unassessed · created_by extractor_
- _Astrophysical implications of hypotheti…_: "while high-velocity production is true for ordinary matter, charged black holes and black holes produced in certain configurations would be stopped inside white dwarfs and neutron stars regardless."

### 1× — Natural cosmic-ray collisions on Earth have already produced the equivalent of the LHC's entire experimental program
_empirical_verifiable · unassessed · created_by extractor_
- _The safety of the LHC_: "Over the lifetime of the Earth, nature has already conducted the equivalent of the entire LHC experimental programme about a hundred thousand times, and the planet still exists."

### 1× — Observed white dwarfs and neutron stars exclude scenarios in which stable black holes accrete fast enough to be dangerous.
_empirical_derived · unassessed · created_by extractor_
- _Astrophysical implications of hypotheti…_: "The persistence of white dwarfs and neutron stars — objects we observe in great numbers and whose ages and properties we can measure — therefore directly excludes the dangerous accretion scenarios."

### 1× — Production of TeV-scale black holes at the LHC requires extra-dimensional models.
_empirical_derived · unassessed · created_by extractor_
- _Astrophysical implications of hypotheti…_: "which requires speculative extra-dimensional models"

### 1× — The LHC can create microscopic black holes.
_empirical_derived · unassessed · created_by extractor_
- _The safety of the LHC_: "According to the Standard Model of particle physics, the LHC's energies are far too low to create black holes at all."

### 1× — The Large Hadron Collider poses no danger from microscopic black holes it could produce.
_empirical_derived · unassessed · created_by claim_steward_
- _Astrophysical implications of hypotheti…_: "we find that there is no risk of any significance whatsoever from black holes that might be produced at the LHC."

### 1× — The probability of producing strangelets decreases as collision energy increases.
_empirical_verifiable · unassessed · created_by extractor_
- _The safety of the LHC_: "the probability of producing a strangelet *decreases* as collision energy increases"

## 4. Near-duplicate canonical pairs left unmerged — rubric C

Distinct claims whose embeddings are ≥ 0.9 cosine but were NOT merged.
Each is a fragmentation candidate (should they be one claim?) — or a legitimately
distinct pair the matcher correctly kept apart. Judge per row.

_None at ≥ 0.9._

## 5. Shared subclaims (cross-parent structure) — rubric D, E

Subclaims with more than one parent — the structural overlap that lets the graph
scale. Few or none, despite heavy topical overlap, is the main "not scaling" signal.

| parents | subclaim |
|--:|---|
| 2 | If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… |
| 2 | Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… |
| 2 | The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost |
| 2 | The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. |

## 6. Decomposition trees — rubric D

Each top-level claim's decomposition (depth ≤ 4, ≤ 50 lines each).
`[shared]` marks a subclaim reused by another parent. Watch for shallow trees that
stop before bedrock, filler subclaims, and evaluation leaking into decomposition.

<details><summary>The memory burden effect halts black hole evaporation partway, stabilizing the hole.</summary>

```
—contradicts→ The memory burden effect arises in holographic space-time models of black hole evaporation.
—contradicts→ Semiclassical Hawking evaporation remains valid until a black hole approaches the Planck scale.
—supports→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared]
—contradicts→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared]
—supports→ The lifetime of a memory-burdened black hole scales as a high power of its initial entropy
—supports→ Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to constitute all of the dark ma…
  —requires→ Memory-burdened primordial black holes with initial masses between 10^4 and 10^10 grams survive to the presen…
  —requires→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared]
    —contradicts→ The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-b…
      —supports→ The memory burden papers state that black hole behavior past the memory-burden threshold is not known
      —supports→ Independent constraint analyses treat the transition-phase evaporation rate as undetermined and parameterize …
      —contradicts→ Post-2024 works present estimates of the evaporation rate in the transition region derived from the memory-bu…
      —supports→ Recent constraint analyses continue to state that no exact mass-evolution solution or transition-phase rate i…
    —supports→ In prototype saturon systems the onset of decay suppression is sharp once roughly half the information is lost
    —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared]
    —assumes→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared] ↩
    —assumes→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared] ↩
  —contradicts→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
  —contradicts→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
  —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
  —supports→ Analyses with a continuous semiclassical-to-burdened crossover tighten the BBN bounds and cap the dark matter…
—assumes→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
```

</details>

<details><summary>The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-burdened transition</summary>

```
—supports→ The memory burden papers state that black hole behavior past the memory-burden threshold is not known
—supports→ Independent constraint analyses treat the transition-phase evaporation rate as undetermined and parameterize …
—contradicts→ Post-2024 works present estimates of the evaporation rate in the transition region derived from the memory-bu…
—supports→ Recent constraint analyses continue to state that no exact mass-evolution solution or transition-phase rate i…
```

</details>

<details><summary>The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous.</summary>

```
—contradicts→ The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-b…
  —supports→ The memory burden papers state that black hole behavior past the memory-burden threshold is not known
  —supports→ Independent constraint analyses treat the transition-phase evaporation rate as undetermined and parameterize …
  —contradicts→ Post-2024 works present estimates of the evaporation rate in the transition region derived from the memory-bu…
  —supports→ Recent constraint analyses continue to state that no exact mass-evolution solution or transition-phase rate i…
—supports→ In prototype saturon systems the onset of decay suppression is sharp once roughly half the information is lost
—supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared]
—assumes→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared]
—assumes→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared]
```

</details>

<details><summary>Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to constitute all of the dark matter</summary>

```
—requires→ Memory-burdened primordial black holes with initial masses between 10^4 and 10^10 grams survive to the presen…
—requires→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared]
  —contradicts→ The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-b…
    —supports→ The memory burden papers state that black hole behavior past the memory-burden threshold is not known
    —supports→ Independent constraint analyses treat the transition-phase evaporation rate as undetermined and parameterize …
    —contradicts→ Post-2024 works present estimates of the evaporation rate in the transition region derived from the memory-bu…
    —supports→ Recent constraint analyses continue to state that no exact mass-evolution solution or transition-phase rate i…
  —supports→ In prototype saturon systems the onset of decay suppression is sharp once roughly half the information is lost
  —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared]
  —assumes→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared]
  —assumes→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared]
—contradicts→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
—contradicts→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
—supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
—supports→ Analyses with a continuous semiclassical-to-burdened crossover tighten the BBN bounds and cap the dark matter…
```

</details>

<details><summary>Microscopic black holes evaporate essentially instantly through Hawking radiation.</summary>

```
—requires→ Black holes emit Hawking radiation.
—requires→ A black hole emits thermal radiation with a temperature inversely proportional to its mass.
—requires→ A black hole's Hawking evaporation lifetime is proportional to the cube of its mass.
—contradicts→ Quantum-gravity effects near the Planck scale could halt black hole evaporation, leaving a stable remnant.
—contradicts→ The memory burden effect halts black hole evaporation partway, stabilizing the hole.
  —contradicts→ The memory burden effect arises in holographic space-time models of black hole evaporation.
  —contradicts→ Semiclassical Hawking evaporation remains valid until a black hole approaches the Planck scale.
  —supports→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared]
  —contradicts→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared]
  —supports→ The lifetime of a memory-burdened black hole scales as a high power of its initial entropy
  —supports→ Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to constitute all of the dark ma…
    —requires→ Memory-burdened primordial black holes with initial masses between 10^4 and 10^10 grams survive to the presen…
    —requires→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared]
      —contradicts→ The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-b…
        —supports→ The memory burden papers state that black hole behavior past the memory-burden threshold is not known
        —supports→ Independent constraint analyses treat the transition-phase evaporation rate as undetermined and parameterize …
        —contradicts→ Post-2024 works present estimates of the evaporation rate in the transition region derived from the memory-bu…
        —supports→ Recent constraint analyses continue to state that no exact mass-evolution solution or transition-phase rate i…
      —supports→ In prototype saturon systems the onset of decay suppression is sharp once roughly half the information is lost
      —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared]
      —assumes→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared] ↩
      —assumes→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared] ↩
    —contradicts→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
    —contradicts→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
    —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
    —supports→ Analyses with a continuous semiclassical-to-burdened crossover tighten the BBN bounds and cap the dark matter…
  —assumes→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
```

</details>

<details><summary>Black holes emit Hawking radiation.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Collisions at the LHC present no danger.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Cosmic rays striking white dwarfs or neutron stars would produce the same black holes the LHC could produce.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Cosmic-ray collisions in dense stars rule out LHC production of dangerous stable black holes.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Cosmic-ray-produced black holes would be captured inside white dwarfs and neutron stars despite their high velocities.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Natural cosmic-ray collisions on Earth have already produced the equivalent of the LHC's entire experimental program</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Observed white dwarfs and neutron stars exclude scenarios in which stable black holes accrete fast enough to be dangerous.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>Production of TeV-scale black holes at the LHC requires extra-dimensional models.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>The LHC can create microscopic black holes.</summary>

```
(atomic — no decomposition)
```

</details>

<details><summary>The Large Hadron Collider poses no danger from microscopic black holes it could produce.</summary>

```
—supports→ Microscopic black holes evaporate essentially instantly through Hawking radiation.
  —requires→ Black holes emit Hawking radiation.
  —requires→ A black hole emits thermal radiation with a temperature inversely proportional to its mass.
  —requires→ A black hole's Hawking evaporation lifetime is proportional to the cube of its mass.
  —contradicts→ Quantum-gravity effects near the Planck scale could halt black hole evaporation, leaving a stable remnant.
  —contradicts→ The memory burden effect halts black hole evaporation partway, stabilizing the hole.
    —contradicts→ The memory burden effect arises in holographic space-time models of black hole evaporation.
    —contradicts→ Semiclassical Hawking evaporation remains valid until a black hole approaches the Planck scale.
    —supports→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared]
    —contradicts→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared]
    —supports→ The lifetime of a memory-burdened black hole scales as a high power of its initial entropy
    —supports→ Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to constitute all of the dark ma…
      —requires→ Memory-burdened primordial black holes with initial masses between 10^4 and 10^10 grams survive to the presen…
      —requires→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared]
        —contradicts→ The literature contains no derivation of the black hole evaporation rate across the semiclassical-to-memory-b…
        —supports→ In prototype saturon systems the onset of decay suppression is sharp once roughly half the information is lost
        —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared]
        —assumes→ Semiclassical Hawking evaporation is blocked already after a black hole has radiated half of its entropy plus… [shared] ↩
        —assumes→ The memory burden effect suppresses the decay of any saturon once roughly half of its information is lost [shared] ↩
      —contradicts→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
      —contradicts→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
      —supports→ If the transition to memory-burdened evaporation is continuous, BBN and recombination rule out primordial bla… [shared] ↩
      —supports→ Analyses with a continuous semiclassical-to-burdened crossover tighten the BBN bounds and cap the dark matter…
    —assumes→ The transition from semiclassical to memory-burdened black hole evaporation is practically instantaneous. [shared] ↩
```

</details>

<details><summary>The probability of producing strangelets decreases as collision energy increases.</summary>

```
(atomic — no decomposition)
```

</details>

## 7. Assessment — rubric F

Status distribution: contested 4, supported 1.

Top-level claims with **no current assessment** (11) — note the
pipeline swallows assessment errors silently, so these may be failures, not skips:

- Black holes emit Hawking radiation.
- Collisions at the LHC present no danger.
- Cosmic rays striking white dwarfs or neutron stars would produce the same black holes the LHC could produce.
- Cosmic-ray collisions in dense stars rule out LHC production of dangerous stable black holes.
- Cosmic-ray-produced black holes would be captured inside white dwarfs and neutron stars despite their high velocities.
- Natural cosmic-ray collisions on Earth have already produced the equivalent of the LHC's entire experimental program
- Observed white dwarfs and neutron stars exclude scenarios in which stable black holes accrete fast enough to be dangerous.
- Production of TeV-scale black holes at the LHC requires extra-dimensional models.
- The LHC can create microscopic black holes.
- The Large Hadron Collider poses no danger from microscopic black holes it could produce.
- The probability of producing strangelets decreases as collision energy increases.

## 8. Arguments — rubric D

| stance | argument | on claim |
|---|---|---|
| against | Continuous-transition exclusion | Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to… |
| for | Abrupt-onset survival window | Memory burden allows primordial black holes in the 10^4 to 10^10 gram window to… |
| against | Planck-scale remnant hypothesis | Microscopic black holes evaporate essentially instantly through Hawking radiati… |
| for | Semiclassical evaporation derivation | Microscopic black holes evaporate essentially instantly through Hawking radiati… |
| for | Absence of derivation in the literature | The literature contains no derivation of the black hole evaporation rate across… |
| against | Semiclassical incumbent and constraint … | The memory burden effect halts black hole evaporation partway, stabilizing the … |
| for | Saturon generalization argument | The memory burden effect halts black hole evaporation partway, stabilizing the … |
| against | Underived idealization | The transition from semiclassical to memory-burdened black hole evaporation is … |
| for | Prototype sharp-onset induction | The transition from semiclassical to memory-burdened black hole evaporation is … |

## 9. Field notes

Record anything that looks wrong — even if it fits none of A–H — in the Field Notes
section of [`corpus/RUBRIC.md`](../../corpus/RUBRIC.md). When a behavior recurs across
runs, promote it to a named failure mode there.
