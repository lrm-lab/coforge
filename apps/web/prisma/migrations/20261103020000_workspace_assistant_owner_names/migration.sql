-- migration-safety v1
-- checked: 2026-11-03T07:12:41.155Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-03T03:32:05.486Z production
-- body-sha256: 88833f8e07d32cce3bb5abf1858a935f4e2d79d16d9c079c321442c160919e43
-- table: "agents" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
-- Names every platform assistant for its owner, as a new one is: "{name}的助手", or
-- "{name}'s Assistant" when the owner saved English as their interface language
-- (user_preferences.language). Only a name still exactly "通用助手" changes; a renamed assistant
-- keeps its name. A blank display name falls back to 'Unnamed' (UNNAMED_PERSON_NAME in
-- src/lib/human-label.ts, which SQL cannot import), and the name is cut to the Agent display-name
-- limit (80) less the suffix: 3 characters of "的助手", 12 of "'s Assistant".
UPDATE "agents" AS a
SET "displayName" = CASE
  WHEN o."english" THEN left(o."name", 68) || '''s Assistant'
  ELSE left(o."name", 77) || '的助手'
END
FROM (
  SELECT
    u."id",
    coalesce(nullif(btrim(u."displayName"), ''), 'Unnamed') AS "name",
    coalesce(p."language" = 'en', false) AS "english"
  FROM "users" AS u
  LEFT JOIN "user_preferences" AS p ON p."userId" = u."id"
) AS o
WHERE o."id" = a."ownerId"
  AND a."systemKind" = 'workspace-assistant'
  AND a."displayName" = '通用助手';
