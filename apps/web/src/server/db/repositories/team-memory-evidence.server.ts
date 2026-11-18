import type { TeamMemoryEvidence } from "@lrm/coforge-sdk/agent";
import type { Prisma } from "#src/generated/prisma/client";

export async function readableMemoryEvidence(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  evidence: TeamMemoryEvidence[],
): Promise<TeamMemoryEvidence[]> {
  const taskIds = evidence.filter(({ kind }) => kind === "task").map(({ id }) => id);
  const messageIds = evidence.filter(({ kind }) => kind === "message").map(({ id }) => id);
  const artifactIds = evidence.filter(({ kind }) => kind === "artifact").map(({ id }) => id);
  const conversation = {
    channelName: { not: null },
    visibility: "public",
    hiddenFromWorkspaceAt: null,
  };
  const [tasks, messages, artifacts] = await Promise.all([
    taskIds.length
      ? tx.task.findMany({
          where: { id: { in: taskIds }, workspaceId, deletedAt: null, conversation },
          select: { id: true, revision: true },
          take: taskIds.length,
        })
      : [],
    messageIds.length
      ? tx.message.findMany({
          where: { id: { in: messageIds }, workspaceId, conversation },
          select: { id: true, sequence: true },
          take: messageIds.length,
        })
      : [],
    artifactIds.length
      ? tx.artifact.findMany({
          where: {
            id: { in: artifactIds },
            workspaceId,
            deletedAt: null,
            OR: [{ access: "workspace" }, { homeKey: "workspace" }],
          },
          select: { id: true, currentVersion: true },
          take: artifactIds.length,
        })
      : [],
  ]);
  return evidence.filter(({ kind, id, revision }) => {
    if (kind === "task")
      return tasks.some((task) => task.id === id && (revision ?? 0) <= task.revision);
    if (kind === "message")
      return messages.some(
        (message) => message.id === id && (revision ?? message.sequence) === message.sequence,
      );
    return artifacts.some(
      (artifact) => artifact.id === id && (revision ?? 0) <= artifact.currentVersion,
    );
  });
}
