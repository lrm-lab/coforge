import { noticeReleased, noticeSubtaskDeleted, onlyWaitingFor } from "./task-gates.server";
import { noticeActor, noticeText, quotedTask } from "./task-notices.server";
import { announceNeighbours } from "./task-publication.server";
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
  number: number;
  title: string;
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
  async runOnce(now = new Date(), workspaceId?: string) {
    const cutoff = new Date(now.getTime() - DELETED_TASK_UNDO_MS);
    const marked = await this.ports.db.task.findMany({
      where: { deletedAt: { not: null, lt: cutoff }, ...(workspaceId ? { workspaceId } : {}) },
      select: {
        id: true,
        status: true,
        number: true,
        title: true,
        workspaceId: true,
        conversationId: true,
        deletedByMemberId: true,
        deletedByUserId: true,
      },
      orderBy: { deletedAt: "asc" },
    });
    for (const task of marked) {
      try {
        await this.#removeClaimed(task, cutoff);
        sweepFailures.delete(task.id);
      } catch (error) {
        const seen = (sweepFailures.get(task.id) ?? 0) + 1;
        sweepFailures.set(task.id, seen);
        // A row that keeps failing is retried on the next run; past a few, it is alerted once —
        // an unremovable marker would otherwise retry the error log every sweep.
        console.error(
          `deleted-task sweep failed on task ${task.id}${seen > 3 ? " (repeated)" : ""}:`,
          error,
        );
      }
    }
  }

  async #removeClaimed(task: MarkedTask, cutoff: Date) {
    // The deleter's notice identity: its channel member row when it had one, else the admin's
    // user id — a Workspace owner/admin deletes without ever joining the channel (task #512).
    const member = task.deletedByMemberId
      ? await this.ports.db.conversationMember.findUnique({
          where: { id: task.deletedByMemberId },
          select: { id: true, userId: true, agentId: true, user: true, agent: true },
        })
      : task.deletedByUserId
        ? await this.ports.db.user
            .findUnique({
              where: { id: task.deletedByUserId },
              select: { username: true, displayName: true },
            })
            .then((user) =>
              user
                ? {
                    // task #512: the record names a person, not a member — a member-less
                    // admin's actor id is null in it, matching a server's sender.
                    id: null,
                    userId: task.deletedByUserId,
                    agentId: null,
                    user,
                    agent: null,
                  }
                : null,
            )
        : null;
    // A marker from before the deleter columns landed carries none; it cannot name a deleter
    // but is still removed, with no record posted. The delete carries the window condition, so
    // a restore inside the window keeps it.
    if (!member) {
      const related = await relatedTasks(this.ports.db, task);
      await this.ports.db.task.deleteMany({
        where: { id: task.id, deletedAt: { lt: cutoff } },
      });
      if (related.length)
        await announceNeighbours(this.ports, task.conversationId, related, `${task.id}:task-swept`);
      return;
    }
    const related = await withNotices(
      this.ports,
      { conversationId: task.conversationId, workspaceId: task.workspaceId },
      async (tx, notices) => {
        // `FOR UPDATE SKIP LOCKED` claims the row: a second instance's identical update blocks
        // on the lock instead of double-posting the record, and finds it gone after.
        // Only a row still marked and past the window is claimed: a restore inside the window
        // clears deletedAt first, so the lock then fails the condition and the sweep skips it.
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "tasks"
          WHERE "id" = ${task.id}::uuid AND "deletedAt" < ${cutoff}
          FOR UPDATE SKIP LOCKED
        `;
        if (claimed.length === 0) return;
        // task #512: the channel record posts only at the real removal — the marker itself
        // wrote none, so a restore inside the window never has to take a record back.
        const actor = noticeActor(member);
        await notices.inConversation({
          body: noticeText.taskDeleted(actor.displayName),
          system: { kind: "task.deleted", params: { actor, task: quotedTask(task, []) } },
        });
        const related = await relatedTasks(tx, task);
        await noticeReleased(notices, member, await onlyWaitingFor(tx, task), task.id);
        await noticeSubtaskDeleted(tx, notices, member, task);
        await tx.task.delete({ where: { id: task.id } });
        return related;
      },
    );
    // task #512: the neighbours' new copies go out once the row is gone — the blocker a marked
    // Task held is released, the parent its children lost is named, in the same announcement.
    if (related?.length)
      await announceNeighbours(this.ports, task.conversationId, related, `${task.id}:task-swept`);
  }
}

let started = false;
let sweeping = false;
const sweepFailures = new Map<string, number>();

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
