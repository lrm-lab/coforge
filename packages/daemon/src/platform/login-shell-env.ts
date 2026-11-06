/**
 * Which variables the login-shell probe may hand to a Workspace Daemon child. The shell's
 * environment is the user's own terminal environment, so the allowlist is deliberately narrow:
 * proxy and locale settings every tool expects, plus credential-shaped names (`*_API_KEY`,
 * `*_TOKEN`, …) so provider configs that reference them (`$AIBERM_API_KEY` in a Pi
 * `models.json`) resolve the way they do in the user's terminal. Everything else — database
 * URLs, shell hooks, loader variables, CoForge's own injected `COFORGE_*` — stays out.
 */

/** Never imported, whatever else matches: every variable CoForge itself sets for its children. */
const DENIED_PREFIX = "COFORGE_";

const PROXY_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ftp_proxy",
]);

const EXACT_NAMES = new Set(["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES"]);

/** Credential-shaped suffixes, matched on the whole upper-case name. */
const CREDENTIAL_SUFFIXES = [
  "_API_KEY",
  "_APIKEY",
  "_API_SECRET",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_PASSWD",
  "_PRIVATE_KEY",
  "_SECRET_KEY",
  "_ACCESS_KEY",
  "_SESSION_KEY",
  "_CREDENTIAL",
  "_CREDENTIALS",
] as const;

export function isLoginShellEnvAllowed(name: string): boolean {
  if (name.startsWith(DENIED_PREFIX)) return false;
  if (PROXY_NAMES.has(name) || EXACT_NAMES.has(name) || name.startsWith("LC_")) return true;
  return CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** The allowlisted, defined entries of an environment, in its own order. */
export function filterLoginShellEnv(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && isLoginShellEnvAllowed(name)) filtered[name] = value;
  }
  return filtered;
}

/**
 * Serialized-size guard for the probe's result file: env is best-effort, PATH is not. An
 * oversized env is dropped whole rather than truncating the file the PATH parse depends on.
 */
const ENV_JSON_MAX_BYTES = 128 * 1024;

export function boundedLoginShellEnv(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env = filterLoginShellEnv(environment);
  return JSON.stringify(env).length <= ENV_JSON_MAX_BYTES ? env : {};
}
