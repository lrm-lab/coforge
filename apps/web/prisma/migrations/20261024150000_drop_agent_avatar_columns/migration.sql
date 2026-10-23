-- Destructive: drops "agents"."avatarObjectKey" and "agents"."avatarContentType".
-- Nothing reads them since Agent pictures became mascots (avatarMascot, migration
-- 20261024110100_agent_mascot), and no row references them: verified 2026-10-23 on staging and
-- production, where the stored objects were deleted.
-- Approved by Frank to drop both in one step, accepting that the previous build, which still
-- selects them, errors on Agent queries in the short window between migrate and the new Web
-- start, and that it cannot be rolled back to without re-adding the columns.
ALTER TABLE "agents" DROP COLUMN "avatarObjectKey",
DROP COLUMN "avatarContentType";
