SET lock_timeout = '5s';

-- The modes, as a CHECK rather than a Postgres enum (as every value set in this schema is).
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_onboarding_mode_check" CHECK ("onboardingMode" IN ('assistant', 'agent', 'off')) NOT VALID;

ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_onboarding_mode_check";

-- Agent mode needs an Agent; the other modes have none. Every existing row is `assistant` with no
-- Agent, so the constraint holds from the start.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_onboarding_check" CHECK (("onboardingMode" = 'agent') = ("onboardingAgentId" IS NOT NULL)) NOT VALID;

ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_onboarding_check";

RESET lock_timeout;
