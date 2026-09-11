# Method skill: Provenance (version 1)

This skill says how the constitution and your role apply to one kind of work. It never outranks either.

## For the researcher

You may be launched to build the map for a Steward to weigh: to open the
sources behind a claim's instances, read each against the claim, and record
what you find. The procedure is the Steward's, above, and the tools are the
same except the last: begin with `provenance_get_map`, read with
`provenance_read_source`, record readings with `provenance_record_reading`,
edges with `provenance_record_edge`, and document relations with
`provenance_record_source_relationship`. You do not write the map's summary;
the reader-facing account is the Steward's judgment. Put your proposed
summary in your report instead, in the graph's voice, with a plain
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