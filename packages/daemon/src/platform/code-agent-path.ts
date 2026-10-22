import { readdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import { loginShellPathDirectories, supervisorStateDirectory } from "./login-shell-path-state";

export function codeAgentExecutableSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  /** Where the Coordinator keeps the PATH it imported from the login shell; a Workspace Daemon
   * knows it from its own process environment. */
  stateDirectory: string | undefined = supervisorStateDirectory(),
): string {
  const paths = platform === "win32" ? win32 : posix;
  const homeDirectory = environment.HOME ?? environment.USERPROFILE;
  const userDirectories = homeDirectory
    ? [
        paths.join(homeDirectory, ".local", "bin"),
        paths.join(homeDirectory, ".pi", "agent", "bin"),
        paths.join(homeDirectory, ".bun", "bin"),
        paths.join(homeDirectory, ".volta", "bin"),
        paths.join(homeDirectory, ".local", "share", "mise", "shims"),
        paths.join(homeDirectory, ".asdf", "shims"),
        // npm-installed code agents: a custom npm prefix, or one nvm-managed node per version.
        // Each exists check is cheap; nvm versions are globbed only when the manager is present.
        paths.join(homeDirectory, ".npm-global", "bin"),
        ...(() => {
          try {
            const nvmRoot = paths.join(homeDirectory, ".nvm", "versions", "node");
            return readdirSync(nvmRoot).map((version) => paths.join(nvmRoot, version, "bin"));
          } catch {
            return [];
          }
        })(),
      ]
    : [];
  const platformDirectories =
    platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : platform === "win32" && environment.APPDATA
        ? [paths.join(environment.APPDATA, "npm")]
        : ["/usr/local/bin"];
  // Current PATH first, then what the login shell added (rc-file installs), then the defaults.
  // Candidates found there still go through the usual executable validation and probe.
  const loginShellDirectories =
    platform === "win32" ? [] : loginShellPathDirectories(stateDirectory);
  return [environment.PATH, ...loginShellDirectories, ...userDirectories, ...platformDirectories]
    .filter((value): value is string => Boolean(value))
    .join(executablePathDelimiter(platform));
}

export function executablePathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ";" : ":";
}
