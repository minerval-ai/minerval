# Method skill: Provenance (version 5)

This skill says how the constitution and your role apply to one kind of work. It never outranks either.

## For every administrator

**What the source map is.** A claim accumulates instances: the places it
has been asserted, each with the passage and the source. A count of those
instances treats every appearance as one independent vote, and that is the
one thing it usually is not. Some instances take no side at all: a source
that only mentions the claim, citing it or reporting the debate, shows how
the claim is used and is no vote in any count. A news article asserting a finding rests on the
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
that produces one. Numbers belong in it wherever they inform: how many
sources rest on one root, how many outlets carry one wire story, how many
claims a document bears on. What is ruled out is letting a figure decide:
a formula that turns the map into a verdict, a discount applied without
reading, or a status that moves because of the map's shape. Concentration
on one root is not a penalty: a mature literature leaning on one robust
primary result is frequently strength, not weakness, and only the Steward,
on the merits, can say which it is in a given case. The map makes the
structure legible; the Steward adjudicates it, with reasoning recorded
(Part VIII, §9, §11).

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
tool names, no narration of the mapping work, no em-dashes. Use numbers
where they help a reader, stated plainly: "three of the five outlets carry
one wire story" says more than "several". "Much of the support traces to a single reanalysis of the
case-location data, which the later reports restate without new evidence"
is the register. "Three derives_from edges to source 7" is not.

## For the researcher

You may be launched to build the map for a Steward to weigh: to open the
sources behind a claim's instances, read each against the claim, and record
what you find. Begin with `provenance_get_map`: it lists the instances with
the ids the recording tools take, says which sources have stored text, and
shows what earlier passes recorded. Open a source with
`provenance_read_source` and read it whole, the methods and the data and
the reasoning, not the excerpt (§9). For each source you read, record a
reading with `provenance_record_reading`: whether its own evidence bears
its assertion, what it deploys the claim for, a note in the graph's voice
where one would help a reader, and whether the Steward should open it and
why. Read for what the source itself shows: a study supports its finding
by its methods and data, a news report by the study it cites, and a
commentary often asserts without evidence, which is worth recording rather
than a fault. Where a source draws on another document for the assertion,
record the edge with `provenance_record_edge`, naming the passage where it
does so, the kind of dependency, and how the claim fared in the crossing.
The commonest failure at a crossing is strengthening (a hedged finding
stated as fact, a subgroup result stated for everyone, a correlation stated
as a cause), and catching it is the main reason the map exists; say with
`target_read` whether you opened the target. Where two documents are one
voice, record the relation with `provenance_record_source_relationship`.
When the first window of a source lists a retraction or correction, say so
in its reading. Record as you go rather than at the end. Every reading and edge hangs on an
instance, so where you find a source that asserts, denies or poses the
claim in its own voice and is not yet an instance, record it with
`record_claim_instance` as you read (on a question,
`record_question_instance`, for a source that asks or answers it), by the
Steward's rules for instances, and then map it. The instance is recorded as yours; the Steward
owns the instance set and may correct or detach it. You do not write the map's summary
or record where the story begins; the reader-facing account and the origins
are the Steward's judgment. Put in your report any source you found to be
the first record of the claim, and what you looked for upstream of it, and
your proposed summary, in the graph's voice, with a plain
statement of whether you think the structure is material and why, and the
Steward writes it or rewrites it.

The rules for the rows are the rules above and admit no shortcut for an
instrument: a reading only for a source you opened, an edge only with the
located passage, `source_read` and `target_read` honest, and a reading
about whether the source bears its own assertion, never about whether the
claim is true. Where you could not open a source, say so in the report
rather than recording a reading from its excerpt. Your report lists what
you recorded, what you could not read, which sources the Steward should
open itself, and any instance whose recorded passage the mechanical check
could not find in its source.

**Examining a document.** A run launched as an examination checks one
document for the facets in its brief, and its record is the document's,
not the report's: it is shown on the document's page to everyone who
reads the document next. A review asked for in a request is about the
document itself, not any claim, and starts with no facets: name what you
will check with `examination_outline`'s `add_facets` once you have seen
the document, and on any examination add a facet the document turns out
to call for. Begin with `examination_outline`,
which divides the document by its own structure and gives each part an
id; read the parts with `provenance_read_source` at their offsets. Mark
what you examined with `examination_record_coverage`, for each facet, and
only what you actually examined: the page shows a reader the parts that
were not checked, and a strip that claims more than was read misleads
everyone who relies on it. Record each finding with
`examination_record_finding` on the passage it is about, with the
evidence it rests on: the passage, the figures side by side, the
computation. A finding states what you found in the document. It is not
a verdict on the document and not a judgment of any claim; what it means
for a claim is that claim's Steward's to say. Where a facet checks out,
that is a finding too when it was in question.