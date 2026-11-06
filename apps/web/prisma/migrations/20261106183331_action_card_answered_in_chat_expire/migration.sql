-- migration-safety v1
-- checked: 2026-11-06T18:33:31.283Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-06T17:40:08.153Z production
-- body-sha256: 5159709e20bf216d6917fdbf0225a2a515f6ab4e79455fa77beea2c145442f79
-- table: "action_cards" rows≈27 size=131072 lock=row-exclusive rewrite=yes statement=UPDATE
-- task #624: rows still carrying the `answered_in_chat` state #616 removed read as expired; the
-- rewrite lets the contract step drop the state and, next release, its two columns. Safe under the
-- previous build: it maps the state to expired too, so the window before the swap sees only
-- `expired` rows.
-- Rollback: none needed — `expired` is the state those rows already read as.
SET lock_timeout = '5s';
UPDATE "action_cards" SET "state" = 'expired' WHERE "state" = 'answered_in_chat';
RESET lock_timeout;
