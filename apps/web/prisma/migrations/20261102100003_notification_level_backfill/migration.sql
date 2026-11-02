-- migration-safety v1
-- checked: 2026-11-02T08:24:22.471Z  pg: 18.0  verdict: ok
-- snapshot: 2026-11-02T02:44:37.622Z production
-- body-sha256: cfe74ef1347496f18f9d6ba1bad2b70233f57136dfdbba54c5adb878edbec771
-- table: "conversation_members" rows≈-1 size=0 lock=row-exclusive rewrite=yes statement=UPDATE
SET lock_timeout = '5s';

UPDATE "conversation_members" SET "notificationLevel" = 'muted' WHERE "channelMuted" = true;

RESET lock_timeout;
