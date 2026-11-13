ALTER TABLE "research_runs" ADD COLUMN "questions" jsonb;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "answers" jsonb;--> statement-breakpoint
-- A source is whatever an agent read, fixed as it was when it was read
-- (constitution §9; #547). Its stored text, once stored, is not replaced by
-- other text: text that differs is a new source. The application only ever
-- fills text where none is held; this makes a direct overwrite fail too, so
-- that what a judgment or a shown page's fingerprint rests on cannot be
-- swapped under it. Clearing the text of a document found unreadable stays
-- possible (workers/url-extraction.ts), and a mirrored row is the public
-- graph's, which holds its own rows to this.
CREATE OR REPLACE FUNCTION minerval_source_text_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.raw_content IS NOT NULL AND btrim(OLD.raw_content) <> ''
     AND NEW.raw_content IS NOT NULL AND btrim(NEW.raw_content) <> ''
     AND NEW.raw_content IS DISTINCT FROM OLD.raw_content THEN
    RAISE EXCEPTION 'A source''s stored text does not change once it is stored: text that differs is recorded as a new source.'
      USING ERRCODE = 'MVL08';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_text_fixed" BEFORE UPDATE OF "raw_content" ON "sources" FOR EACH ROW WHEN (OLD."origin" <> 'mirror') EXECUTE FUNCTION minerval_source_text_fixed();
