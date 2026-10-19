import type { GitHubCredentialResponse } from "@lrm/coforge-sdk/agent";
import { delimiter, dirname, resolve } from "node:path";
import { CliError } from "./cli-error";

type CredentialLookup = () => Promise<GitHubCredentialResponse>;

/** How long to wait before asking again for a credential the cloud could not issue right now. At
 * worst three lookups that each run to their 12-second deadline (a transport timeout) and these
 * waits hold `git push` about 38 seconds. */
const RETRY_DELAYS_MS = [500, 1_500] as const;

export type CredentialRetry = { sleep?: (ms: number) => Promise<void> };

/** `lookup`, asked again after a short wait while its failure says it is retryable (a 5xx or a
 * transport failure: see `githubCredential` in `local-client.ts`). A refusal (the GitHub
 * connection needs a person) is final. */
async function lookupWithRetry(lookup: CredentialLookup, retry: CredentialRetry) {
  const sleep = retry.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await lookup();
    } catch (error) {
      if (!(error instanceof CliError && error.retryable === true)) throw error;
      await sleep(delay);
    }
  }
  return lookup();
}

/**
 * Normalizes a GitHub path-like segment (a credential-helper `path` field, or the tail of a
 * parsed remote URL - see `git-prepare-commit-msg.ts`) to its `owner/repo` shape, or `null` when
 * it is not one.
 */
export function githubOwnerRepoName(candidate: string): string | null {
  const path = candidate.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : null;
}

/** Implements Git's credential-helper protocol for HTTPS repositories on github.com. */
export async function runGitHubCredentialHelper(
  operation: string | undefined,
  input: string,
  lookup: CredentialLookup,
  retry: CredentialRetry = {},
) {
  if (operation === "store" || operation === "erase") return "";
  if (operation !== "get") throw new Error("GitHub credential helper operation is invalid");
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com") return "";
  const rawPath = fields.get("path");
  const path = rawPath ? githubOwnerRepoName(rawPath) : null;
  if (!path) throw new Error("GitHub credential repository is invalid");
  const credential = await lookupWithRetry(lookup, retry);
  return `username=${credential.username}\npassword=${credential.password}\n\n`;
}

/** Runs the host's GitHub CLI with a fresh user token scoped to this child process. */
export async function runGitHubCli(
  args: readonly string[],
  lookup: CredentialLookup,
  environment: Record<string, string | undefined> = Bun.env,
  executablePath = process.execPath,
  retry: CredentialRetry = {},
) {
  const wrapperDirectory = resolve(dirname(executablePath));
  const path = (environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && resolve(entry) !== wrapperDirectory)
    .join(delimiter);
  const executable = Bun.which("gh", { PATH: path });
  if (!executable) throw new Error("GitHub CLI is not installed");
  const credential = await lookupWithRetry(lookup, retry);
  const process = Bun.spawn([executable, ...args], {
    env: { ...environment, PATH: path, GH_TOKEN: credential.password },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return process.exited;
}
