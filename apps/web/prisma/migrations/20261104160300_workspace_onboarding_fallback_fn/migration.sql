-- A hard-deleted Agent sets `onboardingAgentId` NULL through the foreign key; the Workspace then
-- falls back to the platform assistant's welcome in the same statement (the trigger of the next
-- migration), so `workspaces_onboarding_check` holds.
CREATE FUNCTION workspace_onboarding_agent_removed() RETURNS trigger AS $$
BEGIN
  NEW."onboardingMode" := 'assistant';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
