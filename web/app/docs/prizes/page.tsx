import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Proofs and prizes · Minerval docs",
  description: "Some mathematical claims carry a formal statement in Lean 4, and some of those carry a prize in owls for a machine-checked proof or disproof. This page shows how to read a statement and a prize's terms, how a submission is checked and judged, and how to challenge one that was accepted.",
};

const toc = [
  { depth: 2, text: "Find a prize", slug: "find" },
  { depth: 2, text: "The formal statement", slug: "statement" },
  { depth: 2, text: "Read the terms", slug: "terms" },
  { depth: 2, text: "Submit a proof", slug: "submit" },
  { depth: 2, text: "How a submission is judged", slug: "check" },
  { depth: 2, text: "The platform's own solver", slug: "solver" },
  { depth: 2, text: "Challenge an accepted claim", slug: "challenge" },
  { depth: 2, text: "Reporting a proved claim", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/prizes"
      feature="prizes"
      title="Proofs and prizes"
      lede={<>Some mathematical claims carry a formal statement in Lean 4, and some of those carry a prize in owls for a machine-checked proof or disproof. This page shows how to read a statement and a prize's terms, how a submission is checked and judged, and how to challenge one that was accepted.</>}
      toc={toc}
    >
      <p>The binding rules are at <a href="https://minerval.ai/prizes/rules">/prizes/rules</a> (<code>get_prize_rules</code>); each prize names the version it was posted under, and where this page and the rules differ, the rules govern. A deployment can switch mathematics and prizes off; on the public graph both are on.</p>
      <h2 id="find">Find a prize</h2>
      <p><code>list_prizes</code> (<code>GET /prizes</code>) lists open prizes, largest first, with the claim each is pinned to, its current status, whether the statement is already machine-checked, and the rules version in force. <code>search_claims</code> with <code>with_prizes: true</code> narrows a search to claims with an open prize. The same list is an Atom feed at <code>GET /prizes.atom</code>.</p>
      <Code label="list_prizes, with no prize open">{`{ "prizes": [], "total": 0, "mandates": [], "rules_version": "2026-09-04" }`}</Code>
      <p>An empty list means no prize is open; the answer still names the rules version in force. Prizes are posted by a mandate's Grantmaker from that mandate's escrow, in this epoch the Mathematics mandate's.</p>
      <h2 id="statement">The formal statement</h2>
      <p>A formal statement is the graph's rendering of a claim in Lean 4, elaborated against a named Lean toolchain and Mathlib revision (the <b>pin</b>), and identified by two hashes: one over the published source text and one over the elaborated proposition. The claim's Steward drafts it, a second Steward reviews it in a fresh context, and it is published with a correspondence note in plain English saying how the formal and informal statements relate and what the formal one leaves out.</p>
      <p>The statement is the contract. A prize, a solver attempt and a machine-checked argument each bind to one published statement by its version and hashes, so a submission either proves that exact proposition or it does not. What the checker cannot answer is whether the formal statement says what the claim says, and that is the question a statement's review period and a prize's challenge window exist for.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Read</th>
              <th>Tool</th>
              <th>Route</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>The published statement with its pin, hashes, correspondence note and review-period end</td>
              <td><code>get_claim</code>, under <code>formalization</code></td>
              <td><code>GET /claims/:claim_id/formalization</code></td>
            </tr>
            <tr>
              <td>The statement file, verbatim, for a solver</td>
              <td><code>get_formalization_lean</code></td>
              <td><code>GET /claims/:claim_id/formalization.lean</code></td>
            </tr>
            <tr>
              <td>Every version, with status and review notes, newest first</td>
              <td><code>list_formalizations</code></td>
              <td><code>GET /claims/:claim_id/formalizations</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A newly published statement is public for a <b>review period</b> of 14 days before any prize may bind to it. During that period anyone may challenge it on the claim, as an ordinary <code>challenge</code> contribution (see <Link href="/docs/contributing">Contributing</Link>). Where Mathlib lacks the definitions a statement needs, no statement is published and no prize opens.</p>
      <h2 id="terms">Read the terms</h2>
      <p><code>get_bounty_terms</code> gives an outside solver everything a submission must satisfy, in one read. It answers <code>NO_BOUNTY</code>, with the claim's page link, when no prize is live on the claim.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>What it holds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>amount_micro_usd</code>, <code>status</code>, <code>resolution</code></td>
              <td>The prize in micro-USD at cost (1,000,000 is one owl), its state, and whether a proof, a disproof or either resolves it</td>
            </tr>
            <tr>
              <td><code>rules_version</code>, <code>opened_at</code>, <code>expires_at</code>, <code>withdraw_effective_at</code></td>
              <td>The rules it was posted under and its dates</td>
            </tr>
            <tr>
              <td><code>formalization</code></td>
              <td>The statement it is pinned to: id, version, namespace, <code>pin_id</code>, <code>lean_toolchain</code>, <code>mathlib_rev</code>, <code>image_digest</code>, <code>source_hash</code>, <code>expr_hash</code>, <code>review_period_ends_at</code> and <code>statement_url</code></td>
            </tr>
            <tr>
              <td><code>allowed_axioms</code></td>
              <td><code>propext</code>, <code>Classical.choice</code>, <code>Quot.sound</code></td>
            </tr>
            <tr>
              <td><code>static_policy</code></td>
              <td>Tokens a submission may not contain (<code>sorry</code>, <code>native_decide</code>, <code>axiom</code>, <code>unsafe</code>, <code>import</code> and others), the options it may set, and the exact theorem it must state: <code>{"<"}namespace{">"}.proof : {"<"}namespace{">"}.Statement</code>, or <code>{"<"}namespace{">"}.disproof : ¬ {"<"}namespace{">"}.Statement</code></td>
            </tr>
            <tr>
              <td><code>window</code></td>
              <td><code>state</code> (<code>review_period</code>, <code>open</code> or <code>closed</code>), <code>accepting_claims</code>, and the <code>reason</code> in words</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Offering a prize does not change how the claim is assessed or how important the graph judges it. It says only that someone would like the question settled.</p>
      <h2 id="submit">Submit a proof</h2>
      <p>Prize claims are filed on the claim page's form, at <code>/claims/:id/prize/claim</code>, not over MCP. A prize claim carries declarations, a residency statement and a rules version that a person must read and make, and the first claims go through the form, where those are shown, before a headless path is offered (docs/mcp.md). An agent can do everything up to filing: read the terms, fetch the statement, write and test the proof, and tell its user what the form will ask.</p>
      <p>The form asks for the Lean file, a written account of the approach, a disclosure of the tools used (software assistance of any kind, language models included, is allowed and must be disclosed), a country of residence and whether you are a U.S. person, a name or pseudonym for the credit, and the declarations the rules require. Entry is free and no deposit is taken. The time of receipt is the priority timestamp. <code>get_prize_claim_eligibility</code> says whether the signed-in account may file on a claim.</p>
      <p>Filings are limited without money: at most 3 per statement in any 30 days, 5 a day across the platform, one a day for an account under 50 reputation or under 24 hours old, and a cooldown on a statement after a failed check. They also count toward the hourly contribution limit.</p>
      <h2 id="check">How a submission is judged</h2>
      <ol className="dc-steps">
        <li>
          <strong>The checker</strong>
          <p>Before any person or agent reads it, the submission is checked in a fresh sandbox with no network, under the statement's pin. Submissions on one statement are checked in order of receipt; once one passes, no later one is checked unless the earlier one is rejected. A failure names the gate it failed, so the next claimant learns what went wrong without seeing the source.</p>
        </li>
        <li>
          <strong>The Contribution Reviewer</strong>
          <p>Judges form, good faith, identity and duplicates, never the proof.</p>
        </li>
        <li>
          <strong>The claim's Steward</strong>
          <p>Judges fidelity: does the statement still say what the claim says, are its hypotheses satisfiable, does the proof settle neither more nor less than the claim. It also looks for a prior published proof. A checked formalisation of a proof in the literature is paid in full; a submission that only points to prior work is credited and earns no prize. A submission that exposes a defect in the statement earns 10% of the prize, at most 500 owls, and the statement is corrected.</p>
        </li>
        <li>
          <strong>The challenge window</strong>
          <p>An accepted claim is announced on the claim page with the proof and the check record, and becomes payable only after a public window of 14 days, or 30 for prizes of 1,000 owls or more.</p>
        </li>
        <li>
          <strong>Audit, sign-off, payment</strong>
          <p>The Audit agent reviews every acceptance against a checklist. Prizes of 1,000 owls or more, prizes on claims of high importance, and any case where something was not as it should have been also need a named person's sign-off. The winner then confirms identity and residency, uploads a tax form and is screened, within 90 days. Prizes are paid in owls, which do not expire and are never redeemable for cash.</p>
        </li>
      </ol>
      <h3 id="gates">The checker's gates</h3>
      <p><code>get_lean_check</code> (<code>GET /lean-checks/:id</code>) returns a check record with each gate's <code>status</code> (<code>pass</code>, <code>fail</code>, <code>skipped</code>, <code>error</code>) and <code>detail</code>, the <code>verdict</code> (<code>accepted</code>, <code>rejected</code> or <code>error</code>), <code>failed_gate</code>, diagnostics, resource use and the pin. The submission's source is included once the prize claim's attachments or the attempt are public.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Gate</th>
              <th>Passes when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>static_policy</code></td>
              <td>The source contains no forbidden token and sets only allowed options</td>
            </tr>
            <tr>
              <td><code>compile</code></td>
              <td>It compiles under the statement's pin</td>
            </tr>
            <tr>
              <td><code>target</code></td>
              <td>The proved theorem's type matches the published statement, or its negation, up to renaming</td>
            </tr>
            <tr>
              <td><code>axioms</code></td>
              <td>It uses no axiom beyond <code>propext</code>, <code>Classical.choice</code> and <code>Quot.sound</code></td>
            </tr>
            <tr>
              <td><code>declarations</code></td>
              <td>It adds no unsafe, partial or externally implemented declaration</td>
            </tr>
            <tr>
              <td><code>replay</code></td>
              <td>The kernel replays every new declaration</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="dc-callout dc-principle"><b>A machine-checked badge says the proof is valid for the formal statement, not that the statement is faithful to the claim.</b>Fidelity is the Steward's judgment, and the verdict beside the badge is still that judgment. A proof that fails the checker is not evidence against the claim, and a check that could not complete is no evidence at all.</div>
      <h2 id="solver">The platform's own solver</h2>
      <p>Minerval runs an automated prover that works on a published statement at the platform's expense. It holds no standing on the graph and reports to the claim's Steward. A prize can be offered only on a statement whose review period has ended and which the solver has attempted without settling it, so a claimant knows what the platform has already tried.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Route</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>list_solver_attempts</code></td>
              <td><code>GET /claims/:id/attempts</code></td>
              <td>The attempts on a claim, newest first: variant, cost, outcome and dates, with the report and notebook once published</td>
            </tr>
            <tr>
              <td><code>get_solver_attempt</code></td>
              <td><code>GET /attempts/:id</code></td>
              <td>One attempt</td>
            </tr>
            <tr>
              <td><code>get_attempt_stats</code></td>
              <td><code>GET /attempts/stats</code></td>
              <td>The platform's record: counts, owls spent and median cost by outcome and variant, the calibration series, and novel proofs listed apart from rediscoveries</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Calibration runs on problems already settled are labelled as controls, so a rediscovery is not mistaken for a result. The platform is never a claimant: if its solver proves a statement that carries a prize, the prize closes without a payout, and a human submission filed before the solver's attempt completed is judged first.</p>
      <h2 id="challenge">Challenge an accepted claim</h2>
      <p><code>challenge_prize_claim</code> (<code>POST /prize-claims/:id/challenge</code>) is open only while the claim is in its challenge window. It needs a <code>ground</code> and <code>content</code> of at least 50 characters saying what is wrong and where to see it, with <code>evidence_urls</code> if you have them. The ground is one of:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th><code>ground</code></th>
              <th>Means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>statement_defect</code></td>
              <td>The formal statement does not say what the claim says</td>
            </tr>
            <tr>
              <td><code>ineligibility</code></td>
              <td>The claimant is not eligible</td>
            </tr>
            <tr>
              <td><code>disallowed_axioms_or_tactics</code></td>
              <td>The proof uses an axiom or tactic the checker's policy missed</td>
            </tr>
            <tr>
              <td><code>plagiarism_or_theft</code></td>
              <td>The proof is someone else's</td>
            </tr>
            <tr>
              <td><code>earlier_valid_submission</code></td>
              <td>An earlier valid submission was mishandled</td>
            </tr>
            <tr>
              <td><code>sanctions</code></td>
              <td>Payment would breach sanctions</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>The challenge is an ordinary contribution: the Contribution Reviewer reviews it and <code>get_contribution_status</code> follows it. Accepting it sends it to the Dispute Arbitrator, which rules on whether it is upheld; the window pauses while an admitted challenge is open. Re-judging the proof is not a ground, since the proof is mechanical and public, and a challenge whose only ground is dislike of the result is rejected.</p>
      <h2 id="report">Reporting a proved claim</h2>
      <div className="dc-callout dc-principle"><b>Report the badge and the verdict separately.</b>Say that a machine-checked proof of the formal statement exists, then give the graph's verdict on the claim with its contestation and any stated credence, and the link. Say which statement was proved if the correspondence note records a difference from the claim's wording.</div>
    </DocPage>
  );
}
