import { useServerFn } from "@tanstack/react-start";
import {
  startGitHubConnection,
  startGitHubInstallation,
  startGitHubReauthorization,
} from "#src/features/integrations/github.functions";
import type { GitHubStepAction } from "./github-step";

/** Starts the GitHub flow an action names and leaves for GitHub; the callback comes back to the
 * Workspace home. Rejects when the flow could not be started. */
export function useStartGitHubFlow(): (action: GitHubStepAction) => Promise<void> {
  const connect = useServerFn(startGitHubConnection);
  const install = useServerFn(startGitHubInstallation);
  const reauthorize = useServerFn(startGitHubReauthorization);
  const flows = { connect, install, reauthorize };
  return async (action) => {
    const { url } = await flows[action]({ data: { returnTo: "home" } });
    window.location.assign(url);
  };
}
