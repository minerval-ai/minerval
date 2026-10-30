# Vendored MIRA schema files

`mira.jsonld`, `mira.ttl`, and `mira.shacl` are copied unmodified from
[MIRA-science/schema](https://github.com/MIRA-science/schema) at commit
`365d40403498da5c3c6698f21680696b25f1c2c8` (2026-10-21), licensed under
the Apache License 2.0. They pin the MIRA version the export targets
(docs/mira.md): the tests validate every export against `mira.shacl`, with
the class hierarchy from `mira.ttl`, and resolve the JSON-LD context from
`mira.jsonld` without a network fetch.

`tests/unit/services/fixtures/mira-sample-data.json` is the same commit's
`sampleData.json`, which the validator is shown to accept.

To move to a newer MIRA: copy the three files from the new commit, update
`MIRA_SCHEMA_COMMIT` (and `MIRA_SCHEMA_VERSION` if `owl:versionInfo`
changed) in `src/services/mira-service.ts`, and run the tests.
