ALTER TABLE "actions" ADD COLUMN "end_reason" text;--> statement-breakpoint
-- A row's end reason describes the close it was given; when the group's
-- next piece of work opens the row again, the reason goes with the close,
-- as the fault columns do (#1045).
CREATE OR REPLACE FUNCTION actions_clear_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('open', 'running') THEN
    NEW.fault_reason := NULL;
    NEW.fault_since := NULL;
    NEW.fault_attempts := 0;
    NEW.retry_after := NULL;
  ELSE
    NEW.end_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;
