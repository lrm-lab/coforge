import type { PrismaClient } from "#src/generated/prisma/client";
import {
  TASK_CONVERSATIONS_MIN_COMPUTER_RELEASE,
  computerSupportsTaskConversations,
} from "#src/server/computers/task-computer-version.server";

/**
 * An Agent on a Computer older than task conversations need is refused every Task request, with
 * no data an older CLI could not read. Undefined when the request may go on.
 */
export async function taskComputerRefusal(db: PrismaClient, principal: { agentId: string }) {
  const agent = await db.agent.findUnique({
    where: { id: principal.agentId },
    select: { computer: { select: { computerVersion: true } } },
  });
  // An Agent with no Computer runs no CLI of its own.
  if (!agent?.computer || computerSupportsTaskConversations(agent.computer.computerVersion))
    return undefined;
  return Response.json(
    {
      error: `This Computer needs CoForge ${TASK_CONVERSATIONS_MIN_COMPUTER_RELEASE} or later to use tasks. Upgrade it, then try again.`,
      code: "CLIENT_UPGRADE_REQUIRED",
      retryable: false,
    },
    { status: 426 },
  );
}
