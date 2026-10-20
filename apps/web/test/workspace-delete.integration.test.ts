import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { WorkspaceDeparture } from "#src/server/workspaces/departure.server";
import {
  WorkspaceDeletion,
  type WorkspaceDeletionSignals,
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
 * A Workspace's owner deletes it for good: everything in it goes — what its members wrote, their
 * Tasks, the Action cards its Agents prepared, files, Reminders, Records — its Computers learn it is
 * gone the next time they connect, and every open page leaves it. Nobody else may, and the owner
 * must type its slug. Drives the real services against local PostgreSQL.
 *
 * Removing its memory from OpenViking is in `workspace-delete-memory.integration.test.ts`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

async function errorOf(promise: Promise<unknown>) {
  return (await errorIdOf(promise))?.code;
}

test.skipIf(!connectionString)(
  "the owner deletes a Workspace in use and everything in it goes; its Computers and open pages hear of it and its files are removed",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const files = recordingFileRemoval();
    const heard = recordingSignals();
    try {
      // Resolves while the file removal is still running: it happens after the answer.
      await new WorkspaceDeletion(db, {
        files: files.removal,
        signals: heard.signals,
        memory: unboundMemory(db).memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      for (const count of [
        db.message.count({ where: { workspaceId: workspace.id } }),
        db.task.count({ where: { workspaceId: workspace.id } }),
        db.actionCard.count({ where: { workspaceId: workspace.id } }),
        db.agent.count({ where: { workspaceId: workspace.id } }),
        db.conversation.count({ where: { workspaceId: workspace.id } }),
        db.workspaceMembership.count({ where: { workspaceId: workspace.id } }),
        db.daemonApiKey.count({ where: { workspaceId: workspace.id } }),
        db.reminder.count({ where: { workspaceId: workspace.id } }),
        db.weeklyReport.count({ where: { workspaceId: workspace.id } }),
        db.app.count({ where: { ownerWorkspaceId: workspace.id } }),
        db.appInstallation.count({ where: { workspaceId: workspace.id } }),
      ])
        expect(await count).toBe(0);
      // Its Computer stays the owner's; only the link to the Workspace went.
      expect(await db.computer.count({ where: { ownerId: owner.id } })).toBe(1);
      // The Computer's key now answers why it stopped working.
      expect(await new DaemonCredentialRevocations(db).reasonFor(fixture.liveKeyHash)).toBe(
        "workspace_deleted",
      );
      expect(files.calls).toEqual([
        {
          workspaceId: workspace.id,
          files: [...fixture.privateKeys].sort(),
          images: [...fixture.imageKeys].sort(),
        },
      ]);
      expect(heard.deleted).toEqual([workspace.id]);
      expect(heard.reconnected).toEqual([
        { workspaceId: workspace.id, computerIds: [fixture.computerId] },
      ]);
    } finally {
      files.release();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "only the owner deletes, and only with the Workspace's own slug; nothing changes otherwise",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner, admin, member } = fixture;
    const files = recordingFileRemoval();
    const heard = recordingSignals();
    const deletion = new WorkspaceDeletion(db, {
      files: files.removal,
      signals: heard.signals,
      memory: unboundMemory(db).memory,
    });
    const stranger = await db.user.create({
      data: {
        displayName: `wd-stranger-${crypto.randomUUID().slice(0, 8)}`,
        username: `wd-stranger-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
    const messages = () => db.message.count({ where: { workspaceId: workspace.id } });
    const messagesBefore = await messages();
    try {
      for (const userId of [admin.id, member.id, stranger.id])
        expect(
          await errorOf(
            deletion.delete({ workspaceId: workspace.id, userId, confirmSlug: workspace.slug }),
          ),
        ).toBe("ACCESS_DENIED");
      for (const confirmSlug of [
        "",
        workspace.name,
        workspace.slug.toUpperCase(),
        ` ${workspace.slug}`,
      ])
        expect(
          await errorOf(
            deletion.delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug }),
          ),
        ).toBe("INVALID_INPUT");

      // A Workspace that is gone already (deleted from another tab) is not found.
      expect(
        await errorOf(
          deletion.delete({
            workspaceId: crypto.randomUUID(),
            userId: owner.id,
            confirmSlug: workspace.slug,
          }),
        ),
      ).toBe("NOT_FOUND");

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
      expect(await messages()).toBe(messagesBefore);
      expect(await db.daemonApiKey.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect(
        await new DaemonCredentialRevocations(db).reasonFor(fixture.liveKeyHash),
      ).toBeUndefined();
      expect(files.calls).toEqual([]);
      expect(heard.deleted).toEqual([]);
      expect(heard.reconnected).toEqual([]);
    } finally {
      await db.user.delete({ where: { id: stranger.id } });
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "the delete stands when file removal and the realtime signals fail after it",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const failing: WorkspaceDeletionSignals = {
      async workspaceDeleted() {
        throw new Error("Centrifugo down");
      },
      async reconnectDaemons() {
        throw new Error("Centrifugo down");
      },
    };
    try {
      await new WorkspaceDeletion(db, {
        files: { remove: () => Promise.reject(new Error("bucket refused")) },
        signals: failing,
        memory: unboundMemory(db).memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await new DaemonCredentialRevocations(db).reasonFor(fixture.liveKeyHash)).toBe(
        "workspace_deleted",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "after deleting, the owner goes to the next Workspace they are in and `/` remembers it, or nowhere and `/` forgets",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const other = await db.workspace.create({
      data: {
        slug: `wd-next-${crypto.randomUUID().slice(0, 8)}`,
        name: "Next",
        members: { create: { userId: owner.id, role: "member" } },
      },
    });
    const remembered: { slug?: string } = { slug: workspace.slug };
    const departure = new WorkspaceDeparture(
      new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)),
      {
        read: () => remembered.slug,
        remember: (slug) => {
          remembered.slug = slug;
        },
        forget: () => {
          remembered.slug = undefined;
        },
      },
    );
    const deletion = quietDeletion(db);
    // The Delete Workspace server function's own call.
    const deleteAndGo = (target: { id: string; slug: string }) =>
      departure.delete(deletion, {
        workspaceId: target.id,
        userId: owner.id,
        confirmSlug: target.slug,
      });
    try {
      expect(await deleteAndGo(workspace)).toEqual({ nextWorkspaceSlug: other.slug });
      expect(remembered.slug).toBe(other.slug);

      // A refused delete goes nowhere and `/` keeps what it remembered.
      await expect(deleteAndGo(other)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(remembered.slug).toBe(other.slug);

      await db.workspace.delete({ where: { id: other.id } });
      expect(await departure.next(owner.id)).toEqual({ nextWorkspaceSlug: null });
      expect(remembered.slug).toBeUndefined();
    } finally {
      await db.workspace.delete({ where: { id: other.id } }).catch(() => {});
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "every foreign key inside a Workspace that does not cascade is one the delete handles",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    try {
      // `Restrict` (r) and `NO ACTION` (a) keys naming any table the Workspace's cascade reaches,
      // whether or not the naming table has a Workspace column: each would fail the cascade
      // unless handled.
      const rows = await db.$queryRaw<{ name: string }[]>`
        WITH RECURSIVE cascaded(rel) AS (
          SELECT 'workspaces'::regclass::oid
          UNION
          SELECT c.conrelid FROM pg_constraint c JOIN cascaded ON c.confrelid = cascaded.rel
          WHERE c.contype = 'f' AND c.confdeltype = 'c'
        )
        SELECT c.conname AS name FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confdeltype IN ('r', 'a')
          AND c.confrelid IN (SELECT rel FROM cascaded)
        ORDER BY 1`;
      // A new one here needs its rows deleted before the Workspace in `WorkspaceDeletion`
      // (and a row in the first test's fixture), then its name added below.
      expect(rows.map(({ name }) => name)).toEqual([
        // Deleted with the messages: an Action card goes with its message.
        "action_cards_preparedByAgentId_workspaceId_fkey",
        // `NO ACTION` is checked at the end of the cascading statement, when both rows are gone.
        "conversations_coordinatorAgentId_workspaceId_fkey",
        // Memory Offer citations are deleted first.
        "memory_offer_citations_openviking_citation_fkey",
        // Messages are deleted first; Tasks go with their message.
        "messages_senderMemberId_conversationId_workspaceId_fkey",
        "tasks_creatorMemberId_conversationId_workspaceId_fkey",
        "tasks_ownerMemberId_conversationId_workspaceId_fkey",
        // Settled rows are deleted first; any other refuses the delete with CONFLICT.
        "workspace_memory_cleanup_work_workspace_id_fkey",
      ]);
    } finally {
      await db.$disconnect();
    }
  },
);

test.skipIf(!connectionString)(
  "a Task written in a channel while the Workspace is deleted lands first, and the delete still completes",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner, team, memberRowId } = fixture;
    // The writer has its own connection, as a concurrent request would.
    const writerDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    const deleter = quietDeletion(db);
    try {
      let deleting: Promise<void> | undefined;
      // The Task write the way TaskBoard does it: the conversation's lock first, then the rows.
      await writerDb.$transaction(async (tx) => {
        await lockConversation(tx, team.id);
        const message = await tx.message.create({
          data: {
            workspaceId: workspace.id,
            conversationId: team.id,
            senderMemberId: memberRowId,
            sequence: 100,
            body: "a task written during the delete",
          },
        });
        deleting = deleter.delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        });
        await waitForLockWait(db);
        // The Task's key on the Workspace row: a delete holding that row would deadlock here.
        await tx.task.create({
          data: {
            messageId: message.id,
            conversationId: team.id,
            workspaceId: workspace.id,
            number: 100,
            title: "raced",
            creatorMemberId: memberRowId,
          },
        });
      });
      await deleting;
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.task.count({ where: { workspaceId: workspace.id } })).toBe(0);
    } finally {
      await writerDb.$disconnect();
      await fixture.cleanup();
    }
  },
);

/** Resolves once some other session is waiting on a row lock: the delete has reached a lock the
 * writer holds. Fails after five seconds. */
async function waitForLockWait(db: PrismaClient) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row && row.waiting > 0n) return;
    await Bun.sleep(20);
  }
  throw new Error("the delete never waited on the writer's lock");
}

test.skipIf(!connectionString)(
  "a write that holds the Workspace row before its conversation deadlocks with the delete, which tries again and completes",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner, team } = fixture;
    const writerDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    try {
      let deleting: Promise<void> | undefined;
      // The opposite order: a row naming the Workspace first (its key's share lock on the
      // Workspace row), then the conversation. PostgreSQL aborts the delete, which waited first.
      await writerDb.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "workspaces" WHERE "id" = ${workspace.id}::uuid FOR KEY SHARE`;
        deleting = quietDeletion(db).delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        });
        await waitForLockWait(db);
        await lockConversation(tx, team.id);
      });
      await deleting;
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    } finally {
      await writerDb.$disconnect();
      await fixture.cleanup();
    }
  },
);
