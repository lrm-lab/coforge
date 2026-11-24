SET lock_timeout = '5s';
ALTER TABLE "workspace_member_preferences"
  VALIDATE CONSTRAINT "workspace_member_preferences_agentProfileTabOrder_check";
RESET lock_timeout;
