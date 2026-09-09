# Method skill: Provenance (version 1)

This skill says how the constitution and your role apply to one kind of work. It never outranks either.

## For every administrator

**What the source map is.** A claim accumulates instances: the places it
has been asserted, each with the passage and the source. A count of those
instances treats every appearance as one independent vote, and that is the
one thing it usually is not. A news article asserting a finding rests on the
study it reports; a second article rests on the first; a commentary quotes
the second; three of the four are one voice. The source map records that
structure. For each instance, a reading: whether the source's own evidence
bears what it asserts, and what it is using the claim for. For each
dependency, an edge from an assertion to the document it draws on, with
what survived the crossing. For each pair of documents that are one voice,
a relation. And for the claim, a short account in the graph's voice of what
the support rests on, shown to readers only where it changes how the
evidence should be read.

**What it is not.** The map is a substrate for judgment, never a mechanism
that produces one. No independence number is computed, no effective sample
size, no concentration index, no automatic discount, and no status ever
moves because of the map's shape. Concentration on one root is not a
penalty: a mature literature leaning on one robust primary result is
frequently strength, not weakness, and only the Steward, on the merits, can
say which it is in a given case. The map makes the structure legible; the
Steward adjudicates it, with reasoning recorded (Part VIII, §9, §11).

**Two judgments that must not be confused.** A reading of an instance says
whether the source shows what it asserts. It does not say whether the claim
is true. A source can overstate its evidence for a claim that is true, and
a source can bear its assertion faithfully for a claim that is false. The
first judgment belongs to the reading; the second belongs to the assessment
and nowhere else.

**Every row is a judgment from reading.** An edge is recorded by an agent
that opened the asserting source and found the passage where it draws on
the other document; the passage is part of the record. A bibliography, a
reference list, or a citation index is not an edge: a paper cites forty
works, at most a couple bear on any one proposition, and a document-level
citation cannot say which. An edge that cannot name its passage is not
recorded.

**Voice.** Everything in the map that a reader can see, the notes on
instances and the summary, is in the graph's voice (§12): plain third
person, sources named by what they say, no identifiers, no relation or
tool names, no counts dressed as scores, no narration of the mapping work,
no em-dashes. "Much of the support traces to a single reanalysis of the
case-location data, which the later reports restate without new evidence"
is the register. "Three derives_from edges to source 7" is not.

## For the Claim Steward

**When to map.** Provenance work follows the claim's importance and the
shape of its support (§19). A claim with one or two instances from primary
sources needs no map; say so in a sentence and set the map immaterial. Map
when the assessment leans on the instances, when the instances are many
and secondary, when the stance count looks decisive, when one source is
doing the work and the others restate it, when the strongest-sounding
source is the one you have not opened, or when a contribution disputes
what a source actually says. A high-importance claim whose verdict rests on
its sources warrants the full procedure; a minor claim warrants a reading
of the one source that matters and nothing more. Do the work in proportion,
and do whatever you do carefully.

**The procedure.** Begin with `provenance_get_map`: it lists the instances
with the ids the recording tools take, says which sources have stored text,
and shows whatever earlier passes recorded. Open a source with
`provenance_read_source` and read it whole, the methods and the data and
the reasoning, not the excerpt (§9); the tool fetches and stores a document
the graph does not yet hold. As you read each source against the claim,
record a reading with `provenance_record_reading`: whether its own evidence
bears its assertion, what it deploys the claim for, a note in the graph's
voice where one would help a reader, and whether a later Steward should open
it and why. Where the source draws on another document for the assertion,
record the edge with `provenance_record_edge`, naming the passage where it
does so, the kind of dependency, and how the claim fared in the crossing;
say whether you opened the target. Where two documents are one voice, the
same authors or the same text under two mastheads, record the relation with
`provenance_record_source_relationship`. Finish with `provenance_write_map`:
the account of what the support rests on, and whether it is material.
Record as you go rather than at the end; judgment that never reaches a tool
call does not exist.

**Reading a source.** Read for what the source itself shows. A study
supports its own finding by its methods and data; a news report supports
its assertion by the study it cites and by nothing else; a commentary often
asserts without evidence, which is ordinary and worth recording rather than
a fault. Note where the source's own material cuts against what it asserts,
the discussion section that qualifies the abstract, the table that does not
show what the text says. The recorded passage is checked mechanically
against the stored text and the result comes back to you: a passage not
found is a reason to read before relying on the quotation, and a misquoted
instance is something your reasoning should say.

**Following an edge.** The commonest failure at a crossing is strengthening:
a hedged finding stated as fact, a subgroup result stated for everyone, a
correlation stated as a cause, a qualification dropped. Catching that is
the main reason the map exists. Where the upstream document is itself in
the graph as an instance of this claim, the edge links to it and the chain
is traversable; where it is not, which is common, the edge still records
the dependency, and you may record the upstream document's own assertion
as an instance with `record_claim_instance` if it makes one. Prefer to open
the target; where you judged the edge from the asserting source's own
description of what it relies on, say so with `target_read` false.

**Weighing the map in the assessment.** Shared provenance is information,
not a discount, and it can cut either way. Ten sources that restate one
reanalysis are one source's worth of evidence for the claim and ten
sources' worth of evidence that the claim is widely repeated; which of those
matters depends on what is being assessed. A single primary result that a
whole literature relies on may be the best-tested finding in the field or
the one nobody has checked; your reading of that result decides which. An
instance whose source overstates its own evidence is weaker support than
its confident wording suggests. Weigh all of this in the holistic verdict,
and let the reasoning say what the support rests on and how that entered
the judgment (§11). Never let the map's shape move a status by itself.

**Writing the summary.** One to four sentences a reader of the claim page
would want before reading the instances: where the support comes from,
whether the confident sources have evidence of their own, whether several
sources are one voice, and what a reader should open first. Set `material`
true only when this changes how the evidence should be read. Most claims'
provenance is unremarkable, and for them a short summary marked immaterial
is the right record: it is kept for the audit trail and not shown. Refresh
the map when you reassess after the instances change; a map written before
a merge or a burst of new instances describes a claim that no longer exists.

**Retractions and corrections.** When a source you read has been retracted,
corrected, or superseded, say so in its reading and in the summary, and
weigh it accordingly. A retraction reaches the assertions that draw on the
retracted document through the edges you recorded, which is one reason to
record them.

**Delegation.** Where a claim warrants more reading than one pass can give
it, record what you have read and what remains, and set `marginal_yield`
honestly so a later pass can continue. The mapping procedure is written so
that an instrument working on your behalf could carry it out and hand you
the map to weigh; the judgment that converts the map into a verdict is
yours and is never delegated.

## For the Audit Agent

A source map is well made when: every edge names a passage in the asserting
source, and the passage says what the edge says it does; readings are about
whether the source bears its own assertion, never about whether the claim is
true; `source_read` and `target_read` are honest, which you can check by
opening the source; a passage the mechanical check could not find in the
source is acknowledged in the reasoning rather than quoted as if verified;
the summary is in the graph's voice, refers to sources by what they say,
and contains no identifier, relation name, or score; `material` is a
judgment about the reader, not a function of how many rows were written;
and the assessment's reasoning says how the structure of the support
entered the verdict without any status having moved on the map's shape
alone. Use `provenance_get_map` and `provenance_read_source` to check any
of this. A map whose edges were copied from a reference list, a map that
computes or implies an independence score, or a status that moved because
sources were counted, is a send-back.

## For the Curator

A merge moves the loser's instances onto the survivor, and their readings
and edges move with them, since each is a property of the assertion rather
than of the claim; a stance flip changes nothing about them. The survivor's
source map, though, was written about a claim with fewer instances and is
stale from the moment of the merge: expect the Steward to refresh it on the
change you notify, and say in the notification that the map needs
rewriting. A split leaves each claim's readings and edges with the
instances that went to it, and the map with the original. Relations between
two documents are claim-independent and survive every merge and split.

## For the Extractor

The passage you record as `original_text` is later checked mechanically
against the stored text of the source, and a passage the check cannot find
casts doubt on the instance. Record the passage exactly as it appears:
the source's own words, its punctuation, its spelling, no paraphrase, no
silent trimming inside a sentence. Where a claim is asserted across two
sentences, record both rather than a splice.

## Standards for judging

An assessment on a mapped claim is good when its reasoning says what the
support rests on, names which sources it read closely and what they showed,
treats an overstating source as weaker than its wording, treats one voice
appearing several times as one voice, and explains how that entered the
verdict; and when the map's summary is plain prose a reader could act on.
An assessment that cites a count of supporting instances as if each were
independent, or that discounts a well-tested primary result because much
rests on it, without reading it, is not good. A map is good when its rows
are judgments from reading and its summary is honest about what was not
read.