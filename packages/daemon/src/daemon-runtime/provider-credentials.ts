import { join, resolve } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/** Where a runtime's login is kept and what moves it elsewhere: the one table the credential
 * ledger (whose sign-in an Agent uses) and the disk watch (where to look for a new login) read. */
type ProviderCredentials = Readonly<{
  /** The environment variable that puts the login's directory somewhere else. */
  dirEnv: string;
  /** The environment variable holding a key that replaces the login. */
  keyEnv?: string;
  /** The directory under the home directory, and the file in it, that hold the login. */
  homeDir: string;
  file: string;
  /** The login also lives in a macOS Keychain item. */
  keychain?: true;
}>;

const PROVIDER_CREDENTIALS: Readonly<Record<string, ProviderCredentials>> = {
  [RUNTIME_PROVIDER.CLAUDE_CODE]: {
    dirEnv: "CLAUDE_CONFIG_DIR",
    keyEnv: "ANTHROPIC_AUTH_TOKEN",
    homeDir: ".claude",
    file: ".credentials.json",
    keychain: true,
  },
  [RUNTIME_PROVIDER.CODEX]: {
    dirEnv: "CODEX_HOME",
    keyEnv: "OPENAI_API_KEY",
    homeDir: ".codex",
    file: "auth.json",
  },
  [RUNTIME_PROVIDER.GROK]: { dirEnv: "GROK_HOME", homeDir: ".grok", file: "auth.json" },
};

export type CredentialEnv = Readonly<Record<string, string | undefined>>;

export type CredentialHome = Readonly<{
  env: CredentialEnv;
  homeDir: string;
  platform: string;
  cwd: string;
}>;

export type CredentialPart =
  | Readonly<{ kind: "file"; path: string }>
  | Readonly<{ kind: "keychain"; service: string }>;

const value = (env: CredentialEnv, name: string): string | undefined =>
  env[name]?.trim() || undefined;

/** Whether an environment gives the runtime a login of its own: another home directory, another
 * login directory, or a key in place of the login. */
export function hasOwnLogin(provider: string, env: CredentialEnv): boolean {
  const known = PROVIDER_CREDENTIALS[provider];
  return ["HOME", ...(known ? [known.dirEnv] : []), ...(known?.keyEnv ? [known.keyEnv] : [])].some(
    (name) => value(env, name),
  );
}

const homeOf = (home: CredentialHome): string =>
  value(home.env, "HOME") ??
  (home.platform === "win32" ? value(home.env, "USERPROFILE") : undefined) ??
  home.homeDir;

/** Claude Code's Keychain item, named after the config directory when one is set. */
function claudeKeychainService(env: CredentialEnv): string {
  const dir = value(env, "CLAUDE_SECURESTORAGE_CONFIG_DIR") ?? value(env, "CLAUDE_CONFIG_DIR");
  if (!dir) return "Claude Code-credentials";
  const digest = new Bun.CryptoHasher("sha256").update(dir.normalize("NFC")).digest("hex");
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}

/**
 * Where a runtime's login keeps its credentials, from the environment it runs in, as the reference
 * Computer's `credentialSourceFor` knows them; undefined for a runtime whose credentials are not
 * known, or one a key in the environment replaces.
 */
export function credentialPartsOf(
  provider: string,
  home: CredentialHome,
): readonly CredentialPart[] | undefined {
  const known = PROVIDER_CREDENTIALS[provider];
  if (!known || (known.keyEnv && value(home.env, known.keyEnv))) return undefined;
  const configured = value(home.env, known.dirEnv);
  const dir = configured ? resolve(home.cwd, configured) : join(homeOf(home), known.homeDir);
  const file = { kind: "file", path: join(dir, known.file) } as const;
  return known.keychain && home.platform === "darwin"
    ? [{ kind: "keychain", service: claudeKeychainService(home.env) }, file]
    : [file];
}
