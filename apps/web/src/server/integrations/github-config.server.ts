import { AppError } from "#src/lib/app-error";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { GitHubConnection, type GitHubConfig } from "./github-connection.server";

const GITHUB_APP_SLUG = /^[a-z0-9-]+$/;

export async function readGitHubConfig(
  env: Record<string, string | undefined> = Bun.env,
): Promise<GitHubConfig | null> {
  const clientId = env.COFORGE_GITHUB_CLIENT_ID?.trim();
  if (!clientId) return null;
  const clientSecret = await secret(env, "COFORGE_GITHUB_CLIENT_SECRET");
  const encryptionKey = await secret(env, "COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY");
  if (!clientSecret || !encryptionKey) return null;
  // Optional: existing deployments have no webhook configured yet. The webhook route
  // returns 503 until an operator sets this, independent of the OAuth connection flow.
  const webhookSecret = (await secret(env, "COFORGE_GITHUB_WEBHOOK_SECRET")) || null;
  const appId = Number(env.COFORGE_GITHUB_APP_ID);
  const appSlug = env.COFORGE_GITHUB_APP_SLUG?.trim() ?? "";
  const callbackUrl = new URL(env.COFORGE_GITHUB_CALLBACK_URL ?? "");
  if (
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    !GITHUB_APP_SLUG.test(appSlug) ||
    !/^[0-9a-f]{64}$/i.test(encryptionKey) ||
    callbackUrl.protocol !== "https:" ||
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.search ||
    callbackUrl.hash ||
    callbackUrl.pathname !== "/api/integrations/github/callback"
  )
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  return {
    appId,
    clientId,
    clientSecret,
    appSlug,
    callbackUrl: callbackUrl.toString(),
    encryptionKey: Uint8Array.from(Buffer.from(encryptionKey, "hex")),
    webhookSecret,
  };
}

export async function configuredGitHub() {
  const config = await readGitHubConfig();
  if (!config) return null;
  const db = requireDatabaseClient();
  return {
    config,
    connection: new GitHubConnection(db, config),
  };
}

/**
 * `Name <email>`: a name of printable characters without `<`, `>` or edge whitespace, one space,
 * and an email with no whitespace or angle brackets and a dotted domain. One line only, so the
 * value can never smuggle a second trailer into the message.
 */
const COMMIT_CO_AUTHOR =
  /^[^\s<>\p{Cc}](?:[^<>\p{Cc}]*[^\s<>\p{Cc}])? <[^\s<>@]+@[^\s<>@.]+(?:\.[^\s<>@.]+)+>$/u;
const loggedInvalidCoAuthors = new Set<string>();

/**
 * The co-author an Agent's commit names in its `Co-authored-by` trailer
 * (`github-commit-trailers.server.ts`), from `COFORGE_COMMIT_COAUTHOR` as one `Name <email>` value,
 * e.g. `CoForge <coforge@example.com>`. It is a regular GitHub user account, not the GitHub App's
 * `[bot]` account: GitHub shows a bot co-author without a profile or hovercard. Not a secret, and
 * per environment. Unset or blank means no trailer; a malformed value is logged once and treated
 * as unset rather than throwing, so a typo never breaks an Agent's commit.
 */
export function readCommitCoAuthor(
  env: Record<string, string | undefined> = Bun.env,
): string | null {
  const value = env.COFORGE_COMMIT_COAUTHOR?.trim() ?? "";
  if (!value) return null;
  if (COMMIT_CO_AUTHOR.test(value) && !/^co-authored-by:/i.test(value)) return value;
  if (!loggedInvalidCoAuthors.has(value)) {
    loggedInvalidCoAuthors.add(value);
    console.warn(
      JSON.stringify({
        event: "github.commit_coauthor_invalid",
        variable: "COFORGE_COMMIT_COAUTHOR",
      }),
    );
  }
  return null;
}

async function secret(env: Record<string, string | undefined>, name: string) {
  const inline = env[name]?.trim();
  const path = env[`${name}_FILE`]?.trim();
  if (inline && path) throw new AppError("TEMPORARILY_UNAVAILABLE");
  if (!path) return inline;
  try {
    return (await Bun.file(path).text()).trim();
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  }
}
