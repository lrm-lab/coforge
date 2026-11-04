import { noticeReleased, noticeSubtaskDeleted, onlyWaitingFor } from "./task-gates.server";
import { relatedTasks } from "./task-relations.server";
import { withNotices } from "./task-notice-posting.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { TaskBoardDependencies, TaskBoardPorts } from "./task-board-ports.server";

/** The undo window a deleted Task keeps before the sweep removes it for good (task #512). */
export const DELETED_TASK_UNDO_MS = 60_000;

type MarkedTask = {
  id: string;
  status: string;
  workspaceId: string;
  conversationId: string;
  deletedByMemberId: string | null;
  deletedByUserId: string | null;
};

/** The sweep that finally removes marked Tasks past the undo window, one claim per row. */
export class DeletedTaskSweep {
  private readonly ports: TaskBoardPorts;

  constructor(db: PrismaClient, dependencies: TaskBoardDependencies = {}) {
    this.ports = { db, reader: dependencies.reader ?? "people", dependencies };
  }

  /** Marks past the window each get removed once: `FOR UPDATE SKIP LOCKED` claims the row, so
   * two web instances sweeping at once never both delete the same Task. */
  async runOnce(now = new Date()) {
    const cutoff = new Date(now.getTime() - DELETED_TASK_UNDO_MS);
    const marked = await this.ports.db.task.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: {
        id: true,
        status: true,
        workspaceId: true,
        conversationId: true,
        deletedByMemberId: true,
        deletedByUserId: true,
      },
      orderBy: { deletedAt: "asc" },
    });
    for (const task of marked) {
      try {
        await this.#removeClaimed(task);
      } catch (error) {
        console.error(`deleted-task sweep failed on task ${task.id}:`, error);
      }
    }
  }

  async #removeClaimed(task: MarkedTask) {
    // The deleter's notice identity: its channel member row when it had one, else the admin's
    // user id — a Workspace owner/admin deletes without ever joining the channel (task #512).
    const member = task.deletedByMemberId
      ? await this.ports.db.conversationMember.findUnique({
          where: { id: task.deletedByMemberId },
          select: { id: true, userId: true, agentId: true },
        })
      : task.deletedByUserId
        ? { id: `admin:${task.deletedByUserId}`, userId: task.deletedByUserId, agentId: null }
        : null;
    // A marker from before the deleter columns landed carries none; it cannot name a deleter
    // but is still removed, with no record posted.
    if (!member) {
      await this.ports.db.task.delete({ where: { id: task.id } });
      return;
    }
    await withNotices(
      this.ports,
      { conversationId: task.conversationId, workspaceId: task.workspaceId },
      async (tx, notices) => {
        // `FOR UPDATE SKIP LOCKED` claims the row: a second instance's identical update blocks
        // on the lock instead of double-posting the record, and finds it gone after.
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "tasks" WHERE "id" = ${task.id}::uuid FOR UPDATE SKIP LOCKED
        `;
        if (claimed.length === 0) return;
        const related = await relatedTasks(tx, task);
        await noticeReleased(notices, member, await onlyWaitingFor(tx, task), task.id);
        await noticeSubtaskDeleted(tx, notices, member, task);
        await tx.task.delete({ where: { id: task.id } });
        return related;
      },
    );
  }
}

let started = false;
let sweeping = false;

/** The period between sweep runs; a marked Task is removed at most one run past its window. */
export const DELETED_TASK_SWEEP_MS = 15_000;

/** The Centrifugo RPC composition's deleted-task sweep registration (`registerBackgroundSweeps`). */
export function ensureDeletedTaskSweep(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => void run(), DELETED_TASK_SWEEP_MS);
  timer.unref();
  onServerShutdown(() => clearInterval(timer));
}

async function run() {
  if (sweeping) return;
  sweeping = true;
  try {
    await new DeletedTaskSweep(requireDatabaseClient()).runOnce();
  } finally {
    sweeping = false;
  }
}
