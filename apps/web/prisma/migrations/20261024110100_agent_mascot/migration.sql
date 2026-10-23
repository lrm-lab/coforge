-- Agents no longer have uploaded pictures: each shows one of the platform mascots, which its
-- creator picks (`avatarMascot`, null = the mascot its id chooses). Every upload is discarded.
-- Expand only: "avatarObjectKey" and "avatarContentType" stay (unread) so the previous Web build,
-- which still selects them, keeps working while deploy migrates before starting the new build
-- and if a failed deploy rolls back to it. A later migration drops them once no running build
-- reads them; the stored image objects they name are not removed.
ALTER TABLE "agents" ADD COLUMN "avatarMascot" TEXT;
