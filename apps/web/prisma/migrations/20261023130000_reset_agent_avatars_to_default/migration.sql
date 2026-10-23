-- Every Agent now shows the platform default picture unless its creator uploads one. Agents
-- created before that were each given a stored copy of a pool picture, and nobody had uploaded
-- their own, so clear every Agent's avatar once: each falls back to the default. The stored
-- objects these rows named are no longer referenced and are not removed here.
UPDATE "agents"
SET "avatarObjectKey" = NULL, "avatarContentType" = NULL
WHERE "avatarObjectKey" IS NOT NULL OR "avatarContentType" IS NOT NULL;
