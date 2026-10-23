-- A person's avatar is now one of four cartoon people (`person-1` to `person-4`); the thirty
-- portrait photos (`portrait-01` to `portrait-30`) are no longer shipped. Whoever chose one keeps a
-- preset, mapped by `(NN - 1) % 4 + 1` so the choices spread over the four people. Data only: no
-- schema change. Uploaded photos (any other "avatarObjectKey") and people with no avatar are left
-- alone; those show the cartoon person their id chooses, resolved by the app and never stored.
--
-- Deployment plan: data only and fast. The deploy applies it before the new Web starts; the lossy
-- 30 -> 4 mapping was approved by Frank. If the new build is rolled back, the previous build shows
-- initials for the migrated users (see below).
--
-- Rollback and forward compatibility: the 30 -> 4 mapping is irreversible (the original portrait
-- is not recoverable), so a rollback restores no one's earlier choice. A build from before this
-- change resolves `preset:person-N` to nothing (that build ships no such preset), so those people
-- show an initial, and it references portrait files this change deletes from `public/avatars`.
-- Roll back by redeploying this change's build, not by reverting the data. Apply this migration
-- before the new build serves traffic; a new build reads both old and new references.
UPDATE "users"
SET "avatarObjectKey" = 'preset:person-' || (((substring("avatarObjectKey" from 17)::int - 1) % 4) + 1)
WHERE "avatarObjectKey" ~ '^preset:portrait-[0-9]{2}$';
