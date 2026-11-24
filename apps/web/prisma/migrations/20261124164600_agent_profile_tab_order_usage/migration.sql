-- migration-safety v1
-- checked: 2026-11-24T08:46:48.140Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-24T06:03:34.229Z production
-- body-sha256: 65653c1cb4ecbb8e2d8f8d1cf0f8cadd5d625f11652ed837752539115b5f678d
-- table: "workspace_member_preferences" rows≈-1 size=32768 lock=access-exclusive rewrite=no statement=ALTER TABLE DROP CONSTRAINT
SET lock_timeout = '5s';
ALTER TABLE "workspace_member_preferences"
  DROP CONSTRAINT "workspace_member_preferences_agentProfileTabOrder_check",
  ADD CONSTRAINT "workspace_member_preferences_agentProfileTabOrder_check"
    CHECK ("agentProfileTabOrder" <@ ARRAY['profile', 'activity', 'chat', 'reminders', 'workspace', 'apps', 'usage']::TEXT[]) NOT VALID;
RESET lock_timeout;
