import { posix, win32 } from "node:path";

/**
 * Where the Computer keeps its per-server login credentials, and the one filename a server's
 * login has, shared so the Coordinator's `retire-session` resolves the same path the
 * Computer's `FileCredentialStore` wrote (task #417).
 */

export type PathEnvironment = Readonly<Record<string, string | undefined>>;

export function joinUserDirectory(
  input: { platform: NodeJS.Platform; homeDirectory: string },
  ...parts: string[]
): string {
  return joinPlatformDirectory(input.platform, input.homeDirectory, ".coforge", ...parts);
}

export function joinPlatformDirectory(
  platform: NodeJS.Platform,
  base: string,
  ...parts: string[]
): string {
  if (platform === "win32") return win32.join(base, ...parts);
  if (platform === "linux" || platform === "darwin") {
    return posix.join(base, ...parts);
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** The Computer's credentials directory, honoring `COFORGE_COMPUTER_CREDENTIALS_DIR` and
 * `COFORGE_COMPUTER_HOME` before the platform default. */
export function resolveComputerCredentialsDirectory(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: PathEnvironment;
}): string {
  const credentialsDirectory = input.environment.COFORGE_COMPUTER_CREDENTIALS_DIR;
  if (credentialsDirectory) return credentialsDirectory;
  const computerHome = input.environment.COFORGE_COMPUTER_HOME;
  if (computerHome) return joinPlatformDirectory(input.platform, computerHome, "credentials");
  return joinUserDirectory(input, "computer", "credentials");
}

/** The one credential filename a `serverHttpUrl` login has — `<hostname>[-<port>].json` — so a
 * staging login beside a production one is never picked by mistake. */
export function computerCredentialFilename(serverUrl: string): string {
  const url = new URL(serverUrl);
  const server = url.hostname.toLowerCase() + (url.port ? `-${url.port}` : "");
  return `${server}.json`;
}
