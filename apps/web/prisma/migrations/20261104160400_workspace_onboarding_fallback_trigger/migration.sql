-- migration-safety v1
-- checked: 2026-11-02T07:25:28.166Z  pg: 18.0  verdict: ok-with-lock-timeout
-- snapshot: 2026-11-02T02:44:37.622Z production
-- body-sha256: 2ea6cbfd646aa868d7f31780277c640b43166311cfd88331b80feb8774751225
-- table: "*" rows≈-1 size=0 lock=access-exclusive rewrite=yes statement=unrecognised statement
SET lock_timeout = '5s';

CREATE TRIGGER workspace_onboarding_agent_removed
  BEFORE UPDATE OF "onboardingAgentId" ON "workspaces"
  FOR EACH ROW
  WHEN (NEW."onboardingAgentId" IS NULL AND NEW."onboardingMode" = 'agent')
  EXECUTE FUNCTION workspace_onboarding_agent_removed();

RESET lock_timeout;
