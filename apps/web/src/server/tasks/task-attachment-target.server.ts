import type { PrismaClient } from "#src/generated/prisma/client";
import { taskConversationsGate } from "./task-conversations-gate.server";
import { TaskConversations } from "./task-conversations.server";

/** A task's ref as an Agent writes it: its board (`#channel` or `dm:@peer`), then `:#N`. */
const TASK_TARGET = /^(.+):#(\d+)$/;

/**
 * The task conversation an upload target names, or null when `target` names no task. The Agent
 * reads the task's board, as for any task command; the conversation and the Agent's seat in it
 * are made if they are not there yet, so a file can wait for the first reply.
 */
export async function resolveTaskAttachmentTarget(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  target: string,
) {
  const match = TASK_TARGET.exec(target);
  if (!match) return null;
  if (!(await taskConversationsGate(db, principal)())) return null;
  return new TaskConversations({ db, reader: "agent", dependencies: {} }).open(principal, {
    target: match[1]!.replace(/^dm:/, ""),
    number: Number(match[2]),
  });
}
