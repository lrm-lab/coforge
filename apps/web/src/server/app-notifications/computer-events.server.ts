import type { Prisma } from "#src/generated/prisma/client";
import {
  appNotificationsPossible,
  attemptAppNotification,
  recordAppNotifications,
} from "./app-notifications.server";

/**
 * What apps are told about Computers and the Agents running on them. Each function runs inside the
 * transaction of the domain write it describes, so the event exists only if that write commits.
 */

/**
 * The executable a Computer runs moved from `previous` to `version`. A Computer is one machine
 * that Workspaces share, so every Workspace it is linked to is told.
 */
export async function recordComputerVersionChanged(
  tx: Prisma.TransactionClient,
  computerId: string,
  change: { previous: string; version: string },
) {
  if (!appNotificationsPossible() || change.previous === change.version) return;
  const links = await attemptAppNotification(tx, () =>
    tx.workspaceComputer.findMany({ where: { computerId }, select: { workspaceId: true } }),
  );
  for (const { workspaceId } of links ?? [])
    await recordAppNotifications(tx, { id: workspaceId }, [
      {
        type: "computer.version_changed",
        data: {
          computer_id: computerId,
          previous_version: change.previous,
          version: change.version,
        },
      },
    ]);
}

/**
 * The Computer reported the outcome of an Agent control command, which moved the command from phase
 * `from` to `to`: a Stop that finished is `computer.agent_stopped`, a Start that finished is
 * `computer.agent_started`. Any other move records nothing; a restart is a stop and then a start.
 */
export function recordComputerAgentTransition(
  tx: Prisma.TransactionClient,
  agent: { workspaceId: string; computerId: string; agentId: string },
  move: { from: string | undefined; to: string },
) {
  const type =
    move.from === "stopping" && move.to === "stopped"
      ? "computer.agent_stopped"
      : move.from === "starting" && move.to === "completed"
        ? "computer.agent_started"
        : undefined;
  if (!type) return Promise.resolve();
  return recordAppNotifications(tx, { id: agent.workspaceId }, [
    { type, data: { computer_id: agent.computerId, agent_id: agent.agentId } },
  ]);
}
