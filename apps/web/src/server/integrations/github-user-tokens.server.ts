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

export const REFRESH_COOLDOWN_MS = 30_000;

type SharedTokenState = {
  refreshCooldown: Map<string, number>;
  inflightRefresh: Map<string, Promise<void>>;
};

const sharedTokenStates = new WeakMap<object, SharedTokenState>();

function tokenStateFor(db: object): SharedTokenState {
  let state = sharedTokenStates.get(db);
  if (!state) {
    state = { refreshCooldown: new Map(), inflightRefresh: new Map() };
    sharedTokenStates.set(db, state);
  }
  return state;
}

type ConnectionRow = {
  clientId: string;
  githubUserId: string;
  login: string;
  credentials: string | null;
  expiresAt: Date;
  refreshExpiresAt: Date;
  updatedAt: Date;
};

type PreparedToken =
  | {
      ok: true;
      token: string;
      githubUserId: string;
      row: ConnectionRow;
      refreshStored: boolean;
    }
  | {
      ok: false;
      status: "disconnected" | "reauthorize";
      login: string | null;
      cleared?: { reason: string; row: ConnectionRow };
    }
  | { error: AppError };

type RefreshStepResult = PreparedToken | { kind: "retry" };

type ReadPlan =
  | PreparedToken
  | { kind: "wait_inflight" }
  | {
      kind: "needs_refresh";
      row: ConnectionRow;
      refreshToken: string;
      release: () => void;
    };

const MAX_PREPARE_ATTEMPTS = 3;

export class GitHubUserTokens {
  readonly #state: SharedTokenState;

  constructor(
    private readonly db: PrismaClient,
    private readonly config: { clientId: string },
    private readonly github: GitHubApi,
    private readonly sealed: GitHubSealedValues,
    private readonly now: () => number,
  ) {
    this.#state = tokenStateFor(db);
  }

  async withToken<T>(
    userId: string,
    action: (
      token: string,
      githubUserId: string,
      row: { expiresAt: Date; updatedAt: Date; credentials: string | null; login: string },
    ) => Promise<T>,
    refreshWithinMs = 60_000,
  ) {
    const prepared = await this.#prepareToken(userId, refreshWithinMs);
    if ("error" in prepared) throw prepared.error;
    if (!prepared.ok) {
      if (prepared.cleared)
        this.logCleared(userId, "refresh", prepared.cleared.reason, prepared.cleared.row);
      return { ok: false as const, status: prepared.status, login: prepared.login };
    }
    if (prepared.refreshStored) console.info(JSON.stringify({ event: "github.refresh_committed" }));
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

  async #prepareToken(userId: string, refreshWithinMs: number): Promise<PreparedToken> {
    let retries = 0;
    for (;;) {
      const inflight = this.#state.inflightRefresh.get(userId);
      if (inflight) {
        await inflight;
        continue;
      }
      if (this.#cooling(userId)) throw unavailable("refresh_cooldown");
      const plan = await this.#readOrPlanRefresh(userId, refreshWithinMs);
      if ("kind" in plan && plan.kind === "wait_inflight") continue;
      if ("kind" in plan && plan.kind === "needs_refresh") {
        let outcome: RefreshStepResult;
        try {
          outcome = await this.#executeRefresh(userId, plan.row, plan.refreshToken);
        } finally {
          plan.release();
        }
        if ("kind" in outcome) {
          if (++retries >= MAX_PREPARE_ATTEMPTS)
            return { error: unavailable("refresh_retry_exhausted") };
          continue;
        }
        return outcome;
      }
      return plan;
    }
  }

  async #readOrPlanRefresh(userId: string, refreshWithinMs: number): Promise<ReadPlan> {
    let pendingRelease: (() => void) | undefined;
    try {
      return await this.locked(userId, async (tx): Promise<ReadPlan> => {
        if (this.#state.inflightRefresh.has(userId)) return { kind: "wait_inflight" };
        const row = await tx.gitHubConnection.findUnique({ where: { userId } });
        if (!row) return { ok: false, status: "disconnected", login: null };
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
          const tokens = credentialsSchema.parse(
            JSON.parse(await this.sealed.open(userId, "tokens", row.credentials)),
          );
          if (row.expiresAt.getTime() > this.now() + refreshWithinMs) {
            return {
              ok: true,
              token: tokens.access_token,
              githubUserId: row.githubUserId,
              row,
              refreshStored: false,
            };
          }
          if (row.refreshExpiresAt.getTime() <= this.now()) {
            reason = "refresh_token_expired";
            throw new GitHubUnauthorized();
          }
          if (this.#cooling(userId)) return { error: unavailable("refresh_cooldown") };
          const deferred = Promise.withResolvers<void>();
          this.#state.inflightRefresh.set(userId, deferred.promise);
          const release = () => {
            if (this.#state.inflightRefresh.get(userId) === deferred.promise)
              this.#state.inflightRefresh.delete(userId);
            deferred.resolve();
          };
          pendingRelease = release;
          return {
            kind: "needs_refresh",
            row,
            refreshToken: tokens.refresh_token,
            release,
          };
        } catch (error) {
          if (error instanceof GitHubUnauthorized) {
            await tx.gitHubConnection.update({ where: { userId }, data: { credentials: null } });
            return {
              ok: false,
              status: "reauthorize",
              login: row.login,
              cleared: { reason, row },
            };
          }
          return {
            error: error instanceof AppError ? error : unavailable(failureReason(error)),
          };
        }
      });
    } catch (error) {
      pendingRelease?.();
      throw error;
    }
  }

  async #executeRefresh(
    userId: string,
    seen: ConnectionRow,
    refreshToken: string,
  ): Promise<RefreshStepResult> {
    let refreshed: z.infer<typeof tokensSchema>;
    try {
      refreshed = await this.github.exchange({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (error) {
      if (error instanceof GitHubUnauthorized) return this.#handleRefreshUnauthorized(userId, seen);
      if (!(error instanceof GitHubOAuthRejected)) {
        this.#state.refreshCooldown.set(userId, this.now() + REFRESH_COOLDOWN_MS);
        this.logRefreshUncertain(userId, "exchange", error);
      }
      return {
        error: error instanceof AppError ? error : unavailable(failureReason(error)),
      };
    }

    let nextData: Awaited<ReturnType<GitHubUserTokens["storedTokens"]>>;
    try {
      nextData = await this.storedTokens(userId, refreshed);
    } catch (error) {
      this.logRefreshUncertain(userId, "store", error);
      this.revokeBestEffort(refreshed.access_token);
      return {
        error: error instanceof AppError ? error : unavailable(failureReason(error)),
      };
    }

    let stored: { outcome: RefreshStepResult; revokeToken?: string };
    try {
      stored = await this.locked(
        userId,
        async (tx): Promise<{ outcome: RefreshStepResult; revokeToken?: string }> => {
          const latest = await tx.gitHubConnection.findUnique({ where: { userId } });
          if (!latest) {
            return {
              outcome: { ok: false, status: "disconnected", login: null },
              revokeToken: refreshed.access_token,
            };
          }
          if (
            latest.updatedAt.getTime() !== seen.updatedAt.getTime() ||
            latest.credentials !== seen.credentials
          ) {
            if (!latest.credentials || latest.clientId !== this.config.clientId) {
              return {
                outcome: { ok: false, status: "reauthorize", login: latest.login },
                revokeToken: refreshed.access_token,
              };
            }
            return { outcome: { kind: "retry" }, revokeToken: refreshed.access_token };
          }
          try {
            const current = await tx.gitHubConnection.update({
              where: { userId },
              data: nextData,
            });
            return {
              outcome: {
                ok: true,
                token: refreshed.access_token,
                githubUserId: latest.githubUserId,
                row: current,
                refreshStored: true,
              },
            };
          } catch (error) {
            this.logRefreshUncertain(userId, "store", error);
            return {
              outcome: {
                error: error instanceof AppError ? error : unavailable(failureReason(error)),
              },
              revokeToken: refreshed.access_token,
            };
          }
        },
      );
    } catch (error) {
      this.logRefreshUncertain(userId, "store", error);
      throw error;
    }
    if (stored.revokeToken) this.revokeBestEffort(stored.revokeToken);
    return stored.outcome;
  }

  #handleRefreshUnauthorized(userId: string, seen: ConnectionRow): Promise<RefreshStepResult> {
    return this.locked(userId, async (tx): Promise<RefreshStepResult> => {
      const row = await tx.gitHubConnection.findUnique({ where: { userId } });
      if (!row) return { ok: false, status: "disconnected", login: null };
      if (
        row.updatedAt.getTime() !== seen.updatedAt.getTime() ||
        row.credentials !== seen.credentials
      ) {
        if (!row.credentials || row.clientId !== this.config.clientId)
          return { ok: false, status: "reauthorize", login: row.login };
        return { kind: "retry" };
      }
      await tx.gitHubConnection.update({ where: { userId }, data: { credentials: null } });
      return {
        ok: false,
        status: "reauthorize",
        login: row.login,
        cleared: { reason: "bad_refresh_token", row },
      };
    });
  }

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

  private revokeBestEffort(token: string) {
    if (typeof this.github.revoke === "function") void this.github.revoke(token);
  }

  #cooling(userId: string) {
    const until = this.#state.refreshCooldown.get(userId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.#state.refreshCooldown.delete(userId);
    return false;
  }

  private logRefreshUncertain(userId: string, stage: "exchange" | "store", error: unknown) {
    console.warn(
      JSON.stringify({
        event: "github.refresh_uncertain",
        userId,
        stage,
        reason: failureReason(error),
        at: new Date(this.now()).toISOString(),
      }),
    );
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
      { timeout: 5_000, maxWait: 5_000 },
    );
  }

  async lockAccount(tx: Prisma.TransactionClient, githubUserId: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github-account:${this.config.clientId}:${githubUserId}`}, 0))::text`;
  }

  forgetRefreshCooldown(userId: string) {
    this.#state.refreshCooldown.delete(userId);
  }

  async storedTokens(userId: string, tokens: z.infer<typeof tokensSchema>) {
    this.forgetRefreshCooldown(userId);
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
