/** The surface that names and stops a Workspace's processes, as the package exports them: the
 * launchd jobs, the Agent process sweep, a Workspace's launchd identity and its state directory.
 * Split out of `daemon-public-api.ts` when that file reached its size limit (task #726); the
 * Daemon's own stop budget lives here too, because a caller that stops a Workspace needs it. */
export { launchdJobs } from "#src/platform/launchd-job";
export { stopWorkspaceAgentProcesses } from "#src/platform/linux-agent-processes";
export { workspaceLaunchdIdentity } from "#src/supervisor/launchd-workspace-instance";
export { workspaceStateDirectory } from "#src/supervisor/workspace-instance";
