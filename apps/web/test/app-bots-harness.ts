import { afterAll, afterEach } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { createAppBotEndpoint } from "#src/server/app-bots/app-bots-composition.server";
import { NO_RATE_LIMIT } from "#src/server/app-rate-limits/app-rate-limit.server";
import { botFixture, type BotFixture } from "./app-bots-fixture";

/**
 * What the app bot integration tests share: a PostgreSQL client (none unless
 * `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, which skips them), the fixtures cleaned
 * after each test, a refusal catcher, and the app backend's two calls built as requests.
 * `useBotHarness()` registers the cleanup in the file that calls it.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
export const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const fixtures: BotFixture[] = [];

export function useBotHarness() {
  afterEach(async () => {
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
}

export async function fixture(options?: Parameters<typeof botFixture>[1]) {
  const made = await botFixture(db!, options);
  fixtures.push(made);
  return made;
}

/** A fixture whose bot an admin has granted. */
export async function granted(options?: Parameters<typeof botFixture>[1]) {
  const f = await fixture(options);
  await f.bots.grant(f.actor("admin"), f.key);
  return f;
}

export async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

export const endpoint = () =>
  createAppBotEndpoint(db!, {
    issuer: "https://coforge.test",
    limits: { token: NO_RATE_LIMIT, installation: NO_RATE_LIMIT },
  });

export function tokenRequest(installationId: string, authorization: string | null, body?: unknown) {
  return endpoint().token(
    new Request(`https://coforge.test/api/app-installations/${installationId}/bot-token`, {
      method: "POST",
      headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    installationId,
  );
}

export function statusRequest(installationId: string, authorization: string | null, body: unknown) {
  return endpoint().status(
    new Request(`https://coforge.test/api/app-installations/${installationId}/bot-status`, {
      method: "PUT",
      headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    installationId,
  );
}
