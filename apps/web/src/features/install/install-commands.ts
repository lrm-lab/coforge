/** The two published bootstrap entry points, rooted at whichever deployment is being used.
 * Both consumers derive their text from here so neither can drift back to a fixed host. */
export function installCommands(origin: string): {
  posix: string;
  windows: string;
} {
  return {
    posix: `curl -fsSL ${origin}/computer/install.sh | sh`,
    windows: `irm ${origin}/computer/install.ps1 | iex`,
  };
}

/** Explicit sign-in for users who want to authorize separately from setup. */
export function loginCommand(): string {
  return `coforge-computer login`;
}

/** Join one Workspace; setup requests device-code authorization when credentials are missing. */
export function setupCommand(workspaceSlug: string): string {
  return `coforge-computer setup --workspace ${workspaceSlug}`;
}

/** Install and join in one paste. install.sh runs setup through the installed shim, so the POSIX
 * command needs no PATH change; install.ps1 runs in-process and updates the session's PATH, so the
 * Windows setup can follow as a plain second line. */
export function connectionCommands(origin: string, workspaceSlug: string | null) {
  const commands = installCommands(origin);
  if (!workspaceSlug) return commands;
  return {
    posix: `${commands.posix} -s -- --workspace ${workspaceSlug}`,
    windows: `${commands.windows}\n${setupCommand(workspaceSlug)}`,
  };
}
