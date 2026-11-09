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
import {
  removeComputerFromWorkspace,
  unlinkDepartingMemberComputers,
} from "#src/server/computers/computer-membership.server";
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
async function expectBobComputerOutOfWorkspace(scope: Setup, expectReconnect = true) {
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
  expect(scope.reconnects).toEqual(
    expectReconnect ? [{ workspaceId: workspace.id, computerIds: [bobComputer.id] }] : [],
  );
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
    kind: "daemon",
    apiKeyHash: expect.any(String),
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
  "removing a Computer from one Workspace preserves its Computer record and other Workspace binding",
  async () => {
    const scope = await setup();
    try {
      await removeComputerFromWorkspace(scope.db, {
        userId: scope.bob.id,
        workspaceId: scope.workspace.id,
        computerId: scope.bobComputer.id,
      });

      await expectBobComputerOutOfWorkspace(scope, false);
      expect(
        await scope.db.computer.findUnique({
          where: { id: scope.bobComputer.id },
          select: { id: true },
        }),
      ).toEqual({ id: scope.bobComputer.id });
    } finally {
      await scope.teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the removal preview lists exactly the Computers the removal disconnects, with their live Agents",
  async () => {
    const scope = await setup();
    try {
      const { db, workspace, other, bob, owner, bobComputer, ownerComputer } = scope;
      const agent = (data: {
        workspaceId: string;
        ownerId: string;
        name: string;
        visibility?: string;
        computerId?: string;
        deletedAt?: Date;
      }) =>
        db.agent.create({
          data: { displayName: data.name, runtimeConfig: {}, ...data },
        });
      // On Bob's Computer in this Workspace: a public Agent he owns, a private one the owner
      // owns (counts, but only an elevated viewer may see its name), and an archived one (neither).
      const publicAgent = await agent({
        workspaceId: workspace.id,
        ownerId: bob.id,
        name: "bob-public",
        computerId: bobComputer.id,
      });
      const hiddenAgent = await agent({
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: "owner-private",
        visibility: "private",
        computerId: bobComputer.id,
      });
      await agent({
        workspaceId: workspace.id,
        ownerId: bob.id,
        name: "bob-archived",
        computerId: bobComputer.id,
        deletedAt: new Date(),
      });
      // Same Computer in the other Workspace, and the owner's Computer here: neither is Bob's
      // departure from this Workspace.
      await agent({
        workspaceId: other.id,
        ownerId: bob.id,
        name: "bob-elsewhere",
        computerId: bobComputer.id,
      });
      await agent({
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: "owner-agent",
        computerId: ownerComputer.id,
      });

      const preview = await scope.directory.removalComputers({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        targetUserId: bob.id,
      });
      expect(preview.map((computer) => computer.id)).toEqual([bobComputer.id]);
      expect(preview[0]).toMatchObject({ kind: "local", agentCount: 2 });
      // The owner is elevated: both live Agents are named.
      expect(preview[0]!.agents.map((row) => row.id).sort()).toEqual(
        [publicAgent.id, hiddenAgent.id].sort(),
      );

      await scope.directory.removeMember({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        targetUserId: bob.id,
      });
      // The set the dialog showed is the set the departure disconnected.
      expect(scope.reconnects).toEqual([
        { workspaceId: workspace.id, computerIds: [bobComputer.id] },
      ]);
      expect([...scope.reconnects[0]!.computerIds].sort()).toEqual(
        preview.map((computer) => computer.id).sort(),
      );
    } finally {
      await scope.teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the leave preview lists the same Computers the leave disconnects, naming only Agents the member may see",
  async () => {
    const scope = await setup();
    try {
      const { db, workspace, bob, owner, bobComputer } = scope;
      const own = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: bob.id,
          name: "bob-own",
          displayName: "bob-own",
          visibility: "private",
          computerId: bobComputer.id,
          runtimeConfig: {},
        },
      });
      await db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: owner.id,
          name: "owner-private",
          displayName: "owner-private",
          visibility: "private",
          computerId: bobComputer.id,
          runtimeConfig: {},
        },
      });

      const preview = await scope.directory.leaveComputers({
        workspaceId: workspace.id,
        userId: bob.id,
      });
      expect(preview.map((computer) => computer.id)).toEqual([bobComputer.id]);
      // Bob is an ordinary member: the owner's private Agent counts but is not named; his own
      // private one is.
      expect(preview[0]).toMatchObject({ agentCount: 2 });
      expect(preview[0]!.agents.map((row) => row.id)).toEqual([own.id]);

      await scope.directory.leave({ workspaceId: workspace.id, userId: bob.id });
      expect(scope.reconnects).toEqual([
        { workspaceId: workspace.id, computerIds: [bobComputer.id] },
      ]);
      expect([...scope.reconnects[0]!.computerIds].sort()).toEqual(
        preview.map((computer) => computer.id).sort(),
      );
    } finally {
      await scope.teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "departure previews enforce the same authority as the departure itself",
  async () => {
    const scope = await setup();
    try {
      const { db, workspace, bob, owner } = scope;
      const suffix = crypto.randomUUID().slice(0, 8);
      const carol = await db.user.create({
        data: { displayName: `mc-carol-${suffix}`, username: `mc-carol-${suffix}` },
      });
      await db.$transaction((tx) =>
        admitWorkspaceMember(tx, { workspace, userId: carol.id, role: "member" }),
      );

      // An ordinary member cannot preview removing anyone.
      await expect(
        scope.directory.removalComputers({
          workspaceId: workspace.id,
          actorUserId: bob.id,
          targetUserId: carol.id,
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      // A non-member can preview nothing.
      const outsider = await db.user.create({
        data: { displayName: `mc-out-${suffix}`, username: `mc-out-${suffix}` },
      });
      await expect(
        scope.directory.removalComputers({
          workspaceId: workspace.id,
          actorUserId: outsider.id,
          targetUserId: bob.id,
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(
        scope.directory.leaveComputers({ workspaceId: workspace.id, userId: outsider.id }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      // The owner cannot be removed or leave.
      await expect(
        scope.directory.removalComputers({
          workspaceId: workspace.id,
          actorUserId: owner.id,
          targetUserId: owner.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        scope.directory.leaveComputers({ workspaceId: workspace.id, userId: owner.id }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // A member with no Computers previews an empty list.
      await expect(
        scope.directory.removalComputers({
          workspaceId: workspace.id,
          actorUserId: owner.id,
          targetUserId: carol.id,
        }),
      ).resolves.toEqual([]);
      await expect(
        scope.directory.leaveComputers({ workspaceId: workspace.id, userId: carol.id }),
      ).resolves.toEqual([]);
      await db.user.delete({ where: { id: carol.id } });
      await db.user.delete({ where: { id: outsider.id } });
    } finally {
      await scope.teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "unlinking each Workspace's Computers through the seam revokes every key with its record (task #466 seam)",
  async () => {
    const scope = await setup();
    try {
      const { db, workspace, other, bob, keys, bobComputer } = scope;
      // #466 has no deletion entry yet; this pins what it must do first: for every Workspace
      // the person belongs to, `unlinkDepartingMemberComputers` runs before any User-row
      // delete, so each live key gets its `computer_unlinked` record. A bare User delete
      // cannot even run — `computers.ownerId` is Restrict — which is why the flow must go
      // through this seam deliberately rather than rely on a cascade.
      for (const workspaceId of [workspace.id, other.id]) {
        await db.$transaction((tx) =>
          unlinkDepartingMemberComputers(tx, { workspaceId, userId: bob.id }),
        );
      }

      const revocations = new DaemonCredentialRevocations(db);
      expect(await revocations.reasonFor(keys.bobHere.hash)).toBe("computer_unlinked");
      expect(await revocations.reasonFor(keys.bobElsewhere.hash)).toBe("computer_unlinked");
      expect(await db.daemonApiKey.count({ where: { ownerId: bob.id, revokedAt: null } })).toBe(0);
      expect(await db.workspaceComputer.count({ where: { computerId: bobComputer.id } })).toBe(0);
      // The Computer itself still stands: deleting it is the deletion flow's own decision.
      expect(
        await db.computer.findUnique({ where: { id: bobComputer.id }, select: { id: true } }),
      ).toEqual({ id: bobComputer.id });
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
