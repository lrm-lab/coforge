-- migration-safety v1
-- checked: 2026-11-09T07:55:14.891Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-09T05:54:47.238Z production
-- body-sha256: a4523349e7684d889c61008b3f576096de7087c48d9eb892767d3726c68391b8
-- table: "computers" rows≈5 size=147456 lock=row-exclusive rewrite=yes statement=UPDATE
-- table: "computers" rows≈5 size=147456 lock=row-exclusive rewrite=yes statement=UPDATE
-- New cloud Computers are named `<owner>'s Default Cloud Computer` and
-- `<owner>'s New Cloud Computer`. Rename the existing ones that still read as the old generated
-- name: the owner's username or nickname plus `的默认云电脑` / `的新建云电脑`, including a nickname
-- the owner changed after the Computer was created. A Computer whose display name no longer
-- matches its system name has been renamed by its owner and keeps both.

SET lock_timeout = '5s';

UPDATE "computers" AS computer
SET "name" = btrim(person."displayName") || '''s Default Cloud Computer',
    "displayName" = btrim(person."displayName") || '''s Default Cloud Computer'
FROM "users" AS person
WHERE computer."ownerId" = person."id"
  AND computer."kind" = 'cloud'
  AND computer."cloudSlot" = 'default'
  AND computer."name" = computer."displayName"
  AND computer."name" LIKE '%的默认云电脑';

UPDATE "computers" AS computer
SET "name" = btrim(person."displayName") || '''s New Cloud Computer',
    "displayName" = btrim(person."displayName") || '''s New Cloud Computer'
FROM "users" AS person
WHERE computer."ownerId" = person."id"
  AND computer."kind" = 'cloud'
  AND computer."cloudSlot" = 'extra'
  AND computer."name" = computer."displayName"
  AND computer."name" LIKE '%的新建云电脑';

RESET lock_timeout;
