import { join } from "node:path";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { piAgentDirectory } from "@lrm/coforge-anvil/pi";
import { fileStatCacheKey } from "./runtime-inventory-cache";
import { piRuntimeHost } from "./pi/host";
import {
  externalCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProbe,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";

export function piCacheKeyPaths(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const agentDir = piAgentDirectory(environment, piRuntimeHost);
  return [join(agentDir, "models.json"), join(agentDir, "auth.json")];
}

/**
 * What a provider's cached catalog was read from: for most, the executable's mtime+size; for Pi,
 * its config; and for Antigravity, where `agy models` answers per account rather than per install.
 */
export async function catalogCacheKeyFor(
  provider: RuntimeProvider,
  probe: ExternalCodeAgentProbe,
  searchPath: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  version: string | undefined,
): Promise<string | undefined> {
  if (provider === RUNTIME_PROVIDER.PI) return fileStatCacheKey(piCacheKeyPaths(environment));
  const agent = externalCodeAgent[provider as ExternalCodeAgentProvider];
  if (!agent) return undefined;
  const executable = await resolveExternalCodeAgentExecutable(
    agent,
    probe,
    searchPath,
    environment,
    platform,
  );
  if (!executable) return undefined;
  const install = await fileStatCacheKey([executable]);
  if (!install) return undefined;
  if (provider !== RUNTIME_PROVIDER.ANTIGRAVITY) return install;
  // The account decides the model list, and its version can change what the account offers even
  // when an installer keeps the executable's mtime+size. Neither a refreshed token nor a rewritten
  // credential file changes who is signed in, so the account - not the file's stat - is the key.
  return `${version ?? "unknown"}|${install}|${await antigravityAccount(environment)}`;
}

/** Who `agy` is signed in as, or that nobody is; what its model list depends on. */
async function antigravityAccount(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const home = environment.HOME ?? environment.USERPROFILE;
  if (!home) return "unknown";
  const gemini = join(home, ".gemini");
  const account = await Bun.file(join(gemini, "google_account_id"))
    .text()
    .catch(() => "");
  if (account.trim()) return account.trim();
  const signedIn = await Bun.file(join(gemini, "oauth_creds.json")).exists();
  return signedIn ? "credentials" : "signed-out";
}
