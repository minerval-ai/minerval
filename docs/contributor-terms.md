<!--
Draft for counsel review. Not yet in force. The graph's outbound dedication
is already CC0 (README, docs/vocab.md: every nanopub records CC0 in its
publication-info graph); these terms put the contributor's side of that
dedication on the record. Points counsel should settle before launch:

- Section 3: CC0's own fallback license is restated as a direct grant, so
  the terms hold where a public-domain dedication is ineffective (much of
  the EU). Confirm the restatement adds nothing CC0 lacks and loses nothing.
- Section 6: moral-rights waiver is unenforceable in several jurisdictions;
  the consent-to-modification and consent-to-no-attribution language is the
  fallback. Review against the jurisdictions most contributors will be in.
- Section 7 vs the Privacy Policy: the privacy page currently says a deleted
  account's "associated records" are removed. Contributions are public,
  permanent, and CC0; deletion must pseudonymize attribution, not remove
  content. The privacy page needs that sentence changed before launch, and
  the GDPR basis for retaining published contributions (legitimate interest,
  public-record and archival purposes) should be written down.
- Section 9: register a DMCA agent with the US Copyright Office and fill in
  the address; the safe harbor depends on it.
- Liability posture beyond the license: Section 230 shields hosting of
  contributor text in the Contribution Record, but agents rewrite
  contributions into the graph's own voice, so Minerval is plausibly the
  speaker of graph text and cannot rely on 230 for it. The contributor
  warranties in Section 4 do not change that. This is a defamation and
  accuracy exposure question for the graph as a whole, not for these terms,
  but it should be on the same desk.
- Section 4(g): whether to require disclosure of AI-assisted contributions
  rather than merely permit them.
- Terms of Service (governing law, dispute forum, API access rules) do not
  exist yet; these terms and the rewards policy assume them.
-->

# Contributor Terms

*Minerval, Inc.* · Not yet in force · Effective date: to be set

**In short.** The claim graph is a public commons, dedicated to the public
domain under CC0. When you contribute, you dedicate what you submit the same
way. You promise that it is yours to dedicate and that it contains nothing
private, confidential, or unlawful. You accept that Minerval's agents will
evaluate it, may rewrite it into the graph's own voice, and will keep your
exchange with them on the public record permanently, credited to your
account name in the contribution record. Submitting a source is different:
you are pointing at a public page, not dedicating it. Sincere contribution
is free, and these terms are the same whether or not a reward is offered.

## 1. Scope and agreement

These terms govern every Contribution submitted to Minerval, Inc.
("Minerval") through any surface: the website, the API, the browser
extension, the MCP server, or any other channel Minerval provides, by any
person, paid or unpaid. They form part of Minerval's Terms of Service. Where
the two conflict about a Contribution, these terms control.

By submitting a Contribution you agree to these terms as in force at the
time of submission. Minerval records which version you agreed to. You may
submit only if you are at least 13 years old, able to enter a binding
agreement where you live or acting with a guardian's consent, and holding a
Minerval account in good standing.

## 2. Definitions

- **Contribution**: any material you submit to Minerval for inclusion in or
  evaluation against the claim graph: a challenge, support, evidence, an
  argument, a proposed edit to a canonical form or assessment, a merge or
  split proposal, a claim proposal, a comment in an exchange with an agent,
  and the text accompanying any of these. A Source Submission is not a
  Contribution.
- **Source Submission**: pointing Minerval at a document, usually by URL, so
  that Minerval's agents fetch it and extract the claims it makes.
- **The Graph**: the claim graph Minerval publishes, including every claim,
  canonical form, decomposition, argument, assessment, contribution record,
  and export built from them.
- **Graph Voice**: reader-facing text written by Minerval's agents in the
  register of a reference work: canonical forms, the written forms of
  arguments, assessments, and their reasoning.
- **Contribution Record**: the public record attached to a claim of every
  Contribution concerning it, the agents' replies, and the outcome.
- **Automated Systems**: the software Minerval uses to run the Graph,
  including large-language-model agents that evaluate Contributions, write
  Graph Voice, and decide appeals.
- **CC0**: the Creative Commons CC0 1.0 Universal Public Domain Dedication,
  at creativecommons.org/publicdomain/zero/1.0/legalcode.

## 3. The dedication

3.1 **CC0.** On submission, you dedicate the Contribution to the public
domain under CC0, worldwide and irrevocably, to the fullest extent permitted
by law. The dedication covers copyright and every related and neighboring
right, including database rights, in the Contribution as submitted and in
any part of it.

3.2 **Fallback license.** Where the law does not allow a dedication to the
public domain, or to the extent a dedication is not effective, you grant
Minerval and every other person a perpetual, irrevocable, worldwide,
royalty-free, non-exclusive, unconditional license to reproduce, adapt,
translate, combine, publish, distribute, perform, display, and otherwise use
the Contribution for any purpose, commercial or not, with no requirement of
attribution and no other condition.

3.3 **No reservations.** You keep no right in the Contribution against
Minerval or any reuser. You may not attach conditions to it, require
attribution or share-alike, or later restrict its use. You may of course
reuse your own Contribution anywhere, as anyone may.

3.4 **Patents and trademarks.** CC0 does not cover patent or trademark
rights. You agree not to assert any such right you hold against Minerval or
anyone else for using the Contribution as part of the Graph.

3.5 **Why.** The Graph exists to be reused freely by people and by
machines. Its own content, including the text its agents write, is
dedicated to the public domain under CC0, and every published export records
that dedication permanently. Contributions are accepted on the same terms so
that nothing in the Graph carries conditions the rest of it lacks.

## 4. What you promise about the Contribution

You make each of the following promises about every Contribution, at the
time you submit it:

- (a) **It is yours to dedicate.** You wrote it, or you hold the rights
  needed to dedicate it under Section 3. Where several people wrote it, each
  has agreed.
- (b) **Third-party material is quotation only.** Any material not your own
  is limited to what the law permits for quotation and citation, is clearly
  marked as quoted, and identifies its source. You do not submit substantial
  passages of anyone else's copyrighted work.
- (c) **Nothing confidential.** It contains no trade secret, no material
  under a confidentiality obligation, and nothing you are prohibited from
  publishing.
- (d) **Nothing private.** It contains no personal detail about a private
  individual who has not entered the public discourse: no name joined to
  health, finances, whereabouts, conduct, or correspondence, and no contact
  or identifying details of anyone, yourself included, beyond your account.
  Public acts by public actors are what the Graph exists to assess, and
  naming who did them is provenance, not exposure.
- (e) **Lawful and in good faith.** It is lawful where you are and where
  Minerval operates. It is submitted sincerely, on the merits, to improve
  the Graph, and any statement of fact in it about a person is one you have
  a good-faith basis to believe.
- (f) **Aimed at readers, not at the agents.** It contains no instructions,
  prompts, encoded content, or other material designed to influence
  Automated Systems other than through the merits of what it says, and no
  malicious code.
- (g) **AI assistance is yours to answer for.** You may use AI tools to
  prepare a Contribution. If you do, you have reviewed it, you stand behind
  it as if it were your own, and every promise in this Section applies to
  it.
- (h) **One person, one account.** You submit for yourself, from your own
  account, and not on behalf of an undisclosed person or organization.

If a promise in this Section turns out to be untrue, you are responsible for
any loss Minerval suffers as a result, to the extent the law permits.

## 5. What Minerval and its agents do with it

5.1 **Evaluation.** Contributions are evaluated by Automated Systems on the
merits, under the constitution and policies published on this site, and
accepted, rejected, or escalated. The reasons are recorded in the
Contribution Record. Minerval has no obligation to accept, use, keep, or
display any Contribution.

5.2 **Rewriting.** An accepted Contribution is folded into the Graph in
Graph Voice: its substance may be reworded, decomposed, merged with other
material, split, translated, summarized, or superseded. Graph Voice carries
no inline attribution. Your Contribution as you wrote it stays in the
Contribution Record.

5.3 **Publication.** The Contribution, the agents' replies, and the outcome
are published in the Contribution Record, attributed to your account's
display name, and remain there whether the Contribution was accepted or
not.

5.4 **Distribution.** The Graph, including Contribution Records, is
distributed through the website, the API, the browser extension, the MCP
server, and exports, to anyone, including AI systems, under CC0.

5.5 **Removal and moderation.** Minerval may decline to publish, hide,
remove, or edit any Contribution at any time, in whole or part, including
where a promise in Section 4 is untrue or in doubt, where the constitution
or a policy requires it, where the law or legal process requires it, or
where Minerval judges it necessary to protect the Graph or any person.
Removal from display does not undo the dedication in Section 3.

## 6. Moral rights and attribution

6.1 **Waiver and consent.** To the fullest extent permitted by law, you
waive, and agree not to assert against Minerval, its agents, or any reuser,
any moral right in the Contribution, including rights of attribution and
integrity. Where a waiver is not permitted, you consent to every use
described in Section 5, including modification, adaptation, combination,
translation, and publication with or without attribution, and you agree
that none of it is a distortion of or prejudice to your work.

6.2 **Credit in the Contribution Record.** Minerval credits Contributions in
the Contribution Record by account display name, and a contributor's track
record is part of the Graph's public provenance. This credit is a feature of
the Graph, not a right you retain, and Minerval may change how it is shown.

6.3 **After deletion.** If your account is deleted, your Contributions
remain and their credit changes to a neutral marker such as "a former
contributor". See Section 7.

## 7. Permanence, the public record, and deletion

7.1 **Publication is permanent.** The Contribution Record is part of the
Graph, and exports of the Graph that carry your Contribution have been
distributed under CC0 and cannot be recalled. You should assume that
anything you submit will remain public indefinitely.

7.2 **Deleting your account.** You may delete your account at any time.
Deletion removes the account, its credentials, and the link between you and
your Contributions in Minerval's systems, and credits your Contributions as
in Section 6.3. It does not remove the Contributions. Minerval keeps the
records that tax, accounting, and legal obligations require, including
records under the Contributor Rewards Policy.

7.3 **Correction.** The way to correct something you submitted is to submit
again. Minerval does not remove Contributions on request, except under
Sections 7.4 and 9 or where the law requires.

7.4 **Private data.** If a Contribution contains personal detail contrary to
Section 4(d), whether about you or about anyone else, tell Minerval and it
will remove the detail from display. This is the exception to Section 7.3.

## 8. Source Submissions

8.1 **Not a dedication.** Submitting a source dedicates nothing about that
source's content and grants Minerval nothing in it. The source's owner keeps
every right they had. Minerval's agents fetch the source themselves, extract
the claims it makes, and quote from it within what the law permits for
quotation and citation; that quotation is Minerval's responsibility, not
yours.

8.2 **What you promise.** By submitting a source you promise that it is
publicly accessible without credentials, that fetching it is lawful, that
you are not prohibited from sharing it, and that you are not submitting it
in order to place instructions before the agents. Sources are data to the
agents, never instructions.

8.3 **Your own work as a source.** If you submit a document you wrote, it
remains yours. Only what you submit as a Contribution is dedicated.

## 9. Notice and takedown

9.1 **Copyright.** If you believe material in the Graph infringes your
copyright, send a notice to Minerval's designated agent at
copyright@minerval.ai, or by post to the address given on this page, with
the information the Digital Millennium Copyright Act requires: the work, the
material and where it appears, your contact details, a statement of good
faith belief, a statement of accuracy under penalty of perjury, and your
signature. Minerval will remove or disable access to the material, notify
the contributor, and accept a counter-notice as the Act provides. Accounts
that repeatedly infringe are terminated.

9.2 **Other complaints.** Complaints about private personal data,
defamation, or other unlawful content go to privacy@minerval.ai. Minerval
reviews them and may remove material under Section 5.5. A disagreement
about whether a claim is true is not a complaint; it is a Contribution, and
the way to raise it is to submit one.

## 10. Standing and review

Contributions affect your standing on the Graph as the Privacy Policy
describes: acceptances and sincere rejections are recorded, and a finding
of bad faith carries consequences, including a standing that requires a
deposit to contribute and, in serious cases, suspension. Sincere
contribution never costs anything. Review outcomes can be appealed through
the process on the site, and appeals may themselves be decided by Automated
Systems. Instructions aimed at the agents, coordinated campaigns, shared or
multiple accounts, and contributions designed to game decomposition are
treated as bad faith.

## 11. Rewards

Minerval may invite particular Contributions under its Contributor Rewards
Policy and pay for the ones it accepts. Whether or not a reward is offered
or paid, these terms apply unchanged: the dedication in Section 3 is the
same, the promises in Section 4 are the same, and no Contribution is a work
made for hire or assigned to Minerval. A reward is payment for services
rendered to Minerval, and it does not change who holds what.

## 12. No warranty and limitation of liability

The Graph and the contribution surfaces are provided as they are. Minerval
does not warrant that any Contribution will be accepted, kept, displayed,
attributed, or accurately represented, or that the Graph is accurate,
complete, or fit for any purpose. To the fullest extent permitted by law,
Minerval is not liable to you for any indirect, incidental, special,
consequential, or punitive loss arising from a Contribution or its use, and
Minerval's total liability to you in connection with these terms is limited
to one hundred United States dollars. Nothing in these terms limits
liability that cannot be limited by law.

## 13. Changes to these terms

Minerval may change these terms by publishing a new version on this page
with a new effective date. Changes apply to Contributions submitted after
the effective date. A dedication already made under Section 3 is
irrevocable and is not affected by any later version. Material changes are
announced on this page. Continuing to submit Contributions after a change is
acceptance of the change.

## 14. Contact

Questions about these terms: legal@minerval.ai. Copyright notices:
copyright@minerval.ai. Privacy and content complaints: privacy@minerval.ai.
Designated agent postal address: to be set.
