import { terminalText } from "#src/terminal-output";
import type { SetupResult } from "#src/setup/computer-setup";

export function formatWorkspaceServerUrl(serverUrl: string, workspaceSlug: string): string {
  try {
    const base = serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
    return new URL(`w/${encodeURIComponent(workspaceSlug)}`, base).toString();
  } catch {
    return `${serverUrl.replace(/\/+$/, "")}/w/${encodeURIComponent(workspaceSlug)}`;
  }
}

export function writeSetupResult(
  writeLine: (line: string) => void,
  result: SetupResult,
  json: boolean,
): void {
  const workspaceUrl = result.serverUrl
    ? formatWorkspaceServerUrl(result.serverUrl, result.workspace.slug)
    : undefined;
  if (json) {
    writeLine(
      JSON.stringify({
        ok: true,
        workspace: result.workspace,
        config_path: result.configPath,
        ...(result.serverUrl ? { server_url: result.serverUrl } : {}),
        ...(workspaceUrl ? { workspace_url: workspaceUrl } : {}),
        server_registration_created: true,
        daemon_started: !result.daemonStillStarting,
        ...(result.daemonStillStarting ? { daemon_still_starting: true } : {}),
      }),
    );
    return;
  }
  writeLine("CoForge Computer setup complete");
  writeLine(
    `Workspace:             ${terminalText(result.workspace.name)} (${terminalText(result.workspace.slug)})`,
  );
  writeLine(`Configuration saved:   ${terminalText(result.configPath)}`);
  writeLine("Computer:              registered");
  writeLine(
    result.daemonStillStarting
      ? "Daemon:                still starting; run 'coforge-computer status' to follow it"
      : "Daemon:                started",
  );
  if (workspaceUrl) {
    writeLine(`Server:                ${terminalText(workspaceUrl)}`);
  }
}
