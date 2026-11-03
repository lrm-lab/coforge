-- A soft-deleted artifact releases its name: the home's uniqueness only covers live rows.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "artifacts_workspaceId_homeKey_name_key";
RESET lock_timeout;
