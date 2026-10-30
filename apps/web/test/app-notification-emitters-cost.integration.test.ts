import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { recordComputerObservation } from "#src/server/computers/computer-metadata.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import {
  PrismaWorkspaceMemberDirectoryStore,
  workspaceMemberDirectory,
} from "#src/server/workspaces/member-directory-store.server";
import { emitterDatabaseUrl } from "./helpers/app-notification-emitters";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

/**
 * What a deployment that does not use app notifications pays for them: nothing. With the flag file
 * not defining `app-notifications`, the domain writes that emit events issue the statements they
 * always did (counted on the Prisma client) and take no savepoint, row lock or extra transaction
 * for an event. Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = emitterDatabaseUrl;
const queries: string[] = [];
const db = connectionString
  ? new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
      log: [{ emit: "event", level: "query" }],
    })
  : undefined;
db?.$on("query", (event) => queries.push(event.query));
let directory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  directory = await mkdtemp(join(tmpdir(), "coforge-app-notification-cost-"));
  const path = join(directory, "flags.json");
  // A valid flag file that defines another flag only, as production's does.
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-data-permissions": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
        },
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  if (directory) await rm(directory, { recursive: true, force: true });
  await db?.$disconnect();
});

const testWithDatabase = db ? test : test.skip;

/** The statements `work` issues, as the Prisma client logged them. */
async function statementsOf(work: () => Promise<unknown>) {
  queries.length = 0;
  await work();
  return [...queries];
}

/** What only an emitter issues: a savepoint, a Computer row lock, a read of a Workspace's slug, a
 * Computer's Workspace links, or the thread first-reply check (`id <> reply`). */
const EMITTER_ONLY = /SAVEPOINT|FROM computers|"workspaces"\."slug"|"id" <> /i;

async function workspaceWithOwner() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db!.user.create({
    data: { displayName: `cost-${suffix}`, username: `cost-${suffix}` },
  });
  const member = await db!.user.create({
    data: { displayName: `cost-m-${suffix}`, username: `cost-m-${suffix}` },
  });
  const workspace = await db!.workspace.create({
    data: {
      slug: `cost-${suffix}`,
      name: "Cost",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  return {
    owner,
    member,
    workspace,
    async cleanup() {
      await db!.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db!.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    },
  };
}

testWithDatabase(
  "with the flag undefined, channel and member writes issue no emitter statements",
  async () => {
    const f = await workspaceWithOwner();
    try {
      const channels = new PublicChannels(
        db!,
        { execute: (_scope, persist) => persist() },
        quietCentrifugo(),
      );
      const created = await statementsOf(async () => {
        const channel = await channels.create(f.workspace.id, f.owner.id, "ops");
        Object.assign(f, { channel });
      });
      const { channel } = f as unknown as { channel: { id: string } };
      const send = (body: string, threadRootId?: string) =>
        channels.send({
          workspaceId: f.workspace.id,
          userId: f.owner.id,
          channelId: channel.id,
          idempotencyKey: crypto.randomUUID(),
          body,
          ...(threadRootId ? { threadRootId } : {}),
        });
      const root = await send("root");
      const reply = await statementsOf(() => send("reply", root.id));
      const joined = await statementsOf(() =>
        channels.join(f.workspace.id, f.member.id, channel.id),
      );
      const left = await statementsOf(() =>
        channels.leave(f.workspace.id, f.member.id, channel.id),
      );
      const removed = await statementsOf(() =>
        workspaceMemberDirectory(db!).removeMember({
          workspaceId: f.workspace.id,
          actorUserId: f.owner.id,
          targetUserId: f.member.id,
        }),
      );
      for (const statements of [created, reply, joined, left, removed])
        expect(statements.filter((statement) => EMITTER_ONLY.test(statement))).toEqual([]);
      // The reply is the same statements it was: the thread follower reads and the insert, nothing more.
      expect(
        reply.some((statement) => statement.startsWith('INSERT INTO "public"."messages"')),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);

testWithDatabase(
  "with the flag undefined, single-statement writes stay one statement",
  async () => {
    const f = await workspaceWithOwner();
    try {
      const computer = await db!.computer.create({
        data: { ownerId: f.owner.id, machineId: `cost-${crypto.randomUUID().slice(0, 8)}` },
      });
      await db!.workspaceComputer.create({
        data: { workspaceId: f.workspace.id, computerId: computer.id },
      });
      const agent = await db!.agent.create({
        data: {
          workspaceId: f.workspace.id,
          ownerId: f.owner.id,
          name: `cost-a-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Cost",
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "m1",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      const observed = await statementsOf(() =>
        recordComputerObservation(
          db!,
          { workspaceId: f.workspace.id, computerId: computer.id },
          { computerVersion: "2.0.0", startedAt: 2 },
        ),
      );
      const updated = await statementsOf(() =>
        new PrismaAgentRepository(db!).update(agent.id, {
          displayName: "Renamed",
          description: "",
          runtimeConfig: { ...agentRuntime(), model: "m2" },
        }),
      );
      const role = await statementsOf(() =>
        new PrismaWorkspaceMemberDirectoryStore(db!).updateRole(
          f.workspace.id,
          f.member.id,
          "admin",
        ),
      );
      // One statement each, and a role change the update with the rows Prisma reads back for it.
      expect(observed).toHaveLength(1);
      expect(updated).toHaveLength(1);
      for (const statements of [observed, updated, role])
        expect(statements.filter((statement) => EMITTER_ONLY.test(statement))).toEqual([]);
      expect(role[0]).toMatch(/^UPDATE "public"\."workspace_memberships"/);
    } finally {
      await f.cleanup();
    }
  },
);

const agentRuntime = () => ({
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "m1",
  modelProvider: "",
  reasoning: "",
});
