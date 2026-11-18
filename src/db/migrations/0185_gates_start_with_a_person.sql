-- Gates now start with a person deciding after the Redactor, for every kind
-- that carries text from the label, and at the gate to outside also for the
-- public statement that a request was taken up (gate-kinds.ts, startingMode).
-- A gate that already exists keeps working as it did: for each kind whose
-- starting position changed, and where no setting for the whole boundary and
-- every party already says how that kind is treated, the old starting
-- position is written down as a setting, which its authorities can end.
INSERT INTO "gate_settings" ("boundary_id", "kind", "scope", "mode", "from_rule", "sensitivity_label")
SELECT g."boundary_id", k."kind", 'boundary', k."was", 'kept as this gate started, before gates started with a person', g."from_label"
  FROM (SELECT DISTINCT p."boundary_id", p."from_label", p."to_outside" FROM "redaction_policies" p WHERE p."side" = 'page') g
  CROSS JOIN (VALUES
    ('page', 'redactor', false), ('answer', 'redactor', false), ('funding', 'redactor', false), ('mandate', 'redactor', false),
    ('message', 'redactor', false), ('petition', 'redactor', false), ('proposal', 'redactor', false),
    ('taken_up', 'open', true)
  ) AS k("kind", "was", "outside_only")
 WHERE (g."to_outside" OR NOT k."outside_only")
   AND NOT EXISTS (
     SELECT 1 FROM "gate_settings" s
      WHERE s."boundary_id" = g."boundary_id" AND s."ended_at" IS NULL AND s."scope" = 'boundary'
        AND s."party_id" IS NULL AND s."kind" IN ('*', k."kind")
   );
