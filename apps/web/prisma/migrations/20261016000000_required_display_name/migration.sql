-- A person always has a name (as Slack requires one) and is never shown by their username.
-- First sign-in is now marked by `welcomedAt` instead of a missing display name.

ALTER TABLE "users" ADD COLUMN "welcomedAt" TIMESTAMP(3);

-- Everyone who already has a name has been through first sign-in.
UPDATE "users"
SET "welcomedAt" = "createdAt"
WHERE NULLIF(btrim("displayName"), '') IS NOT NULL;

-- Everyone else gets a name now, never their username: the local part of their email when it reads
-- as a name (not a phone number, at most 80 characters, as `initialDisplayName` decides at sign-up),
-- else a placeholder. They are still asked to confirm it at their next sign-in (`welcomedAt` stays
-- null).
UPDATE "users"
SET "displayName" = CASE
  WHEN NULLIF(btrim(split_part("email", '@', 1)), '') IS NULL THEN 'Unnamed'
  WHEN btrim(split_part("email", '@', 1)) ~ '^\+?[0-9 ().-]+$' THEN 'Unnamed'
  WHEN char_length(btrim(split_part("email", '@', 1))) > 80 THEN 'Unnamed'
  ELSE btrim(split_part("email", '@', 1))
END
WHERE NULLIF(btrim("displayName"), '') IS NULL;

ALTER TABLE "users" ALTER COLUMN "displayName" SET NOT NULL;
