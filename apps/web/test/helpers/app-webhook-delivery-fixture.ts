import { afterAll, afterEach, beforeAll, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";

import { flagOnFor } from "./app-notification-subscription";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { type AppNotificationDeliveryJob } from "#src/server/app-notifications/app-notification-jobs";
import { stopAppNotificationQueue } from "#src/server/app-notifications/app-notification-queue.server";

import { createAppWebhooks } from "#src/server/app-notifications/app-webhooks-composition.server";

import {
  forgetAppWebhookKey,
  rememberAppWebhookKey,
} from "#src/server/app-notifications/webhook-secret.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import {
  OutboundEgress,
  type FetchOutboundRequest,
} from "#src/server/egress/outbound-egress.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * Shared setup of the signed HTTP delivery tests (`app-webhook-delivery-*.integration.test.ts`): against local PostgreSQL with migrations applied and a
 * receiver on a loopback port. The egress is https-only and public-only, so these tests build the
 * webhook and the delivery with an `OutboundEgress` whose `resolve` answers a public address and
 * whose `fetch` forwards the pinned request to the receiver; the real egress is used wherever
 * refusal is the point.
 *
 * Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL. It also needs
 * `DATABASE_URL` to name the same database, which the delivery composition reads.
 */
export const connectionString = Bun.env.APP_NOTIFICATIONS_TEST_DATABASE_URL;
/** Created by `useWebhookDeliveryEnvironment` for each run of a test file, and disconnected after. */
export let db: PrismaClient | undefined;

export const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 24 }, (_, index) => `hook-on-${RUN}-${index}`);
export let nextOnSlug = 0;
export const KEY = "w".repeat(64);
export const PUBLIC_ADDRESS = { address: "203.0.114.8", family: 4 as const };
const realFetch = fetch;
/** Forwards a pinned https request to the loopback receiver over plain http. */
export const toReceiver: FetchOutboundRequest = (url, init) => {
  const { pathname, search } = new URL(url);
  return realFetch(`http://127.0.0.1:${receiver!.port}${pathname}${search}`, {
    ...init,
    tls: undefined,
  });
};
export const loopback = new OutboundEgress({
  resolve: async () => [PUBLIC_ADDRESS],
  fetch: toReceiver,
});
export const strict = new OutboundEgress();

type Received = { headers: Headers; body: string };
export const received: Received[] = [];
/** The statuses the receiver answers with, in order; 204 once they run out. */
export const state = { script: [] as number[] };
/** The loopback receiver; started and stopped with the environment, like `db`. */
export let receiver: ReturnType<typeof Bun.serve> | undefined;
export const endpoint = () => "https://hooks.example/hook";

/** Registers the hooks every delivery test file needs: the flag file, the signing key, and the
 * receiver and database teardown. Call it once at the top of the file. */
export function useWebhookDeliveryEnvironment() {
  let flagDirectory: string | undefined;

  beforeAll(async () => {
    if (!connectionString) return;
    nextOnSlug = 0;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        received.push({ headers: request.headers, body: await request.text() });
        return new Response("secret response body", { status: state.script.shift() ?? 204 });
      },
    });
    flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-webhooks-"));
    const path = join(flagDirectory, "flags.json");
    await Bun.write(
      path,
      JSON.stringify({
        $schema: "https://flagd.dev/schema/v0/flags.json",
        flags: {
          "app-notifications": flagOnFor(ON_SLUGS),
          "app-data-permissions": flagOnFor(ON_SLUGS),
        },
      }),
    );
    await installFeatureFlags(
      await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
    );
    rememberAppWebhookKey(KEY);
  });

  afterEach(() => {
    received.length = 0;
    state.script = [];
    rememberAppWebhookKey(KEY);
  });

  afterAll(async () => {
    await receiver?.stop(true);
    await stopAppNotificationQueue();
    forgetAppWebhookKey();
    await installFeatureFlags({ status: "disabled" });
    if (flagDirectory) await rm(flagDirectory, { recursive: true, force: true });
    await db?.$disconnect();
    db = undefined;
    receiver = undefined;
  });
}

/** A Workspace with an owner and a plain member, and one app registered (hence installed) in it. */
export async function fixture({ flag = "on" }: { flag?: "on" | "off" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db!.user.create({
    data: { displayName: `hook-${suffix}`, username: `hook-${suffix}` },
  });
  const member = await db!.user.create({
    data: { displayName: `hookm-${suffix}`, username: `hookm-${suffix}` },
  });
  const workspace = await db!.workspace.create({
    data: {
      slug: flag === "on" ? ON_SLUGS[nextOnSlug++]! : `hook-off-${suffix}`,
      name: "Webhooks",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const key = `hook-${suffix}`;
  const actor = { workspaceId: workspace.id, actorUserId: owner.id };
  await createAppRegistry(db!).registerApp(actor, {
    key,
    name: "Acme Hooked",
    description: "",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "other",
    allowedScopes: ["openid", "profile", "identity"],
  });
  const installation = await db!.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id },
    select: { id: true, appId: true },
  });
  return {
    workspace,
    actor,
    memberActor: { workspaceId: workspace.id, actorUserId: member.id },
    key,
    appId: installation.appId,
    installationId: installation.id,
    async cleanup() {
      await db!.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db!.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } }).catch(() => {});
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A delivery job for the installation: the id names the message, `retryCount` the attempt. */
export function jobFor(
  { workspace, installationId }: Fixture,
  { id = crypto.randomUUID(), retryCount = 0 } = {},
) {
  const event = newAppNotificationEvent({
    type: "workspace.member_added",
    workspaceId: workspace.id,
    data: { userId: crypto.randomUUID(), role: "member" },
  });
  const data: AppNotificationDeliveryJob = { eventId: event.id, installationId, event };
  return { id, retryCount, data };
}

export const statusOf = (installationId: string) =>
  db!.appInstallationWebhookStatus.findUnique({ where: { installationId } });

/** Runs `work` with a fixture and always cleans it up. */
export async function withFixture(work: (f: Fixture) => Promise<void>, flag: "on" | "off" = "on") {
  const f = await fixture({ flag });
  try {
    await work(f);
  } finally {
    await f.cleanup();
  }
}

export const testWithDatabase = connectionString ? test : test.skip;
export const webhooks = (egress = loopback) => createAppWebhooks(db!, egress);
