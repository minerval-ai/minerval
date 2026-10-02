# Method skill: Provenance (version 1)

This skill says how the constitution and your role apply to one kind of work. It never outranks either.

## For the researcher

You may be launched to build the map for a Steward to weigh: to open the
sources behind a claim's instances, read each against the claim, and record
what you find. The procedure is the Steward's, above, and the tools are the
same except the last two: begin with `provenance_get_map`, read with
`provenance_read_source`, record readings with `provenance_record_reading`,
edges with `provenance_record_edge`, and document relations with
`provenance_record_source_relationship`. You do not write the map's summary
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
not the report's: it is shown on the document's page to every reader and
every Steward whose claim rests on it. Begin with `examination_outline`,
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