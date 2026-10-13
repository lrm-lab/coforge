-- DataMigration: `displayName` becomes the one name a person has. A nickname already set is kept
-- as it is; a person with none (or only whitespace) takes their full name, trimmed; one with
-- neither stays unnamed and is asked at their next sign-in. `\s` trims tabs and newlines as the
-- app's `trim()` does, which `BTRIM` (spaces only) would not.
UPDATE "users"
   SET "displayName" = NULLIF(regexp_replace("fullName", '^\s+|\s+$', '', 'g'), '')
 WHERE NULLIF(regexp_replace("displayName", '^\s+|\s+$', '', 'g'), '') IS NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "fullName";
