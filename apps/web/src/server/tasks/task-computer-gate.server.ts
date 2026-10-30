import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { taskConversationsEnabled } from "./task-conversations-gate.server";
import {
  TASK_CONVERSATIONS_MIN_COMPUTER_RELEASE,
  computerSupportsTaskConversations,
} from "#src/server/computers/task-computer-version.server";

/** The Computers hosting this Workspace's live Agents whose release cannot serve task
 * conversations, by the name they are shown under. */
async function outdatedComputers(db: PrismaClient, workspaceId: string) {
  const computers = await db.computer.findMany({
    where: { agents: { some: { workspaceId, deletedAt: null } } },
    select: { name: true, displayName: true, computerVersion: true },
  });
  return computers
    .filter((computer) => !computerSupportsTaskConversations(computer.computerVersion))
    .map((computer) => computer.displayName || computer.name);
}

/**
 * The switch for task conversations opens only when every Computer with an Agent in the Workspace
 * can serve them: an older CLI crashes listing a Task that sits on no channel message.
 */
export async function requireComputersForTaskConversations(db: PrismaClient, workspaceId: string) {
  const computers = await outdatedComputers(db, workspaceId);
  if (computers.length)
    throw new AppError("CONFLICT", {
      errorId: "computers-need-upgrade",
      details: {
        version: TASK_CONVERSATIONS_MIN_COMPUTER_RELEASE,
        computers: computers.join(", "),
      },
    });
}

/**
 * While task conversations are on, an Agent on a Computer older than they need is refused every
 * Task request, with no data an older CLI could not read. Undefined when the request may go on.
 */
export async function taskComputerRefusal(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
) {
  const agent = await db.agent.findUnique({
    where: { id: principal.agentId },
    select: { computer: { select: { computerVersion: true } } },
  });
  // An Agent with no Computer runs no CLI of its own.
  if (!agent?.computer || computerSupportsTaskConversations(agent.computer.computerVersion))
    return undefined;
  if (!(await taskConversationsEnabled(db, principal))) return undefined;
  return Response.json(
    {
      error: `This Computer needs CoForge ${TASK_CONVERSATIONS_MIN_COMPUTER_RELEASE} or later to use tasks. Upgrade it, then try again.`,
      code: "CLIENT_UPGRADE_REQUIRED",
      retryable: false,
    },
    { status: 426 },
  );
}
