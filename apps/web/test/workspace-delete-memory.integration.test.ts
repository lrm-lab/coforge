import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryCleanupStore } from "#src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import { createWorkspaceMemoryCleanup } from "#src/server/workspace-memory/cleanup.server";
import { createProductionWorkspaceMemoryCleanupRemotes } from "#src/server/workspace-memory/cleanup-remotes.server";
import {
  WORKSPACE_MEMORY_REMOVAL_OPERATION_ID,
  WorkspaceDeletion,
  workspaceMemoryRemoval,
} from "#src/server/workspaces/deletion.server";
import {
  connectionString,
  errorIdOf,
  quietDeletion,
  recordingFileRemoval,
  recordingSignals,
  setup,
  unboundMemory,
} from "./helpers/workspace-deletion-fixture";

/**
 * Deleting a Workspace removes its memory first: its OpenViking account and binding go before any
 * row does, a removal OpenViking refuses leaves the Workspace whole, and pressing again finishes
 * the job. The rest of the delete is in `workspace-delete.integration.test.ts`. Drives the real
 * services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

const OPENVIKING_URL = "http://openviking.test:1933";
const OPENVIKING_ADMIN_KEY = "root-key-held-by-the-server";

/**
 * Memory removal as production composes it (the real cleanup rows, binding rows and OpenViking
 * client), handed an admin identity the way a provisioner will, with the HTTP to OpenViking
 * recorded and answered with `status`. Each request notes how many messages the Workspace still
 * had when it was sent: the account goes before any row does.
 */
function openVikingMemory(db: PrismaClient, workspaceId: string) {
  const openviking = {
    status: 202,
    requests: [] as {
      method: string | undefined;
      url: string;
      authorization: string | null;
      messagesLeft: number;
    }[],
  };
  const remotes = createProductionWorkspaceMemoryCleanupRemotes({
    bindings: new PrismaOpenVikingBindingStore(db),
    openviking: {
      baseUrl: OPENVIKING_URL,
      adminIdentity: {
        accountId: "root",
        userId: "cleanup-admin",
        role: "admin",
        authorization: `Bearer ${OPENVIKING_ADMIN_KEY}`,
      },
      fetchImpl: async (input, init) => {
        openviking.requests.push({
          method: init?.method,
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          messagesLeft: await db.message.count({ where: { workspaceId } }),
        });
        return new Response(null, { status: openviking.status });
      },
    },
  });
  return {
    openviking,
    memory: createWorkspaceMemoryCleanup({
      store: new PrismaWorkspaceMemoryCleanupStore(db),
      remotes,
    }),
  };
}

/** The Workspace's memory as OpenViking holds it: a binding and a mapped identity under it. */
async function bindMemory(db: PrismaClient, workspaceId: string) {
  await db.openVikingBinding.create({
    data: {
      workspaceId,
      accountId: `acct-${workspaceId}`,
      serviceIdentityId: "svc",
      credentialRef: "secret:ov",
      generation: 1,
    },
  });
  await db.openVikingMappedIdentity.create({
    data: {
      workspaceId,
      actorKind: "projection_worker",
      actorSubject: "projection",
      openvikingUserId: "svc-projection",
      role: "service",
      access: "projection_only",
      generation: 1,
    },
  });
}

test.skipIf(!connectionString)(
  "cleanup Workspace memory finished for good does not keep the Workspace",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    try {
      await db.workspaceMemoryCleanupWork.create({
        data: {
          workspaceId: workspace.id,
          operationId: "del-1",
          target: "openviking_binding",
          state: "settled",
        },
      });
      await quietDeletion(db).delete({
        workspaceId: workspace.id,
        userId: owner.id,
        confirmSlug: workspace.slug,
      });
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(
        await db.workspaceMemoryCleanupWork.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

const MEMORY_REFUSAL = {
  code: "TEMPORARILY_UNAVAILABLE",
  errorId: "workspace-memory-removal-failed",
} as const;

/** Everything a refused delete must leave as it was found. */
async function expectWorkspaceIntact(fixture: Awaited<ReturnType<typeof setup>>, messages: number) {
  const { db, workspace } = fixture;
  expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
  expect(await db.message.count({ where: { workspaceId: workspace.id } })).toBe(messages);
  expect(await db.daemonApiKey.count({ where: { workspaceId: workspace.id } })).toBe(1);
}

test.skipIf(!connectionString)(
  "a Workspace with memory in OpenViking loses its account and binding before any row goes, and is then deleted",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const heard = recordingSignals();
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: heard.signals,
        memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      // One typed delete of the bound account, with the server-held key, while every message was
      // still there: a delete that OpenViking refuses must find the Workspace whole.
      expect(openviking.requests).toEqual([
        {
          method: "DELETE",
          url: `${OPENVIKING_URL}/api/v1/admin/accounts/acct-${workspace.id}`,
          authorization: `Bearer ${OPENVIKING_ADMIN_KEY}`,
          messagesLeft: messages,
        },
      ]);
      expect(messages).toBeGreaterThan(0);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
      expect(
        await db.openVikingMappedIdentity.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
      // The cleanup's bookkeeping goes with the Workspace it named.
      expect(
        await db.workspaceMemoryCleanupWork.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
      expect(heard.deleted).toEqual([workspace.id]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "an account OpenViking no longer has counts as deleted",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    openviking.status = 404;
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: recordingSignals().signals,
        memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(openviking.requests).toHaveLength(1);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "when OpenViking cannot delete the account the Workspace stays whole, and pressing again finishes the job",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const files = recordingFileRemoval();
    const heard = recordingSignals();
    const deletion = new WorkspaceDeletion(db, {
      files: files.removal,
      signals: heard.signals,
      memory,
    });
    const press = () =>
      errorIdOf(
        deletion.delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        }),
      );
    try {
      openviking.status = 500;
      expect(await press()).toEqual(MEMORY_REFUSAL);
      await expectWorkspaceIntact(fixture, messages);
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect(
        await db.workspaceMemoryCleanupWork.findFirst({
          where: { workspaceId: workspace.id, target: "openviking_account" },
          select: { state: true, sanitizedError: true },
        }),
      ).toEqual({ state: "retryable_failure", sanitizedError: "openviking account delete failed" });
      expect(files.calls).toEqual([]);
      expect(heard.deleted).toEqual([]);

      openviking.status = 202;
      expect(await press()).toBeUndefined();
      expect(openviking.requests).toHaveLength(2);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
      expect(heard.deleted).toEqual([workspace.id]);
    } finally {
      files.release();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "with no OpenViking admin credential wired, as in production today, a bound Workspace is refused and stays whole",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    try {
      const error = await errorIdOf(
        new WorkspaceDeletion(db, {
          files: recordingFileRemoval().removal,
          signals: recordingSignals().signals,
          memory: workspaceMemoryRemoval(db),
        }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug }),
      );

      expect(error).toEqual(MEMORY_REFUSAL);
      await expectWorkspaceIntact(fixture, messages);
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a Workspace with no memory is deleted without reaching OpenViking",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const calls: string[] = [];
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: recordingSignals().signals,
        memory: {
          enqueueWorkspaceDeletion: (input) => {
            calls.push("enqueue");
            return memory.enqueueWorkspaceDeletion(input);
          },
          run: (input) => {
            calls.push("run");
            return memory.run(input);
          },
        },
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(openviking.requests).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "cleanup an earlier attempt left unfinished is finished by the delete",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    await db.workspaceMemoryCleanupWork.create({
      data: {
        workspaceId: workspace.id,
        operationId: "del-1",
        target: "openviking_account",
        state: "retryable_failure",
      },
    });
    const { remotes, memory } = unboundMemory(db);
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: recordingSignals().signals,
        memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(remotes.calls).toEqual(["openviking_account", "openviking_binding"]);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(
        await db.workspaceMemoryCleanupWork.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a delete pressed while another holds the cleanup is refused until that lease lapses",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const deletion = new WorkspaceDeletion(db, {
      files: recordingFileRemoval().removal,
      signals: recordingSignals().signals,
      memory,
    });
    const press = () =>
      errorIdOf(
        deletion.delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        }),
      );
    try {
      // The other press has the account target leased for another minute.
      for (const target of ["openviking_account", "openviking_binding"] as const)
        await db.workspaceMemoryCleanupWork.create({
          data: {
            workspaceId: workspace.id,
            operationId: WORKSPACE_MEMORY_REMOVAL_OPERATION_ID,
            target,
            state: target === "openviking_account" ? "leased" : "pending",
            leaseOwner: target === "openviking_account" ? "another-press" : null,
            leaseExpiresAt: target === "openviking_account" ? new Date(Date.now() + 60_000) : null,
          },
        });
      expect(await press()).toEqual(MEMORY_REFUSAL);
      await expectWorkspaceIntact(fixture, messages);
      expect(openviking.requests).toEqual([]);

      // It crashed: the lease lapses and the next press takes over.
      await db.workspaceMemoryCleanupWork.updateMany({
        where: { workspaceId: workspace.id, state: "leased" },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      expect(await press()).toBeUndefined();
      expect(openviking.requests).toHaveLength(1);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a binding that outlives the cleanup keeps the Workspace, and pressing again removes it",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    await bindMemory(db, workspace.id);
    // A cleanup whose binding removal does nothing: the binding is there when the rows go.
    const { memory: forgetful } = unboundMemory(db);
    const { memory } = openVikingMemory(db, workspace.id);
    const press = (removal: typeof memory) =>
      errorIdOf(
        new WorkspaceDeletion(db, {
          files: recordingFileRemoval().removal,
          signals: recordingSignals().signals,
          memory: removal,
        }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug }),
      );
    try {
      expect(await press(forgetful)).toEqual(MEMORY_REFUSAL);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(1);

      // The first press left its cleanup marked done; the binding is there all the same.
      expect(await press(memory)).toBeUndefined();
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);
