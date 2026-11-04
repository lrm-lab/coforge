import type { getGitHubConnection } from "#src/features/integrations/github.functions";

/** The viewer's GitHub connection state, as `getGitHubConnection` reports it. */
type GitHubSetupStatus = Awaited<ReturnType<typeof getGitHubConnection>>["status"];

/** Which GitHub flow the setup checklist's GitHub row starts. */
export type GitHubSetupAction = "connect" | "install" | "reauthorize";

/** The one status-to-flow mapping; `null` when there is no flow to start: GitHub is not
 * configured, or the viewer is connected. */
export function githubSetupAction(status: GitHubSetupStatus): GitHubSetupAction | null {
  switch (status) {
    case "disconnected":
      return "connect";
    case "pending_installation":
      return "install";
    case "reauthorize":
      return "reauthorize";
    case "unconfigured":
    case "connected":
      return null;
  }
}
