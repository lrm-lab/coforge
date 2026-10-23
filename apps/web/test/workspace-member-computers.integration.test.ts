import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { prepareDaemonApiKey, verifyDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import {
  authenticateCentrifugoConnect,
  centrifugoConnectDependencies,
} from "#src/server/centrifugo/connect-proxy.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { generalChannelForCreator } from "#src/server/conversations/general-channel.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { admitWorkspaceMember } from "#src/server/workspaces/member-admission.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import { WorkspaceMemberDirectory } from "#src/server/workspaces/member-directory.server";

/**
 * A person who leaves a Workspace, or is removed from it, takes their Computers out of it: their
 * daemon keys for it stop working for good, their Computers are no longer linked to it, and their
 * connected daemons are told to reconnect so the connect proxy refuses them now. Their Computers'
 * place in every other Workspace stays as it was. Drives the real services, Prisma stores and the
 * connect proxy against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const silentRealtime: Pick<ConversationRealtime, "memberChanged"> = {
  async memberChanged() {},
};

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `mc-owner-${suffix}`, username: `mc-owner-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `mc-bob-${suffix}`, username: `mc-bob-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `mc-${suffix}`,
      name: "Member Computers",
      members: { create: { userId: owner.id, role: "owner" } },
      conversations: generalChannelForCreator(owner.id),
    },
  });
  const other = await db.workspace.create({
    data: {
      slug: `mc-other-${suffix}`,
      name: "Other",
      members: { create: { userId: bob.id, role: "owner" } },
    },
  });
  await db.$transaction((tx) =>
    admitWorkspaceMember(tx, { workspace, userId: bob.id, role: "member" }),
  );
  const computer = async (ownerId: string, workspaceIds: string[]) => {
    const row = await db.computer.create({
      data: { ownerId, machineId: `machine-${crypto.randomUUID()}` },
    });
    for (const workspaceId of workspaceIds)
      await db.workspaceComputer.create({ data: { workspaceId, computerId: row.id } });
    return row;
  };
  const bobComputer = await computer(bob.id, [workspace.id, other.id]);
  const ownerComputer = await computer(owner.id, [workspace.id]);
  const hashes: string[] = [];
  const issue = async (userId: string, workspaceId: string, computerId: string) => {
    const { apiKey, record } = prepareDaemonApiKey({
      principal: { userId },
      workspaceId,
      computerId,
    });
    await db.daemonApiKey.create({ data: record });
    hashes.push(record.apiKeyHash);
    return { apiKey, hash: record.apiKeyHash };
  };
  const keys = {
    bobHere: await issue(bob.id, workspace.id, bobComputer.id),
    bobElsewhere: await issue(bob.id, other.id, bobComputer.id),
    owner: await issue(owner.id, workspace.id, ownerComputer.id),
  };
  const reconnects: Array<{ workspaceId: string; computerIds: readonly string[] }> = [];
  const directory = new WorkspaceMemberDirectory(
    new PrismaWorkspaceMemberDirectoryStore(db),
    silentRealtime,
    {
      async reconnectDaemons(workspaceId, computerIds) {
        reconnects.push({ workspaceId, computerIds });
      },
    },
  );
  const repository = new PrismaDaemonApiKeyRepository(db);
  const connect = async (daemonApiKey: string) => {
    const response = await authenticateCentrifugoConnect(
      new Request("http://backend", {
        method: "POST",
        body: JSON.stringify({ data: { daemonApiKey } }),
      }),
      centrifugoConnectDependencies(db),
    );
    return { status: response.status, body: await response.json() };
  };
  const teardown = async () => {
    await db.daemonCredentialRevocation
      .deleteMany({ where: { apiKeyHash: { in: hashes } } })
      .catch(() => {});
    for (const id of [workspace.id, other.id])
      await db.workspace.delete({ where: { id } }).catch(() => {});
    for (const id of [bobComputer.id, ownerComputer.id])
      await db.computer.delete({ where: { id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [owner.id, bob.id] } } }).catch(() => {});
    await db.$disconnect();
  };
  return {
    db,
    owner,
    bob,
    workspace,
    other,
    bobComputer,
    ownerComputer,
    keys,
    reconnects,
    directory,
    repository,
    connect,
    teardown,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Bob's Computer is out of the Workspace for good, and everything else stands. */
async function expectBobComputerOutOfWorkspace(scope: Setup) {
  const { db, workspace, other, bobComputer, ownerComputer, keys, repository } = scope;
  const bobKey = await db.daemonApiKey.findUniqueOrThrow({
    where: { apiKeyHash: keys.bobHere.hash },
  });
  expect(bobKey.revokedAt).not.toBeNull();
  expect(await new DaemonCredentialRevocations(db).reasonFor(keys.bobHere.hash)).toBe(
    "computer_unlinked",
  );
  expect(
    await db.workspaceComputer.findMany({
      where: { workspaceId: workspace.id },
      select: { computerId: true },
    }),
  ).toEqual([{ computerId: ownerComputer.id }]);
  expect(scope.reconnects).toEqual([{ workspaceId: workspace.id, computerIds: [bobComputer.id] }]);
  expect(await scope.connect(keys.bobHere.apiKey)).toEqual({
    status: 200,
    body: { disconnect: { code: 4502, reason: "computer_unlinked" } },
  });

  // His Computer's place in the other Workspace, and the owner's Computer here, are untouched.
  expect(
    await db.workspaceComputer.count({
      where: { workspaceId: other.id, computerId: bobComputer.id },
    }),
  ).toBe(1);
  expect(await verifyDaemonApiKey(keys.bobElsewhere.apiKey, repository)).toEqual({
    userId: scope.bob.id,
    workspaceId: other.id,
    computerId: bobComputer.id,
  });
  expect((await scope.connect(keys.bobElsewhere.apiKey)).status).toBe(200);
  expect(await verifyDaemonApiKey(keys.owner.apiKey, repository)).toMatchObject({
    workspaceId: workspace.id,
    computerId: ownerComputer.id,
  });
  expect(await new DaemonCredentialRevocations(db).reasonFor(keys.bobElsewhere.hash)).toBe(
    undefined,
  );
}

test.skipIf(!connectionString)(
  "leaving revokes the member's daemon keys for that Workspace alone, unlinks their Computers from it, and reconnects them",
  async () => {
    const scope = await setup();
    try {
      await scope.directory.leave({ workspaceId: scope.workspace.id, userId: scope.bob.id });
      await expectBobComputerOutOfWorkspace(scope);
    } finally {
      await scope.teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "being removed revokes the member's daemon keys for that Workspace alone, unlinks their Computers from it, and reconnects them",
  async () => {
    const scope = await setup();
    try {
      await scope.directory.removeMember({
        workspaceId: scope.workspace.id,
        actorUserId: scope.owner.id,
        targetUserId: scope.bob.id,
      });
      await expectBobComputerOutOfWorkspace(scope);
    } finally {
      await scope.teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a live key whose owner is no longer a member of its Workspace fails verification, and the connect proxy refuses it for good",
  async () => {
    const scope = await setup();
    try {
      // A departure from before keys were revoked on leaving: the key and the link are still there.
      await scope.db.workspaceMembership.delete({
        where: {
          workspaceId_userId: { workspaceId: scope.workspace.id, userId: scope.bob.id },
        },
      });
      await expect(verifyDaemonApiKey(scope.keys.bobHere.apiKey, scope.repository)).rejects.toThrow(
        "invalid Daemon API key",
      );
      expect(await scope.connect(scope.keys.bobHere.apiKey)).toEqual({
        status: 200,
        body: { disconnect: { code: 4502, reason: "computer_unlinked" } },
      });
      expect((await scope.connect(scope.keys.bobElsewhere.apiKey)).status).toBe(200);
      expect((await scope.connect(scope.keys.owner.apiKey)).status).toBe(200);
    } finally {
      await scope.teardown();
    }
  },
);
