import type { z } from "zod";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { credentialsSchema, type tokensSchema } from "./github-account-shapes.server";
import {
  GitHubOAuthRejected,
  GitHubUnauthorized,
  failureReason,
  unavailable,
  type GitHubApi,
} from "./github-api.server";
import type { GitHubSealedValues } from "./github-sealed-values.server";

/**
 * A User's stored GitHub tokens: the only code that reads, refreshes, rewrites or clears them.
 * Serializes per User with an advisory lock.
 */
export class GitHubUserTokens {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: { clientId: string },
    private readonly github: GitHubApi,
    private readonly sealed: GitHubSealedValues,
    private readonly now: () => number,
  ) {}

  async withToken<T>(
    userId: string,
    action: (
      token: string,
      githubUserId: string,
      row: { expiresAt: Date; updatedAt: Date; credentials: string | null; login: string },
    ) => Promise<T>,
    refreshWithinMs = 60_000,
  ) {
    const prepared = await this.locked(userId, async (tx) => {
      const row = await tx.gitHubConnection.findUnique({ where: { userId } });
      if (!row) return { ok: false as const, status: "disconnected" as const, login: null };
      let stage: "read" | "exchange" | "store" = "read";
      let reason = "unauthorized";
      try {
        if (!row.credentials) {
          reason = "no_credentials";
          throw new GitHubUnauthorized();
        }
        if (row.clientId !== this.config.clientId) {
          reason = "client_mismatch";
          throw new GitHubUnauthorized();
        }
        let tokens = credentialsSchema.parse(
          JSON.parse(await this.sealed.open(userId, "tokens", row.credentials)),
        );
        let current = row;
        if (row.expiresAt.getTime() <= this.now() + refreshWithinMs) {
          if (row.refreshExpiresAt.getTime() <= this.now()) {
            reason = "refresh_token_expired";
            throw new GitHubUnauthorized();
          }
          stage = "exchange";
          reason = "bad_refresh_token";
          const refreshed = await this.github.exchange({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
          });
          stage = "store";
          current = await tx.gitHubConnection.update({
            where: { userId },
            data: await this.storedTokens(userId, refreshed),
          });
          tokens = refreshed;
        }
        return {
          ok: true as const,
          token: tokens.access_token,
          githubUserId: row.githubUserId,
          row: current,
        };
      } catch (error) {
        if (error instanceof GitHubUnauthorized) {
          await tx.gitHubConnection.update({ where: { userId }, data: { credentials: null } });
          return {
            ok: false as const,
            status: "reauthorize" as const,
            login: row.login,
            cleared: { reason, row },
          };
        }
        if (stage !== "read" && !(error instanceof GitHubOAuthRejected))
          console.warn(
            JSON.stringify({
              event: "github.refresh_uncertain",
              userId,
              stage,
              reason: failureReason(error),
              at: new Date(this.now()).toISOString(),
            }),
          );
        // Commit a rotated token even if the subsequent read fails. The action runs
        // after this transaction, so a transient GitHub failure cannot undo a refresh.
        return {
          error: error instanceof AppError ? error : unavailable(failureReason(error)),
        };
      }
    });
    if ("error" in prepared) throw prepared.error;
    if (!prepared.ok) {
      if ("cleared" in prepared && prepared.cleared)
        this.logCleared(userId, "refresh", prepared.cleared.reason, prepared.cleared.row);
      return prepared;
    }
    // The advisory lock only covers the token read/refresh above. GitHub reads run here,
    // outside any transaction, so a slow API call never blocks a concurrent disconnect().
    try {
      return {
        ok: true as const,
        data: await action(prepared.token, prepared.githubUserId, prepared.row),
      };
    } catch (error) {
      if (error instanceof GitHubUnauthorized) {
        await this.clearCredentialsIfUnchanged(userId, prepared.row);
        return { ok: false as const, status: "reauthorize" as const, login: prepared.row.login };
      }
      throw error instanceof AppError ? error : new AppError("TEMPORARILY_UNAVAILABLE");
    }
  }

  /** Never wipe a credential that a concurrent refresh already rotated past what we read. */
  private async clearCredentialsIfUnchanged(
    userId: string,
    seen: { updatedAt: Date; credentials: string | null },
  ) {
    const cleared = await this.locked(userId, async (tx) => {
      const row = await tx.gitHubConnection.findUnique({ where: { userId } });
      if (
        !row ||
        row.updatedAt.getTime() !== seen.updatedAt.getTime() ||
        row.credentials !== seen.credentials
      )
        return undefined;
      await tx.gitHubConnection.update({ where: { userId }, data: { credentials: null } });
      return row;
    });
    if (cleared) this.logCleared(userId, "call_401", "unauthorized", cleared);
  }

  private logCleared(
    userId: string,
    site: "refresh" | "call_401",
    reason: string,
    row: { expiresAt: Date; refreshExpiresAt: Date; updatedAt: Date },
  ) {
    console.warn(
      JSON.stringify({
        event: "github.credentials_cleared",
        userId,
        site,
        reason,
        expiresAt: row.expiresAt.toISOString(),
        refreshExpiresAt: row.refreshExpiresAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    );
  }

  locked<T>(userId: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${userId}`}, 0))::text`;
        return action(tx);
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
  }

  /**
   * Serializes the transactions that connect one GitHub account, whichever User finishes first.
   * Take it after the User's own lock (`locked`) and before reading who owns the account; nothing
   * else takes it.
   */
  async lockAccount(tx: Prisma.TransactionClient, githubUserId: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github-account:${this.config.clientId}:${githubUserId}`}, 0))::text`;
  }

  async storedTokens(userId: string, tokens: z.infer<typeof tokensSchema>) {
    return {
      credentials: await this.sealed.seal(
        userId,
        "tokens",
        JSON.stringify(credentialsSchema.parse(tokens)),
      ),
      expiresAt: new Date(this.now() + tokens.expires_in * 1000),
      refreshExpiresAt: new Date(this.now() + tokens.refresh_token_expires_in * 1000),
    };
  }
}
