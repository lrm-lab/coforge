import type { PrismaClient } from "#src/generated/prisma/client";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import type { AppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { authorizationServerConfiguration } from "#src/server/authorization-server/configuration.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAppBotStore } from "#src/server/db/repositories/app-bot.repositories.server";
import { PrismaGrantStore } from "#src/server/db/repositories/oauth-grant.repositories.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import { AppBotEndpoint } from "./app-bot-endpoint.server";
import { AppBots } from "./app-bots.server";

/** An app's bots over PostgreSQL; `db` may be an open transaction. */
export function createAppBots(db: DatabaseScope): AppBots {
  return new AppBots(new PrismaAppBotStore(db));
}

/** The calls of an app's backend over PostgreSQL. `limits` is the seam a test passes; production
 * uses the per-app and per-installation request limits. */
export function createAppBotEndpoint(
  db: PrismaClient,
  options: { issuer: string; limits?: Pick<AppRateLimits, "token" | "installation"> },
): AppBotEndpoint {
  return new AppBotEndpoint(createAppBots(db), new PrismaGrantStore(db), {
    issuer: options.issuer,
    limits: options.limits ?? getAppRateLimits(),
  });
}

/** The endpoint of the configured issuer, or null when this deployment runs no authorization
 * server (the routes then answer 404, as the installation APIs do). */
export function currentAppBotEndpoint(): AppBotEndpoint | null {
  const configuration = authorizationServerConfiguration();
  if (configuration.status === "disabled") return null;
  return createAppBotEndpoint(requireDatabaseClient(), { issuer: configuration.issuer });
}
