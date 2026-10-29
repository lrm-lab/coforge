-- A comment on a video may point at a time in it: `video-timestamp {time}` (task #271). The check
-- only gains one anchor type; no row changes. Added NOT VALID, so the swap holds its lock for no
-- scan, and validated in the next migration. Safe to run again: the check is dropped if present.
--
-- Rollback: code from before this change reads a `video-timestamp` anchor as none, so such a
-- comment shows as one on the whole video and the CLI prints no anchor for it. Leave this check in
-- place on rollback; narrowing it again fails while any video comment keeps a time.
ALTER TABLE "attachment_comments" DROP CONSTRAINT IF EXISTS "attachment_comments_anchor_check";
ALTER TABLE "attachment_comments" ADD CONSTRAINT "attachment_comments_anchor_check" CHECK (
  ("anchorType" IS NULL AND "anchorData" IS NULL)
  OR (
    "anchorType" IS NOT NULL
    AND "anchorType" IN ('md-section', 'lines', 'csv-rows', 'html-region', 'video-timestamp')
    AND "anchorData" IS NOT NULL
    AND jsonb_typeof("anchorData") = 'object'
    AND octet_length("anchorData"::text) <= 4096
  )
) NOT VALID;
