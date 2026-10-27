-- The Agent profile panel gained its Apps and Chat tabs after this check was written, so a saved
-- order holding either was rejected and every drag of its tabs snapped back. The check now lists
-- all six (AGENT_PROFILE_TABS).
ALTER TABLE "workspace_member_preferences"
  DROP CONSTRAINT "workspace_member_preferences_agentProfileTabOrder_check",
  ADD CONSTRAINT "workspace_member_preferences_agentProfileTabOrder_check"
    CHECK ("agentProfileTabOrder" <@ ARRAY['profile', 'activity', 'chat', 'reminders', 'workspace', 'apps']::TEXT[]);
