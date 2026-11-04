import { useNavigate } from "@tanstack/react-router";
import { githubSetupAction } from "./github-setup-action";
import { useStartGitHubFlow } from "./use-start-github-flow";
import type { SetupStepId } from "./setup-steps";
import type { loadSetupChecklist } from "./setup-checklist.functions";

type Checklist = Awaited<ReturnType<typeof loadSetupChecklist>>;

/** What each step does when run: the page that lets the person do it, or, for GitHub, the OAuth
 * flow itself, which comes back to the Workspace home. */
export function useSetupStepActions(workspaceSlug: string, checklist: Checklist) {
  const navigate = useNavigate();
  const startFlow = useStartGitHubFlow();
  const params = { workspaceSlug };

  const actions: Record<SetupStepId, () => Promise<void>> = {
    github: async () => {
      // A connection already made is looked at in Settings, not started again.
      if (checklist.githubStatus === "connected") {
        await navigate({
          to: "/w/$workspaceSlug/settings",
          params,
          search: { section: "integrations" },
        });
        return;
      }
      const action = githubSetupAction(checklist.githubStatus);
      if (action) await startFlow(action);
    },
    agent: () =>
      navigate({
        to: "/w/$workspaceSlug/members",
        params,
        search: { memberType: "agent", setup: "create-agent" },
      }),
    computer: () => navigate({ to: "/w/$workspaceSlug/computers", params }),
  };
  return actions;
}
