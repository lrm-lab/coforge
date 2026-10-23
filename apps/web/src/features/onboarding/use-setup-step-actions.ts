import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  startGitHubConnection,
  startGitHubInstallation,
  startGitHubReauthorization,
} from "#src/features/integrations/github.functions";
import type { SetupStepId } from "./setup-steps";
import type { loadSetupChecklist } from "./setup-checklist.functions";

type Checklist = Awaited<ReturnType<typeof loadSetupChecklist>>;

/** What each step does when run: the page that lets the person do it, or, for GitHub, the OAuth
 * flow itself, which comes back to the Workspace home. */
export function useSetupStepActions(workspaceSlug: string, checklist: Checklist) {
  const navigate = useNavigate();
  const connect = useServerFn(startGitHubConnection);
  const reauthorize = useServerFn(startGitHubReauthorization);
  const install = useServerFn(startGitHubInstallation);
  const params = { workspaceSlug };

  const actions: Record<SetupStepId, () => Promise<void>> = {
    assistant: async () => {
      const dmId = checklist.assistantConversationId;
      await (dmId
        ? navigate({ to: "/w/$workspaceSlug/dm/$dmId", params: { ...params, dmId } })
        : navigate({ to: "/w/$workspaceSlug", params }));
    },
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
      const start =
        checklist.githubStatus === "reauthorize"
          ? reauthorize
          : checklist.githubStatus === "pending_installation"
            ? install
            : connect;
      window.location.assign((await start({ data: { returnTo: "home" } })).url);
    },
    agent: () =>
      navigate({
        to: "/w/$workspaceSlug/members",
        params,
        search: { memberType: "agent", setup: "create-agent" },
      }),
    task: () => navigate({ to: "/w/$workspaceSlug/tasks", params }),
    computer: () => navigate({ to: "/w/$workspaceSlug/computers", params }),
    invite: () =>
      navigate({
        to: "/w/$workspaceSlug/members",
        params,
        search: { memberType: "human", setup: "invite" },
      }),
  };
  return actions;
}
