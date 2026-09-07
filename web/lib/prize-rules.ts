// The official prize rules, as /prizes/rules renders them (docs/mathematics.md
// §8.10 and Appendix D). One versioned text: every bounty names the version in
// force when it was posted and every submission records the version it was
// made under, so the version constant here is the one the form submits and the
// API checks. The page computes a content hash over prizeRulesText() at build
// time; a change to any sentence changes the hash, and a change that alters
// the terms bumps the version and the effective date together. Past versions
// are retained in this file's history.

export const PRIZE_RULES_VERSION = "2026-09-04";
export const PRIZE_RULES_EFFECTIVE = "2026-09-04";

export interface PrizeRule {
  slug: string;
  title: string;
  body: string;
}

export const PRIZE_RULES: PrizeRule[] = [
  {
    slug: "sponsor",
    title: "Sponsor",
    body:
      "Minerval [legal name and postal address, entered before the first prize is posted]. Minerval is the sole obligor of every prize offered on the site. No other person holds funds for a claimant or owes a claimant anything.",
  },
  {
    slug: "what-is-offered",
    title: "What is offered",
    body:
      "A prize, in the amount shown on the claim page, for the first eligible submission that the checker accepts as a proof or disproof of the formal statement identified on that page by its version, pin, and hashes, and that the claim's steward accepts as faithful to the claim, after the challenge window closes without a successful challenge.",
  },
  {
    slug: "the-formal-statement-is-the-contract",
    title: "The formal statement is the contract",
    body:
      "What counts as a solution is the statement as published, under the named Lean toolchain and Mathlib revision, with the allowed axioms propext, Classical.choice, and Quot.sound only (Lean's standard classical foundation), and with the static policy published with these rules. If the statement is found not to say what the claim says, the prize is not owed for proving it; a claimant whose submission exposes the defect receives the defect award of ten percent of the prize, at most 500 owls, drawn from the prize; a person who exposes a defect during the statement's public review period, before any prize is offered, receives a fixed review award of 100 owls; and the prize re-binds to the corrected statement after fourteen days' notice and the corrected statement's own review period, less any defect award paid.",
  },
  {
    slug: "eligibility",
    title: "Eligibility",
    body:
      "Natural persons aged 18 or over; one payee per submission; not Minerval, its contractors on this program, or a person who funded the mandate that posted the prize; not residents of jurisdictions where the prize cannot lawfully be paid, including comprehensively sanctioned jurisdictions and, for now, Italy and Brazil. Entry is free. Purchasing anything from Minerval confers no advantage.",
  },
  {
    slug: "submissions",
    title: "Submissions",
    body:
      "Through the claim page's form, with a Lean file, a written account, a tools disclosure, and the declarations. AI assistance is permitted and must be disclosed. A submission is confidential to Minerval and its agents until it is accepted or the prize closes, and is then dedicated to the public domain under CC0 1.0; for material without copyright the claimant grants the broadest license available and warrants that the submission is the claimant's own work or properly attributed. A submission that reproduces a proof Minerval's own solver produced is not eligible.",
  },
  {
    slug: "priority",
    title: "Priority",
    body:
      "The first submission by time of receipt that passes the checker and the steward's review wins. Submissions with identical receipt times that both pass share the prize equally. Once a submission has passed the checker, no further submissions are accepted for that prize unless it is later rejected. There is no random selection at any stage.",
  },
  {
    slug: "review",
    title: "Review",
    body:
      "The checker's verdict is mechanical and public. The steward judges only whether the statement proved is the statement posted. An accepted submission is announced on the claim page and becomes payable after a challenge window of fourteen days (thirty for prizes of 1,000 owls or more), extended while an admitted challenge is open, up to twice the window. Challenges may be filed only on the listed grounds, with evidence. Every acceptance is audited. Prizes of 1,000 owls or more, and prizes on claims of high importance, require a named person's sign-off.",
  },
  {
    slug: "payment",
    title: "Payment",
    body:
      "Prizes are stated and paid in owls. Owls are credit for metered work on the site, valued at one dollar of metered cost each; they do not expire, cannot be transferred, and are never redeemable for cash. Payment requires identity verification, a tax form, and sanctions screening first, to be completed within ninety days of the prize becoming payable, after which the prize lapses; the amount may be reduced by required withholding.",
  },
  {
    slug: "taxes",
    title: "Taxes",
    body:
      "Prizes are income to the winner. Minerval reports and withholds as United States law requires.",
  },
  {
    slug: "withdrawal-and-change",
    title: "Withdrawal and change",
    body:
      "Minerval may withdraw or amend a prize with thirty days' notice on the claim page and the prize listing; submissions received before the effective time are judged under the prior terms. A prize closes without payment if Minerval's own solver produces a checked proof first, in which case the proof is published, or if the only passing submission came from a person who was not eligible.",
  },
  {
    slug: "publicity",
    title: "Publicity",
    body:
      "The winner's chosen credit name, the proof, and the checker record are published as a matter of record. Use of a winner's name or likeness in promotion requires separate written consent.",
  },
  {
    slug: "disputes",
    title: "Disputes",
    body: "[Governing law, venue, and arbitration terms from counsel.]",
  },
  {
    slug: "versions",
    title: "Versions",
    body:
      "These rules are versioned; each prize names the version in force when it was posted, and each submission records the version it was made under.",
  },
];

// The canonical plain text the content hash is computed over: version,
// effective date, then each numbered term. Whitespace is normalised so the
// hash tracks the words, not the file's line breaks.
export function prizeRulesText(): string {
  const head = `Minerval prize rules, version ${PRIZE_RULES_VERSION}, effective ${PRIZE_RULES_EFFECTIVE}.`;
  const terms = PRIZE_RULES.map(
    (r, i) => `${i + 1}. ${r.title}. ${r.body.replace(/\s+/g, " ").trim()}`,
  );
  return [head, ...terms].join("\n");
}
