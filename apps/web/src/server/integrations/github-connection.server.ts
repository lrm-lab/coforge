import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { GitHubAuthorizationResult } from "#src/features/integrations/github-callback";
import { GitHubApi, GitHubUnauthorized, failureReason, type Http } from "./github-api.server";
import {
  pageSchema,
  idSchema,
  publicRepositorySchema,
  repositoriesSchema,
  userSchema,
} from "./github-account-shapes.server";
import { GitHubInstallationCache } from "./github-installation-cache.server";
import { GitHubRepositoryBrowser } from "./github-repository-browser.server";
import type { RepositorySelection } from "./github-repository-shapes.server";
import { GitHubSealedValues } from "./github-sealed-values.server";
import { GitHubUserTokens } from "./github-user-tokens.server";

export type GitHubConfig = {
  appId: number;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  appSlug: string;
  encryptionKey: Uint8Array<ArrayBuffer>;
  webhookSecret: string | null;
};

const REFRESH_THROTTLE_MS = 60_000;
const PROACTIVE_REFRESH_WINDOW_MS = 3_600_000;
// Module-level: configuredGitHub() builds a new GitHubConnection per request, so an
// instance field would never throttle anything.
const lastProactiveRefresh = new Map<string, number>();

/** Personal GitHub integration. Only its HTTP adapter handles bearer credentials. */
export class GitHubConnection {
  private readonly github: GitHubApi;
  private readonly sealed: GitHubSealedValues;
  private readonly tokens: GitHubUserTokens;
  private readonly installations: GitHubInstallationCache;
  private readonly browser: GitHubRepositoryBrowser;

  constructor(
    private readonly db: PrismaClient,
    private readonly config: GitHubConfig,
    http: Http = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.github = new GitHubApi(config, http);
    this.sealed = new GitHubSealedValues(config);
    this.tokens = new GitHubUserTokens(db, config, this.github, this.sealed, now);
    this.installations = new GitHubInstallationCache(
      db,
      this.github,
      { appId: config.appId, installUrl: this.installUrl },
      now,
    );
    this.browser = new GitHubRepositoryBrowser(this.github, {
      withToken: (userId, action) => this.tokens.withToken(userId, action),
      accessibleRepositories: (userId) => this.accessibleRepositories(userId),
    });
  }

  async begin(userId: string, mode: "connect" | "replace" | "reauthorize" = "connect") {
    const state = randomValue();
    const verifier = randomValue();
    await this.tokens.locked(userId, async (tx) => {
      const data = {
        stateHash: hash(state),
        verifier: await this.sealed.seal(
          userId,
          "oauth",
          JSON.stringify({
            verifier,
            expectedGithubUserId:
              mode === "reauthorize"
                ? (await tx.gitHubConnection.findUnique({ where: { userId } }))?.githubUserId
                : undefined,
          }),
        ),
        expiresAt: new Date(this.now() + 600_000),
      };
      await tx.gitHubAuthorization.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      state,
      code_challenge: hash(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), state };
  }

  beginInstallation() {
    const state = randomValue();
    const url = new URL(
      `https://github.com/apps/${this.config.appSlug}/installations/select_target`,
    );
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  async complete(
    userId: string,
    browserState: string,
    state: string,
    code: string,
  ): Promise<GitHubAuthorizationResult> {
    // Every `authorizationFailed(...)` below logs the stage and a short reason.
    if (!state || state.length > 256) return authorizationFailed("state", "state_invalid");
    if (!browserState) return authorizationFailed("state", "browser_state_missing");
    if (state !== browserState) return authorizationFailed("state", "browser_state_mismatch");
    if (code.length > 2048) return authorizationFailed("state", "code_too_long");
    // Commit consumption before external I/O. A later transaction abort must not
    // restore a usable verifier and permit replay of an already exchanged code.
    let rejection = "no_attempt";
    const verifier = await this.tokens.locked(userId, async (tx) => {
      const attempt = await tx.gitHubAuthorization.findUnique({ where: { userId } });
      if (!attempt || attempt.stateHash !== hash(state) || !attempt.verifier) return null;
      if (attempt.expiresAt.getTime() <= this.now() || !code) {
        await tx.gitHubAuthorization.delete({ where: { userId } });
        rejection = code ? "expired" : "no_code";
        return null;
      }
      await tx.gitHubAuthorization.update({ where: { userId }, data: { verifier: "" } });
      return attempt.verifier;
    });
    if (!verifier) return authorizationFailed("attempt", rejection);
    const result = await this.tokens.locked(userId, async (tx) => {
      const attempt = await tx.gitHubAuthorization.findUnique({ where: { userId } });
      // A disconnect or new begin between transactions cancels finalization.
      if (!attempt || attempt.stateHash !== hash(state) || attempt.verifier)
        return authorizationFailed("attempt", "cancelled");
      await tx.gitHubAuthorization.delete({ where: { userId } });
      if (attempt.expiresAt.getTime() <= this.now() || !code)
        return authorizationFailed("attempt", code ? "expired" : "no_code");
      // Consume failed exchanges too. Never replay a code after an ambiguous network result.
      let authorized;
      let stage = "open";
      try {
        const stored = JSON.parse(await this.sealed.open(userId, "oauth", verifier)) as {
          verifier?: string;
          expectedGithubUserId?: string;
        };
        stage = "exchange";
        const tokens = await this.github.exchange({
          code,
          redirect_uri: this.config.callbackUrl,
          code_verifier: stored.verifier ?? verifier,
        });
        stage = "user";
        const user = userSchema.parse(await this.github.api("/user", tokens.access_token));
        authorized = { tokens, user };
      } catch (error) {
        return authorizationFailed(stage, failureReason(error));
      }
      const { tokens, user } = authorized;
      const storedAuthorization = JSON.parse(await this.sealed.open(userId, "oauth", verifier)) as {
        expectedGithubUserId?: string;
      };
      if (
        storedAuthorization.expectedGithubUserId &&
        storedAuthorization.expectedGithubUserId !== String(user.id)
      )
        return "wrong_account" as const;
      const existing = await tx.gitHubConnection.findUnique({
        where: {
          clientId_githubUserId: { clientId: this.config.clientId, githubUserId: String(user.id) },
        },
      });
      if (existing && existing.userId !== userId) {
        authorizationFailed("owner", "github_account_taken");
        return "account_taken" as const;
      }
      const data = {
        clientId: this.config.clientId,
        githubUserId: String(user.id),
        login: user.login,
        ...(await this.tokens.storedTokens(userId, tokens)),
      };
      await tx.gitHubConnection.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
      return true;
    });
    if (result === true) {
      try {
        // The connection is already saved. A failed sync just leaves the
        // installation cache empty until the next sync (background refresh or Refresh button).
        await this.sync(userId);
      } catch {
        // Never log GitHub response bodies, tokens, or secrets.
      }
    }
    return result;
  }

  async status(userId: string) {
    const result = await this.tokens.withToken(userId, async (token, githubUserId) => {
      const user = userSchema.parse(await this.github.api("/user", token));
      if (String(user.id) !== githubUserId) throw new GitHubUnauthorized();
      return user.login;
    });
    return result.ok
      ? { status: "connected" as const, login: result.data, installUrl: this.installUrl }
      : { status: result.status, login: result.login, installUrl: this.installUrl };
  }

  /** Pure DB read. No GitHub I/O, and safe to call on every Settings mount. */
  async overview(userId: string) {
    const row = await this.db.gitHubConnection.findUnique({ where: { userId } });
    if (!row) return { status: "disconnected" as const, login: null, installUrl: this.installUrl };
    if (!row.credentials)
      return { status: "reauthorize" as const, login: row.login, installUrl: this.installUrl };
    this.maybeProactivelyRefresh(userId, row);
    const rows = await this.db.gitHubUserInstallation.findMany({ where: { userId } });
    const installations = rows
      .filter((item) => !item.suspended)
      .map((item) => ({
        id: item.installationId,
        login: item.accountLogin,
        repositorySelection: item.repositorySelection as "all" | "selected",
        suspended: item.suspended,
        configureUrl: item.configureUrl,
      }));
    return installations.length === 0
      ? {
          status: "pending_installation" as const,
          login: row.login,
          installUrl: this.installUrl,
          installations: [],
        }
      : {
          status: "connected" as const,
          login: row.login,
          installUrl: this.installUrl,
          installations,
        };
  }

  /**
   * Fetches /user and /user/installations (all pages) from GitHub in parallel, verifies
   * identity, and replaces the User's installation cache in one transaction. Returns the
   * same shape as overview(). Safe to call from a background refresh or a webhook-adjacent
   * manual "Refresh" action; never called on the hot settings-load path.
   */
  async sync(userId: string) {
    const result = await this.tokens.withToken(userId, async (token, githubUserId) => {
      const [user, installations] = await Promise.all([
        this.github.api("/user", token).then((value) => userSchema.parse(value)),
        this.installations.fetchAll(token),
      ]);
      if (String(user.id) !== githubUserId) throw new GitHubUnauthorized();
      return installations;
    });
    if (result.ok) await this.installations.replace(userId, result.data);
    return this.overview(userId);
  }

  async repositories(userId: string, installationId: number, page: number) {
    idSchema.parse(installationId);
    pageSchema.parse(page);
    const result = await this.tokens.withToken(userId, async (token) => {
      // This user-token endpoint checks BOTH personal access and App installation access.
      // Never replace it with /installation/repositories or an installation token.
      const data = repositoriesSchema.parse(
        await this.github.api(
          `/user/installations/${installationId}/repositories?per_page=30&page=${page}`,
          token,
        ),
      );
      return {
        repositories: data.repositories.map((item) => ({
          id: item.id,
          fullName: item.full_name,
          private: item.private,
          htmlUrl: `https://github.com/${item.full_name}`,
        })),
        hasMore: page * 30 < data.total_count,
      };
    });
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /**
   * Every repository the connected user can reach through a usable App installation.
   * Takes its installation list from sync(userId), so calling this also refreshes the cache.
   */
  async accessibleRepositories(userId: string) {
    const overview = await this.sync(userId);
    if (overview.status === "disconnected" || overview.status === "reauthorize")
      throw new AppError("ACCESS_DENIED");
    if (overview.status !== "connected") return [];
    const pagesPerInstallation = await Promise.all(
      overview.installations.map(async (installation) => {
        const pages = [await this.repositories(userId, installation.id, 1)];
        for (let page = 2; page <= 10000 && pages.at(-1)?.hasMore; page++)
          pages.push(await this.repositories(userId, installation.id, page));
        return pages.flatMap((page) =>
          page.repositories.map((repository) => ({
            ...repository,
            installationId: installation.id,
          })),
        );
      }),
    );
    return [
      ...new Map(
        pagesPerInstallation.flat().map((repository) => [repository.id, repository]),
      ).values(),
    ].sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  /**
   * Unauthenticated GitHub REST lookup for a public github.com repository.
   * Private or missing names never become a Project repository without a connection.
   */
  async lookupPublicRepository(fullName: string) {
    const name = z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(300)
      .parse(fullName);
    try {
      const metadata = publicRepositorySchema.parse(
        await this.github.request(`https://api.github.com/repos/${name}`, {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2026-03-10",
            "user-agent": "CoForge",
          },
        }),
      );
      if (metadata.private || metadata.full_name !== name) throw new AppError("ACCESS_DENIED");
      return {
        id: metadata.id,
        fullName: metadata.full_name,
        htmlUrl: metadata.html_url,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }
  }

  repositoryOverview(userId: string, repository: RepositorySelection) {
    return this.browser.repositoryOverview(userId, repository);
  }

  repositoryTree(userId: string, repository: RepositorySelection) {
    return this.browser.repositoryTree(userId, repository);
  }

  repositoryObject(
    userId: string,
    repository: RepositorySelection,
    target: { path: string; oid?: string },
  ) {
    return this.browser.repositoryObject(userId, repository, target);
  }

  repositoryDirectoryCommits(userId: string, repository: RepositorySelection, path: string) {
    return this.browser.repositoryDirectoryCommits(userId, repository, path);
  }

  repositoryRaw(userId: string, repository: RepositorySelection, path: string) {
    return this.browser.repositoryRaw(userId, repository, path);
  }

  /**
   * A current user token for one Agent-owned GitHub operation; never persisted by the caller.
   * Throws `ACCESS_DENIED` only when the person must reconnect GitHub (no connection, or one whose
   * authorization `withToken` cleared) and `TEMPORARILY_UNAVAILABLE` for anything thrown, even an
   * `ACCESS_DENIED` from a GitHub 403/404, which cleared nothing. Logs the failure, with its
   * reason, once.
   */
  async credential(userId: string) {
    const result = await this.tokens
      .withToken(userId, async (token, _githubUserId, row) => ({
        username: "x-access-token",
        password: token,
        expiresAt: row.expiresAt.toISOString(),
      }))
      .catch((error: unknown) => {
        throw credentialFailed(userId, "TEMPORARILY_UNAVAILABLE", failureReason(error));
      });
    if (!result.ok) throw credentialFailed(userId, "ACCESS_DENIED", result.status);
    return result.data;
  }

  async disconnect(userId: string) {
    await this.tokens.locked(userId, async (tx) => {
      await tx.gitHubAuthorization.deleteMany({ where: { userId } });
      await tx.gitHubConnection.deleteMany({ where: { userId } });
      await tx.gitHubUserInstallation.deleteMany({ where: { userId } });
    });
  }

  /**
   * If the cached token is close to expiry, kick off a refresh in the background without
   * blocking the (DB-only) overview() read. Throttled per userId so a burst of page loads
   * cannot fire concurrent refreshes.
   */
  private maybeProactivelyRefresh(
    userId: string,
    row: { expiresAt: Date; refreshExpiresAt: Date },
  ) {
    const now = this.now();
    if (row.expiresAt.getTime() - now >= PROACTIVE_REFRESH_WINDOW_MS) return;
    if (row.refreshExpiresAt.getTime() <= now) return;
    const last = lastProactiveRefresh.get(userId) ?? 0;
    if (now - last < REFRESH_THROTTLE_MS) return;
    lastProactiveRefresh.set(userId, now);
    void this.tokens.withToken(userId, async () => {}, PROACTIVE_REFRESH_WINDOW_MS).catch(() => {});
  }

  private get installUrl() {
    return `https://github.com/apps/${this.config.appSlug}/installations/new`;
  }
}

/**
 * The callback answers every failure with the same page, so this line is the only place the cause
 * shows. It names the stage and a short reason; it never carries a code, token, secret, or any
 * GitHub response text.
 */
function authorizationFailed(stage: string, reason: string) {
  console.warn(JSON.stringify({ event: "github.authorization_failed", stage, reason }));
  return false as const;
}

/**
 * The Agent credential route answers with a fixed sentence, so this line is where the cause shows:
 * whether the person must reconnect, and a short reason. It never carries a token or GitHub text.
 */
function credentialFailed(
  userId: string,
  code: "ACCESS_DENIED" | "TEMPORARILY_UNAVAILABLE",
  reason: string,
) {
  const outcome = code === "ACCESS_DENIED" ? "reconnect" : "unavailable";
  console.warn(JSON.stringify({ event: "github.credential_failed", userId, outcome, reason }));
  return new AppError(code);
}

function randomValue() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("base64url");
}
