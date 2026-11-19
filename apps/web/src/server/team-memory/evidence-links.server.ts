import type { Prisma } from "#src/generated/prisma/client";
import type { TeamMemoryEvidence } from "@lrm/coforge-sdk/agent";

type Target = { conversationId: string; taskNumber?: number; title?: string };

/** Artifact pages resolve their own authorization. Task and message locations are sent only for public channels. */
export async function memoryEvidenceLinks(
  db: Pick<Prisma.TransactionClient, "task" | "message">,
  workspaceId: string,
  evidence: TeamMemoryEvidence[],
): Promise<Record<string, Target>> {
  const ids = (kind: TeamMemoryEvidence["kind"]) => [
    ...new Set(evidence.filter((ref) => ref.kind === kind).map(({ id }) => id)),
  ];
  const taskIds = ids("task");
  const messageIds = ids("message");
  const conversation = {
    channelName: { not: null },
    visibility: "public",
    hiddenFromWorkspaceAt: null,
  };
  const [tasks, messages] = await Promise.all([
    taskIds.length
      ? db.task.findMany({
          where: { id: { in: taskIds }, workspaceId, deletedAt: null, conversation },
          select: { id: true, conversationId: true, number: true, title: true },
          take: taskIds.length,
        })
      : [],
    messageIds.length
      ? db.message.findMany({
          where: { id: { in: messageIds }, workspaceId, conversation },
          select: { id: true, conversationId: true },
          take: messageIds.length,
        })
      : [],
  ]);
  return Object.fromEntries([
    ...tasks.map(
      ({ id, conversationId, number, title }) =>
        [`task:${id}`, { conversationId, taskNumber: number, title }] as const,
    ),
    ...messages.map(({ id, conversationId }) => [`message:${id}`, { conversationId }] as const),
  ]);
}
